// Stage R2.3 (task card 2026-10-29 §1.1, §4.2, §4.3): plan.rework sends an approved latest bound
// revision back for rework in one transaction. It records the rework, cancels the revision's
// unverified task set (verified states stay byte-exact as completion records), and moves the
// feature to created with reason "plan in rework". Old revisions, hashes and receipts are untouched.
// A superseded latest revision is not_current everywhere currency is read. The verified states of
// superseded revisions become read-only reuse candidates. Real temp stores, synthetic data through
// the real commands. `plan.rework` is new in R2.3, so the command is checked before it is called.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApprovalStore, type ApprovalStore } from "./approvals";
import { buildPlanTools } from "./plan-tools";
import { createPlanCommands } from "./plans";
import { UI_ORIGIN, type WriteOrigin } from "./sessions";
import { fixedClock, NOW_ISO, nextId } from "./test-support/build";
import { makePlanProject, type PlanProject } from "./test-support/plans";

const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent" }, quoted: "rework it" };
const REASON = "Scope changed";
const SENT = (rev: number) => `revision ${rev} was sent for rework`;

let t: PlanProject | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

type R<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: unknown } };
function ok<T>(r: R<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}
function err<T>(r: R<T>) {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`);
  return r.error;
}

const TASKS = [
  { id: "t1", title: "Build", description: "do", dod: "- [check] npm test" },
  { id: "t2", title: "Ship", description: "", dod: "Shipped" },
  { id: "t3", title: "Docs", description: "", dod: "Written" },
];

/**
 * A bound plan whose rev 1 is approved with every gate satisfied (the feature and plan grilling
 * links point at the fully answered seed session) and whose feature is planned. Task states:
 * t1 verified with a note, t2 in_progress, t3 none (todo).
 */
async function approvedBound(opts: { kind?: "feature" | "bug" } = {}) {
  t = await makePlanProject();
  const s = t;
  const seed = await s.seedAnswered();
  const { createFeatureCommands } = await import("./features");
  const features = createFeatureCommands({
    directory: () => {
      throw new Error("unused");
    },
    now: fixedClock,
    newId: nextId,
    storeOptions: { now: fixedClock, newId: nextId },
  });
  const featureId = ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Search", description: "", kind: opts.kind ?? "feature" }, UI_ORIGIN)).featureId;
  const data = async () => {
    const read = await (await s.open(s.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data;
  };
  const draft = async (tasks = TASKS) =>
    ok(await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), planId, featureId, title: "Rollout", sessionIds: [seed.sessionId], markdown: "# Rollout", tasks }, UI_ORIGIN));
  let planId: string | undefined;
  const d1 = await draft();
  planId = d1.planId;
  await (await s.open(s.P)).transact(await s.revision(), (draftData) => {
    draftData.features.find((f) => f.id === featureId)!.grillSessionId = seed.sessionId;
    draftData.plans.find((p) => p.id === d1.planId)!.grillSessionId = seed.sessionId;
  });
  ok(await s.plans.approve(s.open, { projectId: s.P, planId: d1.planId, rev: 1, contentHash: d1.contentHash }, UI_ORIGIN));
  const task = async (rev: number, hash: string, taskId: string, status: "todo" | "in_progress" | "done" | "verified", note?: string) =>
    s.plans.taskUpdate(
      s.open,
      { projectId: s.P, expectedRevision: await s.revision(), planId: d1.planId, planRev: rev, contentHash: hash, taskId, status, ...(note !== undefined ? { note } : {}) },
      UI_ORIGIN,
    );
  ok(await task(1, d1.contentHash, "t1", "in_progress"));
  ok(await task(1, d1.contentHash, "t1", "done"));
  ok(await task(1, d1.contentHash, "t1", "verified", "Checked by hand"));
  ok(await task(1, d1.contentHash, "t2", "in_progress"));
  const plan = async () => (await data()).plans.find((p) => p.id === d1.planId)!;
  const feature = async () => (await data()).features.find((f) => f.id === featureId)!;
  const statusEvents = async () => (await feature()).events.filter((e) => e.kind === "status");
  const receiptDir = join(s.stateDir, "approvals", s.P, d1.planId);
  const receiptBytes = async () =>
    Promise.all(
      (await readdir(receiptDir).catch(() => [] as string[]))
        .filter((n) => n.endsWith(".json") && !n.startsWith("."))
        .sort()
        .map(async (n) => [n, await readFile(join(receiptDir, n), "utf8")]),
    );
  const snapshot = async () => ({ revision: await s.revision(), data: JSON.stringify(await data()), receipts: await receiptBytes() });
  const rework = async (x: { planRev?: number; reason?: string; origin?: WriteOrigin; expectedRevision?: number; planId?: string } = {}) => {
    expect(typeof s.plans.rework, "plan commands expose rework (R2.3)").toBe("function");
    return s.plans.rework(
      s.open,
      { projectId: s.P, expectedRevision: x.expectedRevision ?? (await s.revision()), planId: x.planId ?? d1.planId, planRev: x.planRev ?? 1, reason: x.reason ?? REASON },
      x.origin ?? UI_ORIGIN,
    );
  };
  const get = async () => ok(await s.plans.get(s.open, { projectId: s.P, planId: d1.planId }));
  /** Sets the feature status directly (only for refusal scenarios). */
  const forceFeature = async (status: "created" | "planned" | "executing" | "done" | "deferred" | "cancelled") => {
    await (await s.open(s.P)).transact(await s.revision(), (draftData) => {
      const f = draftData.features.find((x) => x.id === featureId)!;
      f.status = status;
      if (status === "deferred") f.statusBeforeDefer = "planned";
      else delete f.statusBeforeDefer;
    });
  };
  return { ...s, seed, features, featureId, d1, data, draft, plan, feature, statusEvents, receiptBytes, snapshot, rework, get, task, forceFeature };
}

describe("R2.3 plan.rework of an approved latest bound revision", () => {
  it("records the rework, cancels the unverified task set, keeps verified states byte-exact, moves the feature to created; old revisions, hashes and receipts unchanged", async () => {
    const s = await approvedBound();
    const before = await s.plan();
    expect((await s.feature()).status, "precondition: approval planned the feature").toBe("planned");
    const t1Before = JSON.stringify(before.taskStates.find((x) => x.taskId === "t1" && x.planRev === 1));
    expect(JSON.parse(t1Before)).toMatchObject({ status: "verified", verification: { note: "Checked by hand" } });
    const revisionsBefore = JSON.stringify(before.revisions);
    const copiesBefore = JSON.stringify(before.approvals);
    const receiptsBefore = await s.receiptBytes();
    expect(receiptsBefore.map(([n]) => n)).toEqual(["1.json"]);
    const eventsBefore = (await s.statusEvents()).length;

    const out = ok(await s.rework());
    expect(out.revision).toBe(await s.revision());

    const after = await s.plan();
    expect(after.reworks).toEqual([{ planRev: 1, at: NOW_ISO, reason: REASON, actor: { kind: "human" } }]);
    expect(JSON.stringify(after.taskStates.find((x) => x.taskId === "t1" && x.planRev === 1)), "verified state byte-exact").toBe(t1Before);
    expect(after.taskStates.find((x) => x.taskId === "t2" && x.planRev === 1)).toEqual({ taskId: "t2", planRev: 1, status: "cancelled" });
    expect(after.taskStates.find((x) => x.taskId === "t3" && x.planRev === 1)).toEqual({ taskId: "t3", planRev: 1, status: "cancelled" });
    expect(after.taskStates.filter((x) => x.planRev === 1)).toHaveLength(3);
    expect(JSON.stringify(after.revisions)).toBe(revisionsBefore);
    expect(JSON.stringify(after.approvals)).toBe(copiesBefore);
    expect(await s.receiptBytes()).toEqual(receiptsBefore);
    const f = await s.feature();
    expect(f.status).toBe("created");
    expect(f.statusReason).toBe("plan in rework");
    const events = await s.statusEvents();
    expect(events).toHaveLength(eventsBefore + 1);
    expect(events.at(-1)).toMatchObject({ kind: "status", from: "planned", to: "created", reason: "plan in rework" });
  });

  it("an executing feature can be sent for rework too", async () => {
    const s = await approvedBound();
    await s.forceFeature("executing");
    ok(await s.rework());
    expect((await s.feature())).toMatchObject({ status: "created", statusReason: "plan in rework" });
    expect((await s.statusEvents()).at(-1)).toMatchObject({ from: "executing", to: "created", reason: "plan in rework" });
  });

  it("a previously approved revision whose basis decision was later cancelled (not_current) can still be sent for rework", async () => {
    const s = await approvedBound();
    const cancelled = await s.project.service.decisionCancel(s.project.paseo, { projectId: s.P, expectedRevision: await s.revision(), ...s.seed.q1, reason: "Dropped" });
    if (!cancelled.ok) throw new Error(`cancel failed: ${cancelled.error.code}`);
    const view = await s.get();
    expect(view.approval, "precondition: the approval is no longer current").toBe("not_current");
    ok(await s.rework());
    expect((await s.plan()).reworks?.map((r) => r.planRev)).toEqual([1]);
    expect((await s.feature()).status).toBe("created");
  });
});

describe("R2.3 plan.rework refusals write nothing", () => {
  const refused = async (s: Awaited<ReturnType<typeof approvedBound>>, attempt: () => Promise<R<unknown>>, code: string) => {
    const before = await s.snapshot();
    const e = err(await attempt());
    expect(e.code, e.message).toBe(code);
    expect(await s.snapshot()).toEqual(before);
  };

  it("chat (MCP) origin is invalid_input; a stale expectedRevision is revision_conflict", async () => {
    const s = await approvedBound();
    await refused(s, () => s.rework({ origin: CHAT }), "invalid_input");
    await refused(s, async () => s.rework({ expectedRevision: (await s.revision()) - 1 }), "revision_conflict");
    ok(await s.rework());
  });

  it("not the latest revision is plan_revision_mismatch; an unapproved latest revision is invalid_input", async () => {
    const s = await approvedBound();
    expect((await s.draft()).rev, "precondition: an unapproved rev 2 is latest").toBe(2);
    await refused(s, () => s.rework({ planRev: 1 }), "plan_revision_mismatch");
    await refused(s, () => s.rework({ planRev: 2 }), "invalid_input");
  });

  it("an already reworked revision is invalid_input", async () => {
    const s = await approvedBound();
    ok(await s.rework());
    await refused(s, () => s.rework(), "invalid_input");
    expect((await s.plan()).reworks).toHaveLength(1);
  });

  it("feature created, done, deferred or cancelled is invalid_input (control: planned succeeds afterwards)", async () => {
    const s = await approvedBound();
    for (const status of ["created", "done", "deferred", "cancelled"] as const) {
      await s.forceFeature(status);
      await refused(s, () => s.rework(), "invalid_input");
    }
    await s.forceFeature("planned");
    ok(await s.rework());
  });

  it("an unbound (legacy) approved plan is invalid_input", async () => {
    const s = await approvedBound();
    const legacy = ok(
      await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Legacy", sessionIds: [s.seed.sessionId], markdown: "# L", tasks: [{ id: "l1", title: "L", description: "" }] }, UI_ORIGIN),
    );
    ok(await s.plans.approve(s.open, { projectId: s.P, planId: legacy.planId, rev: 1, contentHash: legacy.contentHash }, UI_ORIGIN));
    await refused(s, () => s.rework({ planId: legacy.planId, planRev: 1 }), "invalid_input");
  });
});

describe("R2.3 a superseded latest revision is not current everywhere", () => {
  it("plan.get, plan.list and roadmap_plan_status show not_current with the rework reason; approve and task start are plan_not_current", async () => {
    const s = await approvedBound();
    expect((await s.get()).approval, "control: current before the rework").toBe("current");
    ok(await s.rework());
    const view = await s.get();
    expect(view.approval).toBe("not_current");
    expect(view.notCurrentReasons).toEqual([SENT(1)]);
    const list = ok(await s.plans.list(s.open, { projectId: s.P }));
    expect(list.plans.find((p) => p.id === s.d1.planId)?.approval).toBe("not_current");
    const statusTool = buildPlanTools(s.plans).find((x) => x.name === "roadmap_plan_status")!;
    const status = await statusTool.run(statusTool.input.parse({ planId: s.d1.planId }), { open: s.open, projectId: s.P, origin: CHAT });
    expect(status).toMatchObject({ ok: true, value: { approval: "not_current", notCurrentReasons: [SENT(1)] } });
    const approve = err(await s.plans.approve(s.open, { projectId: s.P, planId: s.d1.planId, rev: 1, contentHash: s.d1.contentHash }, UI_ORIGIN));
    expect(approve.code).toBe("plan_not_current");
    expect(approve.message).toContain(SENT(1));
    for (const taskId of ["t2", "t3"]) {
      const before = await s.snapshot();
      expect(err(await s.task(1, s.d1.contentHash, taskId, "in_progress")).code, `${taskId} start`).toBe("plan_not_current");
      expect(await s.snapshot()).toEqual(before);
    }
  });

  it("tracker preview is tracker_not_current after the rework (control: ok before)", async () => {
    const s = await approvedBound();
    const { createTrackerCommands } = await import("./tracker/sync");
    const { createTrackerKeyStore } = await import("./tracker/token");
    const tracker = createTrackerCommands({
      directory: () => {
        throw new Error("tracker commands must use the call's opener");
      },
      now: fixedClock,
      newId: nextId,
      storeOptions: { now: fixedClock, newId: nextId, log: s.env.log },
      approvals: s.approvals,
      settings: async () => ({ provider: "none", mode: "dry-run", closeByProject: {} }),
      keys: createTrackerKeyStore({ stateDir: s.stateDir }),
      live: {},
      connection: { read: async () => ({ url: new URL("http://127.0.0.1:9/mcp/synthetic") }) },
      processStartedAt: fixedClock(),
    });
    const ref = { projectId: s.P, planId: s.d1.planId };
    ok(await tracker.preview(s.open, ref, UI_ORIGIN));
    ok(await s.rework());
    expect(err(await tracker.preview(s.open, ref, UI_ORIGIN)).code).toBe("tracker_not_current");
  });
});

describe("R2.3 reuse candidates and the next revision", () => {
  it("plan.get lists the verified task of the superseded revision with its verification date; nothing without a rework", async () => {
    const s = await approvedBound();
    expect("reuseCandidates" in (await s.get()), "absent when empty").toBe(false);
    const at = (await s.plan()).taskStates.find((x) => x.taskId === "t1")!.verification!.at;
    ok(await s.rework());
    expect((await s.get()).reuseCandidates).toEqual([{ planRev: 1, taskId: "t1", title: "Build", verifiedAt: at }]);
  });

  it("a historical verified state without a verification record is a candidate without an invented date", async () => {
    const s = await approvedBound();
    await (await s.open(s.P)).transact(await s.revision(), (draftData) => {
      draftData.plans.find((p) => p.id === s.d1.planId)!.taskStates.push({ taskId: "t3", planRev: 1, status: "verified" });
    });
    ok(await s.rework());
    const candidates = (await s.get()).reuseCandidates ?? [];
    const t3 = candidates.find((c) => c.taskId === "t3");
    expect(t3).toEqual({ planRev: 1, taskId: "t3", title: "Docs" });
    expect(t3 !== undefined && "verifiedAt" in t3).toBe(false);
    expect((await s.plan()).taskStates.find((x) => x.taskId === "t3")).toEqual({ taskId: "t3", planRev: 1, status: "verified" });
  });

  it("re-draft and approval: the feature is planned with statusReason cleared; the new revision's task states start independently", async () => {
    const s = await approvedBound();
    ok(await s.rework());
    const d2 = await s.draft();
    expect(d2.rev).toBe(2);
    ok(await s.plans.approve(s.open, { projectId: s.P, planId: s.d1.planId, rev: 2, contentHash: d2.contentHash }, UI_ORIGIN));
    const f = await s.feature();
    expect(f.status).toBe("planned");
    expect("statusReason" in f).toBe(false);
    expect((await s.statusEvents()).at(-1)).toMatchObject({ from: "created", to: "planned", reason: "plan approved" });
    const plan = await s.plan();
    expect(plan.taskStates.filter((x) => x.planRev === 2), "states materialise lazily from todo").toEqual([]);
    expect((await s.get()).approval).toBe("current");
    // t1 was verified in rev 1; in rev 2 it starts from todo, so it can be started.
    ok(await s.task(2, d2.contentHash, "t1", "in_progress"));
    expect((await s.plan()).taskStates.filter((x) => x.planRev === 2)).toEqual([{ taskId: "t1", planRev: 2, status: "in_progress" }]);
    expect((await s.plan()).taskStates.find((x) => x.taskId === "t1" && x.planRev === 1)?.status).toBe("verified");
    expect((await s.get()).reuseCandidates?.map((c) => [c.planRev, c.taskId])).toEqual([[1, "t1"]]);
  });

  it("candidates of several superseded revisions are listed newest revision first", async () => {
    const s = await approvedBound();
    ok(await s.rework());
    const d2 = await s.draft();
    ok(await s.plans.approve(s.open, { projectId: s.P, planId: s.d1.planId, rev: 2, contentHash: d2.contentHash }, UI_ORIGIN));
    ok(await s.task(2, d2.contentHash, "t2", "in_progress"));
    ok(await s.task(2, d2.contentHash, "t2", "done"));
    ok(await s.task(2, d2.contentHash, "t2", "verified", "Second pass"));
    ok(await s.rework({ planRev: 2 }));
    expect((await s.get()).reuseCandidates?.map((c) => [c.planRev, c.taskId])).toEqual([
      [2, "t2"],
      [1, "t1"],
    ]);
    expect((await s.get()).notCurrentReasons).toEqual([SENT(2)]);
  });
});

// Root race (R2.3 verification): a same-revision approve retry passes its checks while the feature
// is planned and the revision is not reworked; a rework commits between the receipt write and the
// cosmetic copy transaction. The copy is still recorded, but the copy transaction must not move the
// feature back to planned: the revision is superseded.
describe("R2.3 race: rework committed between an approve retry's receipt and its copy", () => {
  it("keeps the feature created in rework, adds no planned event, and leaves the revision superseded", async () => {
    const s = await approvedBound();
    const real = createApprovalStore({ stateDir: s.stateDir, log: () => undefined });
    const hook = { writes: 0 };
    const approvals: ApprovalStore = {
      read: (projectId, planId, rev) => real.read(projectId, planId, rev),
      async write(r) {
        const out = await real.write(r);
        hook.writes++;
        // Another UI client sends the revision for rework after the receipt and before the copy.
        ok(await s.rework());
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
    expect((await s.feature()).status, "precondition: planned and not reworked").toBe("planned");
    expect((await s.plan()).reworks).toBeUndefined();
    const receiptsBefore = await s.receiptBytes();
    const eventsBefore = await s.statusEvents();

    const a = ok(await racing.approve(s.open, { projectId: s.P, planId: s.d1.planId, rev: 1, contentHash: s.d1.contentHash }, UI_ORIGIN));
    expect(hook.writes, "the receipt hook ran once").toBe(1);
    expect(a).toMatchObject({ alreadyApproved: true, copyRecorded: true });
    expect(await s.receiptBytes(), "the existing receipt is preserved byte for byte").toEqual(receiptsBefore);
    expect((await s.plan()).approvals.map((r) => r.planRev)).toEqual([1]);

    const f = await s.feature();
    expect(f.status).toBe("created");
    expect(f.statusReason).toBe("plan in rework");
    const events = await s.statusEvents();
    expect(events.slice(0, eventsBefore.length)).toEqual(eventsBefore);
    const added = events.slice(eventsBefore.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: "status", from: "planned", to: "created", reason: "plan in rework" });

    const plan = await s.plan();
    expect(plan.reworks?.map((r) => r.planRev)).toEqual([1]);
    for (const taskId of ["t2", "t3"]) expect(plan.taskStates.find((x) => x.taskId === taskId && x.planRev === 1)?.status, taskId).toBe("cancelled");
    expect(plan.taskStates.find((x) => x.taskId === "t1" && x.planRev === 1)?.status).toBe("verified");
    const view = await s.get();
    expect(view.approval).toBe("not_current");
    expect(view.notCurrentReasons).toEqual([SENT(1)]);
  });
});

// R2 corrective c0011 (task card 2026-10-29 §8.2, §8.7): old data may hold two plans bound to one
// feature (written directly here; the producer now refuses it). Such data stays readable; redraft,
// approve and rework of either plan fail closed with feature_has_multiple_plans and write nothing.
describe("R2 corrective c0011: duplicate bound plans stay readable and fail closed on writes", () => {
  const DUP = "dup-plan";
  async function withDuplicate() {
    const s = await approvedBound();
    await (await s.open(s.P)).transact(await s.revision(), (draftData) => {
      const original = draftData.plans.find((p) => p.id === s.d1.planId)!;
      draftData.plans.push({ ...structuredClone(original), id: DUP, title: "Duplicate", approvals: [], taskStates: [] });
    });
    const planIds = [s.d1.planId, DUP].sort();
    const dupReceiptDir = join(s.stateDir, "approvals", s.P, DUP);
    const dupReceipts = async () => (await readdir(dupReceiptDir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const refusedMultiple = async (attempt: () => Promise<R<unknown>>) => {
      const before = await s.snapshot();
      const e = err(await attempt());
      expect(e.code, e.message).toBe("invalid_input");
      expect(e.details).toEqual({ reason: "feature_has_multiple_plans", featureId: s.featureId, planIds });
      expect(await s.snapshot()).toEqual(before);
      expect(await dupReceipts()).toEqual([]);
    };
    return { ...s, planIds, refusedMultiple, dupReceipts };
  }

  it("the duplicate data is readable through feature.list, plan.list and plan.get", async () => {
    const s = await withDuplicate();
    const features = ok(await s.features.list(s.open, { projectId: s.P }, UI_ORIGIN));
    expect(features.features.map((f) => f.id)).toContain(s.featureId);
    const list = ok(await s.plans.list(s.open, { projectId: s.P }));
    expect(list.plans.filter((p) => p.featureId === s.featureId).map((p) => p.id).sort()).toEqual(s.planIds);
    for (const planId of s.planIds) expect(ok(await s.plans.get(s.open, { projectId: s.P, planId })).plan.id).toBe(planId);
  });

  it("redraft of either plan is refused with feature_has_multiple_plans and no write", async () => {
    const s = await withDuplicate();
    for (const planId of s.planIds) {
      await s.refusedMultiple(async () =>
        s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), planId, featureId: s.featureId, title: "Rollout", sessionIds: [s.seed.sessionId], markdown: "# Again", tasks: TASKS }, UI_ORIGIN),
      );
    }
  });

  it("approve of the unapproved duplicate is refused before any receipt is written", async () => {
    const s = await withDuplicate();
    const dup = (await s.data()).plans.find((p) => p.id === DUP)!;
    const latest = dup.revisions.at(-1)!;
    await s.refusedMultiple(() => s.plans.approve(s.open, { projectId: s.P, planId: DUP, rev: latest.rev, contentHash: latest.contentHash }, UI_ORIGIN));
  });

  it("rework of the approved original is refused with no write", async () => {
    const s = await withDuplicate();
    await s.refusedMultiple(() => s.rework());
    expect((await s.plan()).reworks).toBeUndefined();
    expect((await s.feature()).status).toBe("planned");
  });
});

// Stage R3.5 (card §6.2a): plan.rework of the executing revision ends the live run
// (cancelled_for_rework) in the same transaction; Plan.reworks, receipts and verified states stay;
// afterRunEffect gets the run after commit.
describe("R3.5 rework ends the live run", () => {
  it("ends the running run as cancelled_for_rework and keeps the R2 rework record, receipts and verified state", async () => {
    const s = await approvedBound();
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      draft.features.find((f) => f.id === s.featureId)!.status = "executing";
      draft.runs.push({
        id: "run-1", featureId: s.featureId, planId: s.d1.planId, planRev: 1, runToken: "tok-1", state: "running", startAuth: { kind: "ui", at: NOW_ISO },
        tasks: [{ taskId: "t2", state: "in_progress", agentId: "agent-w", failedCycles: 0, extraBudget: 0, unresolved: [] }],
        acks: [], events: [{ at: NOW_ISO, kind: "started" }], lateEvidence: [],
      });
    });
    const effects: unknown[] = [];
    const { createPlanCommands } = await import("./plans");
    const plans = createPlanCommands({
      directory: () => { throw new Error("unused"); }, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId },
      approvals: s.approvals, afterRunEffect: (x: unknown) => void effects.push(x),
    } as Parameters<typeof createPlanCommands>[0]);
    const receipts = await s.receiptBytes();
    const t1 = JSON.stringify((await s.plan()).taskStates.find((x) => x.taskId === "t1"));
    ok(await plans.rework(s.open, { projectId: s.P, expectedRevision: await s.revision(), planId: s.d1.planId, planRev: 1, reason: "Scope changed" }, UI_ORIGIN));
    const run = (await s.data()).runs.find((r) => r.id === "run-1")!;
    expect(run).toMatchObject({ state: "ended", endReason: "cancelled_for_rework" });
    expect((await s.plan()).reworks?.map((r) => r.planRev)).toEqual([1]);
    expect(await s.receiptBytes()).toEqual(receipts);
    expect(JSON.stringify((await s.plan()).taskStates.find((x) => x.taskId === "t1"))).toBe(t1);
    expect(effects).toEqual([expect.objectContaining({ runId: "run-1" })]);
  });
});

// Stage R4.3 (task card §4): plan.rework runs through the shared `reworkInDraft`, unchanged in
// behaviour (the R2 tests above are the control). The helper's authority is the ApprovalStore receipt
// pre-read by `readLatestReceipts` (never plan.approvals): with no receipt it refuses and changes
// nothing; with the real receipt it reworks exactly as plan.rework does. It never writes a receipt.
describe("R4.3 readLatestReceipts and reworkInDraft", () => {
  const load = async () => {
    const mod = await import("./plans");
    for (const n of ["readLatestReceipts", "reworkInDraft"] as const) expect(typeof mod[n], `server/plans exports ${n}`).toBe("function");
    return mod;
  };

  it("readLatestReceipts reads the ApprovalStore receipt of each feature's bound latest revision, keyed planId#rev; misses are absent", async () => {
    const m = await load();
    const s = await approvedBound();
    const map = await m.readLatestReceipts(s.approvals, s.P, await s.data(), [s.featureId, "f-unknown"]);
    expect([...map.keys()]).toEqual([`${s.d1.planId}#1`]);
    expect(map.get(`${s.d1.planId}#1`)).toMatchObject({ planRev: 1, contentHash: s.d1.contentHash });
  });

  it("without a receipt reworkInDraft refuses with a reason and leaves the draft unchanged; with the real receipt it reworks like plan.rework", async () => {
    const m = await load();
    const s = await approvedBound();
    const receipts = await m.readLatestReceipts(s.approvals, s.P, await s.data(), [s.featureId]);
    const receiptBefore = await s.receiptBytes();
    const draft = structuredClone(await s.data());
    const snap = JSON.stringify(draft);
    const refused = m.reworkInDraft(draft, { projectId: s.P, planId: s.d1.planId, planRev: 1, receipt: null, reason: "prerequisite cancelled", at: "2026-10-29T10:00:00.000Z", actor: { kind: "human" } });
    expect(refused.reworked).toBe(false);
    expect(refused.reworked ? undefined : typeof refused.why).toBe("string");
    expect(JSON.stringify(draft), "nothing changed").toBe(snap);
    const done = m.reworkInDraft(draft, { projectId: s.P, planId: s.d1.planId, planRev: 1, receipt: receipts.get(`${s.d1.planId}#1`) ?? null, reason: "prerequisite cancelled", at: "2026-10-29T10:00:00.000Z", actor: { kind: "human" } });
    expect(done.reworked).toBe(true);
    const plan = (draft as { plans: Array<{ id: string; reworks?: Array<{ planRev: number }> }> }).plans.find((p) => p.id === s.d1.planId)!;
    expect(plan.reworks?.map((r) => r.planRev)).toEqual([1]);
    const feature = (draft as { features: Array<{ id: string; status: string }> }).features.find((f) => f.id === s.featureId)!;
    expect(feature.status).toBe("created");
    expect(JSON.stringify(feature)).toMatch(/plan in rework/);
    expect(await s.receiptBytes(), "never writes a receipt").toEqual(receiptBefore);
  });
});

// R4.3 corrective (Fable ruling): the AUTOMATIC reworkInDraft gains `allowDeferred: true`, so a
// deferred feature whose statusBeforeDefer is planned or executing is reworked at cancel, stays
// deferred and gets statusBeforeDefer "created". Without the flag it refuses; manual plan.rework stays
// strict (planned | executing only; the existing "deferred is invalid_input" control above).
describe("R4.3 corrective: reworkInDraft allowDeferred", () => {
  it("deferred (from planned) with the real receipt: refused without allowDeferred; with it reworked, still deferred, statusBeforeDefer created", async () => {
    const mod = await import("./plans");
    const s = await approvedBound();
    await s.forceFeature("deferred");
    const receipts = await mod.readLatestReceipts(s.approvals, s.P, await s.data(), [s.featureId]);
    const receipt = receipts.get(`${s.d1.planId}#1`) ?? null;
    expect(receipt, "precondition: the real receipt").not.toBeNull();
    const x: Parameters<typeof mod.reworkInDraft>[1] = { projectId: s.P, planId: s.d1.planId, planRev: 1, receipt, reason: "prerequisite cancelled", at: "2026-10-29T10:00:00.000Z", actor: { kind: "human" } };
    const strict = structuredClone(await s.data());
    expect(mod.reworkInDraft(strict, x).reworked, "without allowDeferred a deferred feature is refused").toBe(false);
    const auto = structuredClone(await s.data());
    expect(mod.reworkInDraft(auto, { ...x, allowDeferred: true }).reworked).toBe(true);
    const f = (auto as { features: Array<Record<string, unknown>> }).features.find((g) => g.id === s.featureId)!;
    expect(f.status).toBe("deferred");
    expect(f.statusBeforeDefer).toBe("created");
    expect((auto as { plans: Array<{ id: string; reworks?: Array<{ planRev: number }> }> }).plans.find((p) => p.id === s.d1.planId)!.reworks?.map((r) => r.planRev)).toEqual([1]);
  });
});
