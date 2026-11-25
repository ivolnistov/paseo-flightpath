// Stage R4.3 (task card 2026-10-29 R4 §4): feature dependencies on runs. Cancelling A with A → B → C:
// one transaction pre-read against the REAL ApprovalStore receipts (never plan.approvals), B's live
// run ends (cancelled_for_rework), B's latest approved revision is reworked through `reworkInDraft`
// and B gets `replacementRequested` (requested when bound, queued otherwise); a transitive C is only
// paused (prerequisite_cancelled), its tasks kept. After commit each effect is delivered once.
// Approving B's replacement clears B's request (`replacementCleared`) and requests every non-done C.
// Real temp store, real ApprovalStore, fake SDK; runs are MODELLED STATE (labelled) written into the
// store, because a dependent cannot start running while its prerequisite is open.
import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { ExecutionRun, Feature } from "../shared/model";
import type { ApprovalStore } from "./approvals";
import { DomainError } from "../shared/errors";
import { UI_ORIGIN } from "./sessions";
import { fixedClock, NOW_ISO, nextId, readJsonObject } from "./test-support/build";
import { makePlanProject, receipt, type PlanProject } from "./test-support/plans";

let t: PlanProject | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});
type R<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
const ok = <T,>(r: R<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};
const COORD = (agentId: string) => ({ agentId, workspaceId: `ws-${agentId}`, boundAt: NOW_ISO, profileRef: "team-coordinator" });
type CVariant = "running" | "owner" | "prerequisite_not_done" | "none";
type ReceiptMode = "valid" | "none" | "mismatch";

const loadRuns = async () => await import("./runs");
const loadPlans = async () => await import("./plans");

/** A → B → C with approved plans for B and C (real receipts); runs and bindings modelled as asked. */
async function world(o: { bBound?: boolean; bRun?: boolean; bDeferred?: boolean; bDeferredFrom?: "planned" | "executing" | "created"; bOwnerPaused?: boolean; bDone?: boolean; bReceipt?: ReceiptMode; c?: CVariant; cBound?: boolean; clock?: { now: string } } = {}) {
  t = await makePlanProject();
  const s = t;
  const seed = await s.seedAnswered();
  const effects: { runs: Array<{ projectId: string; runId: string }>; replacements: Array<{ projectId: string; featureId: string; agentId: string }> } = { runs: [], replacements: [] };
  const { createFeatureCommands } = await import("./features");
  // Local mutable clock seam (test-only): defaults to the fixed clock; `o.clock.now` moves it.
  const clock = o.clock ?? { now: NOW_ISO };
  const now = () => new Date(clock.now);
  const base = { directory: () => { throw new Error("unused"); }, now, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } };
  const deps = {
    ...base,
    approvals: s.approvals,
    afterRunEffect: (x: { projectId: string; runId: string }) => void effects.runs.push(x),
    afterReplacementRequest: (x: { projectId: string; featureId: string; agentId: string }) => void effects.replacements.push(x),
  };
  const features = createFeatureCommands(deps as Parameters<typeof createFeatureCommands>[0]);
  // R4.3 verify harness repair: a LOCAL plan-commands instance carrying the same replacement hook
  // (the shared test-support `s.plans` is built without it). Shared support stays unchanged.
  const { createPlanCommands } = await import("./plans");
  const plans = createPlanCommands({ ...deps, approvals: s.approvals } as Parameters<typeof createPlanCommands>[0]);
  const create = async (title: string, dependsOn: string[] = []) =>
    ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title, description: "", kind: "feature", ...(dependsOn.length ? { dependsOn } : {}) }, UI_ORIGIN)).featureId;
  const A = await create("Alpha");
  const B = await create("Bravo", [A]);
  const C = await create("Charlie", [B]);
  const transact = async (fn: Parameters<Awaited<ReturnType<typeof s.open>>["transact"]>[1]) => (await s.open(s.P)).transact(await s.revision(), fn);
  const tasks = [{ id: "t1", title: "Build", description: "", dod: "x" }, { id: "t2", title: "Ship", description: "", dod: "y", dependsOn: ["t1"] }];
  const planFor = async (featureId: string, title: string) => {
    const d = ok(await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId, title, sessionIds: [seed.sessionId], markdown: `# ${title}`, tasks }, UI_ORIGIN));
    await transact((draft) => {
      draft.features.find((f) => f.id === featureId)!.grillSessionId = seed.sessionId;
      draft.plans.find((p) => p.id === d.planId)!.grillSessionId = seed.sessionId;
    });
    ok(await s.plans.approve(s.open, { projectId: s.P, planId: d.planId, rev: 1, contentHash: d.contentHash }, UI_ORIGIN));
    return d;
  };
  const bPlan = await planFor(B, "B plan");
  const cPlan = await planFor(C, "C plan");
  const runOf = (id: string, featureId: string, planId: string, state: "running" | "paused", pauseReason?: ExecutionRun["pauseReason"]): ExecutionRun =>
    ({
      id, featureId, planId, planRev: 1, runToken: `tok-${id}`, state, ...(state === "paused" ? { pauseReason, pausedAt: NOW_ISO } : {}),
      startAuth: { kind: "ui", at: NOW_ISO },
      tasks: [
        { taskId: "t1", state: "verified", agentId: "agent-w", failedCycles: 1, extraBudget: 0, unresolved: [] },
        { taskId: "t2", state: "in_progress", agentId: "agent-w", failedCycles: 0, extraBudget: 0, unresolved: [] },
      ],
      acks: [], events: [{ at: NOW_ISO, kind: "started" }, { at: NOW_ISO, kind: "cycle_started", taskId: "t2", detail: `cyc-${id}` }], lateEvidence: [],
    });
  await transact((draft) => {
    // MODELLED STATE (labelled): bindings, statuses and live runs the test needs.
    const b = draft.features.find((f) => f.id === B)!;
    const c = draft.features.find((f) => f.id === C)!;
    if (o.bBound ?? true) b.coordinator = COORD("agent-b");
    if (o.cBound) c.coordinator = COORD("agent-c");
    if (o.bRun ?? true) {
      b.status = "executing";
      b.everStarted = true;
      // A deferred executing feature's live run is paused "deferred" (R3.5 status effect).
      draft.runs.push(o.bDeferred ? runOf("run-b", B, bPlan.planId, "paused", "deferred") : o.bOwnerPaused ? runOf("run-b", B, bPlan.planId, "paused", "owner") : runOf("run-b", B, bPlan.planId, "running"));
    }
    const cv = o.c ?? "running";
    if (cv !== "none") {
      c.status = "executing";
      c.everStarted = true;
      draft.runs.push(runOf("run-c", C, cPlan.planId, cv === "running" ? "running" : "paused", cv === "running" ? undefined : cv));
    }
    if (o.bDeferred) {
      (b as Record<string, unknown>).statusBeforeDefer = o.bDeferredFrom ?? b.status;
      b.status = "deferred";
    }
    if (o.bDone) b.status = "done";
  });
  const receiptMode = o.bReceipt ?? "valid";
  const bReceiptPath = s.env.receiptPath({ projectId: s.P, planId: bPlan.planId, planRev: 1 });
  if (receiptMode === "none") await rm(bReceiptPath); // only the project approval copy remains (a forged/copied approval)
  if (receiptMode === "mismatch") {
    const r = readJsonObject(await readFile(bReceiptPath, "utf8"));
    await writeFile(bReceiptPath, JSON.stringify({ ...r, contentHash: "c".repeat(64) }));
  }
  const data = async () => {
    const read = await (await s.open(s.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data;
  };
  const feature = async (id: string): Promise<Feature> => (await data()).features.find((f) => f.id === id)!;
  const run = async (id: string): Promise<ExecutionRun | undefined> => (await data()).runs.find((r) => r.id === id);
  const plan = async (planId: string) => (await data()).plans.find((p) => p.id === planId)!;
  const cancelA = async () => features.statusSet(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId: A, status: "cancelled" }, UI_ORIGIN);
  return { s, seed, features, plans, clock, deps, effects, A, B, C, bPlan, cPlan, data, feature, run, plan, transact, cancelA, create, planFor };
}
type World = Awaited<ReturnType<typeof world>>;
const req = (f: Feature) => (f as Feature & { replacementRequested?: Record<string, unknown> }).replacementRequested;
const notes = (f: Feature) => f.events.filter((e) => e.kind === "note").map((e) => (e as { reason?: string }).reason ?? "");

describe("R4.3 cancel A with A → B → C (B approved, bound, running)", () => {
  it("one transaction: B's run ends cancelled_for_rework, B's latest revision is reworked (created, 'plan in rework') with replacementRequested requested + reworkedRev; C's run pauses prerequisite_cancelled with tasks kept and no request", async () => {
    const w = await world();
    const before = await w.s.revision();
    const cTasks = JSON.stringify((await w.run("run-c"))!.tasks);
    ok(await w.cancelA());
    expect(await w.s.revision(), "one transaction").toBe(before + 1);
    expect((await w.feature(w.A)).status).toBe("cancelled");
    expect(await w.run("run-b")).toMatchObject({ state: "ended", endReason: "cancelled_for_rework" });
    const b = await w.feature(w.B);
    expect(b.status).toBe("created");
    expect(JSON.stringify(b)).toMatch(/plan in rework/);
    expect(req(b)).toMatchObject({ state: "requested", becauseOf: w.A, reworkedRev: 1 });
    expect((await w.plan(w.bPlan.planId)).reworks?.map((r) => r.planRev)).toEqual([1]);
    const c = await w.run("run-c");
    expect(c).toMatchObject({ state: "paused", pauseReason: "prerequisite_cancelled" });
    expect(JSON.stringify(c!.tasks), "C's tasks kept").toBe(cTasks);
    expect(req(await w.feature(w.C)), "no request for a transitive C yet").toBeUndefined();
  });

  it("after commit: one run effect each for B and C, and exactly one replacement steer to B's coordinator", async () => {
    const w = await world();
    ok(await w.cancelA());
    expect(w.effects.runs.map((x) => x.runId).sort()).toEqual(["run-b", "run-c"]);
    expect(w.effects.replacements).toEqual([{ projectId: w.s.P, featureId: w.B, agentId: "agent-b" }]);
  });
});

describe("R4.3 cancel A: B variants", () => {
  it("B unbound: the request is queued and nothing is sent", async () => {
    const w = await world({ bBound: false, bRun: false });
    ok(await w.cancelA());
    expect(req(await w.feature(w.B))).toMatchObject({ state: "queued", becauseOf: w.A });
    expect(w.effects.replacements).toEqual([]);
  });

  // Fable ruling (design §3.4/§3.6, Q14/Q21) restoring the card: a direct dependent's live run ALWAYS
  // ends at cancel. Without a valid receipt there is no rework record, but the run still ends (detail
  // "approval receipt missing or mismatched") with a feature note, and the feature becomes created
  // ("prerequisite cancelled") with a request only. Replaces the earlier "no rework: status not moved"
  // expectation (P's conditional end was rejected).
  for (const mode of ["none", "mismatch"] as const) {
    it(`receipt ${mode === "none" ? "missing (only the project approval copy)" : "mismatched (another contentHash)"}: B's run still ends, no rework record, B created 'prerequisite cancelled' with a request only and a note`, async () => {
      const w = await world({ bReceipt: mode });
      const notesBefore = notes(await w.feature(w.B)).length;
      ok(await w.cancelA());
      const run = (await w.run("run-b"))!;
      expect(run).toMatchObject({ state: "ended", endReason: "cancelled_for_rework" });
      expect(run.events.some((e) => /approval receipt missing or mismatched/.test(String((e as { detail?: string }).detail ?? ""))), "the end names the missing/mismatched receipt").toBe(true);
      expect((await w.plan(w.bPlan.planId)).reworks ?? [], "no rework record").toEqual([]);
      const b = await w.feature(w.B);
      expect(b.status).toBe("created");
      expect(b.statusReason).toBe("prerequisite cancelled");
      expect(req(b)).toMatchObject({ state: "requested", becauseOf: w.A });
      expect(req(b)!.reworkedRev).toBeUndefined();
      expect(notes(b).length, "a feature note explains the end").toBeGreaterThan(notesBefore);
      expect(w.effects.runs.map((x) => x.runId)).toContain("run-b");
    });
  }

  it("missing receipt: the ended run no longer blocks a replacement draft, and a later approval clears the request", async () => {
    const clock = { now: NOW_ISO };
    const w = await world({ bReceipt: "none", clock });
    ok(await w.cancelA());
    clock.now = "2026-12-01T00:00:00.000Z";
    const d = ok(await w.plans.draft(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: w.B, planId: w.bPlan.planId, title: "B plan v2", sessionIds: [w.seed.sessionId], markdown: "# B v2", tasks: [{ id: "t1", title: "Build again", description: "", dod: "x" }] }, UI_ORIGIN));
    expect(req(await w.feature(w.B)), "drafting does not clear").toBeDefined();
    ok(await w.plans.approve(w.s.open, { projectId: w.s.P, planId: w.bPlan.planId, rev: (d as { rev?: number }).rev ?? 2, contentHash: d.contentHash }, UI_ORIGIN));
    expect(req(await w.feature(w.B)), "a later receipt clears the request-only B").toBeUndefined();
  });

  it("an owner-paused direct B's live run also ends cancelled_for_rework (the human pause is not kept for a direct dependent)", async () => {
    const w = await world({ bOwnerPaused: true });
    ok(await w.cancelA());
    expect(await w.run("run-b")).toMatchObject({ state: "ended", endReason: "cancelled_for_rework" });
  });

  it("a done dependent B is byte-identical (never touched)", async () => {
    const w = await world({ bDone: true, bRun: false, c: "none" });
    const bBefore = JSON.stringify(await w.feature(w.B));
    ok(await w.cancelA());
    expect(JSON.stringify(await w.feature(w.B))).toBe(bBefore);
    expect(w.effects.replacements).toEqual([]);
  });
});

describe("R4.3 cancel A: transitive C variants", () => {
  it("an owner-paused C keeps owner", async () => {
    const w = await world({ c: "owner" });
    ok(await w.cancelA());
    expect(await w.run("run-c")).toMatchObject({ state: "paused", pauseReason: "owner" });
  });

  it("a C paused prerequisite_not_done becomes prerequisite_cancelled with a run event", async () => {
    const w = await world({ c: "prerequisite_not_done" });
    const eventsBefore = (await w.run("run-c"))!.events.length;
    ok(await w.cancelA());
    const c = (await w.run("run-c"))!;
    expect(c).toMatchObject({ state: "paused", pauseReason: "prerequisite_cancelled" });
    expect(c.events.length).toBeGreaterThan(eventsBefore);
  });

  it("a run-less C gets no run change and exactly one 'execution waits' note naming A", async () => {
    const w = await world({ c: "none" });
    const notesBefore = notes(await w.feature(w.C)).length;
    ok(await w.cancelA());
    expect((await w.data()).runs.filter((r) => r.featureId === w.C)).toEqual([]);
    const added = notes(await w.feature(w.C)).slice(notesBefore);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/Alpha/);
    expect(added[0]).toMatch(/execution waits/i);
  });
});

// Fable ruling (restoration; replaces the earlier "rework on undefer" expectations): a deferred B
// whose statusBeforeDefer is planned or executing is reworked AT CANCEL with a valid receipt (the
// automatic reworkInDraft allows deferred), stays deferred with statusBeforeDefer "created" and
// reworkedRev set; its live run ends at cancel. Undefer simply returns it to created (plan in rework)
// and never reworks or reads a receipt.
describe("R4.3 deferred B", () => {
  it("valid receipt: reworked and its live run ended AT CANCEL; B stays deferred with statusBeforeDefer created and reworkedRev", async () => {
    const w = await world({ bDeferred: true, c: "none" });
    expect(await w.run("run-b"), "precondition: the deferred executing B's run is paused deferred").toMatchObject({ state: "paused", pauseReason: "deferred" });
    ok(await w.cancelA());
    expect(await w.run("run-b")).toMatchObject({ state: "ended", endReason: "cancelled_for_rework" });
    expect((await w.plan(w.bPlan.planId)).reworks?.map((r) => r.planRev)).toEqual([1]);
    const b = await w.feature(w.B);
    expect(b.status).toBe("deferred");
    expect((b as Record<string, unknown>).statusBeforeDefer).toBe("created");
    expect(req(b)).toMatchObject({ reworkedRev: 1, becauseOf: w.A });
  });

  it("undefer returns B to created (plan in rework) and never reworks again or reads a receipt", async () => {
    const w = await world({ bDeferred: true, c: "none" });
    ok(await w.cancelA());
    const reworks = JSON.stringify((await w.plan(w.bPlan.planId)).reworks);
    await rm(w.s.env.receiptPath({ projectId: w.s.P, planId: w.bPlan.planId, planRev: 1 })); // a receipt read now would change nothing
    ok(await w.features.statusSet(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: w.B, status: "created" }, UI_ORIGIN));
    const b = await w.feature(w.B);
    expect(b.status).toBe("created");
    expect(b.statusReason).toBe("plan in rework");
    expect(JSON.stringify((await w.plan(w.bPlan.planId)).reworks), "no second rework").toBe(reworks);
  });

  it("a deferred planned B (no run) with a valid receipt is also reworked at cancel", async () => {
    const w = await world({ bRun: false, bDeferred: true, c: "none" });
    ok(await w.cancelA());
    expect((await w.plan(w.bPlan.planId)).reworks?.map((r) => r.planRev)).toEqual([1]);
    expect((await w.feature(w.B) as Record<string, unknown>).statusBeforeDefer).toBe("created");
  });

  it("missing receipt: no rework record, B stays deferred with statusBeforeDefer created and a request only; undefer returns it to created", async () => {
    const w = await world({ bDeferred: true, c: "none", bReceipt: "none" });
    ok(await w.cancelA());
    expect(await w.run("run-b")).toMatchObject({ state: "ended", endReason: "cancelled_for_rework" });
    expect((await w.plan(w.bPlan.planId)).reworks ?? []).toEqual([]);
    const b = await w.feature(w.B);
    expect(b.status).toBe("deferred");
    expect((b as Record<string, unknown>).statusBeforeDefer).toBe("created");
    expect(req(b)!.reworkedRev).toBeUndefined();
    ok(await w.features.statusSet(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: w.B, status: "created" }, UI_ORIGIN));
    expect((await w.feature(w.B)).status).toBe("created");
  });

  it("after the deferred B is reworked at cancel, undeferred and its replacement approved, Start creates a NEW run (never the stale one)", async () => {
    const w = await world({ bDeferred: true, c: "none" });
    ok(await w.cancelA());
    ok(await w.features.statusSet(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: w.B, status: "created" }, UI_ORIGIN));
    const d = ok(await w.plans.draft(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: w.B, planId: w.bPlan.planId, title: "B plan v2", sessionIds: [w.seed.sessionId], markdown: "# B v2", tasks: [{ id: "t1", title: "Build again", description: "", dod: "x" }] }, UI_ORIGIN));
    ok(await w.plans.approve(w.s.open, { projectId: w.s.P, planId: w.bPlan.planId, rev: (d as { rev?: number }).rev ?? 2, contentHash: d.contentHash }, UI_ORIGIN));
    const { createRunCommands } = await import("./runs");
    const { roadmapSettings } = await import("../shared/settings");
    const runs = createRunCommands({ ...w.deps, approvals: w.s.approvals, settings: async () => roadmapSettings.schema.parse({}) } as Parameters<typeof createRunCommands>[0]);
    const started = ok(await runs.start(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: w.B }, UI_ORIGIN));
    expect(started.existing, "not the stale run").toBe(false);
    expect(started.runId).not.toBe("run-b");
    expect((await w.run(started.runId))!.planRev).toBe((d as { rev?: number }).rev ?? 2);
  });
});

describe("R4.3 replacement approval", () => {
  async function approveReplacement(w: World) {
    // B's replacement: a new bound revision drafted after the rework, then approved by the human.
    const d = ok(await w.plans.draft(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: w.B, planId: w.bPlan.planId, title: "B plan v2", sessionIds: [w.seed.sessionId], markdown: "# B v2", tasks: [{ id: "t1", title: "Build again", description: "", dod: "x" }] }, UI_ORIGIN));
    return { d, approve: async () => w.plans.approve(w.s.open, { projectId: w.s.P, planId: w.bPlan.planId, rev: (d as { rev?: number }).rev ?? 2, contentHash: d.contentHash }, UI_ORIGIN) };
  }

  it("drafting the replacement clears nothing; approving it (rev > reworkedRev) clears B and requests every non-done C (steered when bound) with a trigger note", async () => {
    const w = await world({ c: "owner", cBound: true });
    ok(await w.cancelA());
    const r = await approveReplacement(w);
    expect(req(await w.feature(w.B)), "drafting does not clear").toBeDefined();
    w.effects.replacements.length = 0;
    ok(await r.approve());
    expect(req(await w.feature(w.B)), "cleared by the newer approved revision").toBeUndefined();
    const c = await w.feature(w.C);
    expect(req(c)).toMatchObject({ state: "requested", becauseOf: w.A });
    expect(notes(c).some((n) => /replacement requested/i.test(n) && /Bravo/.test(n))).toBe(true);
    expect(w.effects.replacements).toEqual([{ projectId: w.s.P, featureId: w.C, agentId: "agent-c" }]);
  });

  it("an unbound C is queued on B's replacement approval and nothing is sent for it", async () => {
    const w = await world({ c: "none", cBound: false });
    ok(await w.cancelA());
    const r = await approveReplacement(w);
    w.effects.replacements.length = 0;
    ok(await r.approve());
    expect(req(await w.feature(w.C))).toMatchObject({ state: "queued", becauseOf: w.A });
    expect(w.effects.replacements).toEqual([]);
  });
});

describe("R4.3 replacementCleared (pure)", () => {
  it("with reworkedRev only a greater approved rev clears; without it only a strictly later receipt.at clears", async () => {
    const m = await loadPlans();
    expect(typeof m.replacementCleared, "server/plans exports replacementCleared").toBe("function");
    const cleared = m.replacementCleared;
    const at = "2026-10-29T10:00:00.000Z";
    const later = "2026-10-29T11:00:00.000Z";
    const earlier = "2026-10-29T09:00:00.000Z";
    const withRev: Parameters<typeof cleared>[0] = { at, becauseOf: "fA", state: "requested", reworkedRev: 2 };
    expect(cleared(withRev, receipt({ planRev: 3, at: earlier }))).toBe(true);
    expect(cleared(withRev, receipt({ planRev: 2, at: later })), "the reworked revision itself").toBe(false);
    expect(cleared(withRev, receipt({ planRev: 1, at: later }))).toBe(false);
    const requestOnly: Parameters<typeof cleared>[0] = { at, becauseOf: "fA", state: "requested" };
    expect(cleared(requestOnly, receipt({ planRev: 1, at: later }))).toBe(true);
    expect(cleared(requestOnly, receipt({ planRev: 5, at }), ), "equal time is not later").toBe(false);
    expect(cleared(requestOnly, receipt({ planRev: 5, at: earlier })), "an approval-effects retry of an older receipt").toBe(false);
  });
});

describe("R4.3 afterReplacementRequest", () => {
  it("one steer with the replacement prompt; a failed steer leaves exactly one feature note and is not retried", async () => {
    const w = await world({ bRun: false, c: "none" });
    const m = await loadRuns();
    expect(typeof m.afterReplacementRequest, "server/runs exports afterReplacementRequest").toBe("function");
    const after = m.afterReplacementRequest;
    const sends: Array<{ agentId: string; text: string }> = [];
    let fail = false;
    const paseo = { agents: { ref: (agentId: string) => ({ send: async (text: string) => { sends.push({ agentId, text }); if (fail) throw new Error("agent offline"); return {}; } }) } };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only agents.ref(id).send is exercised
    const paseoApi = paseo as unknown as PaseoApi;
    const logs: string[] = [];
    // R4 successor c0038 contract: the request carries the actor that raised it (a variable, so the current
    // helper accepts the extra property; the corrected helper will require it).
    const request = { projectId: w.s.P, featureId: w.B, agentId: "agent-b", actor: { kind: "human" as const } };
    await after({ paseo: () => paseoApi, open: w.s.open, log: (l: string) => void logs.push(l) }, request);
    expect(sends).toHaveLength(1);
    expect(sends[0].agentId).toBe("agent-b");
    expect(sends[0].text).toMatch(/replacement/i);
    expect(sends[0].text).toMatch(/approv/i);
    fail = true;
    const before = notes(await w.feature(w.B)).length;
    await after({ paseo: () => paseoApi, open: w.s.open, log: (l: string) => void logs.push(l) }, request);
    expect(sends, "no retry").toHaveLength(2);
    const added = notes(await w.feature(w.B)).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/agent offline/);
  });
});

describe("R4.3 done prerequisite and removal (controls)", () => {
  it("a done feature cannot be reopened manually (feature_transition) and stays byte-identical", async () => {
    const w = await world({ bDone: true, bRun: false, c: "none" });
    const before = JSON.stringify(await w.feature(w.B));
    const out = await w.features.statusSet(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: w.B, status: "planned" }, UI_ORIGIN);
    expect(out.ok ? "ok" : out.error.code).toBe("feature_transition");
    expect(JSON.stringify(await w.feature(w.B))).toBe(before);
  });
});

// ---- R4.3 independent verification (T) ----
describe("R4.3 verification: replacement approval selection, old-receipt retry and deferred runs", () => {
  async function replacementApproved(w: World) {
    const d = ok(await w.plans.draft(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: w.B, planId: w.bPlan.planId, title: "B plan v2", sessionIds: [w.seed.sessionId], markdown: "# B v2", tasks: [{ id: "t1", title: "Build again", description: "", dod: "x" }] }, UI_ORIGIN));
    w.effects.replacements.length = 0;
    ok(await w.plans.approve(w.s.open, { projectId: w.s.P, planId: w.bPlan.planId, rev: (d as { rev?: number }).rev ?? 2, contentHash: d.contentHash }, UI_ORIGIN));
  }

  it("a RUNNING bound C is also requested (and steered once) when B's replacement is approved; its run is not touched by the approval", async () => {
    const w = await world({ c: "running", cBound: true });
    ok(await w.cancelA());
    const cRun = JSON.stringify(await w.run("run-c"));
    await replacementApproved(w);
    expect(req(await w.feature(w.C))).toMatchObject({ state: "requested", becauseOf: w.A });
    expect(w.effects.replacements).toEqual([{ projectId: w.s.P, featureId: w.C, agentId: "agent-c" }]);
    expect(JSON.stringify(await w.run("run-c")), "the approval does not mutate C's run").toBe(cRun);
  });

  it("a run-less C is requested too (selection is by dependency, whatever the run state)", async () => {
    const w = await world({ c: "none", cBound: true });
    ok(await w.cancelA());
    await replacementApproved(w);
    expect(req(await w.feature(w.C))).toMatchObject({ state: "requested", becauseOf: w.A });
  });

  it("real approval-effects retry of an OLDER receipt does not clear a request-only B (local clock seam, strictly later request)", async () => {
    const clock = { now: NOW_ISO }; // B's receipt was written at NOW_ISO by the shared support plans
    // Request-only with a VALID (older) receipt: B deferred from "created" (modelled), so the automatic
    // rework refuses (not planned or executing) while the receipt stays authoritative.
    const w = await world({ bRun: false, bDeferred: true, bDeferredFrom: "created", c: "none", clock });
    clock.now = "2026-12-01T00:00:00.000Z"; // the cancel (and its request) is strictly later than the receipt
    ok(await w.cancelA());
    const before = req(await w.feature(w.B));
    expect(before).toMatchObject({ state: "requested" });
    expect(before!.reworkedRev).toBeUndefined();
    // Re-running the approval of the same (older-receipt) revision replays the approval effects.
    const again = await w.plans.approve(w.s.open, { projectId: w.s.P, planId: w.bPlan.planId, rev: 1, contentHash: w.bPlan.contentHash }, UI_ORIGIN);
    expect(again.ok, again.ok ? "" : JSON.stringify(again.error)).toBe(true);
    expect(req(await w.feature(w.B)), "an older receipt never clears the request").toEqual(before);
  });

});

// R4 final KensAI c0008: when the automatic rework at cancel is refused, B's note (and a live run's end
// detail) must carry the reason reworkInDraft computed, not always the receipt cause. Reachable setup:
// B approved with a real, valid receipt and executing; the owner sends its latest revision for rework in
// the UI (plan.rework records plan.reworks, ends B's run in the same transaction and returns B to created).
// Cancelling A then reaches reworkInDraft's "already sent for rework" refusal while the receipt still
// matches on disk. The run-end detail is not reachable in this flow (the manual rework already ended the
// run), so only the note is asserted here; no synthetic live run is invented.
describe("R4 KensAI c0008: the refusal cause recorded for B is the computed one", () => {
  it("B already sent for rework (UI, receipt still valid): cancelling A records 'already sent for rework', never the receipt cause", async () => {
    const w = await world();
    ok(await w.plans.rework(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), planId: w.bPlan.planId, planRev: 1, reason: "owner rework" }, UI_ORIGIN));
    expect((await w.plan(w.bPlan.planId)).reworks?.map((r) => r.planRev), "precondition: revision 1 already sent for rework").toEqual([1]);
    expect((await readFile(w.s.env.receiptPath({ projectId: w.s.P, planId: w.bPlan.planId, planRev: 1 }), "utf8")).length, "precondition: the real receipt is still on disk").toBeGreaterThan(0);
    expect((await w.run("run-b"))?.state, "precondition: the manual rework ended B's run").toBe("ended");
    const before = notes(await w.feature(w.B)).length;
    ok(await w.cancelA());
    const added = notes(await w.feature(w.B)).slice(before);
    expect(added.length, "a cancel note for B").toBeGreaterThan(0);
    expect(added.join("\n"), "no false receipt cause").not.toMatch(/approval receipt/);
    expect(added.some((n) => /already sent for rework/.test(n)), `the computed cause: ${JSON.stringify(added)}`).toBe(true);
  });

  for (const mode of ["none", "mismatch"] as const) {
    it(`control: receipt ${mode} keeps the exact receipt wording in B's note`, async () => {
      const w = await world({ bReceipt: mode });
      const before = notes(await w.feature(w.B)).length;
      ok(await w.cancelA());
      const added = notes(await w.feature(w.B)).slice(before);
      expect(added).toContain("prerequisite Alpha cancelled; approval receipt missing or mismatched, so the plan was not reworked");
    });
  }
});

// R4 final corrective (root): STORED-DATA EDGE, not a live workflow. No command creates a bound plan
// without revisions (plans are created with their first draft), but the persisted Plan schema accepts
// `revisions: []`. Synthetic fixture: B's single bound plan is emptied through a direct store transact.
// Cancelling A must not name a cause that is false for this store ("more than one plan"); it names
// "the bound plan has no revisions" in the note it writes.
describe("R4 corrective: a single bound plan with no revisions (synthetic stored-data edge)", () => {
  it("cancelling A records 'the bound plan has no revisions', never 'more than one plan'", async () => {
    const w = await world({ bRun: false, c: "none" });
    await w.transact((draft) => {
      const p = draft.plans.find((x) => x.id === w.bPlan.planId)!;
      p.revisions = [];
      p.taskStates = [];
      p.approvals = [];
    });
    const stored = await w.plan(w.bPlan.planId);
    expect(stored.revisions, "precondition: the store accepted a bound plan with zero revisions").toEqual([]);
    expect((await w.data()).plans.filter((p) => p.featureId === w.B), "precondition: exactly one bound plan").toHaveLength(1);
    const before = notes(await w.feature(w.B)).length;
    ok(await w.cancelA());
    const added = notes(await w.feature(w.B)).slice(before);
    expect(added.join("\n"), "no false cause").not.toMatch(/more than one plan/);
    expect(added.some((n) => /the bound plan has no revisions/.test(n)), `the true cause: ${JSON.stringify(added)}`).toBe(true);
  });
});

// R4 successor KensAI c0039: a later prerequisite cancellation that reworks nothing must keep the earlier
// reworkedRev, or a retried approval (which reuses the durable receipt with its ORIGINAL time) can never
// clear the request. Reachable only through a failure: the r2 approval wrote its durable receipt but the
// project copy was not recorded (approval-copy transaction failed), so B stayed created.
// STORED-STATE RECOVERY FIXTURE (labelled): that failure is reproduced by writing r2's receipt through the
// real ApprovalStore without the project copy; every other step uses the real commands and clock.
describe("R4 successor c0039: an earlier reworkedRev survives a later refused rework", () => {
  it("A → B ← A2: rework at A's cancel, r2 receipt without copy, A2 cancelled, approval retried → request cleared and propagated", async () => {
    const clock = { now: "2026-11-01T10:00:00.000Z" };
    const w = await world({ clock });
    const a2 = await w.create("Alpha two");
    await w.transact((draft) => {
      draft.features.find((f) => f.id === w.B)!.dependsOn.push(a2); // MODELLED STATE (labelled): B also depends on A2
    });
    ok(await w.cancelA());
    expect(req(await w.feature(w.B)), "precondition: A's cancel reworked B's r1").toMatchObject({ reworkedRev: 1, becauseOf: w.A });
    clock.now = "2026-11-02T10:00:00.000Z";
    const d = ok(await w.plans.draft(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: w.B, planId: w.bPlan.planId, title: "B plan v2", sessionIds: [w.seed.sessionId], markdown: "# B v2", tasks: [{ id: "t1", title: "Build again", description: "", dod: "x" }] }, UI_ORIGIN));
    const r2 = (await w.plan(w.bPlan.planId)).revisions.find((r) => r.rev === 2)!;
    await w.s.approvals.write(receipt({ receiptId: "rcpt-b-r2", projectId: w.s.P, planId: w.bPlan.planId, planRev: 2, contentHash: d.contentHash, decisionSnapshotHash: r2.decisionSnapshotHash, at: clock.now }));
    expect((await w.plan(w.bPlan.planId)).approvals.some((a) => a.planRev === 2), "precondition: no project copy of the r2 approval").toBe(false);
    expect((await w.feature(w.B)).status, "precondition: B stayed created").toBe("created");
    clock.now = "2026-11-03T10:00:00.000Z";
    ok(await w.features.statusSet(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: a2, status: "cancelled" }, UI_ORIGIN));
    const after = req(await w.feature(w.B));
    expect(after, "A2's cancel rewrote the request").toMatchObject({ becauseOf: a2 });
    const stored = await w.s.approvals.read(w.s.P, w.bPlan.planId, 2);
    expect(stored?.at, "precondition: the durable receipt keeps its original time, before the new request").toBe("2026-11-02T10:00:00.000Z");
    expect(String(after?.at) > String(stored?.at)).toBe(true);
    expect(after, "the earlier reworkedRev is kept").toMatchObject({ reworkedRev: 1 });
    clock.now = "2026-11-04T10:00:00.000Z";
    ok(await w.plans.approve(w.s.open, { projectId: w.s.P, planId: w.bPlan.planId, rev: 2, contentHash: d.contentHash }, UI_ORIGIN));
    const b = await w.feature(w.B);
    expect(req(b), "the retried approval of r2 (> reworkedRev 1) clears B's request").toBeUndefined();
    expect(b.status).toBe("planned");
    expect(req(await w.feature(w.C)), "B's approval propagates the request to its dependent C").toBeDefined();
  });
});

// R4 final DeepSeek c0082 (T): a cancel of A and the human approval of a dependent D's revision are
// serialised per project. These controls run the two LEGAL orders through the real commands, stores
// and ApprovalStore and pin their safe outcomes; they hold before and after the serialisation fix.
// The forbidden interleaving (cancel's receipt snapshot taken before the receipt is published, the
// publish landing before the cancel commits) is not exercised here: see the RED report for the seam.
describe("R4 final DeepSeek c0082: cancel versus approval, serialised orders (controls)", () => {
  async function withDraftedD(w: World) {
    const D = await w.create("Delta", [w.A]);
    const tasks = [{ id: "t1", title: "Build", description: "", dod: "x" }];
    const d = ok(await w.s.plans.draft(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: D, title: "D plan", sessionIds: [w.seed.sessionId], markdown: "# D", tasks }, UI_ORIGIN));
    await w.transact((draft) => {
      draft.features.find((f) => f.id === D)!.grillSessionId = w.seed.sessionId;
      draft.plans.find((p) => p.id === d.planId)!.grillSessionId = w.seed.sessionId;
    });
    const approveD = async () => w.plans.approve(w.s.open, { projectId: w.s.P, planId: d.planId, rev: 1, contentHash: d.contentHash }, UI_ORIGIN);
    return { D, d, approveD };
  }

  it("approval first, then cancel: the cancel sees the receipt and reworks D (reworkedRev 1, no missing-receipt note)", async () => {
    const clock = { now: "2026-11-01T00:00:00.000Z" };
    const w = await world({ clock });
    const { D, approveD } = await withDraftedD(w);
    ok(await approveD());
    expect((await w.feature(D)).status, "precondition: the approval planned D").toBe("planned");
    clock.now = "2026-11-01T00:01:00.000Z";
    ok(await w.cancelA());
    const d = await w.feature(D);
    expect(d.status).toBe("created");
    expect(d.statusReason).toBe("plan in rework");
    expect(req(d)).toMatchObject({ becauseOf: w.A, reworkedRev: 1 });
    expect(notes(d).join("\n")).not.toMatch(/receipt missing|mismatch/i);
  });

  it("cancel first, then a later approval: D ends planned with its request cleared by the strictly later receipt", async () => {
    const clock = { now: "2026-11-01T00:00:00.000Z" };
    const w = await world({ clock });
    const { D, approveD } = await withDraftedD(w);
    ok(await w.cancelA());
    const before = await w.feature(D);
    expect(req(before), "the cancel requested a replacement for D").toMatchObject({ becauseOf: w.A });
    expect(req(before)?.reworkedRev, "nothing approved, nothing reworked").toBeUndefined();
    clock.now = "2026-11-01T00:01:00.000Z";
    ok(await approveD());
    const d = await w.feature(D);
    expect(d.status).toBe("planned");
    expect(req(d), "no request is left on a feature whose latest revision is approved").toBeUndefined();
  });
});

// R4 final DeepSeek c0082 durable RED (lock plan §2): the cancel's receipt snapshot is taken, then the
// approval races to publish D's receipt before the cancel commits. Future seam: an optional
// `projectSection<T>(key, run)` on FeatureDeps/PlanDeps, passed here as an extra structural property
// (ignored by the current code). Both wrappers use one TEST-local mutex. Release signals only, no
// timers: the held cancel resumes on whichever comes first, the real publish (current code: the race)
// or the approval asking for its section (fixed code: the cancel finishes first, the approval later).
describe("R4 final DeepSeek c0082: cancel receipt snapshot versus a concurrent approval publish", () => {
  it("both succeed; D's latest revision is approved with no leftover request, and no note claims a missing receipt after it existed", async () => {
    // Local clock seam that advances on every read, so event and receipt times are strictly ordered.
    let tick = 0;
    const clock = {
      get now() {
        return new Date(Date.parse("2026-11-01T00:00:00.000Z") + 1000 * tick++).toISOString();
      },
    };
    const w = await world({ clock });
    const D = await w.create("Delta", [w.A]);
    const d = ok(await w.s.plans.draft(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: D, title: "D plan", sessionIds: [w.seed.sessionId], markdown: "# D", tasks: [{ id: "t1", title: "Build", description: "", dod: "x" }] }, UI_ORIGIN));
    await w.transact((draft) => {
      draft.features.find((f) => f.id === D)!.grillSessionId = w.seed.sessionId;
      draft.plans.find((p) => p.id === d.planId)!.grillSessionId = w.seed.sessionId;
    });

    const signal = () => {
      let resolve!: () => void;
      const p = new Promise<void>((r) => (resolve = r));
      return { p, resolve };
    };
    const cancelHeld = signal();
    const published = signal();
    const approveWantsSection = signal();
    const cancelSettled = signal();
    let releasedBy: "published" | "approveWantsSection" | undefined;

    // TEST-local per-key mutex (chain semantics), shared by both wrappers.
    const tails = new Map<string, Promise<unknown>>();
    const mutex = async <T,>(key: string, run: () => Promise<T>): Promise<T> => {
      const before = tails.get(key) ?? Promise.resolve();
      const result = before.then(run, run);
      tails.set(key, result.catch(() => undefined));
      return result;
    };
    const cancelSection = async <T,>(key: string, run: () => Promise<T>): Promise<T> => mutex(key, run);
    const approveSection = async <T,>(key: string, run: () => Promise<T>): Promise<T> => {
      approveWantsSection.resolve();
      return mutex(key, run);
    };

    const real = w.s.approvals;
    const cancelApprovals: ApprovalStore = {
      write: async (r) => real.write(r),
      read: async (projectId, planId, rev) => {
        const out = await real.read(projectId, planId, rev);
        if (planId === d.planId) {
          cancelHeld.resolve();
          releasedBy = await Promise.race([published.p.then(() => "published" as const), approveWantsSection.p.then(() => "approveWantsSection" as const)]);
        }
        return out;
      },
    };
    const approveApprovals: ApprovalStore = {
      read: async (projectId, planId, rev) => real.read(projectId, planId, rev),
      write: async (r) => {
        const out = await real.write(r);
        published.resolve();
        await cancelSettled.p;
        return out;
      },
    };
    const { createFeatureCommands } = await import("./features");
    const { createPlanCommands } = await import("./plans");
    const featureDeps = { ...w.deps, approvals: cancelApprovals, projectSection: cancelSection };
    const planDeps = { ...w.deps, approvals: approveApprovals, projectSection: approveSection };
    const features2 = createFeatureCommands(featureDeps as Parameters<typeof createFeatureCommands>[0]);
    const plans2 = createPlanCommands(planDeps as Parameters<typeof createPlanCommands>[0]);

    let cancel: Awaited<ReturnType<typeof features2.statusSet>> | undefined;
    let approve: Awaited<ReturnType<typeof plans2.approve>> | undefined;
    try {
      const cancelP = features2.statusSet(w.s.open, { projectId: w.s.P, expectedRevision: await w.s.revision(), featureId: w.A, status: "cancelled" }, UI_ORIGIN).finally(() => cancelSettled.resolve());
      // A cancel that settles without reaching D's receipt read must not strand the test.
      await Promise.race([cancelHeld.p, cancelP]);
      const approveP = plans2.approve(w.s.open, { projectId: w.s.P, planId: d.planId, rev: 1, contentHash: d.contentHash }, UI_ORIGIN);
      [cancel, approve] = await Promise.all([cancelP, approveP]);
    } finally {
      // Every gate is released whatever happened, so no wrapper stays pending after the test.
      cancelHeld.resolve();
      published.resolve();
      approveWantsSection.resolve();
      cancelSettled.resolve();
    }
    expect(releasedBy, "precondition: the cancel was held after its real receipt read for D").toBeDefined();
    expect(cancel?.ok, "the cancel succeeds").toBe(true);
    expect(approve?.ok, "the approval succeeds").toBe(true);

    const plan = await w.plan(d.planId);
    const latestRev = plan.revisions.at(-1)!.rev;
    const receipt = await real.read(w.s.P, d.planId, latestRev);
    expect(receipt, "D's latest revision has a real approval receipt").not.toBeNull();
    const feature = await w.feature(D);
    const missing = feature.events.filter((e) => e.kind === "note" && /receipt missing or mismatched/.test((e as { reason?: string }).reason ?? ""));
    const diagnostic = JSON.stringify({ releasedBy, receiptAt: receipt?.at, request: req(feature), notes: feature.events.filter((e) => e.kind === "note") });
    for (const e of missing) expect(Date.parse(e.at), `a missing-receipt note may only precede the receipt (${diagnostic})`).toBeLessThan(Date.parse(receipt!.at));
    expect(req(feature), `no leftover request on a feature whose latest revision is approved (${diagnostic})`).toBeUndefined();
  });
});

// R4 exact-final DeepSeek c0124 (T): `feature.status.set` declares a Result. A UI cancel whose
// dependent receipt read fails, or whose project cannot be opened, must resolve the existing failure
// codes (fail closed: no commit, no effects), never reject. The critical section is released after
// the failure, so the next cancel of the same project still runs.
describe("R4 exact-final DeepSeek c0124: a failing cancel returns its Result", () => {
  const snapshot = async (w: World) => ({ revision: await w.s.revision(), data: JSON.stringify(await w.data()) });

  it("a receipt read failing with EACCES resolves { ok: false, code: 'internal' }; nothing is committed or delivered; the section is released", async () => {
    const w = await world();
    const real = w.s.approvals;
    const failing: ApprovalStore = {
      write: async (r) => real.write(r),
      read: async (projectId, planId, rev) => {
        if (planId === w.bPlan.planId) throw Object.assign(new Error("EACCES: permission denied (synthetic)"), { code: "EACCES" });
        return real.read(projectId, planId, rev);
      },
    };
    const deps = { ...w.deps, approvals: failing };
    const { createFeatureCommands } = await import("./features");
    const features = createFeatureCommands(deps as Parameters<typeof createFeatureCommands>[0]);
    const before = await snapshot(w);
    const settled = features.statusSet(w.s.open, { projectId: w.s.P, expectedRevision: before.revision, featureId: w.A, status: "cancelled" }, UI_ORIGIN);
    await expect(settled, "the declared Result channel, not a rejection").resolves.toMatchObject({ ok: false, error: { code: "internal" } });
    expect(await snapshot(w), "fail closed: store revision and data unchanged").toEqual(before);
    expect(w.effects, "no run effect or replacement steer").toEqual({ runs: [], replacements: [] });
    // The project's critical section was released: a later cancel with readable receipts proceeds.
    ok(await w.cancelA());
    expect((await w.feature(w.A)).status).toBe("cancelled");
  });

  it("an opener failing with unknown_project resolves { ok: false, code: 'unknown_project' } for a UI cancel, as it already does for a deferral", async () => {
    const w = await world();
    const missing = async (): Promise<never> => {
      throw new DomainError("unknown_project", "no such project (synthetic)");
    };
    const before = await snapshot(w);
    const deferral = w.features.statusSet(missing, { projectId: w.s.P, expectedRevision: before.revision, featureId: w.A, status: "deferred" }, UI_ORIGIN);
    await expect(deferral, "control: the non-cancel path returns its Result").resolves.toMatchObject({ ok: false, error: { code: "unknown_project" } });
    const cancel = w.features.statusSet(missing, { projectId: w.s.P, expectedRevision: before.revision, featureId: w.A, status: "cancelled" }, UI_ORIGIN);
    await expect(cancel, "the UI cancel returns the same Result").resolves.toMatchObject({ ok: false, error: { code: "unknown_project" } });
    expect(await snapshot(w)).toEqual(before);
    expect(w.effects).toEqual({ runs: [], replacements: [] });
  });
});
