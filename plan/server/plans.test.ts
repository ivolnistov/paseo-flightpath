// Plan commands (Stage 3 T3.5): drafts, exact-revision approval with plugin-data receipts,
// currency, task identity, the derived Markdown export and its race, over a real temp store.
import { cp, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../shared/errors";
import { isV2Revision, type ApprovalReceipt, type Ref } from "../shared/model";
import { PlanApprove, PlanView } from "../shared/rpc";
import { nodeStoreFs, type StoreFs } from "./fs-port";
import { exportHeader, renderExport, syncExport } from "./plan-export";
import { createApprovalStore, type ApprovalStore } from "./approvals";
import { cancelledRefs, contentHash, contentHashV2 } from "./plan-hash";
import { basisCurrent } from "./plan-rules";
import { openStore } from "./store";
import { createPlanCommands } from "./plans";
import { UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { fixedClock, NOW_ISO, nextId } from "./test-support/build";
import { makePlanProject, receipt, type PlanProject } from "./test-support/plans";

const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent" }, quoted: "approve it" };
let t: PlanProject | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

type R<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: any } };
function ok<T>(r: R<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}
function err<T>(r: R<T>) {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`);
  return r.error;
}
const exists = (p: string) => stat(p).then(() => true, () => false);

async function setup(opts?: { storeFs?: StoreFs }) {
  t = await makePlanProject(opts);
  const seed = await t.seedAnswered();
  const { plans, open, P } = t;
  const draft = async (extra: Partial<{ planId: string; tasks: Array<{ id?: string; title: string; description: string }>; markdown: string; origin: WriteOrigin }> = {}) =>
    plans.draft(
      open,
      {
        projectId: P, expectedRevision: await t!.revision(), title: "Rollout", sessionIds: [seed.sessionId],
        markdown: extra.markdown ?? "# Rollout\n\nShip it", tasks: extra.tasks ?? [{ id: "t1", title: "Build", description: "do" }],
        ...(extra.planId ? { planId: extra.planId } : {}),
      },
      extra.origin ?? UI_ORIGIN,
    );
  const get = (planId: string) => plans.get(open, { projectId: P, planId });
  const approve = (planId: string, rev: number, contentHash: string, origin: WriteOrigin = UI_ORIGIN) =>
    plans.approve(open, { projectId: P, planId, rev, contentHash }, origin);
  const task = async (planId: string, planRev: number, contentHash: string, taskId: string, status: "todo" | "in_progress" | "done" | "verified", extra: { note?: string; origin?: WriteOrigin; expectedRevision?: number } = {}) =>
    plans.taskUpdate(
      open,
      { projectId: P, expectedRevision: extra.expectedRevision ?? (await t!.revision()), planId, planRev, contentHash, taskId, status, ...(extra.note ? { note: extra.note } : {}) },
      extra.origin ?? UI_ORIGIN,
    );
  const answer = async (q: Ref, optionId: string) =>
    ok(await t!.project.service.questionAnswer(t!.project.paseo, { projectId: P, expectedRevision: await t!.revision(), ...q, optionId }));
  const receiptDir = (planId: string) => join(t!.stateDir, "approvals", P, planId);
  const receiptFiles = async (planId: string) => (await readdir(receiptDir(planId)).catch(() => [] as string[])).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  const exportPath = (planId: string) => join(t!.project.root, ".decisions", "plans", `${planId}.md`);
  const latestRevision = async (planId: string) => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data.plans.find((p) => p.id === planId)!;
  };
  return { ...t, seed, draft, get, approve, task, answer, receiptDir, receiptFiles, exportPath, latestRevision };
}

describe("draft", () => {
  it("creates rev 1 with a hash, one store step, the export header and the current basis", async () => {
    const s = await setup();
    const before = await s.revision();
    const d = ok(await s.draft());
    expect(d.rev).toBe(1);
    expect(d.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.revision).toBe(before + 1);
    expect(d.exportWritten).toBe(true);
    const text = await readFile(s.exportPath(d.planId), "utf8");
    expect(text.startsWith(exportHeader(d.planId, 1, d.contentHash))).toBe(true);
    const plan = await s.latestRevision(d.planId);
    expect(plan.revisions[0].basedOn).toEqual([
      { ...s.seed.q1, answerRev: 1, definitionRev: 1, validity: "valid" },
      { ...s.seed.q2, answerRev: 1, definitionRev: 1, validity: "valid" },
    ].sort((a, b) => a.questionId.localeCompare(b.questionId)));
    expect(plan.approvals).toEqual([]);
  });

  it("a second draft with an edited task gets rev 2 and a new hash; task states do not carry over", async () => {
    const s = await setup();
    const d1 = ok(await s.draft({ tasks: [{ id: "t1", title: "Build", description: "do" }, { id: "t2", title: "Test", description: "" }] }));
    ok(await s.approve(d1.planId, 1, d1.contentHash));
    ok(await s.task(d1.planId, 1, d1.contentHash, "t1", "in_progress"));
    const d2 = ok(await s.draft({ planId: d1.planId, tasks: [{ id: "t1", title: "Build v2", description: "do" }, { id: "t2", title: "Test", description: "" }] }));
    expect(d2.rev).toBe(2);
    expect(d2.contentHash).not.toBe(d1.contentHash);
    const plan = await s.latestRevision(d1.planId);
    expect(plan.taskStates.filter((x) => x.planRev === 2)).toEqual([]);
    expect(err(await s.draft({ planId: d1.planId, tasks: [{ id: "dup", title: "A", description: "" }, { id: "dup", title: "B", description: "" }] })).code).toBe("invalid_input");
  });
});

describe("approve", () => {
  it("writes a receipt, records a copy, becomes current, is idempotent and bound to the latest rev and hash", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    const a = ok(await s.approve(d1.planId, 1, d1.contentHash));
    expect(a).toMatchObject({ alreadyApproved: false, copyRecorded: true });
    expect(await s.receiptFiles(d1.planId)).toEqual(["1.json"]);
    const view = ok(await s.get(d1.planId));
    expect(view.approval).toBe("current");
    expect(view.approvals).toHaveLength(1);
    expect(view.approvals[0]).toMatchObject({ verified: true, receipt: { receiptId: a.receiptId, planRev: 1, contentHash: d1.contentHash, actor: { kind: "human" } } });
    expect("hostClientId" in view.approvals[0].receipt.actor).toBe(false);

    const again = ok(await s.approve(d1.planId, 1, d1.contentHash));
    expect(again).toMatchObject({ alreadyApproved: true, receiptId: a.receiptId });
    expect(await s.receiptFiles(d1.planId)).toEqual(["1.json"]);

    const d2 = ok(await s.draft({ planId: d1.planId, markdown: "# Rollout v2" }));
    const stale = err(await s.approve(d1.planId, 1, d1.contentHash));
    expect(stale.code).toBe("plan_revision_mismatch");
    expect(stale.details).toMatchObject({ latestRev: 2 });
    expect(err(await s.approve(d1.planId, 2, "0".repeat(64))).code).toBe("plan_revision_mismatch");
    expect(d2.rev).toBe(2);
    expect(await s.receiptFiles(d1.planId)).toEqual(["1.json"]);
  });

  it("a later re-answer makes the approval not_current; re-approving then gives plan_not_current", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    ok(await s.approve(d1.planId, 1, d1.contentHash));
    await s.answer(s.seed.q1, "b");
    const view = ok(await s.get(d1.planId));
    expect(view.approval).toBe("not_current");
    expect(view.notCurrentReasons.some((x) => x.includes(s.seed.q1.questionId))).toBe(true);
    expect(await s.receiptFiles(d1.planId)).toEqual(["1.json"]);
    const blocked = err(await s.approve(d1.planId, 1, d1.contentHash));
    expect(blocked.code).toBe("plan_not_current");
  });

  it("a copy forged into the project JSON without a receipt is unverified; a receipt for another project is ignored", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    const forged: ApprovalReceipt = receipt({ receiptId: "forged", projectId: s.P, planId: d1.planId, planRev: 1, contentHash: d1.contentHash, decisionSnapshotHash: (await s.latestRevision(d1.planId)).revisions[0].decisionSnapshotHash });
    const store = await s.open(s.P);
    await store.transact(await s.revision(), (draft) => {
      draft.plans.find((p) => p.id === d1.planId)!.approvals.push(forged);
    });
    const view = ok(await s.get(d1.planId));
    expect(view.approval).toBe("unverified");
    expect(view.approvals).toEqual([{ receipt: forged, verified: false }]);

    // A receipt file under this project's path whose content names another project.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(s.receiptDir(d1.planId), { recursive: true, mode: 0o700 });
    await writeFile(join(s.receiptDir(d1.planId), "1.json"), JSON.stringify({ ...forged, projectId: "prj_other" }), { mode: 0o600 });
    const after = ok(await s.get(d1.planId));
    expect(after.approval).toBe("unverified");
    expect(after.approvals[0].verified).toBe(false);
  });

  it("restart: new plan commands over the same stateDir and project see the same current approval", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    ok(await s.approve(d1.planId, 1, d1.contentHash));
    const fresh = s.makeCommands();
    expect(ok(await fresh.get(s.open, { projectId: s.P, planId: d1.planId })).approval).toBe("current");
  });

  it("history: approve rev 1, draft rev 2, approve rev 2 gives two verified copies in order", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    ok(await s.approve(d1.planId, 1, d1.contentHash));
    const d2 = ok(await s.draft({ planId: d1.planId, markdown: "# v2" }));
    ok(await s.approve(d1.planId, 2, d2.contentHash));
    const view = ok(await s.get(d1.planId));
    expect(view.approvals.map((a) => [a.receipt.planRev, a.verified])).toEqual([[1, true], [2, true]]);
    expect(view.approval).toBe("current");
    expect(await s.receiptFiles(d1.planId)).toEqual(["1.json", "2.json"]);
  });

  it("approval from a chat origin is invalid_input and writes no receipt", async () => {
    const s = await setup();
    const d1 = ok(await s.draft({ origin: CHAT }));
    expect(err(await s.approve(d1.planId, 1, d1.contentHash, CHAT)).code).toBe("invalid_input");
    expect(await s.receiptFiles(d1.planId)).toEqual([]);
    expect(ok(await s.get(d1.planId)).approval).toBe("unapproved");
  });
});

describe("approval store revision and authoritative history (KensAI C14/C20)", () => {
  /** The real opener, but every transact on the opened store fails with revision_conflict. */
  const conflictingOpener = (real: StoreOpener) => {
    const attempts = { transact: 0 };
    const open: StoreOpener = async (projectId) => {
      const store = await real(projectId);
      return new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === "transact") {
            return () => {
              attempts.transact++;
              return Promise.reject(new DomainError("revision_conflict", "injected conflict", { expected: 0, actual: 1 }));
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    };
    return { open, attempts };
  };

  it("approve returns the exact store revision its copy commit produced, and the contract keeps it", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    const before = await s.revision();
    const a = ok(await s.approve(d1.planId, 1, d1.contentHash)) as Record<string, unknown>;
    expect(a.copyRecorded).toBe(true);
    expect(a.revision, "the store revision committed by this approval's copy").toBe(before + 1);
    expect(await s.revision()).toBe(before + 1);
    const parsed = PlanApprove.output.parse({ ok: true, value: a }) as { ok: true; value: Record<string, unknown> };
    expect(parsed.value.revision).toBe(before + 1);
    expect(PlanApprove.output.safeParse({ ok: true, value: { ...a, revision: null } }).success, "null is a valid revision").toBe(true);
  });

  it("when every copy attempt conflicts the receipt is durable, copyRecorded false and revision null", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    const before = await s.revision();
    const conflict = conflictingOpener(s.open);
    const a = ok(await s.plans.approve(conflict.open, { projectId: s.P, planId: d1.planId, rev: 1, contentHash: d1.contentHash }, UI_ORIGIN)) as Record<string, unknown>;
    expect(conflict.attempts.transact, "the bounded copy retry ran out").toBe(3);
    expect(a).toMatchObject({ alreadyApproved: false, copyRecorded: false });
    expect("revision" in a, "the field is present").toBe(true);
    expect(a.revision, "no commit by this approval, so no store revision").toBeNull();
    expect(await s.revision()).toBe(before);
    expect(await s.receiptFiles(d1.planId)).toEqual(["1.json"]);
  });

  it("plan.get history shows the authoritative receipt even when its project copy was never recorded", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    const conflict = conflictingOpener(s.open);
    const a = ok(await s.plans.approve(conflict.open, { projectId: s.P, planId: d1.planId, rev: 1, contentHash: d1.contentHash }, UI_ORIGIN));
    expect(a.copyRecorded).toBe(false);
    const stored = await s.approvals.read(s.P, d1.planId, 1);
    expect(stored).not.toBeNull();

    const view = ok(await s.get(d1.planId));
    expect(view.approval).toBe("current");
    expect(view.approvals, "the verified plugin-data receipt is listed").toEqual([{ receipt: stored, verified: true }]);
    expect((await s.latestRevision(d1.planId)).approvals, "get does not repair the cosmetic copy implicitly").toEqual([]);
  });

  it("a tampered copy reusing the receiptId, or a forged one, never hides or replaces the genuine receipt", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    ok(await s.approve(d1.planId, 1, d1.contentHash));
    const genuine = (await s.approvals.read(s.P, d1.planId, 1))!;
    expect(ok(await s.get(d1.planId)).approvals, "an honest matching copy is listed once").toEqual([{ receipt: genuine, verified: true }]);

    const tampered: ApprovalReceipt = { ...genuine, note: "approved by someone else", at: "2026-10-22T00:00:00.000Z" };
    const forged: ApprovalReceipt = { ...genuine, receiptId: "forged-receipt", note: "forged" };
    const store = await s.open(s.P);
    await store.transact(await s.revision(), (draft) => {
      draft.plans.find((p) => p.id === d1.planId)!.approvals = [tampered, forged];
    });

    const view = ok(await s.get(d1.planId));
    expect(view.approval).toBe("current");
    const verified = view.approvals.filter((x) => x.verified);
    expect(verified, "exactly the genuine receipt is verified").toEqual([{ receipt: genuine, verified: true }]);
    for (const bad of [tampered, forged]) {
      expect(view.approvals.some((x) => !x.verified && JSON.stringify(x.receipt) === JSON.stringify(bad)), bad.receiptId).toBe(true);
    }
    expect(view.approvals.some((x) => x.verified && x.receipt.note !== genuine.note)).toBe(false);
  });
});

describe("owner rulings end to end", () => {
  it("R1: a skipped question can be drafted, blocks approval, then answer + new draft approves", async () => {
    const s = await setup();
    ok(await s.project.service.questionSkip(s.project.paseo, { projectId: s.P, expectedRevision: await s.revision(), ...s.seed.q2 }));
    const d1 = ok(await s.draft());
    const plan = await s.latestRevision(d1.planId);
    expect(plan.revisions[0].basedOn.find((b) => b.questionId === s.seed.q2.questionId)?.validity).toBe("skipped");
    const blocked = err(await s.approve(d1.planId, 1, d1.contentHash));
    expect(blocked.code).toBe("plan_not_current");
    expect(JSON.stringify(blocked)).toMatch(/is skipped; answer it/);
    expect(await s.receiptFiles(d1.planId)).toEqual([]);

    await s.answer(s.seed.q2, "d");
    const d2 = ok(await s.draft({ planId: d1.planId }));
    const a = ok(await s.approve(d1.planId, 2, d2.contentHash));
    expect(a.alreadyApproved).toBe(false);
    expect(await s.receiptFiles(d1.planId)).toEqual(["2.json"]);
    expect(ok(await s.get(d1.planId)).approval).toBe("current");
  });

  it("R2: an inactive branch is drafted and approved; activating it makes the approval not current", async () => {
    const s = await setup();
    ok(
      await s.project.service.questionCreate(s.project.paseo, {
        projectId: s.P, expectedRevision: await s.revision(), sessionId: s.seed.sessionId, title: "Branch", context: "",
        options: [{ id: "x", label: "X" }], allowFreeText: false, activatedBy: [{ parent: s.seed.q1, optionIds: ["b"] }], invalidatedBy: [],
      }),
    );
    const d1 = ok(await s.draft());
    expect((await s.latestRevision(d1.planId)).revisions[0].basedOn).toHaveLength(2);
    ok(await s.approve(d1.planId, 1, d1.contentHash));
    expect(ok(await s.get(d1.planId)).approval).toBe("current");
    await s.answer(s.seed.q1, "b");
    const view = ok(await s.get(d1.planId));
    expect(view.approval).toBe("not_current");
    expect(view.notCurrentReasons.some((x) => x.includes("became active")), view.notCurrentReasons.join(" | ")).toBe(true);
  });
});

describe("task updates", () => {
  it("an old revision's task action with a fresh expectedRevision is rejected even when the task id is reused", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    ok(await s.approve(d1.planId, 1, d1.contentHash));
    const d2 = ok(await s.draft({ planId: d1.planId, tasks: [{ id: "t1", title: "Build again", description: "do" }] }));
    ok(await s.approve(d1.planId, 2, d2.contentHash));
    const out = err(await s.task(d1.planId, 1, d1.contentHash, "t1", "in_progress"));
    expect(out.code).toBe("plan_revision_mismatch");
    expect((await s.latestRevision(d1.planId)).taskStates.filter((x) => x.planRev === 2 && x.taskId === "t1")).toEqual([]);
    expect(err(await s.task(d1.planId, 2, d1.contentHash, "t1", "in_progress")).code).toBe("plan_revision_mismatch");
  });

  it("enforces currency, the verified rules, task existence and the store revision", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    const H = d1.contentHash;
    expect(err(await s.task(d1.planId, 1, H, "t1", "in_progress")).code).toBe("plan_not_current");
    ok(await s.approve(d1.planId, 1, H));
    ok(await s.task(d1.planId, 1, H, "t1", "in_progress"));
    ok(await s.task(d1.planId, 1, H, "t1", "done"));
    expect(err(await s.task(d1.planId, 1, H, "t1", "verified", { note: "checked", origin: CHAT })).code).toBeTruthy();
    expect((await s.latestRevision(d1.planId)).taskStates.find((x) => x.taskId === "t1")?.status).toBe("done");
    expect(err(await s.task(d1.planId, 1, H, "t1", "verified")).code, "verified needs a note").toBeTruthy();
    ok(await s.task(d1.planId, 1, H, "t1", "verified", { note: "checked in staging" }));
    expect((await s.latestRevision(d1.planId)).taskStates).toEqual([
      { taskId: "t1", planRev: 1, status: "verified", verification: { at: NOW_ISO, note: "checked in staging" } },
    ]);
    expect(err(await s.task(d1.planId, 1, H, "nope", "in_progress")).code).toBe("not_found");
    expect(err(await s.task(d1.planId, 1, H, "t1", "in_progress", { expectedRevision: 1 })).code).toBe("revision_conflict");
  });
});

describe("export file", () => {
  it("an unwritable export reports exportWritten false and logs; plan.get repairs it", async () => {
    const s = await setup();
    const plansDir = join(s.project.root, ".decisions", "plans");
    await writeFile(plansDir, "not a directory");
    const d1 = ok(await s.draft());
    expect(d1.exportWritten).toBe(false);
    expect(s.logs.some((l) => /export/i.test(l))).toBe(true);
    expect((await s.latestRevision(d1.planId)).revisions).toHaveLength(1);
    await rm(plansDir);
    const view = ok(await s.get(d1.planId));
    expect(view.exportWritten).toBe(true);
    expect(await exists(s.exportPath(d1.planId))).toBe(true);
  });

  it("a hand-edited body under an intact header is rewritten to the full latest render", async () => {
    const s = await setup();
    const d1 = ok(await s.draft());
    const file = s.exportPath(d1.planId);
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("Ship it", "Ship it NOW, skip review"));
    ok(await s.get(d1.planId));
    const latest = (await s.latestRevision(d1.planId)).revisions.at(-1)!;
    expect(await readFile(file, "utf8")).toBe(renderExport(d1.planId, latest));
  });

  it("an older held export cannot leave older content: a later revision committed meanwhile wins", async () => {
    // Signal the moment a store commit publishes its manifest.
    let committed: (() => void) | null = null;
    const signalFs: StoreFs = {
      ...nodeStoreFs,
      async rename(from, to) {
        await nodeStoreFs.rename(from, to);
        if (to.endsWith(join(".decisions", "manifest.json")) && committed) {
          const c = committed;
          committed = null;
          c();
        }
      },
    };
    const s = await setup({ storeFs: signalFs });
    const d1 = ok(await s.draft());
    const file = s.exportPath(d1.planId);
    await writeFile(file, "stale bytes"); // force the held sync to write

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let beforeWriteCalls = 0;
    const first = syncExport(await s.open(s.P), d1.planId, {
      beforeWrite: async () => {
        beforeWriteCalls++;
        if (beforeWriteCalls === 1) await held; // rev 1 render, holding the per-plan lock
      },
    });

    // Commit rev 2; its own export queues behind the held lock, so it is not awaited yet.
    const rev2Committed = new Promise<void>((resolve) => (committed = resolve));
    const second = s.draft({ planId: d1.planId, markdown: "# Rollout rev 2" });
    await rev2Committed;
    release();

    expect(await first).toBe(true);
    const d2 = ok(await second);
    expect(d2.rev).toBe(2);
    expect(d2.exportWritten).toBe(true);
    const latest = (await s.latestRevision(d1.planId)).revisions.at(-1)!;
    expect(latest.rev).toBe(2);
    expect(await readFile(file, "utf8")).toBe(renderExport(d1.planId, latest));
    expect(beforeWriteCalls, "the held sync re-read the store and wrote the newer revision").toBe(2);
  });
});

/**
 * Stage R2.2 (task card §3.2): the server-owned grilling links of a plan's feature, the plan and its
 * latest revision's tasks. Callers assert the ids are strings before expecting them in blockers.
 */
async function grillLinks(open: StoreOpener, projectId: string, planId: string) {
  const read = await (await open(projectId)).read();
  if (read.status !== "ok") throw new Error("store not ok");
  const plan = read.data.plans.find((p) => p.id === planId)!;
  const feature = read.data.features.find((f) => f.id === plan.featureId);
  const latest = plan.revisions.at(-1);
  const task = (id: string) => (latest !== undefined && isV2Revision(latest) ? latest.tasks.find((x) => x.id === id)?.grillSessionId : undefined);
  return { feature: feature?.grillSessionId, plan: plan.grillSessionId, task, sessions: read.data.sessions };
}

// Redesign Stage R0.6, as amended by R2.1 (task card 2026-10-29 §2): a schema 2 revision is approvable
// only when its approval gates are satisfied (a DoD on every task and complete grilling of the
// feature, the plan and every grill task); otherwise plan.approve is plan_ineligible with the
// blockers. The check runs after the UI-origin and revision checks and before the content-hash check
// and any receipt write; legacy approval is unchanged (tests above).
describe("fail-closed v2 approval guard", () => {
  /** Legacy rev 1 drafted normally, then a schema 2 rev 2 written directly into the store. */
  async function withV2Revision() {
    const s = await setup();
    const d = ok(await s.draft());
    const plan = await s.latestRevision(d.planId);
    const legacy = plan.revisions[0];
    const body = {
      markdown: "# Rollout v2\n\nShip it",
      tasks: [{ id: "t1", title: "Build", description: "do", dependsOn: [], parallel: false, completion: "auto" as const, grill: false, dod: "- [check] npm test" }],
      basedOn: legacy.basedOn,
      decisionSnapshotHash: legacy.decisionSnapshotHash,
    };
    const v2 = { rev: 2, createdAt: NOW_ISO, schema: 2 as const, contentHash: contentHashV2(body), ...body };
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      draft.plans.find((p) => p.id === d.planId)!.revisions.push(v2);
    });
    return { ...s, planId: d.planId, v2, legacy };
  }

  const expectGuard = (e: { code: string; details?: any }) => {
    expect(e.code).toBe("plan_ineligible");
    // R2.1 (card §2.5): the fixture is unbound, schema 2, DoD set, grill false; only the plan gate applies.
    expect(e.details?.blockers).toEqual([{ code: "grilling_required" }]);
  };

  it("approve of a schema 2 revision through the commands layer is plan_ineligible; no receipt, no store write", async () => {
    const s = await withV2Revision();
    const before = await s.revision();
    expectGuard(err(await s.approve(s.planId, 2, s.v2.contentHash)));
    expect(await s.approvals.read(s.P, s.planId, 2)).toBeNull();
    expect(await s.receiptFiles(s.planId)).toEqual([]);
    expect(await s.revision()).toBe(before);
    expect((await s.latestRevision(s.planId)).approvals).toEqual([]);
  });

  it("the same through the UI plan service", async () => {
    const s = await withV2Revision();
    const before = await s.revision();
    expectGuard(err(await s.ui.approve(s.project.paseo, { projectId: s.P, planId: s.planId, rev: 2, contentHash: s.v2.contentHash })));
    expect(await s.approvals.read(s.P, s.planId, 2)).toBeNull();
    expect(await s.revision()).toBe(before);
  });

  it("the guard precedes the content-hash check; origin and revision checks still come first", async () => {
    const s = await withV2Revision();
    expectGuard(err(await s.approve(s.planId, 2, "f".repeat(64))));
    expect(err(await s.approve(s.planId, 2, s.v2.contentHash, CHAT)).code).toBe("invalid_input");
    expect(err(await s.approve(s.planId, 1, s.legacy.contentHash)).code).toBe("plan_revision_mismatch");
    expect(await s.receiptFiles(s.planId)).toEqual([]);
  });

  it("plan.get still reads a plan whose latest revision is schema 2", async () => {
    const s = await withV2Revision();
    const view = ok(await s.get(s.planId)) as any;
    expect(view.plan.revisions.map((r: { rev: number }) => r.rev)).toEqual([1, 2]);
  });
});

// Stage R1.0 (card §1.3, §1.4, §1.6, disposition §7 C3): one versioned draft producer. Unbound plans
// keep the shipped legacy path; an explicit featureId binds and makes v2 with defaults built in code;
// a bound plan always drafts v2 with the same featureId (no downgrade, no rebind). plan.get shows the
// approval blockers that plan.approve enforces. Every rejection writes nothing.
describe("R1.0 versioned drafts and blockers", () => {
  type Task = { id?: string; title: string; description: string; dependsOn?: string[]; parallel?: boolean; completion?: "auto" | "human"; grill?: boolean; dod?: string };
  async function setup2() {
    const s = await setup();
    const { createFeatureCommands } = await import("./features");
    const features = createFeatureCommands({ directory: () => { throw new Error("unused"); }, now: () => new Date(NOW_ISO), newId: (() => { let n = 0; return () => `feat${++n}`; })() } as any);
    const feature = async (title: string) =>
      ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title, description: "", kind: "feature" } as any, UI_ORIGIN)).featureId;
    const draftAny = async (extra: { planId?: string; featureId?: string; tasks?: Task[]; expectedRevision?: number; origin?: WriteOrigin } = {}) =>
      s.plans.draft(
        s.open,
        {
          projectId: s.P, expectedRevision: extra.expectedRevision ?? (await s.revision()), title: "Rollout", sessionIds: [s.seed.sessionId],
          markdown: "# Rollout\n\nShip it", tasks: extra.tasks ?? [{ id: "t1", title: "Build", description: "do" }],
          ...(extra.planId ? { planId: extra.planId } : {}), ...(extra.featureId !== undefined ? { featureId: extra.featureId } : {}),
        } as any,
        extra.origin ?? UI_ORIGIN,
      );
    const snapshot = async () => {
      const read = await (await s.open(s.P)).read();
      if (read.status !== "ok") throw new Error("store not ok");
      return { revision: await s.revision(), data: JSON.stringify(read.data) };
    };
    const expectNoWrite = async (attempt: () => Promise<R<unknown>>, code: string) => {
      const before = await snapshot();
      const e = err(await attempt());
      expect(e.code, e.message).toBe(code);
      expect(await snapshot()).toEqual(before);
      return e;
    };
    const bodyOf = (r: any) => ({ markdown: r.markdown, tasks: r.tasks, basedOn: r.basedOn, decisionSnapshotHash: r.decisionSnapshotHash });
    return { ...s, features, feature, draftAny, snapshot, expectNoWrite, bodyOf };
  }
  const V2_TASKS: Task[] = [
    { id: "t1", title: "Build", description: "do", dod: "Tests pass" },
    { id: "t2", title: "Ship", description: "", dependsOn: ["t1"], parallel: true, completion: "human", grill: true },
  ];
  const DEFAULTS = { dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "" };

  it("legacy draft of a new plan: shipped task objects, contentHash(body), no schema and no featureId", async () => {
    const s = await setup2();
    const d = ok(await s.draftAny());
    const p = await s.latestRevision(d.planId);
    const rev = p.revisions[0] as any;
    expect("featureId" in p).toBe(false);
    expect("schema" in rev).toBe(false);
    expect(rev.tasks).toEqual([{ id: "t1", title: "Build", description: "do" }]);
    expect(Object.keys(rev.tasks[0]).sort()).toEqual(["description", "id", "title"]);
    expect(rev.contentHash).toBe(contentHash(s.bodyOf(rev)));
    expect(d.contentHash).toBe(rev.contentHash);
    expect(Object.keys(rev).sort()).toEqual(["basedOn", "contentHash", "createdAt", "decisionSnapshotHash", "markdown", "rev", "tasks"]);
  });

  it("legacy re-draft of an existing unbound plan stays legacy and leaves rev 1 byte-identical", async () => {
    const s = await setup2();
    const d = ok(await s.draftAny());
    const rev1 = JSON.stringify((await s.latestRevision(d.planId)).revisions[0]);
    ok(await s.draftAny({ planId: d.planId, tasks: [{ id: "t1", title: "Build v2", description: "do" }] }));
    const p = await s.latestRevision(d.planId);
    expect(JSON.stringify(p.revisions[0])).toBe(rev1);
    const rev2 = p.revisions[1] as any;
    expect("schema" in rev2).toBe(false);
    expect("featureId" in p).toBe(false);
    expect(rev2.contentHash).toBe(contentHash(s.bodyOf(rev2)));
  });

  it("a v2-shaped request without featureId is invalid_input with no write, for a new and an unbound existing plan", async () => {
    const s = await setup2();
    for (const tasks of [V2_TASKS, [{ title: "A", description: "", dod: "x" }], [{ title: "A", description: "", grill: false }], [{ title: "A", description: "", dependsOn: [] }]] as Task[][]) {
      await s.expectNoWrite(() => s.draftAny({ tasks }), "invalid_input");
    }
    const d = ok(await s.draftAny());
    await s.expectNoWrite(() => s.draftAny({ planId: d.planId, tasks: V2_TASKS }), "invalid_input");
    // Positive control: the same v2 tasks with a binding write.
    ok(await s.draftAny({ tasks: V2_TASKS, featureId: await s.feature("F") }));
  });

  it("a featureId naming no feature is not_found with no write", async () => {
    const s = await setup2();
    await s.feature("F");
    await s.expectNoWrite(() => s.draftAny({ featureId: "missing", tasks: V2_TASKS }), "not_found");
    await s.expectNoWrite(() => s.draftAny({ featureId: "missing" }), "not_found");
  });

  it("a new plan with featureId: rev 1 is schema 2 with explicit defaults, the binding is set and contentHash is contentHashV2(body)", async () => {
    const s = await setup2();
    const f = await s.feature("F");
    const d = ok(await s.draftAny({ featureId: f, tasks: V2_TASKS }));
    const p = await s.latestRevision(d.planId);
    const rev = p.revisions[0] as any;
    expect(p.featureId).toBe(f);
    expect(rev.rev).toBe(1);
    expect(rev.schema).toBe(2);
    // R2.2 (card §3.2): the grill: true task carries its server-created session; the link is hashed.
    const links = await grillLinks(s.open, s.P, d.planId);
    const t2Session = links.task("t2");
    expect(typeof t2Session, "t2 has a server-created grilling session").toBe("string");
    expect(links.sessions.find((x) => x.id === t2Session)?.title).toBe("[task:t2] Ship");
    expect(rev.tasks).toEqual([
      { id: "t1", title: "Build", description: "do", ...DEFAULTS, dod: "Tests pass" },
      { id: "t2", title: "Ship", description: "", dependsOn: ["t1"], parallel: true, completion: "human", grill: true, grillSessionId: t2Session, dod: "" },
    ]);
    expect("grillSessionId" in rev.tasks[0]).toBe(false);
    expect(rev.contentHash).toBe(contentHashV2(s.bodyOf(rev)));
    const unlinked = { ...s.bodyOf(rev), tasks: rev.tasks.map(({ grillSessionId: _g, ...rest }: { grillSessionId?: string }) => rest) };
    expect(rev.contentHash, "the computed v2 hash includes the link").not.toBe(contentHashV2(unlinked));
    expect(rev.contentHash).not.toBe(contentHash(s.bodyOf(rev)));
    expect(d.contentHash).toBe(rev.contentHash);
  });

  it("C3: the same featureId with every optional v2 field omitted still builds v2 with defaults (not a legacy downgrade)", async () => {
    const s = await setup2();
    const f = await s.feature("F");
    const d = ok(await s.draftAny({ featureId: f }));
    const rev = (await s.latestRevision(d.planId)).revisions[0] as any;
    expect(rev.schema).toBe(2);
    expect(rev.tasks).toEqual([{ id: "t1", title: "Build", description: "do", ...DEFAULTS }]);
  });

  it("binding an existing approved legacy plan appends schema 2; earlier revisions, hashes, receipts, approvals and taskStates stay byte-identical", async () => {
    const s = await setup2();
    const d = ok(await s.draftAny());
    ok(await s.approve(d.planId, 1, d.contentHash));
    ok(await s.task(d.planId, 1, d.contentHash, "t1", "in_progress"));
    const before = await s.latestRevision(d.planId);
    const receiptsBefore = await Promise.all((await s.receiptFiles(d.planId)).map(async (n) => [n, await readFile(join(s.receiptDir(d.planId), n), "utf8")]));
    const f = await s.feature("F");
    const out = ok(await s.draftAny({ planId: d.planId, featureId: f, tasks: [{ id: "t1", title: "Build", description: "do", dod: "Done" }] }));
    expect(out.rev).toBe(2);
    const after = await s.latestRevision(d.planId);
    expect(after.featureId).toBe(f);
    expect(JSON.stringify(after.revisions[0])).toBe(JSON.stringify(before.revisions[0]));
    expect(after.approvals).toEqual(before.approvals);
    expect(after.taskStates).toEqual(before.taskStates);
    expect((after.revisions[1] as any).schema).toBe(2);
    const receiptsAfter = await Promise.all((await s.receiptFiles(d.planId)).map(async (n) => [n, await readFile(join(s.receiptDir(d.planId), n), "utf8")]));
    expect(receiptsAfter).toEqual(receiptsBefore);
  });

  it("a bound plan: no featureId or another featureId is invalid_input with no write; the same featureId appends v2, never v1", async () => {
    const s = await setup2();
    const f = await s.feature("F");
    const g = await s.feature("G");
    const d = ok(await s.draftAny({ featureId: f, tasks: V2_TASKS }));
    await s.expectNoWrite(() => s.draftAny({ planId: d.planId }), "invalid_input");
    await s.expectNoWrite(() => s.draftAny({ planId: d.planId, tasks: V2_TASKS }), "invalid_input");
    await s.expectNoWrite(() => s.draftAny({ planId: d.planId, featureId: g, tasks: V2_TASKS }), "invalid_input");
    const legacyShaped = ok(await s.draftAny({ planId: d.planId, featureId: f }));
    expect(legacyShaped.rev).toBe(2);
    const p = await s.latestRevision(d.planId);
    expect(p.featureId).toBe(f);
    expect(p.revisions.map((r: any) => r.schema)).toEqual([2, 2]);
  });

  it("supplied task ids are kept across revisions; generated ids fill only omitted ones", async () => {
    const s = await setup2();
    const f = await s.feature("F");
    const d = ok(await s.draftAny({ featureId: f, tasks: V2_TASKS }));
    ok(await s.draftAny({ planId: d.planId, featureId: f, tasks: [...V2_TASKS, { title: "New", description: "" }] }));
    const ids = (await s.latestRevision(d.planId)).revisions.map((r: any) => r.tasks.map((t: any) => t.id));
    expect(ids[0]).toEqual(["t1", "t2"]);
    expect(ids[1].slice(0, 2)).toEqual(["t1", "t2"]);
    expect(ids[1][2]).toMatch(/.+/);
    expect(ids[1][2]).not.toMatch(/^t[12]$/);
  });

  it("task graph errors are invalid_input with details.issues and no write: unknown dependency, self, duplicate dependency, cycle, duplicate id", async () => {
    const s = await setup2();
    const f = await s.feature("F");
    const cases: Task[][] = [
      [{ id: "t1", title: "A", description: "", dependsOn: ["missing"] }],
      [{ id: "t1", title: "A", description: "", dependsOn: ["t1"] }],
      [{ id: "t1", title: "A", description: "" }, { id: "t2", title: "B", description: "", dependsOn: ["t1", "t1"] }],
      [{ id: "t1", title: "A", description: "", dependsOn: ["t2"] }, { id: "t2", title: "B", description: "", dependsOn: ["t1"] }],
    ];
    for (const tasks of cases) {
      const e = await s.expectNoWrite(() => s.draftAny({ featureId: f, tasks }), "invalid_input");
      expect(Array.isArray(e.details?.issues) && e.details.issues.length > 0, JSON.stringify(tasks)).toBe(true);
    }
    await s.expectNoWrite(() => s.draftAny({ featureId: f, tasks: [{ id: "t1", title: "A", description: "" }, { id: "t1", title: "B", description: "" }] }), "invalid_input");
    // Positive control: a valid graph writes.
    ok(await s.draftAny({ featureId: f, tasks: V2_TASKS }));
  });

  it("a stale expectedRevision is revision_conflict with no write, before any binding or feature check", async () => {
    const s = await setup2();
    const f = await s.feature("F");
    const stale = (await s.revision()) - 1;
    await s.expectNoWrite(() => s.draftAny({ expectedRevision: stale, featureId: f, tasks: V2_TASKS }), "revision_conflict");
    await s.expectNoWrite(() => s.draftAny({ expectedRevision: stale, featureId: "missing", tasks: V2_TASKS }), "revision_conflict");
    await s.expectNoWrite(() => s.draftAny({ expectedRevision: stale, tasks: V2_TASKS }), "revision_conflict");
  });

  it("plan.get returns blockers: the real R2.1 gates for a v2 latest revision, [] for legacy; both parse with the client PlanView", async () => {
    const s = await setup2();
    const legacy = ok(await s.draftAny());
    const lv = ok(await s.get(legacy.planId)) as any;
    expect(lv.blockers).toEqual([]);
    expect(PlanView.safeParse(lv).success).toBe(true);
    const f = await s.feature("F");
    const v2 = ok(await s.draftAny({ featureId: f, tasks: V2_TASKS }));
    const vv = ok(await s.get(v2.planId)) as any;
    const links = await grillLinks(s.open, s.P, v2.planId);
    for (const id of [links.feature, links.plan, links.task("t2")]) expect(typeof id, "R2.2 created link").toBe("string");
    expect(vv.blockers).toEqual([
      { code: "dod_missing", taskId: "t2" },
      { code: "grilling_required", sessionId: links.feature },
      { code: "grilling_required", sessionId: links.plan },
      { code: "grilling_required", taskId: "t2", sessionId: links.task("t2") },
    ]);
    const parsed = PlanView.safeParse(vv);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.plan.featureId).toBe(f);
  });

  it("plan.approve of a drafted v2 revision is plan_ineligible with the plan.get blockers; origin, then revision mismatch, keep precedence; no receipt", async () => {
    const s = await setup2();
    const f = await s.feature("F");
    const d = ok(await s.draftAny({ featureId: f, tasks: V2_TASKS }));
    const view = ok(await s.get(d.planId)) as any;
    const before = await s.snapshot();
    const e = err(await s.approve(d.planId, 1, d.contentHash));
    expect(e.code).toBe("plan_ineligible");
    expect(e.details?.blockers).toEqual(view.blockers);
    expect(err(await s.approve(d.planId, 1, d.contentHash, CHAT)).code).toBe("invalid_input");
    expect(err(await s.approve(d.planId, 2, d.contentHash)).code).toBe("plan_revision_mismatch");
    expect(await s.receiptFiles(d.planId)).toEqual([]);
    expect(await s.snapshot()).toEqual(before);
  });

  it("plan.list carries featureId for bound plans only", async () => {
    const s = await setup2();
    const legacy = ok(await s.draftAny());
    const f = await s.feature("F");
    const bound = ok(await s.draftAny({ featureId: f, tasks: V2_TASKS }));
    const list = ok(await s.plans.list(s.open, { projectId: s.P })) as any;
    const byId = Object.fromEntries(list.plans.map((p: any) => [p.id, p]));
    expect(byId[bound.planId].featureId).toBe(f);
    expect("featureId" in byId[legacy.planId]).toBe(false);
  });
});

// Stage R1.0 compatibility regression: the shipped legacy draft allocates omitted task ids in task
// order first and the new plan id after them, from the same injected generator. A controlled
// sequence pins that order, so a legacy new plan keeps its shipped ids, body and hash.
describe("R1.0 legacy draft id allocation order", () => {
  it("a legacy new plan with omitted task ids: task ids in task order first, then the plan id", async () => {
    const s = await setup();
    const issued: string[] = [];
    const seq = () => {
      const id = `gen${String(issued.length + 1).padStart(2, "0")}`;
      issued.push(id);
      return id;
    };
    const plans = createPlanCommands({
      directory: () => {
        throw new Error("plan commands must use the call's opener");
      },
      now: fixedClock,
      newId: seq,
      storeOptions: { now: fixedClock, newId: nextId },
      approvals: createApprovalStore({ stateDir: s.stateDir, log: () => undefined }),
    });
    const d = ok(
      await plans.draft(
        s.open,
        {
          projectId: s.P, expectedRevision: await s.revision(), title: "Rollout", sessionIds: [s.seed.sessionId], markdown: "# Rollout",
          tasks: [{ title: "A", description: "" }, { id: "t9", title: "B", description: "" }, { title: "C", description: "" }],
        },
        UI_ORIGIN,
      ),
    );
    expect(issued).toEqual(["gen01", "gen02", "gen03"]);
    expect(d.planId).toBe("gen03");
    const plan = await s.latestRevision(d.planId);
    const rev = plan.revisions[0];
    expect(rev.tasks).toEqual([
      { id: "gen01", title: "A", description: "" },
      { id: "t9", title: "B", description: "" },
      { id: "gen02", title: "C", description: "" },
    ]);
    expect("schema" in rev).toBe(false);
    expect("featureId" in plan).toBe(false);
    expect(rev.contentHash).toBe(contentHash({ markdown: rev.markdown, tasks: rev.tasks, basedOn: rev.basedOn, decisionSnapshotHash: rev.decisionSnapshotHash }));
    expect(d.contentHash).toBe(rev.contentHash);
  });
});

// Stage R1.5 (task card §8, owner Q33=1): cancelling a decision in a revision's recorded basedOn makes
// that approval not current; a fresh draft excludes it and needs a new approval. Old revision and
// receipt bytes are never rewritten. Real temp stores, synthetic data through the real commands.
describe("R1.5 a cancelled basis decision makes approval not current", () => {
  const cancel = async (s: Awaited<ReturnType<typeof setup>>, ref: Ref, reason = "Dropped") => {
    const out = await s.project.service.decisionCancel(s.project.paseo, { projectId: s.P, expectedRevision: await s.revision(), ...ref, reason });
    if (!out.ok) throw new Error(`cancel failed: ${out.error.code}`);
    return out.value;
  };
  const key = (ref: Ref) => `${ref.sessionId}/${ref.questionId}`;
  const receiptBytes = async (s: Awaited<ReturnType<typeof setup>>, planId: string) =>
    Promise.all((await s.receiptFiles(planId)).sort().map(async (n) => [n, await readFile(join(s.receiptDir(planId), n), "utf8")]));
  async function approvedLegacy() {
    const s = await setup();
    const d = ok(await s.draft());
    ok(await s.approve(d.planId, 1, d.contentHash));
    return { s, d };
  }
  /** A question in another session, outside the plan's basis. */
  const unrelated = async (s: Awaited<ReturnType<typeof setup>>): Promise<Ref> => {
    const { service, paseo } = s.project;
    const sessionId = ok(await service.sessionCreate(paseo, { projectId: s.P, expectedRevision: await s.revision(), title: "Other" })).sessionId;
    const questionId = ok(
      await service.questionCreate(paseo, { projectId: s.P, expectedRevision: await s.revision(), sessionId, title: "Elsewhere", context: "", options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [] }),
    ).questionId;
    return { sessionId, questionId };
  };

  it("plan.get and plan.list report not_current with '<ref> was cancelled'; approve and task start are plan_not_current with no write", async () => {
    const { s, d } = await approvedLegacy();
    const receipts = await receiptBytes(s, d.planId);
    const rev1 = JSON.stringify((await s.latestRevision(d.planId)).revisions[0]);
    await cancel(s, s.seed.q2);
    const view = ok(await s.get(d.planId));
    expect(view.approval).toBe("not_current");
    expect(view.notCurrentReasons).toContain(`${key(s.seed.q2)} was cancelled`);
    const list = ok(await s.plans.list(s.open, { projectId: s.P }));
    expect(list.plans.find((p) => p.id === d.planId)?.approval).toBe("not_current");
    const before = await s.revision();
    expect(err(await s.approve(d.planId, 1, d.contentHash)).code).toBe("plan_not_current");
    expect(err(await s.task(d.planId, 1, d.contentHash, "t1", "in_progress")).code).toBe("plan_not_current");
    expect(await s.revision()).toBe(before);
    expect(await receiptBytes(s, d.planId)).toEqual(receipts);
    expect(JSON.stringify((await s.latestRevision(d.planId)).revisions[0])).toBe(rev1);
  });

  it("a fresh draft excludes the cancelled ref, is eligible and approves with a new receipt; old bytes stay; the old rev is plan_revision_mismatch", async () => {
    const { s, d } = await approvedLegacy();
    const receipts = await receiptBytes(s, d.planId);
    const rev1 = (await s.latestRevision(d.planId)).revisions[0];
    const rev1Json = JSON.stringify(rev1);
    await cancel(s, s.seed.q2);
    const next = ok(await s.draft({ planId: d.planId }));
    expect(next.rev).toBe(2);
    const rev2 = (await s.latestRevision(d.planId)).revisions[1];
    expect(rev2.basedOn.map((b) => key(b))).not.toContain(key(s.seed.q2));
    expect(rev2.basedOn.map((b) => key(b))).toContain(key(s.seed.q1));
    expect(rev2.decisionSnapshotHash).not.toBe(rev1.decisionSnapshotHash);
    ok(await s.approve(d.planId, 2, next.contentHash));
    expect(ok(await s.get(d.planId)).approval).toBe("current");
    const after = await receiptBytes(s, d.planId);
    expect(after.length).toBe(receipts.length + 1);
    for (const entry of receipts) expect(after).toContainEqual(entry);
    expect(JSON.stringify((await s.latestRevision(d.planId)).revisions[0])).toBe(rev1Json);
    expect(err(await s.approve(d.planId, 1, d.contentHash)).code).toBe("plan_revision_mismatch");
    // The old revision's non-currency, checked purely (currency covers only the latest).
    const read = await (await s.open(s.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    expect(basisCurrent(read.data.sessions, [s.seed.sessionId], rev1, cancelledRefs(read.data)).reasons).toContain(`${key(s.seed.q2)} was cancelled`);
  });

  it("control: a cancellation outside basedOn keeps plan.get current and every byte unchanged", async () => {
    const { s, d } = await approvedLegacy();
    const receipts = await receiptBytes(s, d.planId);
    const rev1 = JSON.stringify((await s.latestRevision(d.planId)).revisions[0]);
    await cancel(s, await unrelated(s));
    expect(ok(await s.get(d.planId))).toMatchObject({ approval: "current", notCurrentReasons: [] });
    expect(await receiptBytes(s, d.planId)).toEqual(receipts);
    expect(JSON.stringify((await s.latestRevision(d.planId)).revisions[0])).toBe(rev1);
  });

  it("control: with an unanswered remaining active question the new draft is still plan_ineligible", async () => {
    const { s, d } = await approvedLegacy();
    ok(
      await s.project.service.questionCreate(s.project.paseo, {
        projectId: s.P, expectedRevision: await s.revision(), sessionId: s.seed.sessionId, title: "Open one", context: "",
        options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [],
      }),
    );
    await cancel(s, s.seed.q2);
    expect(err(await s.draft({ planId: d.planId })).code).toBe("plan_ineligible");
  });

  it("v2: approve stays plan_ineligible with the R2.1 gates first; the cancellation reason is shown by basisCurrent (A1 as accepted)", async () => {
    const s = await setup();
    const { createFeatureCommands } = await import("./features");
    const features = createFeatureCommands({ directory: () => { throw new Error("unused"); }, now: fixedClock, newId: () => "feat1", storeOptions: { now: fixedClock, newId: nextId } });
    const featureId = ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "F", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
    const d = ok(
      await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "V2", sessionIds: [s.seed.sessionId], markdown: "# V2", tasks: [{ id: "t1", title: "T", description: "" }], featureId }, UI_ORIGIN),
    );
    await cancel(s, s.seed.q1);
    const e = err(await s.approve(d.planId, 1, d.contentHash));
    expect(e.code).toBe("plan_ineligible");
    const links = await grillLinks(s.open, s.P, d.planId);
    for (const id of [links.feature, links.plan]) expect(typeof id, "R2.2 created link").toBe("string");
    expect(e.details?.blockers).toEqual([
      { code: "dod_missing", taskId: "t1" },
      { code: "grilling_required", sessionId: links.feature },
      { code: "grilling_required", sessionId: links.plan },
    ]);
    // A1 (accepted): no receipt, so plan.get stays unapproved with no reasons.
    expect(ok(await s.get(d.planId))).toMatchObject({ approval: "unapproved", notCurrentReasons: [] });
    const read = await (await s.open(s.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    const latest = read.data.plans.find((p) => p.id === d.planId)!.revisions.at(-1)!;
    expect(basisCurrent(read.data.sessions, [s.seed.sessionId], latest, cancelledRefs(read.data)).reasons).toContain(`${key(s.seed.q1)} was cancelled`);
  });

  it("raw v1 fixture (read-only copy, no reseal): no cancellations, and currency is identical with and without the context", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "dr-r15-fixture-")));
    try {
      await cp(fileURLToPath(new URL("./fixtures/v1-store/", import.meta.url)), join(parent, ".decisions"), { recursive: true });
      const store = openStore({ storeRoot: parent, projectId: "prj_2d93f94da090e78c" });
      const read = await store.read();
      if (read.status !== "ok") throw new Error(`fixture store ${read.status}`);
      const cancelled = cancelledRefs(read.data);
      expect(cancelled.size).toBe(0);
      for (const plan of read.data.plans) {
        for (const rev of plan.revisions) {
          expect(basisCurrent(read.data.sessions, plan.sessionIds, rev, cancelled)).toEqual(basisCurrent(read.data.sessions, plan.sessionIds, rev));
        }
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

// Stage R2.1 (task card 2026-10-29 §2.3, §2.4, §6 G4): plan.get and plan.approve share the real
// gates. No producer of grilling links exists in R2.1, so "every gate satisfied" writes
// feature.grillSessionId and plan.grillSessionId into a real store with store.transact (as the
// shipped withV2Revision fixture does), pointing at the fully answered seed session. Approval of a
// bound schema 2 revision moves a created feature to planned once, inside the receipt copy transaction.
describe("R2.1 approval gates end to end", () => {
  const DOD = "- [check] npm test";
  async function gated(kind: "feature" | "bug" = "feature") {
    const s = await setup();
    const { createFeatureCommands } = await import("./features");
    const features = createFeatureCommands({ directory: () => { throw new Error("unused"); }, now: fixedClock, newId: () => "feat1", storeOptions: { now: fixedClock, newId: nextId } });
    const featureId = ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "F", description: "", kind }, UI_ORIGIN)).featureId;
    const d = ok(
      await s.plans.draft(
        s.open,
        { projectId: s.P, expectedRevision: await s.revision(), title: "Gated", sessionIds: [s.seed.sessionId], markdown: "# Gated", tasks: [{ id: "t1", title: "Build", description: "do", dod: DOD }], featureId },
        UI_ORIGIN,
      ),
    );
    const data = async () => {
      const read = await (await s.open(s.P)).read();
      if (read.status !== "ok") throw new Error("store not ok");
      return read.data;
    };
    const featureRecord = async () => (await data()).features.find((f) => f.id === featureId)!;
    const statusEvents = async () => (await featureRecord()).events.filter((e) => e.kind === "status");
    /** Seeds the R2.1 links (and optionally a deferred feature) directly; fails loudly if the store rejects them. */
    const link = async (links: { feature?: string; plan?: string; deferred?: boolean }) => {
      try {
        await (await s.open(s.P)).transact(await s.revision(), (draft) => {
          const f = draft.features.find((x) => x.id === featureId)!;
          const p = draft.plans.find((x) => x.id === d.planId)!;
          if (links.feature !== undefined) f.grillSessionId = links.feature;
          if (links.plan !== undefined) p.grillSessionId = links.plan;
          if (links.deferred) {
            f.status = "deferred";
            f.statusBeforeDefer = "created";
          }
        });
      } catch (e) {
        throw new Error(`seeding R2.1 grilling links was rejected by the store: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const snapshot = async () => ({ revision: await s.revision(), data: JSON.stringify(await data()) });
    return { ...s, features, featureId, d, data, featureRecord, statusEvents, link, snapshot };
  }
  /** The real opener, but every transact on the opened store fails with revision_conflict. */
  const conflicting = (real: StoreOpener) => {
    const attempts = { transact: 0 };
    const open: StoreOpener = async (projectId) => {
      const store = await real(projectId);
      return new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === "transact") {
            return () => {
              attempts.transact++;
              return Promise.reject(new DomainError("revision_conflict", "injected conflict", { expected: 0, actual: 1 }));
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    };
    return { open, attempts };
  };
  const PLANNED = { kind: "status", from: "created", to: "planned", reason: "plan approved" };

  it("auto-linked empty sessions: plan.get and plan.approve report the same feature and plan grilling blockers; nothing is written", async () => {
    const s = await gated();
    const view = ok(await s.get(s.d.planId));
    const links = await grillLinks(s.open, s.P, s.d.planId);
    for (const id of [links.feature, links.plan]) expect(typeof id, "R2.2 created link").toBe("string");
    expect(view.blockers).toEqual([{ code: "grilling_required", sessionId: links.feature }, { code: "grilling_required", sessionId: links.plan }]);
    const before = await s.snapshot();
    const e = err(await s.approve(s.d.planId, 1, s.d.contentHash));
    expect(e.code).toBe("plan_ineligible");
    expect(e.details?.blockers).toEqual(view.blockers);
    expect(await s.approvals.read(s.P, s.d.planId, 1)).toBeNull();
    expect(await s.receiptFiles(s.d.planId)).toEqual([]);
    expect(await s.snapshot()).toEqual(before);
    expect((await s.featureRecord()).status).toBe("created");
  });

  it("every gate satisfied: plan.get has no blockers; approve writes a receipt and moves the feature created → planned with one status event", async () => {
    const s = await gated();
    await s.link({ feature: s.seed.sessionId, plan: s.seed.sessionId });
    expect(ok(await s.get(s.d.planId)).blockers).toEqual([]);
    const a = ok(await s.approve(s.d.planId, 1, s.d.contentHash));
    expect(a).toMatchObject({ alreadyApproved: false, copyRecorded: true });
    expect(await s.approvals.read(s.P, s.d.planId, 1)).not.toBeNull();
    expect(await s.receiptFiles(s.d.planId)).toEqual(["1.json"]);
    const f = await s.featureRecord();
    expect(f.status).toBe("planned");
    const events = await s.statusEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(PLANNED);
    expect((await s.latestRevision(s.d.planId)).approvals.map((r) => r.planRev)).toEqual([1]);
    expect(ok(await s.get(s.d.planId)).approval).toBe("current");
  });

  it("a same-revision retry is alreadyApproved and adds no second status event or receipt", async () => {
    const s = await gated();
    await s.link({ feature: s.seed.sessionId, plan: s.seed.sessionId });
    ok(await s.approve(s.d.planId, 1, s.d.contentHash));
    const again = ok(await s.approve(s.d.planId, 1, s.d.contentHash));
    expect(again.alreadyApproved).toBe(true);
    expect((await s.featureRecord()).status).toBe("planned");
    expect(await s.statusEvents()).toHaveLength(1);
    expect(await s.receiptFiles(s.d.planId)).toEqual(["1.json"]);
  });

  it("a deferred feature stays deferred on approval (no status event)", async () => {
    const s = await gated();
    await s.link({ feature: s.seed.sessionId, plan: s.seed.sessionId, deferred: true });
    const eventsBefore = (await s.featureRecord()).events.length;
    const a = ok(await s.approve(s.d.planId, 1, s.d.contentHash));
    expect(a.alreadyApproved).toBe(false);
    expect(await s.receiptFiles(s.d.planId)).toEqual(["1.json"]);
    const f = await s.featureRecord();
    expect(f.status).toBe("deferred");
    expect(f.statusBeforeDefer).toBe("created");
    expect(f.events).toHaveLength(eventsBefore);
  });

  it("a bug feature needs no feature grilling session: a plan link alone approves and plans it", async () => {
    const s = await gated("bug");
    const links = await grillLinks(s.open, s.P, s.d.planId);
    expect(links.feature, "R2.2: a bug gets no feature session").toBeUndefined();
    expect(typeof links.plan, "R2.2 created plan link").toBe("string");
    expect(ok(await s.get(s.d.planId)).blockers, "control: the plan gate still applies").toEqual([{ code: "grilling_required", sessionId: links.plan }]);
    await s.link({ plan: s.seed.sessionId });
    expect(ok(await s.get(s.d.planId)).blockers).toEqual([]);
    ok(await s.approve(s.d.planId, 1, s.d.contentHash));
    expect((await s.featureRecord()).status).toBe("planned");
    expect(await s.statusEvents()).toHaveLength(1);
  });

  it("when every copy attempt conflicts the receipt stays durable and the feature unchanged; the next same-revision approve records both", async () => {
    const s = await gated();
    await s.link({ feature: s.seed.sessionId, plan: s.seed.sessionId });
    const conflict = conflicting(s.open);
    const first = ok(await s.plans.approve(conflict.open, { projectId: s.P, planId: s.d.planId, rev: 1, contentHash: s.d.contentHash }, UI_ORIGIN));
    expect(first).toMatchObject({ alreadyApproved: false, copyRecorded: false, revision: null });
    expect(conflict.attempts.transact).toBe(3);
    expect(await s.receiptFiles(s.d.planId)).toEqual(["1.json"]);
    expect((await s.featureRecord()).status, "no copy commit, so no status write").toBe("created");
    expect(await s.statusEvents()).toEqual([]);
    const retry = ok(await s.approve(s.d.planId, 1, s.d.contentHash));
    expect(retry).toMatchObject({ alreadyApproved: true, copyRecorded: true });
    expect(await s.receiptFiles(s.d.planId)).toEqual(["1.json"]);
    expect((await s.featureRecord()).status).toBe("planned");
    const events = await s.statusEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(PLANNED);
  });

  it("race: a rev 2 draft committed between the rev 1 receipt and its copy keeps the rev 1 receipt and copy, leaves rev 2 unapproved and the feature created", async () => {
    const s = await gated();
    await s.link({ feature: s.seed.sessionId, plan: s.seed.sessionId });
    expect(ok(await s.get(s.d.planId)).blockers, "rev 1 has every gate satisfied").toEqual([]);
    const real = createApprovalStore({ stateDir: s.stateDir, log: () => undefined });
    const hook = { writes: 0, rev2: "" };
    const approvals: ApprovalStore = {
      read: (projectId, planId, rev) => real.read(projectId, planId, rev),
      async write(r) {
        const out = await real.write(r);
        hook.writes++;
        // Another client drafts rev 2 after the durable receipt and before the cosmetic copy transaction,
        // with rev 1's exact content: only the new revision identity differs.
        const d2 = ok(
          await s.plans.draft(
            s.open,
            { projectId: s.P, expectedRevision: await s.revision(), planId: s.d.planId, featureId: s.featureId, title: "Gated", sessionIds: [s.seed.sessionId], markdown: "# Gated", tasks: [{ id: "t1", title: "Build", description: "do", dod: DOD }] },
            UI_ORIGIN,
          ),
        );
        hook.rev2 = d2.contentHash;
        return out;
      },
    };
    const racing = createPlanCommands({
      directory: () => {
        throw new Error("plan commands must use the call's opener");
      },
      now: fixedClock,
      newId: nextId,
      storeOptions: { now: fixedClock, newId: nextId },
      approvals,
    });
    const a = ok(await racing.approve(s.open, { projectId: s.P, planId: s.d.planId, rev: 1, contentHash: s.d.contentHash }, UI_ORIGIN));
    expect(hook.writes, "the receipt hook ran once").toBe(1);
    expect(a).toMatchObject({ alreadyApproved: false, copyRecorded: true });
    // The historical rev 1 receipt and its copy are retained.
    expect(await s.approvals.read(s.P, s.d.planId, 1)).toMatchObject({ planRev: 1, contentHash: s.d.contentHash });
    expect(await s.receiptFiles(s.d.planId)).toEqual(["1.json"]);
    const plan = await s.latestRevision(s.d.planId);
    expect(plan.revisions.map((r) => r.rev)).toEqual([1, 2]);
    const [rev1, rev2] = plan.revisions;
    expect(hook.rev2, "precondition: rev 2 has rev 1's content hash").toBe(s.d.contentHash);
    expect(rev2?.contentHash).toBe(rev1?.contentHash);
    expect(rev2?.decisionSnapshotHash, "precondition: same decision snapshot").toBe(rev1?.decisionSnapshotHash);
    expect(plan.approvals.map((r) => r.planRev)).toEqual([1]);
    // The latest rev 2 is unapproved, so the feature stays created with no status event.
    const view = ok(await s.get(s.d.planId));
    expect(view.approval).toBe("unapproved");
    expect(view.approvals.map((x) => x.receipt.planRev)).toEqual([1]);
    expect((await s.featureRecord()).status).toBe("created");
    expect(await s.statusEvents()).toEqual([]);
    // Control: approving the latest rev 2 without interleaving plans the feature once.
    expect(view.blockers).toEqual([]);
    const a2 = ok(await s.approve(s.d.planId, 2, hook.rev2));
    expect(a2).toMatchObject({ alreadyApproved: false, copyRecorded: true });
    expect((await s.featureRecord()).status).toBe("planned");
    const events = await s.statusEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(PLANNED);
  });

  // R2 corrective c0015 (task card 2026-10-29 §8.4, §8.7): when every copy attempt conflicts, the
  // durable receipt makes the approval current while the copy and the feature transition are
  // missing; plan.get derives approvalEffectsPending, and a same-revision UI retry completes them.
  const copyFailedApproval = async (s: Awaited<ReturnType<typeof gated>>) => {
    const conflict = conflicting(s.open);
    const a = ok(await s.plans.approve(conflict.open, { projectId: s.P, planId: s.d.planId, rev: 1, contentHash: s.d.contentHash }, UI_ORIGIN));
    expect(conflict.attempts.transact, "all three copy attempts ran").toBe(3);
    expect(a).toMatchObject({ alreadyApproved: false, copyRecorded: false, revision: null });
    expect(await s.receiptFiles(s.d.planId), "precondition: the receipt is durable").toEqual(["1.json"]);
    expect(await s.approvals.read(s.P, s.d.planId, 1)).toMatchObject({ receiptId: a.receiptId, planRev: 1 });
    return a;
  };
  const COPY = (receiptId: string) => ({ effect: "project_copy", reason: `the project copy of approval ${receiptId} is not recorded` });
  const PLANNED_EFFECT = { effect: "feature_planned", reason: "the feature is still created" };

  it("c0015: a copy failure leaves approval current with pending project_copy and feature_planned; a same-revision UI retry completes both once", async () => {
    const s = await gated();
    await s.link({ feature: s.seed.sessionId, plan: s.seed.sessionId });
    const a = await copyFailedApproval(s);
    const view = ok(await s.get(s.d.planId));
    expect(view.approval).toBe("current");
    expect((await s.featureRecord()).status).toBe("created");
    expect(view.approvalEffectsPending).toEqual([COPY(a.receiptId), PLANNED_EFFECT]);
    const retry = ok(await s.approve(s.d.planId, 1, s.d.contentHash));
    expect(retry).toMatchObject({ alreadyApproved: true, copyRecorded: true, receiptId: a.receiptId });
    expect(await s.receiptFiles(s.d.planId)).toEqual(["1.json"]);
    expect((await s.featureRecord()).status).toBe("planned");
    const events = await s.statusEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(PLANNED);
    const after = ok(await s.get(s.d.planId));
    expect("approvalEffectsPending" in after, "nothing pending after the retry").toBe(false);
    expect(after.approval).toBe("current");
  });

  it("c0015: a deferred feature reports only the pending project copy", async () => {
    const s = await gated();
    await s.link({ feature: s.seed.sessionId, plan: s.seed.sessionId, deferred: true });
    const a = await copyFailedApproval(s);
    expect(ok(await s.get(s.d.planId)).approvalEffectsPending).toEqual([COPY(a.receiptId)]);
    expect((await s.featureRecord()).status).toBe("deferred");
  });

  it("c0015: new blockers after the receipt keep the pending effects visible (the UI shows no retry control)", async () => {
    const s = await gated();
    await s.link({ feature: s.seed.sessionId, plan: s.seed.sessionId });
    const a = await copyFailedApproval(s);
    await (await s.open(s.P)).transact(await s.revision(), (draftData) => {
      draftData.sessions.push({ id: "empty-grill", title: "[plan] Gated again", createdAt: NOW_ISO, status: "active", questions: [] });
      draftData.plans.find((p) => p.id === s.d.planId)!.grillSessionId = "empty-grill";
    });
    const view = ok(await s.get(s.d.planId));
    expect(view.blockers).toEqual([{ code: "grilling_required", sessionId: "empty-grill" }]);
    expect(view.approval).toBe("current");
    expect(view.approvalEffectsPending).toEqual([COPY(a.receiptId), PLANNED_EFFECT]);
  });

  it("c0015: nothing is pending for a newer unapproved latest revision", async () => {
    const s = await gated();
    await s.link({ feature: s.seed.sessionId, plan: s.seed.sessionId });
    await copyFailedApproval(s);
    ok(await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), planId: s.d.planId, featureId: s.featureId, title: "Gated", sessionIds: [s.seed.sessionId], markdown: "# Gated v2", tasks: [{ id: "t1", title: "Build", description: "do", dod: DOD }] }, UI_ORIGIN));
    const view = ok(await s.get(s.d.planId));
    expect(view.approval).toBe("unapproved");
    expect("approvalEffectsPending" in view).toBe(false);
  });

  it("c0015: nothing is pending for a current approval without a copy failure", async () => {
    const clean = await gated();
    await clean.link({ feature: clean.seed.sessionId, plan: clean.seed.sessionId });
    ok(await clean.approve(clean.d.planId, 1, clean.d.contentHash));
    const cleanView = ok(await clean.get(clean.d.planId));
    expect(cleanView.approval).toBe("current");
    expect("approvalEffectsPending" in cleanView, "current without pending effects").toBe(false);
  });

  it("c0015: with duplicate bound plans every pending entry carries retryBlocked, no feature_planned is reported, and the retry is refused", async () => {
    const s = await gated();
    await s.link({ feature: s.seed.sessionId, plan: s.seed.sessionId });
    await copyFailedApproval(s);
    await (await s.open(s.P)).transact(await s.revision(), (draftData) => {
      const original = draftData.plans.find((p) => p.id === s.d.planId)!;
      draftData.plans.push({ ...structuredClone(original), id: "dup-plan", title: "Duplicate", approvals: [], taskStates: [] });
    });
    const pending = ok(await s.get(s.d.planId)).approvalEffectsPending ?? [];
    expect(pending.map((e) => e.effect)).toEqual(["project_copy"]);
    for (const e of pending) {
      expect(e.retryBlocked).toBe("feature_has_multiple_plans");
      expect(typeof e.reason).toBe("string");
    }
    const before = await s.snapshot();
    const e = err(await s.approve(s.d.planId, 1, s.d.contentHash));
    expect(e.code).toBe("invalid_input");
    expect(e.details).toMatchObject({ reason: "feature_has_multiple_plans", featureId: s.featureId });
    expect(await s.snapshot()).toEqual(before);
    expect((await s.featureRecord()).status).toBe("created");
  });

  it("precedence: origin, then revision, then blockers, then content hash, then basis currency; failures write nothing", async () => {
    const s = await gated();
    const before = await s.snapshot();
    expect(err(await s.approve(s.d.planId, 1, s.d.contentHash, CHAT)).code).toBe("invalid_input");
    expect(err(await s.approve(s.d.planId, 2, s.d.contentHash)).code, "revision before blockers").toBe("plan_revision_mismatch");
    const blocked = err(await s.approve(s.d.planId, 1, "f".repeat(64)));
    expect(blocked.code, "blockers before content hash").toBe("plan_ineligible");
    const links = await grillLinks(s.open, s.P, s.d.planId);
    for (const id of [links.feature, links.plan]) expect(typeof id, "R2.2 created link").toBe("string");
    expect(blocked.details?.blockers).toEqual([{ code: "grilling_required", sessionId: links.feature }, { code: "grilling_required", sessionId: links.plan }]);
    expect(await s.snapshot()).toEqual(before);
    await s.link({ feature: s.seed.sessionId, plan: s.seed.sessionId });
    expect(err(await s.approve(s.d.planId, 1, "f".repeat(64))).code, "gates clear: the content hash is checked").toBe("plan_revision_mismatch");
    const out = await s.project.service.decisionCancel(s.project.paseo, { projectId: s.P, expectedRevision: await s.revision(), ...s.seed.q1, reason: "Dropped" });
    if (!out.ok) throw new Error(`cancel failed: ${out.error.code}`);
    expect(ok(await s.get(s.d.planId)).blockers, "the grilling session keeps one valid non-cancelled question").toEqual([]);
    const linked = await s.snapshot();
    const e = err(await s.approve(s.d.planId, 1, s.d.contentHash));
    expect(e.code, "basis cancellation after the blockers clear").toBe("plan_not_current");
    expect(e.details?.reasons).toContain(`${s.seed.q1.sessionId}/${s.seed.q1.questionId} was cancelled`);
    expect(await s.snapshot()).toEqual(linked);
    expect(await s.approvals.read(s.P, s.d.planId, 1)).toBeNull();
    expect(await s.receiptFiles(s.d.planId)).toEqual([]);
    expect((await s.featureRecord()).status).toBe("created");
  });
});

// Stage R3.1 (task card 2026-10-29 R3 §2.2, §2.3): plan guards against an execution run, in the
// shared producers (RPC and MCP inherit them). Runs are written directly to the store here; the run
// commands themselves are tested in server/runs.test.ts.
describe("R3.1 plan guards against execution runs", () => {
  async function boundApproved() {
    const s = await setup();
    const { createFeatureCommands } = await import("./features");
    const features = createFeatureCommands({ directory: () => { throw new Error("unused"); }, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } });
    const featureId = ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Search", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
    const tasks = [{ id: "t1", title: "Build", description: "do", dod: "- [check] npm test" }];
    const drafted = async (planId?: string, markdown = "# Rollout") =>
      ok(await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), ...(planId ? { planId } : {}), featureId, title: "Rollout", sessionIds: [s.seed.sessionId], markdown, tasks }, UI_ORIGIN));
    const d = await drafted();
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      draft.features.find((f) => f.id === featureId)!.grillSessionId = s.seed.sessionId;
      draft.plans.find((p) => p.id === d.planId)!.grillSessionId = s.seed.sessionId;
    });
    ok(await s.approve(d.planId, 1, d.contentHash));
    const seedRun = async (state: "running" | "paused" | "ended", planRev = 1) =>
      (await s.open(s.P)).transact(await s.revision(), (draft) => {
        draft.runs.push({
          id: `run-${state}-${planRev}`, featureId, planId: d.planId, planRev, runToken: "tok", state,
          ...(state === "paused" ? { pauseReason: "owner" } : {}), ...(state === "ended" ? { endReason: "finished" } : {}),
          startAuth: { kind: "ui", at: NOW_ISO }, tasks: [], acks: [], events: [{ at: NOW_ISO, kind: "started" }], lateEvidence: [],
        });
      });
    const snapshot = async () => {
      const read = await (await s.open(s.P)).read();
      if (read.status !== "ok") throw new Error("store not ok");
      return { revision: await s.revision(), data: JSON.stringify(read.data) };
    };
    return { ...s, featureId, d, drafted, seedRun, snapshot };
  }

  it("a draft of a bound plan whose feature has a running or paused run is plan_not_current with no write; an ended run does not block", async () => {
    for (const state of ["running", "paused"] as const) {
      const s = await boundApproved();
      await s.seedRun(state);
      const before = await s.snapshot();
      const e = err(await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), planId: s.d.planId, featureId: s.featureId, title: "Rollout", sessionIds: [s.seed.sessionId], markdown: "# Again", tasks: [{ id: "t1", title: "Build", description: "do", dod: "x" }] }, UI_ORIGIN));
      expect(e.code, state).toBe("plan_not_current");
      expect(e.message).toContain("revision is executing; stop and send for rework");
      expect(await s.snapshot()).toEqual(before);
      await t?.cleanup();
      t = undefined;
    }
    const s = await boundApproved();
    await s.seedRun("ended");
    expect((await s.drafted(s.d.planId, "# After the run")).rev).toBe(2);
  });

  it("task.update to verified is task_transition exactly when a run exists for the addressed (planId, planRev), in any state", async () => {
    for (const state of ["running", "paused", "ended"] as const) {
      const s = await boundApproved();
      ok(await s.task(s.d.planId, 1, s.d.contentHash, "t1", "in_progress"));
      ok(await s.task(s.d.planId, 1, s.d.contentHash, "t1", "done"));
      await s.seedRun(state);
      const before = await s.snapshot();
      const e = err(await s.task(s.d.planId, 1, s.d.contentHash, "t1", "verified", { note: "checked" }));
      expect(e.code, state).toBe("task_transition");
      expect(await s.snapshot()).toEqual(before);
      await t?.cleanup();
      t = undefined;
    }
  });

  it("controls: a run-less later revision of the same plan and a legacy plan keep the shipped UI verification", async () => {
    const s = await boundApproved();
    await s.seedRun("ended", 1);
    const d2 = await s.drafted(s.d.planId, "# Rev 2");
    ok(await s.approve(s.d.planId, 2, d2.contentHash));
    ok(await s.task(s.d.planId, 2, d2.contentHash, "t1", "in_progress"));
    ok(await s.task(s.d.planId, 2, d2.contentHash, "t1", "done"));
    ok(await s.task(s.d.planId, 2, d2.contentHash, "t1", "verified", { note: "checked" }));
    const legacy = ok(await s.draft({ tasks: [{ id: "l1", title: "L", description: "" }] }));
    ok(await s.approve(legacy.planId, 1, legacy.contentHash));
    ok(await s.task(legacy.planId, 1, legacy.contentHash, "l1", "in_progress"));
    ok(await s.task(legacy.planId, 1, legacy.contentHash, "l1", "done"));
    ok(await s.task(legacy.planId, 1, legacy.contentHash, "l1", "verified", { note: "checked" }));
  });
});
