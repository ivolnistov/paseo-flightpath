// Stage R3.1 (task card 2026-10-29 R3 §2.2, §2.3): run start authorisation, pause/resume, budget,
// tokens and delegation revoke over a real temp store. `./runs` is new in R3.1: it is loaded from
// the module namespace and its factory is checked before use, so this file collects at R2.
// Chosen interface (consistent with createPlanCommands): `createRunCommands(deps)` with
// deps = RoadmapServiceDeps & { approvals: ApprovalStore; settings: () => Promise<RoadmapSettings> }
// (the ceiling is `repairCeiling`); writes take (open, input, origin), reads take (open, input).
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ExecutionRun, Feature } from "../shared/model";
import { roadmapSettings } from "../shared/settings";
import type { CheckOutcome } from "./check-runner";
import type { ReviewOutcome } from "./review-runner";
import type { RunCommands } from "./runs";
import { UI_ORIGIN, type WriteOrigin } from "./sessions";
import { fixedClock, NOW_ISO, nextId } from "./test-support/build";
import { makePlanProject, type PlanProject } from "./test-support/plans";

// The review request fields these tests read: binding passes through unchanged (z.unknown), items need their index.
const ReviewRequest = z.object({ binding: z.unknown(), dod: z.object({ items: z.array(z.object({ index: z.number() })) }) });

const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent" }, quoted: "start it" };
const CEILING = 3;
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

const loadRuns = async () => {
  const mod: Record<string, unknown> = await import("./runs");
  expect(typeof mod.createRunCommands, "server/runs exports createRunCommands").toBe("function");
  return import("./runs");
};

/** A feature with an approved, current, bound plan (t1; t2 depends on t1); the feature is planned. */
async function approved(opts: { dependsOn?: "created" | "done"; dod?: string; completion?: "auto" | "human"; noTasks?: boolean } = {}) {
  t = await makePlanProject();
  const s = t;
  const seed = await s.seedAnswered();
  const { createFeatureCommands } = await import("./features");
  const deps = { directory: () => { throw new Error("unused"); }, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } };
  const features = createFeatureCommands(deps);
  let prerequisite: string | undefined;
  if (opts.dependsOn) {
    prerequisite = ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Prerequisite", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
  }
  const featureId = ok(
    await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Search", description: "", kind: "feature", ...(prerequisite ? { dependsOn: [prerequisite] } : {}) }, UI_ORIGIN),
  ).featureId;
  const tasks = [
    { id: "t1", title: "Build", description: "", dod: opts.dod ?? "x", ...(opts.completion ? { completion: opts.completion } : {}) },
    { id: "t2", title: "Ship", description: "", dod: "y", dependsOn: ["t1"] },
  ];
  const d = ok(await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId, title: "Rollout", sessionIds: [seed.sessionId], markdown: "# R", tasks: opts.noTasks ? [] : tasks }, UI_ORIGIN));
  const transact = async (fn: Parameters<Awaited<ReturnType<typeof s.open>>["transact"]>[1]) => (await s.open(s.P)).transact(await s.revision(), fn);
  await transact((draft) => {
    draft.features.find((f) => f.id === featureId)!.grillSessionId = seed.sessionId;
    draft.plans.find((p) => p.id === d.planId)!.grillSessionId = seed.sessionId;
    if (prerequisite && opts.dependsOn === "done") {
      const p = draft.features.find((f) => f.id === prerequisite)!;
      p.status = "done";
    }
  });
  ok(await s.plans.approve(s.open, { projectId: s.P, planId: d.planId, rev: 1, contentHash: d.contentHash }, UI_ORIGIN));
  const { createRunCommands } = await loadRuns();
  const runs = createRunCommands({ ...deps, approvals: s.approvals, settings: async () => roadmapSettings.schema.parse({ repairCeiling: CEILING }) });
  const data = async () => {
    const read = await (await s.open(s.P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data;
  };
  const feature = async (): Promise<Feature> => (await data()).features.find((f) => f.id === featureId)!;
  const allRuns = async (): Promise<ExecutionRun[]> => (await data()).runs;
  const snapshot = async () => ({ revision: await s.revision(), data: JSON.stringify(await data()) });
  const bindCoordinator = () =>
    transact((draft) => {
      draft.features.find((f) => f.id === featureId)!.coordinator = { agentId: "agent-c", workspaceId: "ws-1", boundAt: NOW_ISO, profileRef: "team-coordinator" };
    });
  const start = async (extra: { profileRef?: string; origin?: WriteOrigin } = {}) =>
    runs.start(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId, ...(extra.profileRef ? { profileRef: extra.profileRef } : {}) }, extra.origin ?? UI_ORIGIN);
  const tokenOf = async (runId: string) => (await allRuns()).find((r) => r.id === runId)!.runToken;
  const mut = async (x: { runId: string; runToken?: string }) => ({ projectId: s.P, expectedRevision: await s.revision(), runId: x.runId, runToken: x.runToken ?? (await tokenOf(x.runId)) });
  const editRun = (runId: string, fn: (r: ExecutionRun, f: Feature) => void) =>
    transact((draft) => {
      fn(draft.runs.find((r) => r.id === runId)!, draft.features.find((f) => f.id === featureId)!);
    });
  const noWrite = async (attempt: () => Promise<R<unknown>>, code: string) => {
    const before = await snapshot();
    const e = err(await attempt());
    expect(e.code, e.message).toBe(code);
    expect(await snapshot()).toEqual(before);
    return e;
  };
  const started = async () => {
    await bindCoordinator();
    ok(await start());
    const r = (await allRuns())[0];
    return r;
  };
  const runDeps = { ...deps, settings: async () => roadmapSettings.schema.parse({ repairCeiling: CEILING }) };
  return { ...s, seed, features, featureId, prerequisite, d, runs, runDeps, createRunCommands, data, feature, allRuns, snapshot, bindCoordinator, start, mut, editRun, noWrite, started, transact };
}

describe("R3.1 run.start authorisation and target", () => {
  it("without a bound coordinator and without profileRef the start is invalid_input and writes no run", async () => {
    const s = await approved();
    const e = await s.noWrite(() => s.start(), "invalid_input");
    expect(e.message).toContain("choose a coordinator profile or bind an existing chat");
    expect(await s.allRuns()).toEqual([]);
  });

  // R3.4 verification repair: R3.4 now creates the coordinator from a profile. This fixture has no Paseo
  // SDK dependency, so the profile start is refused as coordinator_unavailable (no unbound run recorded).
  it("a profileRef without a bound coordinator and without a reachable Paseo SDK is run_not_ready (coordinator_unavailable), with no write and no run", async () => {
    const s = await approved();
    const e = await s.noWrite(() => s.start({ profileRef: "team-coordinator" }), "run_not_ready");
    expect(JSON.stringify(e.details)).toContain("coordinator_unavailable");
    expect(await s.allRuns()).toEqual([]);
  });

  it("a chat origin is invalid_input with no write", async () => {
    const s = await approved();
    await s.bindCoordinator();
    await s.noWrite(() => s.start({ origin: CHAT }), "invalid_input");
  });

  it("with a bound coordinator: one running run on the latest approved revision; the feature becomes executing; a repeated start returns the same run", async () => {
    const s = await approved();
    await s.bindCoordinator();
    expect((await s.feature()).status, "precondition: approval planned the feature").toBe("planned");
    const statusEventsBefore = (await s.feature()).events.filter((e) => e.kind === "status").length;
    ok(await s.start());
    const runs = await s.allRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run).toMatchObject({ featureId: s.featureId, planId: s.d.planId, planRev: 1, state: "running", startAuth: { kind: "ui" }, acks: [], lateEvidence: [] });
    expect(typeof run.runToken).toBe("string");
    expect(run.tasks).toEqual([
      { taskId: "t1", state: "todo", failedCycles: 0, extraBudget: 0, unresolved: [] },
      { taskId: "t2", state: "todo", failedCycles: 0, extraBudget: 0, unresolved: [] },
    ]);
    expect(run.events.map((e) => e.kind)).toEqual(["started"]);
    const f = await s.feature();
    expect(f.status).toBe("executing");
    expect(f.everStarted).toBe(true);
    const statusEvents = f.events.filter((e) => e.kind === "status");
    expect(statusEvents).toHaveLength(statusEventsBefore + 1);
    expect(statusEvents.at(-1)).toMatchObject({ from: "planned", to: "executing" });
    ok(await s.start());
    const again = await s.allRuns();
    expect(again.map((r) => r.id)).toEqual([run.id]);
    expect(again[0].runToken).toBe(run.runToken);
  });

  it("an unapproved latest revision or a no-longer-current approval refuses the start with run_not_ready (approval_not_current) and no write", async () => {
    const s = await approved();
    await s.bindCoordinator();
    const out = await s.project.service.decisionCancel(s.project.paseo, { projectId: s.P, expectedRevision: await s.revision(), ...s.seed.q1, reason: "Dropped" });
    if (!out.ok) throw new Error(`cancel failed: ${out.error.code}`);
    const e = await s.noWrite(() => s.start(), "run_not_ready");
    expect(JSON.stringify(e.details)).toContain("approval_not_current");
    const s2 = await approved();
    await s2.bindCoordinator();
    ok(await s2.plans.draft(s2.open, { projectId: s2.P, expectedRevision: await s2.revision(), planId: s2.d.planId, featureId: s2.featureId, title: "Rollout", sessionIds: [s2.seed.sessionId], markdown: "# R2", tasks: [{ id: "t1", title: "Build", description: "", dod: "x" }] }, UI_ORIGIN));
    const e2 = await s2.noWrite(() => s2.start(), "run_not_ready");
    expect(JSON.stringify(e2.details)).toContain("approval_not_current");
  });

  it("a reworked latest revision starts nothing", async () => {
    const s = await approved();
    await s.bindCoordinator();
    ok(await s.plans.rework(s.open, { projectId: s.P, expectedRevision: await s.revision(), planId: s.d.planId, planRev: 1, reason: "Scope" }, UI_ORIGIN));
    const before = await s.snapshot();
    expect((await s.start()).ok).toBe(false);
    expect(await s.snapshot()).toEqual(before);
    expect(await s.allRuns()).toEqual([]);
  });

  it("a prerequisite feature that is not done starts the run paused (prerequisite_not_done); done starts it running", async () => {
    const s = await approved({ dependsOn: "created" });
    await s.bindCoordinator();
    ok(await s.start());
    expect((await s.allRuns())[0]).toMatchObject({ state: "paused", pauseReason: "prerequisite_not_done" });
    const s2 = await approved({ dependsOn: "done" });
    await s2.bindCoordinator();
    ok(await s2.start());
    expect((await s2.allRuns())[0].state).toBe("running");
  });
});

describe("R3.1 pause, resume, tokens and ended runs", () => {
  it("pause and resume change the state and only append events", async () => {
    const s = await approved();
    const run = await s.started();
    ok(await s.runs.pause(s.open, await s.mut({ runId: run.id }), UI_ORIGIN));
    const paused = (await s.allRuns())[0];
    expect(paused).toMatchObject({ state: "paused", pauseReason: "owner" });
    expect(paused.events.slice(0, run.events.length)).toEqual(run.events);
    expect(paused.events.length).toBeGreaterThan(run.events.length);
    ok(await s.runs.resume(s.open, await s.mut({ runId: run.id }), UI_ORIGIN));
    const resumed = (await s.allRuns())[0];
    expect(resumed.state).toBe("running");
    expect(resumed.events.slice(0, paused.events.length)).toEqual(paused.events);
    expect(resumed.events.length).toBeGreaterThan(paused.events.length);
  });

  it("a stale runToken is run_stale with no write; a chat origin is invalid_input", async () => {
    const s = await approved();
    const run = await s.started();
    await s.noWrite(async () => s.runs.pause(s.open, await s.mut({ runId: run.id, runToken: "not-the-token" }), UI_ORIGIN), "run_stale");
    await s.noWrite(async () => s.runs.pause(s.open, await s.mut({ runId: run.id }), CHAT), "invalid_input");
  });

  it("any mutation of an ended run is run_stale with no write", async () => {
    const s = await approved();
    const run = await s.started();
    await s.editRun(run.id, (r) => {
      r.state = "ended";
      r.endReason = "finished";
    });
    await s.noWrite(async () => s.runs.pause(s.open, await s.mut({ runId: run.id }), UI_ORIGIN), "run_stale");
    await s.noWrite(async () => s.runs.resume(s.open, await s.mut({ runId: run.id }), UI_ORIGIN), "run_stale");
  });

  it("a run paused for deferred cannot resume while the feature is deferred (run_not_ready)", async () => {
    const s = await approved();
    const run = await s.started();
    await s.editRun(run.id, (r, f) => {
      r.state = "paused";
      r.pauseReason = "deferred";
      f.status = "deferred";
      f.statusBeforeDefer = "executing";
    });
    await s.noWrite(async () => s.runs.resume(s.open, await s.mut({ runId: run.id }), UI_ORIGIN), "run_not_ready");
  });
});

describe("R3.1 run.budget.grant", () => {
  const grant = async (s: Awaited<ReturnType<typeof approved>>, runId: string, taskId: string, cycles: number) =>
    s.runs.budgetGrant(s.open, { ...(await s.mut({ runId })), taskId, cycles }, UI_ORIGIN);

  it("only at the ceiling: adds cycles to extraBudget, keeps failedCycles, reopens only under the raised bound, appends budget_granted", async () => {
    const s = await approved();
    const run = await s.started();
    await s.noWrite(() => grant(s, run.id, "t1", 1), "invalid_input");
    await s.editRun(run.id, (r) => {
      r.tasks[0] = { ...r.tasks[0], state: "ceiling", failedCycles: CEILING + 2 };
    });
    const eventsBefore = (await s.allRuns())[0].events;
    ok(await grant(s, run.id, "t1", 1));
    let t1 = (await s.allRuns())[0].tasks[0];
    expect(t1).toMatchObject({ state: "ceiling", failedCycles: CEILING + 2, extraBudget: 1 });
    ok(await grant(s, run.id, "t1", 2));
    t1 = (await s.allRuns())[0].tasks[0]!;
    expect(t1).toMatchObject({ state: "todo", failedCycles: CEILING + 2, extraBudget: 3 });
    const events = (await s.allRuns())[0].events;
    expect(events.slice(0, eventsBefore.length)).toEqual(eventsBefore);
    expect(events.slice(eventsBefore.length).map((e) => e.kind)).toEqual(["budget_granted", "budget_granted"]);
  });
});

describe("R3.1 delegation.revoke and reads", () => {
  it("revoke sets revokedAt and leaves the running run untouched; run.get and run.list read without writing", async () => {
    const s = await approved();
    const run = await s.started();
    await s.transact((draft) => {
      draft.delegations.push({ id: "del-1", scope: "feature", featureId: s.featureId, grantedAt: NOW_ISO, provenance: { agentId: "agent-1", seqStart: 1, timestamp: NOW_ISO, quoted: "start it" } });
    });
    const runBefore = JSON.stringify((await s.allRuns())[0]);
    ok(await s.runs.revokeDelegation(s.open, { projectId: s.P, expectedRevision: await s.revision(), delegationId: "del-1" }, UI_ORIGIN));
    const d = (await s.data()).delegations.find((x) => x.id === "del-1")!;
    expect(typeof d.revokedAt).toBe("string");
    expect(JSON.stringify((await s.allRuns())[0])).toBe(runBefore);
    const before = await s.snapshot();
    const got = ok(await s.runs.get(s.open, { projectId: s.P, runId: run.id }));
    expect(JSON.stringify(got)).toContain(run.id);
    const listed = ok(await s.runs.list(s.open, { projectId: s.P, featureId: s.featureId }));
    expect(JSON.stringify(listed)).toContain(run.id);
    expect(await s.snapshot()).toEqual(before);
  });
});

// R3.1 verification controls (root-authorised): authority is the durable receipt, never the project
// copy; and a resume re-checks approval currency.
describe("R3.1 start and resume authority", () => {
  it("a matching project approval copy without its durable receipt does not start a run (approval_not_current, no write)", async () => {
    const s = await approved();
    await s.bindCoordinator();
    const plan = (await s.data()).plans.find((p) => p.id === s.d.planId)!;
    expect(plan.approvals.map((c) => c.planRev), "precondition: the project copy matches rev 1").toEqual([1]);
    expect(await s.approvals.read(s.P, s.d.planId, 1), "precondition: the receipt exists on disk").not.toBeNull();
    // The same real state, seen through an approval store that withholds the receipt.
    const withheld = s.createRunCommands({ ...s.runDeps, approvals: { read: async () => null, write: (r) => s.approvals.write(r) } });
    const e = await s.noWrite(async () => withheld.start(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId: s.featureId }, UI_ORIGIN), "run_not_ready");
    expect(JSON.stringify(e.details)).toContain("approval_not_current");
    expect(await s.allRuns()).toEqual([]);
    // Control: the real store (receipt present) starts the run.
    ok(await s.start());
    expect((await s.allRuns()).map((r) => r.state)).toEqual(["running"]);
  });

  it("resume after the approved basis was cancelled is run_not_ready (approval_not_current) with no write", async () => {
    const s = await approved();
    const run = await s.started();
    ok(await s.runs.pause(s.open, await s.mut({ runId: run.id }), UI_ORIGIN));
    const out = await s.project.service.decisionCancel(s.project.paseo, { projectId: s.P, expectedRevision: await s.revision(), ...s.seed.q1, reason: "Dropped" });
    if (!out.ok) throw new Error(`cancel failed: ${out.error.code}`);
    const e = await s.noWrite(async () => s.runs.resume(s.open, await s.mut({ runId: run.id }), UI_ORIGIN), "run_not_ready");
    expect(JSON.stringify(e.details)).toContain("approval_not_current");
    expect((await s.allRuns())[0].state).toBe("paused");
  });
});

// Stage R3.3 (task card 2026-10-29 R3 §4.2, §4.2a): server-owned verification cycles, failure
// accounting, acceptance and the evidence listing. beginVerification and recordVerification are
// internal createRunCommands methods (no RPC, no MCP tool); the current worktree identity comes from
// the injected RunDeps.identity reader (a fake here). Runner outcomes are built as CheckOutcome and
// ReviewOutcome values (the runners are tested separately).
describe("R3.3 verification cycles, acceptance and evidence listing", () => {
  type Ev = import("../shared/model").Evidence;
  type Identity = import("../shared/model").WorktreeIdentity;
  const ID: Identity = { headCommit: "a".repeat(40), indexTreeHash: "b".repeat(64), worktreeTreeHash: "c".repeat(64), untrackedHash: "d".repeat(64) };
  const DRIFTED: Identity = { ...ID, headCommit: "9".repeat(40) };
  const DOD = "- [check] npm test\nDocs are updated";

  async function cycle(opts: { completion?: "auto" | "human"; ceilingFailed?: number; deps?: Record<string, unknown> } = {}) {
    const s = await approved({ dod: DOD, ...(opts.completion ? { completion: opts.completion } : {}) });
    const run = await s.started();
    const reader = { current: ID as Identity | { notReady: "unmerged" } | null };
    const runs = s.createRunCommands({ ...s.runDeps, approvals: s.approvals, identity: async () => reader.current, ...(opts.deps ?? {}) });
    const missingReader = s.createRunCommands({ ...s.runDeps, approvals: s.approvals });
    await s.editRun(run.id, (r) => {
      r.tasks[0] = { ...r.tasks[0], state: "in_progress", agentId: "agent-w", failedCycles: opts.ceilingFailed ?? 0 };
    });
    const binding = { taskId: "t1", planId: s.d.planId, planRev: 1, contentHash: s.d.contentHash, runToken: run.runToken, worktree: ID };
    let n = 0;
    const ev = (kind: Ev["kind"], result: Ev["result"], itemIndex?: number): Ev => ({ id: `ev-${++n}`, kind, taskId: "t1", binding, at: NOW_ISO, result, ...(itemIndex !== undefined ? { itemIndex } : {}) });
    const checks = (result: "pass" | "fail"): CheckOutcome => ({ evidence: [ev("check", result, 0)], late: [], result });
    const review = (status: "pass" | "fail" | "pending"): ReviewOutcome =>
      status === "pending"
        ? { status, evidence: [], late: [], reason: "no review command configured" }
        : { status, evidence: [ev("review", status, 1), ev("review", status)], late: [] };
    const ref = { projectId: s.P, runId: run.id, runToken: run.runToken, taskId: "t1" };
    const begin = (cmds = runs, b = binding) => cmds.beginVerification(s.open, { ...ref, binding: b });
    const record = (cycleId: string, c: CheckOutcome, r?: ReviewOutcome, x: { runToken?: string } = {}) =>
      runs.recordVerification(s.open, { ...ref, ...(x.runToken ? { runToken: x.runToken } : {}), cycleId, binding, checks: c, ...(r ? { review: r } : {}) });
    const t1 = async () => (await s.allRuns())[0].tasks[0];
    const theRun = async () => (await s.allRuns())[0];
    const planState = async () => (await s.data()).plans.find((p) => p.id === s.d.planId)!.taskStates.find((x) => x.planRev === 1 && x.taskId === "t1");
    return { ...s, run, reader, runs, missingReader, binding, ev, checks, review, begin, record, t1, theRun, planState };
  }
  const exists = (c: Awaited<ReturnType<typeof cycle>>) => {
    for (const name of ["beginVerification", "recordVerification", "accept", "evidenceList"]) expect(name in c.runs, `run commands expose ${name} (R3.3)`).toBe(true);
  };

  it("beginVerification moves in_progress to checks_pending with the binding and a server cycle id; off-identity, unreadable or reader-less begins write nothing", async () => {
    const c = await cycle();
    exists(c);
    for (const [label, setup] of [["drift", () => (c.reader.current = DRIFTED)], ["null", () => (c.reader.current = null)], ["unmerged", () => (c.reader.current = { notReady: "unmerged" })]] as const) {
      setup();
      await c.noWrite(() => c.begin(), "invalid_input");
      expect((await c.t1()).state, label).toBe("in_progress");
    }
    c.reader.current = ID;
    await c.noWrite(() => c.begin(c.missingReader), "invalid_input");
    const out = ok(await c.begin());
    expect(typeof out.cycleId).toBe("string");
    const t = await c.t1();
    expect(t).toMatchObject({ state: "checks_pending", binding: c.binding });
    expect((await c.theRun()).events.at(-1)).toMatchObject({ kind: "cycle_started", taskId: "t1", detail: out.cycleId });
  });

  it("a passing cycle verifies the task and mirrors the plan TaskState for that exact revision", async () => {
    const c = await cycle();
    exists(c);
    const { cycleId } = ok(await c.begin());
    expect(ok(await c.record(cycleId, c.checks("pass"), c.review("pass"))).state).toBe("verified");
    expect((await c.t1()).state).toBe("verified");
    expect(await c.planState()).toMatchObject({ taskId: "t1", planRev: 1, status: "verified", verification: { note: "verified by checks and review" } });
    const r = await c.theRun();
    expect((r.evidence ?? []).filter((e) => e.taskId === "t1").map((e) => [e.kind, e.itemIndex ?? "overall", e.result])).toEqual([["check", 0, "pass"], ["review", 1, "pass"], ["review", "overall", "pass"]]);
    expect(r.events.map((e) => e.kind)).toContain("cycle_recorded");
  });

  it("a failed cycle counts once (repeated record is idempotent), keeps the agent, and a later passing cycle at the same binding verifies", async () => {
    const c = await cycle();
    exists(c);
    const first = ok(await c.begin()).cycleId;
    expect(ok(await c.record(first, c.checks("fail"))).state).toBe("in_progress");
    expect(await c.t1()).toMatchObject({ state: "in_progress", failedCycles: 1, agentId: "agent-w" });
    expect((await c.theRun()).events.map((e) => e.kind)).toContain("cycle_failed");
    const before = await c.snapshot();
    ok(await c.record(first, c.checks("fail")));
    expect(await c.snapshot(), "a second record of the same cycle changes nothing").toEqual(before);
    const second = ok(await c.begin()).cycleId;
    expect(second).not.toBe(first);
    expect(ok(await c.record(second, c.checks("pass"), c.review("pass"))).state).toBe("verified");
    expect((await c.t1()).failedCycles, "failedCycles is never reset").toBe(1);
  });

  it("reaching the ceiling marks the task run ceiling with a ceiling_reached event", async () => {
    const c = await cycle({ ceilingFailed: CEILING - 1 });
    exists(c);
    const id = ok(await c.begin()).cycleId;
    ok(await c.record(id, c.checks("pass"), c.review("fail")));
    expect(await c.t1()).toMatchObject({ state: "ceiling", failedCycles: CEILING });
    expect((await c.theRun()).events.map((e) => e.kind)).toEqual(expect.arrayContaining(["cycle_failed", "ceiling_reached"]));
  });

  it("no review command: review_pending with the unresolved reason, no failed cycle; a new begin from review_pending opens a new cycle", async () => {
    const c = await cycle();
    exists(c);
    const id = ok(await c.begin()).cycleId;
    expect(ok(await c.record(id, c.checks("pass"), c.review("pending"))).state).toBe("review_pending");
    expect(await c.t1()).toMatchObject({ state: "review_pending", failedCycles: 0, unresolved: ["no review command configured"] });
    const again = ok(await c.begin()).cycleId;
    expect(again).not.toBe(id);
    expect((await c.t1()).state).toBe("checks_pending");
  });

  // R3.4 (card §5.2 "Verification cycle retirement"): this R3.3 case is adapted. On the task's open cycle
  // with the run's token, drift, an unreadable identity and a paused run now RETIRE the cycle (late
  // evidence kept, cycle_retired "<cycleId>|<reason>", task in_progress with the same worker, binding
  // cleared, unresolved set, failedCycles and extraBudget unchanged). A stale token stays late only.
  it("drift, an unreadable identity or a paused run on the open cycle retire it; a stale token is late only with no state change", async () => {
    const cases: Array<[string, (c: Awaited<ReturnType<typeof cycle>>) => Promise<void>, string, RegExp]> = [
      ["drift", async (c) => void (c.reader.current = DRIFTED), "worktree_drift", /worktree changed/],
      ["unreadable", async (c) => void (c.reader.current = null), "identity_unavailable", /identity unavailable/],
      ["paused", async (c) => {
        await c.editRun(c.run.id, (r) => {
          r.state = "paused";
          r.pauseReason = "owner";
        });
      }, "run_paused", /run paused/],
    ];
    for (const [label, arrange, reason, note] of cases) {
      const c = await cycle();
      exists(c);
      const id = ok(await c.begin()).cycleId;
      await arrange(c);
      const before = await c.theRun();
      await c.record(id, c.checks("pass"), c.review("pass"));
      const after = await c.theRun();
      expect(after.evidence ?? [], label).toEqual(before.evidence ?? []);
      const late = after.lateEvidence.slice(before.lateEvidence.length);
      expect(late.length, label).toBeGreaterThan(0);
      expect(late.every((e) => e.lateReason === reason), `${label}: ${JSON.stringify(late.map((e) => e.lateReason))}`).toBe(true);
      const task = after.tasks[0];
      expect(task, label).toMatchObject({ state: "in_progress", agentId: "agent-w", failedCycles: 0, extraBudget: 0 });
      expect(task.binding, `${label}: binding cleared`).toBeUndefined();
      expect(task.unresolved, label).toHaveLength(1);
      expect(task.unresolved[0], label).toMatch(note);
      expect(after.events.filter((e) => e.kind === "cycle_retired"), label).toEqual([expect.objectContaining({ taskId: "t1", detail: `${id}|${reason}` })]);
      // One project per case: clean this one before the next (the module `t` is reassigned).
      await t?.cleanup();
      t = undefined;
    }
    const c = await cycle();
    exists(c);
    const id = ok(await c.begin()).cycleId;
    const before = await c.theRun();
    await c.record(id, c.checks("pass"), c.review("pass"), { runToken: "not-the-token" });
    const after = await c.theRun();
    expect(after.tasks[0], "stale token: no task change").toEqual(before.tasks[0]);
    expect(after.events.filter((e) => e.kind === "cycle_retired")).toEqual([]);
    expect(after.lateEvidence.slice(before.lateEvidence.length).every((e) => e.lateReason === "run_stale")).toBe(true);
  });

  it("a binding_changed record of the open cycle retires it; a repeated record of a retired cycle appends nothing; a fresh begin clears the note", async () => {
    const c = await cycle();
    exists(c);
    const id = ok(await c.begin()).cycleId;
    c.reader.current = DRIFTED;
    ok(await c.record(id, c.checks("pass"), c.review("pass")));
    const retired = await c.theRun();
    expect(retired.events.filter((e) => e.kind === "cycle_retired")).toHaveLength(1);
    // Repeated record of the retired cycle: late only, no second cycle_retired, no task change.
    c.reader.current = ID;
    await c.record(id, c.checks("pass"), c.review("pass"));
    const again = await c.theRun();
    expect(again.events.filter((e) => e.kind === "cycle_retired")).toHaveLength(1);
    expect(again.tasks[0]).toEqual(retired.tasks[0]);
    expect(again.evidence ?? []).toEqual(retired.evidence ?? []);
    // A fresh begin from in_progress is allowed and clears the retirement note.
    const fresh = ok(await c.begin()).cycleId;
    expect(fresh).not.toBe(id);
    expect(await c.t1()).toMatchObject({ state: "checks_pending", binding: c.binding, unresolved: [] });
    expect(ok(await c.record(fresh, c.checks("pass"), c.review("pass"))).state).toBe("verified");
  });

  it("an old or retired cycle's record never retires or changes the newer open cycle", async () => {
    const c = await cycle();
    exists(c);
    const old = ok(await c.begin()).cycleId;
    c.reader.current = DRIFTED;
    ok(await c.record(old, c.checks("pass"), c.review("pass")));
    c.reader.current = ID;
    const open = ok(await c.begin()).cycleId;
    const before = await c.theRun();
    for (const reader of [DRIFTED, null, ID] as const) {
      c.reader.current = reader;
      await c.record(old, c.checks("pass"), c.review("pass"));
    }
    const after = await c.theRun();
    expect(after.tasks[0], "the open cycle's task is untouched").toEqual(before.tasks[0]);
    expect(after.events.filter((e) => e.kind === "cycle_retired").map((e) => e.detail?.split("|")[0])).toEqual([old]);
    c.reader.current = ID;
    expect(ok(await c.record(open, c.checks("pass"), c.review("pass"))).state).toBe("verified");
  });

  it("a record for an unstarted cycle id, or after the run ended, is late only and retires nothing", async () => {
    const c = await cycle();
    exists(c);
    ok(await c.begin());
    c.reader.current = DRIFTED;
    const before = await c.theRun();
    await c.record("never-started", c.checks("pass"), c.review("pass"));
    const mid = await c.theRun();
    expect(mid.tasks[0]).toEqual(before.tasks[0]);
    expect(mid.events.filter((e) => e.kind === "cycle_retired")).toEqual([]);
    await c.editRun(c.run.id, (r) => {
      r.state = "ended";
      r.endReason = "finished";
    });
    const open = before.events.filter((e) => e.kind === "cycle_started").at(-1)!.detail!;
    await c.record(open, c.checks("pass"), c.review("pass"));
    const after = await c.theRun();
    expect(after.tasks[0]).toEqual(before.tasks[0]);
    expect(after.events.filter((e) => e.kind === "cycle_retired")).toEqual([]);
  });

  it("human completion: checks and review pass → awaiting_acceptance; accept is refused off-identity, from chat or with a stale token, then appends a bound acceptance and verifies", async () => {
    const c = await cycle({ completion: "human" });
    exists(c);
    const id = ok(await c.begin()).cycleId;
    expect(ok(await c.record(id, c.checks("pass"), c.review("pass"))).state).toBe("awaiting_acceptance");
    const accept = async (origin: WriteOrigin = UI_ORIGIN, token?: string, cmds = c.runs) =>
      cmds.accept(c.open, { ...(await c.mut({ runId: c.run.id, runToken: token })), taskId: "t1" }, origin);
    c.reader.current = DRIFTED;
    await c.noWrite(() => accept(), "invalid_input");
    c.reader.current = null;
    await c.noWrite(() => accept(), "invalid_input");
    c.reader.current = ID;
    await c.noWrite(() => accept(UI_ORIGIN, undefined, c.missingReader), "invalid_input");
    await c.noWrite(() => accept(CHAT), "invalid_input");
    await c.noWrite(() => accept(UI_ORIGIN, "not-the-token"), "run_stale");
    const eventsBefore = (await c.theRun()).events;
    ok(await accept());
    const r = await c.theRun();
    const acceptance = (r.evidence ?? []).filter((e) => e.kind === "acceptance");
    expect(acceptance).toHaveLength(1);
    expect(acceptance[0]).toMatchObject({ kind: "acceptance", taskId: "t1", result: "pass", binding: c.binding });
    expect(r.tasks[0].state).toBe("verified");
    expect(await c.planState()).toMatchObject({ status: "verified" });
    expect(r.events.slice(0, eventsBefore.length)).toEqual(eventsBefore);
    // Not awaiting acceptance any more: refused, no write.
    await c.noWrite(() => accept(), "invalid_input");
  });

  it("accept on an ended run is run_stale; outside awaiting_acceptance it is invalid_input", async () => {
    const c = await cycle({ completion: "human" });
    exists(c);
    const accept = async () => c.runs.accept(c.open, { ...(await c.mut({ runId: c.run.id })), taskId: "t1" }, UI_ORIGIN);
    await c.noWrite(accept, "invalid_input");
    await c.editRun(c.run.id, (r) => {
      r.state = "ended";
      r.endReason = "finished";
    });
    await c.noWrite(accept, "run_stale");
  });

  it("run.evidence.list is read only and filters by taskId", async () => {
    const c = await cycle();
    exists(c);
    const id = ok(await c.begin()).cycleId;
    ok(await c.record(id, c.checks("fail")));
    c.reader.current = DRIFTED;
    await c.record(id, c.checks("pass"), c.review("pass"));
    const before = await c.snapshot();
    const all = ok(await c.runs.evidenceList(c.open, { projectId: c.P, runId: c.run.id }));
    expect(all.evidence.map((e) => e.kind)).toEqual(["check"]);
    expect(Array.isArray(all.lateEvidence)).toBe(true);
    expect(typeof all.revision).toBe("number");
    const other = ok(await c.runs.evidenceList(c.open, { projectId: c.P, runId: c.run.id, taskId: "t2" }));
    expect(other.evidence).toEqual([]);
    expect(await c.snapshot()).toEqual(before);
  });

  // R3.3 verification (root): the current cycle's own outcome decides; evidence of earlier cycles at
  // the same binding must neither mask a current failure or missing review nor poison a pending cycle.
  it("a failed review cycle followed by passing checks with no review command is review_pending, with no new failed cycle", async () => {
    const c = await cycle();
    const first = ok(await c.begin()).cycleId;
    ok(await c.record(first, c.checks("pass"), c.review("fail")));
    expect(await c.t1(), "precondition: one failed cycle").toMatchObject({ state: "in_progress", failedCycles: 1 });
    const second = ok(await c.begin()).cycleId;
    expect(ok(await c.record(second, c.checks("pass"), c.review("pending"))).state).toBe("review_pending");
    expect(await c.t1()).toMatchObject({ state: "review_pending", failedCycles: 1, unresolved: ["no review command configured"] });
  });

  it("a cycle whose current checks are late (no current check evidence) never verifies from an earlier cycle's passes", async () => {
    const c = await cycle();
    // Cycle 1 (legitimate): checks pass, no review command → review_pending; the check pass is stored.
    const first = ok(await c.begin()).cycleId;
    ok(await c.record(first, c.checks("pass"), c.review("pending")));
    expect((await c.t1()).state, "precondition").toBe("review_pending");
    // Cycle 2 (legitimate retry from review_pending): the runner reports the check as late (drifted).
    const second = ok(await c.begin()).cycleId;
    const lateCheck = { ...c.ev("check", "pass", 0), lateReason: "worktree_drift" };
    const state = ok(await c.record(second, { evidence: [], late: [lateCheck], result: "fail" }, c.review("pass"))).state;
    expect(state).not.toBe("verified");
    expect((await c.t1()).state).not.toBe("verified");
    expect(await c.planState()).toBeUndefined();
  });

  it("a cycle without a current review never verifies from an earlier cycle's review passes (modelled retry)", async () => {
    const c = await cycle();
    const first = ok(await c.begin()).cycleId;
    expect(ok(await c.record(first, c.checks("pass"), c.review("pass"))).state, "precondition: verified by a full cycle").toBe("verified");
    // MODELLED STATE EDIT (labelled): put the task back to in_progress to model a retry round at the same
    // binding; R3.3 has no such transition, so this isolates recordVerification's evidence scoping.
    await c.editRun(c.run.id, (r) => {
      r.tasks[0] = { ...r.tasks[0], state: "in_progress" };
    });
    const second = ok(await c.begin()).cycleId;
    const state = ok(await c.record(second, c.checks("pass"), c.review("pending"))).state;
    expect(state, "the current cycle has no review: review_pending, not verified").toBe("review_pending");
  });

  it("human completion: a failed review cycle, then a passing cycle, then accept verifies exactly the second cycle; history is kept", async () => {
    const c = await cycle({ completion: "human" });
    const first = ok(await c.begin()).cycleId;
    ok(await c.record(first, c.checks("pass"), c.review("fail")));
    expect(await c.t1(), "precondition: the first cycle failed").toMatchObject({ state: "in_progress", failedCycles: 1 });
    const historyAfterFirst = JSON.stringify((await c.theRun()).evidence);
    const second = ok(await c.begin()).cycleId;
    expect(ok(await c.record(second, c.checks("pass"), c.review("pass"))).state).toBe("awaiting_acceptance");
    ok(await c.runs.accept(c.open, { ...(await c.mut({ runId: c.run.id })), taskId: "t1" }, UI_ORIGIN));
    const r = await c.theRun();
    expect(r.tasks[0]).toMatchObject({ state: "verified", failedCycles: 1 });
    expect(await c.planState()).toMatchObject({ status: "verified" });
    const evidence = r.evidence ?? [];
    expect(JSON.stringify(evidence.slice(0, z.array(z.unknown()).parse(JSON.parse(historyAfterFirst)).length)), "the first cycle's evidence is kept unchanged").toBe(historyAfterFirst);
    expect(evidence.filter((e) => e.kind === "acceptance")).toHaveLength(1);
    expect(evidence.at(-1)).toMatchObject({ kind: "acceptance", result: "pass", binding: c.binding });
    const cycleEvidence = r.events.filter((e) => e.kind === "cycle_evidence").map((e) => e.detail?.split("|")[0]);
    expect(cycleEvidence).toEqual([first, second]);
  });

  it("beginVerification refuses a binding whose contentHash is not the addressed revision's, with no write", async () => {
    const c = await cycle();
    await c.noWrite(() => c.begin(c.runs, { ...c.binding, contentHash: "0".repeat(64) }), "invalid_input");
    expect((await c.t1()).state).toBe("in_progress");
    ok(await c.begin());
  });

  // ---- Stage R3.5 (card §6.2, §6.2a): pause protocol, resume sweep, auto-done, runner orchestration ----
  /** A recording fake SDK (coordinator steer sends) and a recording Runners hook. */
  const r35 = (opts: { sendFails?: boolean } = {}) => {
    const sends: Array<{ agentId: string; text: string; options?: { activeTurnBehavior?: string } }> = [];
    const cancels: string[] = [];
    const starts: unknown[] = [];
    const paseo = {
      agents: {
        ref: (agentId: string) => ({
          send: async (text: string, options?: { activeTurnBehavior?: string }) => {
            sends.push({ agentId, text, ...(options ? { options } : {}) });
            if (opts.sendFails) throw new Error("agent offline");
            return {};
          },
        }),
      },
    };
    const runners = { start: (x: unknown) => void starts.push(x), cancel: (runId: string) => void cancels.push(runId), dispose: async () => undefined };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
    return { sends, cancels, starts, deps: { paseo: () => paseo as never, runners } };
  };

  it("R3.5 pause: one transaction pauses (owner) and retires the open cycle (run_paused); after commit the runners are cancelled and the coordinator is steered to roadmap_run_ack", async () => {
    const f = r35();
    const c = await cycle({ deps: f.deps });
    const id = ok(await c.begin()).cycleId;
    const before = await c.revision();
    ok(await c.runs.pause(c.open, await c.mut({ runId: c.run.id }), UI_ORIGIN));
    expect(await c.revision(), "one transaction").toBe(before + 1);
    const r = await c.theRun();
    expect(r).toMatchObject({ state: "paused", pauseReason: "owner" });
    expect(r.events.filter((e) => e.kind === "cycle_retired")).toEqual([expect.objectContaining({ taskId: "t1", detail: `${id}|run_paused` })]);
    expect(r.tasks[0]).toMatchObject({ state: "in_progress", agentId: "agent-w" });
    expect(f.cancels).toEqual([c.run.id]);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ agentId: "agent-c", options: { activeTurnBehavior: "steer" } });
    expect(f.sends[0].text).toContain("roadmap_run_ack");
    // A later record of the retired cycle is late only and idempotent.
    const settled = await c.theRun();
    await c.record(id, c.checks("pass"), c.review("pass"));
    await c.record(id, c.checks("pass"), c.review("pass"));
    const after = await c.theRun();
    expect(after.tasks[0]).toEqual(settled.tasks[0]);
    expect(after.events.filter((e) => e.kind === "cycle_retired")).toHaveLength(1);
  });

  it("R3.5 pause acknowledgement: unresolved lists 'awaiting ack: <taskId> (<agentId>)' until that agent acks after pausedAt; a task without agentId never counts as acknowledged", async () => {
    const f = r35();
    const c = await cycle({ deps: f.deps });
    ok(await c.runs.pause(c.open, await c.mut({ runId: c.run.id }), UI_ORIGIN));
    const view = async () => ok(await c.runs.get(c.open, { projectId: c.P, runId: c.run.id })).unresolved ?? [];
    expect(await view()).toContain("awaiting ack: t1 (agent-w)");
    ok(await c.runs.ack(c.open, { projectId: c.P, runId: c.run.id, runToken: c.run.runToken, taskId: "t1" }, { agentId: "agent-w", workspaceId: "ws-1" }));
    expect((await view()).some((u) => u.startsWith("awaiting ack: t1"))).toBe(false);
    // An active task without agentId (modelled state) is never acknowledged.
    await c.editRun(c.run.id, (r) => {
      r.tasks[1] = { ...r.tasks[1], state: "claimed" };
    });
    expect((await view()).some((u) => u.startsWith("awaiting ack: t2"))).toBe(true);
  });

  it("R3.5 pause steer failure appends a feature note and the pause stays committed", async () => {
    const f = r35({ sendFails: true });
    const c = await cycle({ deps: f.deps });
    ok(await c.runs.pause(c.open, await c.mut({ runId: c.run.id }), UI_ORIGIN));
    expect((await c.theRun()).state).toBe("paused");
    expect((await c.feature()).events.some((e) => e.kind === "note")).toBe(true);
  });

  it("R3.5 resume sweeps an open cycle left behind (run_paused) in its transaction", async () => {
    const c = await cycle({ deps: r35().deps });
    const id = ok(await c.begin()).cycleId;
    // MODELLED STATE (labelled): a run paused without the pause-time sweep, leaving the cycle open.
    await c.editRun(c.run.id, (r) => {
      r.state = "paused";
      r.pauseReason = "owner";
      r.pausedAt = NOW_ISO;
    });
    ok(await c.runs.resume(c.open, await c.mut({ runId: c.run.id }), UI_ORIGIN));
    const r = await c.theRun();
    expect(r.state).toBe("running");
    expect(r.events.filter((e) => e.kind === "cycle_retired").map((e) => e.detail)).toEqual([`${id}|run_paused`]);
    expect(r.tasks[0].state).toBe("in_progress");
  });

  it("R3.5 auto-done: the record that verifies the last task ends the run (finished) and moves the feature executing → done", async () => {
    const c = await cycle();
    // MODELLED STATE (labelled): t2 already verified, so t1 is the last task.
    await c.editRun(c.run.id, (r) => {
      r.tasks[1] = { ...r.tasks[1], state: "verified" };
    });
    const id = ok(await c.begin()).cycleId;
    expect(ok(await c.record(id, c.checks("pass"), c.review("pass"))).state).toBe("verified");
    const r = await c.theRun();
    expect(r).toMatchObject({ state: "ended", endReason: "finished" });
    expect(r.events.map((e) => e.kind)).toContain("finished");
    const f = await c.feature();
    expect(f.status).toBe("done");
    expect(f.events.filter((e) => e.kind === "status").at(-1)).toMatchObject({ from: "executing", to: "done" });
  });

  it("R3.5 createRunners: an unresolvable worktree records a runner_error retirement (no failed cycle); a record that itself fails is logged", async () => {
    const mod: Record<string, unknown> = await import("./runs");
    expect(typeof mod.createRunners, "server/runs exports createRunners").toBe("function");
    const { createRunners } = await import("./runs");
    const c = await cycle();
    const id = ok(await c.begin()).cycleId;
    const logs: string[] = [];
    const port = { spawn: () => { throw new Error("no process may run in this test"); } };
    const runners = createRunners({ port, paseo: () => null, settings: async () => roadmapSettings.schema.parse({}), open: c.open, record: c.runs.recordVerification, log: (m: string) => void logs.push(m) });
    runners.start({ projectId: c.P, runId: c.run.id, runToken: c.run.runToken, taskId: "t1", cycleId: id, binding: c.binding });
    await runners.dispose();
    const t = await c.t1();
    expect(t).toMatchObject({ state: "in_progress", failedCycles: 0 });
    expect(t.unresolved.join(" ")).toMatch(/runner error/);
    expect((await c.theRun()).events.find((e) => e.kind === "cycle_retired")?.detail).toMatch(new RegExp(`^${id}\\|runner_error`));
    // Card gap (reported): a record that itself fails is logged and leaves the cycle open; begin refuses from checks_pending.
    const id2 = ok(await c.begin()).cycleId;
    const failing = createRunners({ port, paseo: () => null, settings: async () => roadmapSettings.schema.parse({}), open: c.open, record: async () => { throw new Error("store down"); }, log: (m: string) => void logs.push(m) });
    failing.start({ projectId: c.P, runId: c.run.id, runToken: c.run.runToken, taskId: "t1", cycleId: id2, binding: c.binding });
    await failing.dispose();
    expect(logs.some((l) => l.includes("store down") || /record/i.test(l)), JSON.stringify(logs)).toBe(true);
    expect((await c.t1()).state, "the cycle stays open (documented gap)").toBe("checks_pending");
  });

  // ---- Stage R3.5 completion (card §6.2a "Runner orchestration"): createRunners over a fake process port ----
  // git answers from a fixed synthetic repo; "/bin/sh" is a check; any other command is the reviewer,
  // which echoes a verdict for every requested DoD item. Every child honours its abort signal.
  type Spawned = { command: string; args: string[]; opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number; signal?: AbortSignal }; stdin: string; ended: boolean };
  const runnerPort = (o: { checkExit?: number; checkThrows?: boolean; review?: "pass" | "fail" | "hang" } = {}) => {
    const calls: Spawned[] = [];
    let spawnedReview: () => void = () => undefined;
    const reviewSpawned = new Promise<void>((r) => (spawnedReview = r));
    const done = (exitCode: number | null, stdout: Buffer, error?: string) => ({ exitCode, signal: null, stdout, stderr: Buffer.alloc(0), truncated: false, ...(error ? { error } : {}) });
    const aborted = (signal?: AbortSignal) => new Promise<ReturnType<typeof done>>((r) => signal?.addEventListener("abort", () => r(done(null, Buffer.alloc(0), "aborted"))));
    const port = {
      spawn: (command: string, args: string[], opts: Spawned["opts"]) => {
        const call: Spawned = { command, args, opts, stdin: "", ended: false };
        calls.push(call);
        const child = (result: Promise<ReturnType<typeof done>>) => ({ write: (x: string | Buffer) => void (call.stdin += x.toString()), end: () => void (call.ended = true), terminate: async () => undefined, result });
        if (command === "git") {
          const out = args[0] === "rev-parse" ? Buffer.from(`${"a".repeat(40)}\n`) : args[0] === "ls-files" && args.includes("--stage") ? Buffer.concat([Buffer.from(`100644 ${"b".repeat(40)} 0\tsrc/app.ts`), Buffer.from([0])]) : Buffer.alloc(0);
          return child(Promise.resolve(done(0, out)));
        }
        if (command === "/bin/sh") {
          if (o.checkThrows) throw new Error("spawn exploded");
          return child(Promise.resolve(done(o.checkExit ?? 0, Buffer.alloc(0))));
        }
        spawnedReview();
        if (o.review === "hang") return child(aborted(opts.signal));
        const result = Promise.resolve().then(() => {
          const req = ReviewRequest.parse(JSON.parse(call.stdin));
          const v = o.review ?? "pass";
          return done(0, Buffer.from(JSON.stringify({ binding: req.binding, verdict: v, items: req.dod.items.map((i) => ({ index: i.index, verdict: v, note: "seen" })), summary: v })));
        });
        return child(result);
      },
    };
    return { port, calls, reviewSpawned, checks: () => calls.filter((c) => c.command === "/bin/sh"), reviews: () => calls.filter((c) => c.command !== "git" && c.command !== "/bin/sh") };
  };
  const SETTINGS = { repairCeiling: CEILING, reviewCommand: "reviewer --json", checkTimeoutMs: 1234, reviewTimeoutMs: 5678, maxBuffer: 4096 };
  /** A cycle opened at the fake repo's identity, and runners whose `record` resolves `recorded` after the real recordVerification. */
  async function orchestrated(o: Parameters<typeof runnerPort>[0] & { workspaceId?: string; record?: "fails"; lastTask?: boolean } = {}) {
    const mod: Record<string, unknown> = await import("./runs");
    expect(typeof mod.createRunners, "server/runs exports createRunners").toBe("function");
    const { createRunners } = await import("./runs");
    const { worktreeIdentity } = await import("./evidence");
    const f = r35();
    const c = await cycle({ deps: f.deps });
    if (o.workspaceId) {
      await c.transact((draft) => {
        draft.features.find((x) => x.id === c.featureId)!.coordinator!.workspaceId = o.workspaceId!;
      });
    }
    if (o.lastTask) {
      // MODELLED STATE (labelled): t2 already verified, so t1 is the last task.
      await c.editRun(c.run.id, (r) => {
        r.tasks[1] = { ...r.tasks[1], state: "verified" };
      });
    }
    const p = runnerPort(o);
    const id0 = await worktreeIdentity(p.port, "/synthetic/wt", [".decisions"]);
    if ("notReady" in id0) throw new Error("unexpected notReady");
    p.calls.length = 0;
    c.reader.current = id0;
    const binding = { ...c.binding, worktree: id0 };
    const cycleId = ok(await c.begin(c.runs, binding)).cycleId;
    const refs: string[] = [];
    const paseo = { workspaces: { ref: (ws: string) => (refs.push(ws), { id: ws, directory: "/synthetic/wt", refresh: async () => undefined }) }, agents: { ref: () => { throw new Error("runners never address an agent"); } } };
    const records: Array<Parameters<Parameters<typeof createRunners>[0]["record"]>[1]> = [];
    const logs: string[] = [];
    let settle: () => void = () => undefined;
    const recorded = new Promise<void>((r) => (settle = r));
    const runners = createRunners({
      port: p.port,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
      paseo: () => paseo as never,
      settings: async () => roadmapSettings.schema.parse(SETTINGS),
      open: c.open,
      record: async (open, x) => {
        records.push(x);
        try {
          if (o.record === "fails") throw new Error("store down");
          return await c.runs.recordVerification(open, x);
        } finally {
          settle();
        }
      },
      log: (m: string) => void logs.push(m),
    });
    const ref = { projectId: c.P, runId: c.run.id, runToken: c.run.runToken, taskId: "t1" };
    const start = () => runners.start({ ...ref, cycleId, binding });
    return { ...c, f, p, refs, records, logs, recorded, runners, start, cycleId, cycleBinding: binding, ref };
  }
  const retiredDetail = async (c: Awaited<ReturnType<typeof orchestrated>>) => (await c.theRun()).events.filter((e) => e.kind === "cycle_retired").map((e) => e.detail ?? "");

  it("R3.5 createRunners happy path: worktree from the bound workspace, checks then review with settings limits, review stdin covers every DoD item, record at the exact binding verifies and auto-done ends the run", async () => {
    const c = await orchestrated({ lastTask: true });
    c.start();
    await c.recorded;
    await c.runners.dispose();
    expect(c.refs, "the worktree is resolved from the bound coordinator workspace").toEqual(["ws-1"]);
    expect(c.p.checks()).toHaveLength(1);
    expect(c.p.checks()[0]).toMatchObject({ args: ["-c", "npm test"], opts: { cwd: "/synthetic/wt", timeoutMs: 1234, maxBuffer: 4096 } });
    expect(c.p.checks()[0].opts.signal, "checks receive the cycle's abort signal").toBeInstanceOf(AbortSignal);
    expect(c.p.reviews()).toHaveLength(1);
    const review = c.p.reviews()[0];
    expect(review).toMatchObject({ command: "reviewer", args: ["--json"], ended: true, opts: { cwd: "/synthetic/wt", timeoutMs: 5678, maxBuffer: 4096 } });
    const req = ReviewRequest.extend({ taskTitle: z.string() }).parse(JSON.parse(review.stdin));
    expect(req.binding).toEqual(c.cycleBinding);
    expect(req.taskTitle).toBe("Build");
    expect(req.dod.items.map((i) => i.index).sort(), "the review request covers every DoD criterion").toEqual([0, 1]);
    expect(c.records).toHaveLength(1);
    expect(c.records[0]).toMatchObject({ ...c.ref, cycleId: c.cycleId, binding: c.cycleBinding });
    expect(c.records[0].failure).toBeUndefined();
    expect(await c.t1()).toMatchObject({ state: "verified", failedCycles: 0 });
    expect(await c.theRun()).toMatchObject({ state: "ended", endReason: "finished" });
    expect((await c.feature()).status).toBe("done");
    expect(c.f.sends, "no agent is addressed by the runners").toEqual([]);
  });

  it("R3.5 createRunners: a failed check skips the review and counts once; a failed review counts once", async () => {
    const c = await orchestrated({ checkExit: 1 });
    c.start();
    await c.recorded;
    await c.runners.dispose();
    expect(c.p.reviews(), "no review after a failed check").toEqual([]);
    expect(await c.t1()).toMatchObject({ state: "in_progress", failedCycles: 1 });
    expect(c.records).toHaveLength(1);
    await t?.cleanup();
    t = undefined;
    const r = await orchestrated({ review: "fail" });
    r.start();
    await r.recorded;
    await r.runners.dispose();
    expect(r.p.reviews()).toHaveLength(1);
    expect(await r.t1()).toMatchObject({ state: "in_progress", failedCycles: 1 });
  });

  it("R3.5 createRunners: a failed cycle at the ceiling marks the task ceiling", async () => {
    const mod: Record<string, unknown> = await import("./runs");
    expect(typeof mod.createRunners, "server/runs exports createRunners").toBe("function");
    const c = await orchestrated({ checkExit: 2 });
    await c.editRun(c.run.id, (r) => {
      r.tasks[0] = { ...r.tasks[0], failedCycles: CEILING - 1 };
    });
    c.start();
    await c.recorded;
    await c.runners.dispose();
    expect(await c.t1()).toMatchObject({ state: "ceiling", failedCycles: CEILING });
  });

  it("R3.5 createRunners: a thrown runner records a runner_error retirement with no failed cycle", async () => {
    const c = await orchestrated({ checkThrows: true });
    c.start();
    await c.recorded;
    await c.runners.dispose();
    expect(typeof c.records[0].failure).toBe("string");
    expect(await c.t1()).toMatchObject({ state: "in_progress", failedCycles: 0 });
    expect(await retiredDetail(c)).toEqual([expect.stringMatching(new RegExp(`^${c.cycleId}\\|runner_error`))]);
  });

  it("R3.5 createRunners: cancel(runId) aborts the in-flight review; the abort records runner_error with no failed cycle", async () => {
    const c = await orchestrated({ review: "hang" });
    c.start();
    await c.p.reviewSpawned;
    c.runners.cancel(c.run.id);
    await c.recorded;
    await c.runners.dispose();
    expect(c.p.reviews()[0].opts.signal?.aborted).toBe(true);
    expect(await c.t1()).toMatchObject({ state: "in_progress", failedCycles: 0 });
    expect(await retiredDetail(c)).toEqual([expect.stringMatching(new RegExp(`^${c.cycleId}\\|runner_error`))]);
  });

  it("R3.5 createRunners: dispose aborts every in-flight cycle and resolves only after it settled (recorded)", async () => {
    const c = await orchestrated({ review: "hang" });
    c.start();
    await c.p.reviewSpawned;
    await c.runners.dispose();
    expect(c.p.reviews()[0].opts.signal?.aborted).toBe(true);
    expect(c.records, "the aborted cycle was recorded before dispose resolved").toHaveLength(1);
    expect(await c.t1()).toMatchObject({ failedCycles: 0 });
  });

  it("R3.5 verification: a superseded cycle settling never removes the newer cycle's controller (cancel still aborts the newer one)", async () => {
    const c = await orchestrated({ review: "hang" });
    c.start();
    await c.p.reviewSpawned;
    // A second cycle for the same task replaces (and aborts) the first controller.
    c.runners.start({ ...c.ref, cycleId: "cyc-newer", binding: c.cycleBinding });
    await c.recorded; // the first, aborted cycle settled and recorded
    await vi.waitFor(() => expect(c.p.reviews()).toHaveLength(2));
    expect(c.p.reviews()[0].opts.signal?.aborted, "the superseded cycle was aborted").toBe(true);
    expect(c.p.reviews()[1].opts.signal?.aborted).toBe(false);
    c.runners.cancel(c.run.id);
    expect(c.p.reviews()[1].opts.signal?.aborted, "the newer controller is still registered").toBe(true);
    await c.runners.dispose();
    expect(await c.t1()).toMatchObject({ failedCycles: 0 });
  });

  it("R3.5 createRunners: the no-workspace sentinel never resolves through the SDK and retires runner_error without a process", async () => {
    const c = await orchestrated({ workspaceId: "no-workspace" });
    c.start();
    await c.recorded;
    await c.runners.dispose();
    expect(c.refs).toEqual([]);
    expect(c.p.calls).toEqual([]);
    expect(await c.t1()).toMatchObject({ state: "in_progress", failedCycles: 0 });
    expect(await retiredDetail(c)).toEqual([expect.stringMatching(new RegExp(`^${c.cycleId}\\|runner_error`))]);
  });

  it("R3.5 record failure (root ruling): logged, the cycle stays checks_pending with no auto retry; an owner pause retires it; ack, resume and progress done recover", async () => {
    const c = await orchestrated({ record: "fails" });
    c.start();
    await c.recorded;
    await c.runners.dispose();
    expect(c.logs.some((l) => /store down|record/i.test(l)), JSON.stringify(c.logs)).toBe(true);
    expect(c.records, "no retry").toHaveLength(1);
    expect(await c.t1()).toMatchObject({ state: "checks_pending", failedCycles: 0 });
    await c.noWrite(() => c.begin(c.runs, c.cycleBinding), "invalid_input");
    ok(await c.runs.pause(c.open, await c.mut({ runId: c.run.id }), UI_ORIGIN));
    expect(await retiredDetail(c)).toEqual([`${c.cycleId}|run_paused`]);
    expect((await c.t1()).state).toBe("in_progress");
    ok(await c.runs.ack(c.open, { projectId: c.P, runId: c.run.id, runToken: c.run.runToken, taskId: "t1" }, { agentId: "agent-w", workspaceId: "ws-1" }));
    ok(await c.runs.resume(c.open, await c.mut({ runId: c.run.id }), UI_ORIGIN));
    // Root ruling: recovery is the explicit agent path (progress done), not a direct begin.
    const crew = { agentId: "agent-w", workspaceId: "ws-1" };
    expect(ok(await c.runs.progress(c.open, { ...c.ref, state: "done" }, crew)).state).toBe("checks_pending");
    const fresh = (await c.theRun()).events.filter((e) => e.kind === "cycle_started").at(-1)!.detail;
    expect(fresh).not.toBe(c.cycleId);
    expect(await c.t1(), "the fresh cycle is open at the same binding").toMatchObject({ state: "checks_pending", binding: c.cycleBinding });
    expect(c.f.starts, "the fresh cycle starts the runners").toHaveLength(1);
  });

  it("rpc-runs defines task.accept and run.evidence.list", async () => {
    const r: Record<string, unknown> = await import("../shared/rpc-runs");
    for (const name of ["TaskAccept", "RunEvidenceList"]) expect(typeof r[name], `shared/rpc-runs defines ${name}`).toBe("object");
    const { TaskAccept, RunEvidenceList } = await import("../shared/rpc-runs");
    expect(TaskAccept.name).toBe("task.accept");
    expect(RunEvidenceList.name).toBe("run.evidence.list");
    expect(TaskAccept.input.safeParse({ projectId: "prj_test", expectedRevision: 2, runId: "run-1", runToken: "tok-1", taskId: "t1" }).success).toBe(true);
    expect(TaskAccept.input.safeParse({ projectId: "prj_test", expectedRevision: 2, runId: "run-1", taskId: "t1" }).success, "runToken is required").toBe(false);
    expect(RunEvidenceList.input.safeParse({ projectId: "prj_test", runId: "run-1" }).success).toBe(true);
    expect(RunEvidenceList.input.safeParse({ projectId: "prj_test", runId: "run-1", taskId: "t1" }).success).toBe(true);
    expect(RunEvidenceList.input.safeParse({ projectId: "prj_test" }).success).toBe(false);
  });
});

// Stage R3.5 completion (card §6.2a "Auto-done, dependent resume, delegated sweep"): the internal
// `RunCommands.sweep(open, { projectId })` (card final 40c5366c). Prerequisite completion is modelled (labelled).
describe("R3.5 sweep: dependent resume and delegated starts", () => {
  const sweepOf = (runs: Pick<RunCommands, "sweep">) => {
    expect("sweep" in runs, "run commands expose sweep (R3.5)").toBe(true);
    return runs.sweep;
  };
  const prerequisiteDone = (s: Awaited<ReturnType<typeof approved>>) =>
    s.transact((draft) => {
      // MODELLED STATE (labelled): the prerequisite feature reached done through its own run.
      draft.features.find((f) => f.id === s.prerequisite)!.status = "done";
    });

  it("a run paused prerequisite_not_done resumes when every prerequisite is done (with the current verified basis); not before", async () => {
    const s = await approved({ dependsOn: "created" });
    await s.bindCoordinator();
    ok(await s.start());
    const sweep = sweepOf(s.runs);
    await sweep.call(s.runs, s.open, { projectId: s.P });
    expect((await s.allRuns())[0], "prerequisite still not done").toMatchObject({ state: "paused", pauseReason: "prerequisite_not_done" });
    await prerequisiteDone(s);
    await sweep.call(s.runs, s.open, { projectId: s.P });
    const r = (await s.allRuns())[0];
    expect(r.state).toBe("running");
    expect(r.events.map((e) => e.kind)).toContain("resumed");
  });

  it("control: with the approved basis cancelled the dependent stays paused after the sweep", async () => {
    const s = await approved({ dependsOn: "created" });
    await s.bindCoordinator();
    ok(await s.start());
    const out = await s.project.service.decisionCancel(s.project.paseo, { projectId: s.P, expectedRevision: await s.revision(), ...s.seed.q1, reason: "Dropped" });
    if (!out.ok) throw new Error(`cancel failed: ${out.error.code}`);
    await prerequisiteDone(s);
    await sweepOf(s.runs).call(s.runs, s.open, { projectId: s.P });
    expect((await s.allRuns())[0]).toMatchObject({ state: "paused" });
  });

  it("delegated sweep: no delegation starts nothing; a covering delegation takes the delegated path (no profile → one skipped note, no run)", async () => {
    const s = await approved();
    const sweep = sweepOf(s.runs);
    const before = await s.snapshot();
    await sweep.call(s.runs, s.open, { projectId: s.P });
    expect(await s.snapshot(), "no delegation: no write").toEqual(before);
    await s.transact((draft) => {
      draft.delegations.push({ id: "del-1", scope: "feature", featureId: s.featureId, grantedAt: NOW_ISO, provenance: { agentId: "agent-1", seqStart: 1, timestamp: NOW_ISO, quoted: "start it" } });
    });
    await sweep.call(s.runs, s.open, { projectId: s.P });
    expect(await s.allRuns()).toEqual([]);
    expect((await s.feature()).events.filter((e) => e.kind === "note" && /delegated start skipped: no coordinator profile configured/.test(JSON.stringify(e)))).toHaveLength(1);
  });
});

// Stage R3.5 effect correction (root ruling on O1/O2): the exported `afterRunEffect` (composition hook
// after a status or rework effect commits). Runners are cancelled before any send. A paused run
// (deferred) gets the pause steer naming roadmap_run_ack; an ended run (cancelled_with_feature or
// cancelled_for_rework) gets an accurate stop text with no ack/resume instruction (both are run_stale
// on an ended run). A failed send leaves a durable feature note with the cause, as run.pause does;
// the canonical run state is unchanged, nothing is retried and no other agent is addressed.
describe("R3.5 afterRunEffect steer text and failure note", () => {
  async function effectCase(shape: { state: "paused"; pauseReason: "deferred" } | { state: "ended"; endReason: "cancelled_with_feature" | "cancelled_for_rework" }, sendFails = false) {
    const s = await approved();
    const run = await s.started();
    await s.editRun(run.id, (r) => {
      // MODELLED STATE (labelled): the committed result of applyRunEffect for this effect.
      r.state = shape.state;
      if (shape.state === "paused") {
        r.pauseReason = shape.pauseReason;
        r.pausedAt = NOW_ISO;
      } else r.endReason = shape.endReason;
    });
    const ops: Array<{ op: "cancel" | "send"; id: string; text?: string; options?: unknown }> = [];
    const logs: string[] = [];
    const paseo = {
      agents: {
        ref: (agentId: string) => ({
          send: async (text: string, options?: unknown) => {
            ops.push({ op: "send", id: agentId, text, options });
            if (sendFails) throw new Error("agent offline");
            return {};
          },
        }),
      },
    };
    const mod: Record<string, unknown> = await import("./runs");
    expect(typeof mod.afterRunEffect, "server/runs exports afterRunEffect").toBe("function");
    const { afterRunEffect } = await import("./runs");
    const before = (await s.allRuns())[0];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
    await afterRunEffect({ paseo: () => paseo as never, open: s.open, runners: { cancel: (id: string) => void ops.push({ op: "cancel", id }) }, log: (m: string) => void logs.push(m) }, { projectId: s.P, runId: run.id });
    return { s, run, ops, logs, before };
  }
  const notes = async (s: Awaited<ReturnType<typeof approved>>) => (await s.feature()).events.filter((e) => e.kind === "note").map((e) => JSON.stringify(e));

  it("deferred (paused): cancels the runners, then one steer to the coordinator naming roadmap_run_ack", async () => {
    const c = await effectCase({ state: "paused", pauseReason: "deferred" });
    expect(c.ops.map((o) => o.op)).toEqual(["cancel", "send"]);
    expect(c.ops[0].id).toBe(c.run.id);
    expect(c.ops[1]).toMatchObject({ id: "agent-c", options: { activeTurnBehavior: "steer" } });
    expect(c.ops[1].text).toContain("roadmap_run_ack");
  });

  for (const endReason of ["cancelled_with_feature", "cancelled_for_rework"] as const) {
    it(`ended (${endReason}): cancels, then one accurate stop text with no ack or resume instruction`, async () => {
      const c = await effectCase({ state: "ended", endReason });
      expect(c.ops.map((o) => o.op)).toEqual(["cancel", "send"]);
      expect(c.ops[1]).toMatchObject({ id: "agent-c", options: { activeTurnBehavior: "steer" } });
      const text = c.ops[1].text!;
      expect(text).not.toContain("roadmap_run_ack");
      expect(text).not.toMatch(/until (the run is )?resumed|resume/i);
      expect(text).toMatch(/ended|stop/i);
      expect(text, "no run token in the steer").not.toContain(c.run.runToken);
    });
  }

  for (const shape of [{ state: "paused", pauseReason: "deferred" }, { state: "ended", endReason: "cancelled_with_feature" }, { state: "ended", endReason: "cancelled_for_rework" }] as const) {
    it(`a failed steer (${shape.state}) leaves one durable feature note with the cause; the run is unchanged and nothing is retried`, async () => {
      const c = await effectCase(shape, true);
      expect(c.ops.map((o) => o.op), "one attempt, no retry, no other agent").toEqual(["cancel", "send"]);
      const n = await notes(c.s);
      expect(n.filter((x) => x.includes("agent offline")), JSON.stringify(n)).toHaveLength(1);
      expect((await c.s.allRuns())[0]).toEqual(c.before);
      expect(c.logs.some((l) => /steer failed/.test(l)), "the existing log line is kept").toBe(true);
    });
  }
});

// ---- R3 corrective RED (DeepSeek triage, root rulings) ----

/** A recording fake SDK for the run prompt: sends (with the run state at send time) and a switchable failure. */
function promptSdk(s: Awaited<ReturnType<typeof approved>>) {
  const sends: Array<{ agentId: string; text: string; options?: { activeTurnBehavior?: string }; stateAtSend?: string; pauseReasonAtSend?: string }> = [];
  const sdkOps: string[] = [];
  const flags = { fail: false, duringSend: undefined as undefined | (() => Promise<void>) };
  const paseo = {
    config: { get: async () => (sdkOps.push("config.get"), { revision: "r1", config: { agentProfiles: [{ id: "team-coordinator", name: "Coordinator", provider: "claude", model: "opus" }] } }) },
    workspaces: { create: async () => { sdkOps.push("workspaces.create"); throw new Error("no workspace may be created"); }, ref: () => { sdkOps.push("workspaces.ref"); throw new Error("unused"); } },
    agents: {
      ref: (agentId: string) => ({
        send: async (text: string, options?: { activeTurnBehavior?: string }) => {
          sdkOps.push("send");
          const r = (await s.allRuns())[0];
          sends.push({ agentId, text, ...(options ? { options } : {}), ...(r ? { stateAtSend: r.state, ...(r.pauseReason ? { pauseReasonAtSend: r.pauseReason } : {}) } : {}) });
          if (flags.fail) throw new Error("agent offline");
          const hook = flags.duringSend;
          flags.duringSend = undefined;
          await hook?.();
          return {};
        },
        archive: async () => (sdkOps.push("archive"), {}),
      }),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
  const runs = s.createRunCommands({ ...s.runDeps, approvals: s.approvals, paseo: () => paseo as never });
  return { sends, sdkOps, flags, runs };
}

// DeepSeek c0003: a dependent run started while its prerequisite is open, whose initial run prompt
// failed, must not be resumed by the sweep without the prompt. The sweep preflights the current
// receipt and readiness, sends the prompt once (steer) only when it is unresolved, commits `resumed`
// only after delivery; a conflict after delivery records prompt_delivered (no duplicate later); a
// failed re-send keeps the run paused (pauseReason owner, explicit recovery) with the unresolved line
// and no automatic retry.
describe("R3 corrective: prerequisite sweep re-sends an undelivered run prompt (c0003)", () => {
  async function dependentWithFailedPrompt() {
    const s = await approved({ dependsOn: "created" });
    await s.bindCoordinator();
    const f = promptSdk(s);
    f.flags.fail = true;
    ok(await f.runs.start(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId: s.featureId }, UI_ORIGIN));
    const run = (await s.allRuns())[0];
    expect(run).toMatchObject({ state: "paused", pauseReason: "prerequisite_not_done" });
    expect(run.events.map((e) => e.kind), "precondition: the initial prompt failed").toContain("prompt_failed");
    expect(f.sends).toHaveLength(1);
    f.flags.fail = false;
    const prerequisiteDone = () =>
      s.transact((draft) => {
        // MODELLED STATE (labelled): the prerequisite reached done through its own run.
        draft.features.find((x) => x.id === s.prerequisite)!.status = "done";
      });
    const unresolved = async () => ok(await f.runs.get(s.open, { projectId: s.P, runId: run.id })).unresolved ?? [];
    const sweep = () => f.runs.sweep(s.open, { projectId: s.P });
    return { s, f, run, prerequisiteDone, unresolved, sweep };
  }

  it("blocked (prerequisite open): the sweep sends nothing and the run stays paused with the unresolved line", async () => {
    const c = await dependentWithFailedPrompt();
    await c.sweep();
    expect(c.f.sends).toHaveLength(1);
    expect((await c.s.allRuns())[0]).toMatchObject({ state: "paused", pauseReason: "prerequisite_not_done" });
    expect((await c.unresolved()).length).toBeGreaterThan(0);
  });

  it("success: once the prerequisite is done the sweep sends the run prompt once (steer, with the token) while still paused, then commits resumed", async () => {
    const c = await dependentWithFailedPrompt();
    await c.prerequisiteDone();
    await c.sweep();
    expect(c.f.sends).toHaveLength(2);
    const resend = c.f.sends[1];
    expect(resend).toMatchObject({ agentId: "agent-c", options: { activeTurnBehavior: "steer" }, stateAtSend: "paused" });
    expect(resend.text).toContain(c.run.runToken);
    const r = (await c.s.allRuns())[0];
    expect(r.state).toBe("running");
    expect(r.events.map((e) => e.kind)).toContain("resumed");
    expect(await c.unresolved()).toEqual([]);
    await c.sweep();
    expect(c.f.sends, "no second re-send").toHaveLength(2);
  });

  it("failed re-send: the run stays paused (pauseReason owner) with the unresolved line, no resumed, and no automatic retry by a later sweep", async () => {
    const c = await dependentWithFailedPrompt();
    await c.prerequisiteDone();
    c.f.flags.fail = true;
    await c.sweep();
    expect(c.f.sends).toHaveLength(2);
    const r = (await c.s.allRuns())[0];
    expect(r).toMatchObject({ state: "paused", pauseReason: "owner" });
    expect(r.events.map((e) => e.kind)).not.toContain("resumed");
    expect((await c.unresolved()).length).toBeGreaterThan(0);
    c.f.flags.fail = false;
    await c.sweep();
    expect(c.f.sends, "no automatic retry loop").toHaveLength(2);
    expect((await c.s.allRuns())[0].state).toBe("paused");
  });

  it("basis no longer current: the sweep preflights the receipt and sends nothing", async () => {
    const c = await dependentWithFailedPrompt();
    const out = await c.s.project.service.decisionCancel(c.s.project.paseo, { projectId: c.s.P, expectedRevision: await c.s.revision(), ...c.s.seed.q1, reason: "Dropped" });
    if (!out.ok) throw new Error(`cancel failed: ${out.error.code}`);
    await c.prerequisiteDone();
    await c.sweep();
    expect(c.f.sends).toHaveLength(1);
    expect((await c.s.allRuns())[0].state).toBe("paused");
  });

  it("no unresolved prompt (initial prompt delivered): the sweep resumes without sending", async () => {
    const s = await approved({ dependsOn: "created" });
    await s.bindCoordinator();
    const f = promptSdk(s);
    ok(await f.runs.start(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId: s.featureId }, UI_ORIGIN));
    expect(f.sends).toHaveLength(1);
    await s.transact((draft) => {
      draft.features.find((x) => x.id === s.prerequisite)!.status = "done"; // MODELLED STATE (labelled)
    });
    await f.runs.sweep(s.open, { projectId: s.P });
    expect(f.sends).toHaveLength(1);
    expect((await s.allRuns())[0].state).toBe("running");
  });

  it("conflict after delivery: prompt_delivered is recorded, so the next sweep resumes without a second send", async () => {
    const c = await dependentWithFailedPrompt();
    await c.prerequisiteDone();
    // A concurrent write lands while the prompt is being sent: the sweep's transaction conflicts.
    c.f.flags.duringSend = async () => {
      await c.s.transact((draft) => {
        draft.features.find((x) => x.id === c.s.prerequisite)!.events.push({ at: NOW_ISO, actor: { kind: "human" }, kind: "note", reason: "concurrent write" });
      });
    };
    await c.sweep();
    expect(c.f.sends).toHaveLength(2);
    const mid = (await c.s.allRuns())[0];
    if (mid.state === "paused") {
      expect(mid.events.map((e) => e.kind), "delivery recorded after the conflict").toContain("prompt_delivered");
      await c.sweep();
    }
    expect(c.f.sends, "never a duplicate prompt").toHaveLength(2);
    expect((await c.s.allRuns())[0].state).toBe("running");
  });
});

// DeepSeek c0007: the auto-done status event names who caused it: the verified task's agent (else the
// coordinator) when the runners' record verifies the last task; the human for task.accept.
describe("R3 corrective: auto-done actor (c0007)", () => {
  const doneEvent = async (s: Awaited<ReturnType<typeof approved>>) => (await s.feature()).events.filter((e) => e.kind === "status" && e.to === "done").at(-1);
  async function lastTaskCycle(completion: "auto" | "human", agentId: string | undefined) {
    const s = await approved({ dod: "- [check] npm test\nDocs are updated", completion });
    const run = await s.started();
    const ID = { headCommit: "a".repeat(40), indexTreeHash: "b".repeat(64), worktreeTreeHash: "c".repeat(64), untrackedHash: "d".repeat(64) };
    const runs = s.createRunCommands({ ...s.runDeps, approvals: s.approvals, identity: async () => ID });
    await s.editRun(run.id, (r) => {
      // MODELLED STATE (labelled): t2 already verified; t1 in progress (with or without an agent).
      r.tasks[0] = { ...r.tasks[0], state: "in_progress", ...(agentId ? { agentId } : {}) };
      if (!agentId) delete r.tasks[0].agentId;
      r.tasks[1] = { ...r.tasks[1], state: "verified" };
    });
    const binding = { taskId: "t1", planId: s.d.planId, planRev: 1, contentHash: s.d.contentHash, runToken: run.runToken, worktree: ID };
    const ref = { projectId: s.P, runId: run.id, runToken: run.runToken, taskId: "t1" };
    const { cycleId } = ok(await runs.beginVerification(s.open, { ...ref, binding }));
    const ev = (kind: "check" | "review", result: "pass", itemIndex?: number) => ({ id: `ev-${kind}-${itemIndex ?? "all"}`, kind, taskId: "t1", binding, at: NOW_ISO, result, ...(itemIndex !== undefined ? { itemIndex } : {}) });
    ok(await runs.recordVerification(s.open, { ...ref, cycleId, binding, checks: { evidence: [ev("check", "pass", 0)], late: [], result: "pass" }, review: { status: "pass", evidence: [ev("review", "pass", 1), ev("review", "pass")], late: [] } }));
    return { s, run, runs };
  }

  it("the runners' record that verifies the last task attributes executing → done to the task's agent", async () => {
    const c = await lastTaskCycle("auto", "agent-w");
    expect((await c.s.feature()).status).toBe("done");
    expect((await doneEvent(c.s))?.actor).toEqual({ kind: "agent", agentId: "agent-w" });
  });

  it("without a task agent the coordinator is the actor", async () => {
    const c = await lastTaskCycle("auto", undefined);
    expect((await c.s.feature()).status).toBe("done");
    expect((await doneEvent(c.s))?.actor).toEqual({ kind: "agent", agentId: "agent-c" });
  });

  it("control: task.accept (UI) that completes the run attributes done to the human", async () => {
    const c = await lastTaskCycle("human", "agent-w");
    expect((await c.s.allRuns())[0].tasks[0].state).toBe("awaiting_acceptance");
    ok(await c.runs.accept(c.s.open, { ...(await c.s.mut({ runId: c.run.id })), taskId: "t1" }, UI_ORIGIN));
    expect((await c.s.feature()).status).toBe("done");
    expect((await doneEvent(c.s))?.actor).toEqual({ kind: "human" });
  });
});

// DeepSeek c0001: a start on an approved latest revision with no tasks is invalid_input before any
// SDK call, with no write (no approval-blocker change).
describe("R3 corrective: zero-task revision cannot start (c0001)", () => {
  it("bound coordinator: invalid_input and no write", async () => {
    const s = await approved({ noTasks: true });
    await s.bindCoordinator();
    await s.noWrite(() => s.start(), "invalid_input");
    expect(await s.allRuns()).toEqual([]);
  });

  it("profile start: invalid_input before any SDK call", async () => {
    const s = await approved({ noTasks: true });
    const f = promptSdk(s);
    const before = await s.snapshot();
    const out = await f.runs.start(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId: s.featureId, profileRef: "team-coordinator" }, UI_ORIGIN);
    expect(out.ok ? "ok" : out.error.code).toBe("invalid_input");
    expect(f.sdkOps).toEqual([]);
    expect(await s.snapshot()).toEqual(before);
  });
});

// DeepSeek corrective review c0066: the sweep's prompt re-send is in flight when a UI run.resume
// sends the same prompt successfully and commits running/resumed; the sweep's send then rejects.
// The stale failure must not pause the resumed run, append prompt_failed after its resumed, bring
// back an unresolved line or add a failure note: the winning run is preserved byte for byte.
describe("R3 corrective: a stale sweep re-send failure never overwrites a concurrent resume (c0066)", () => {
  it("the resumed run stays running and unchanged; no prompt_failed, owner pause, unresolved line or note from the stale sweep", async () => {
    const s = await approved({ dependsOn: "created" });
    await s.bindCoordinator();
    type Step = { gate?: Promise<void>; fail?: boolean };
    const plan: Step[] = [];
    const sends: string[] = [];
    let releaseSweep: () => void = () => undefined;
    const paseo = {
      agents: {
        ref: (agentId: string) => ({
          send: async () => {
            sends.push(agentId);
            const step = plan.shift() ?? {};
            if (step.gate) await step.gate;
            if (step.fail) throw new Error("agent offline");
            return {};
          },
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
    const runs = s.createRunCommands({ ...s.runDeps, approvals: s.approvals, paseo: () => paseo as never });
    // The initial prompt fails while the prerequisite is open: paused (prerequisite_not_done) with an unresolved line.
    plan.push({ fail: true });
    ok(await runs.start(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId: s.featureId }, UI_ORIGIN));
    const run = (await s.allRuns())[0];
    expect(run).toMatchObject({ state: "paused", pauseReason: "prerequisite_not_done" });
    await s.transact((draft) => {
      draft.features.find((x) => x.id === s.prerequisite)!.status = "done"; // MODELLED STATE (labelled)
    });
    // The sweep's re-send waits on a gate, then rejects; the UI resume's re-send succeeds.
    plan.push({ gate: new Promise<void>((r) => (releaseSweep = r)), fail: true }, {});
    const sweeping = runs.sweep(s.open, { projectId: s.P });
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    ok(await runs.resume(s.open, await s.mut({ runId: run.id }), UI_ORIGIN));
    expect(sends).toHaveLength(3);
    const won = (await s.allRuns())[0];
    expect(won.state, "precondition: the UI resume committed").toBe("running");
    const notesBefore = (await s.feature()).events.filter((e) => e.kind === "note").length;
    const wonBytes = JSON.stringify(won);
    releaseSweep();
    await sweeping;
    const after = (await s.allRuns())[0];
    expect(after.state).toBe("running");
    expect(after.pauseReason).toBeUndefined();
    expect(after.events.slice(after.events.findLastIndex((e) => e.kind === "resumed")).map((e) => e.kind), "nothing after the winning resumed").toEqual(["resumed"]);
    expect(ok(await runs.get(s.open, { projectId: s.P, runId: run.id })).unresolved ?? []).toEqual([]);
    expect((await s.feature()).events.filter((e) => e.kind === "note").length, "no stale failure note").toBe(notesBefore);
    expect(JSON.stringify(after), "the winning run is preserved byte for byte").toBe(wonBytes);
  });
});

// c0066 mirror (root-authorised): the owner's run.resume re-send is held and then rejects while a
// concurrent sweep re-sends successfully and commits running/resumed. The late resume failure must
// not pause or change the winning run, its events, its unresolved view or the feature notes. A
// control keeps a legitimate failure recorded when only an unrelated write happened meanwhile.
describe("R3 corrective: a stale resume re-send failure never overwrites a concurrent sweep resume (c0066 mirror)", () => {
  /** A dependent run whose initial prompt failed, its prerequisite modelled done, and a step-queue SDK. */
  async function heldHarness() {
    const s = await approved({ dependsOn: "created" });
    await s.bindCoordinator();
    type Step = { gate?: Promise<void>; fail?: boolean };
    const plan: Step[] = [];
    const sends: string[] = [];
    const paseo = {
      agents: {
        ref: (agentId: string) => ({
          send: async () => {
            sends.push(agentId);
            const step = plan.shift() ?? {};
            if (step.gate) await step.gate;
            if (step.fail) throw new Error("agent offline");
            return {};
          },
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
    const runs = s.createRunCommands({ ...s.runDeps, approvals: s.approvals, paseo: () => paseo as never });
    plan.push({ fail: true });
    ok(await runs.start(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId: s.featureId }, UI_ORIGIN));
    const run = (await s.allRuns())[0];
    expect(run).toMatchObject({ state: "paused", pauseReason: "prerequisite_not_done" });
    await s.transact((draft) => {
      draft.features.find((x) => x.id === s.prerequisite)!.status = "done"; // MODELLED STATE (labelled)
    });
    let release: () => void = () => undefined;
    const held = (fail: boolean): Step => ({ gate: new Promise<void>((r) => (release = r)), fail });
    const notes = async () => (await s.feature()).events.filter((e) => e.kind === "note").length;
    return { s, runs, run, plan, sends, held, release: () => release(), notes };
  }

  it("the sweep-resumed run stays running and unchanged after the owner's held re-send rejects", async () => {
    const h = await heldHarness();
    h.plan.push(h.held(true), {});
    const resuming = h.runs.resume(h.s.open, await h.s.mut({ runId: h.run.id }), UI_ORIGIN);
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    await h.runs.sweep(h.s.open, { projectId: h.s.P });
    expect(h.sends).toHaveLength(3);
    const won = (await h.s.allRuns())[0];
    expect(won.state, "precondition: the sweep committed the resume").toBe("running");
    const notesBefore = await h.notes();
    const wonBytes = JSON.stringify(won);
    h.release();
    await resuming;
    const after = (await h.s.allRuns())[0];
    expect(after.state).toBe("running");
    expect(after.pauseReason).toBeUndefined();
    expect(after.events.slice(after.events.findLastIndex((e) => e.kind === "resumed")).map((e) => e.kind), "nothing after the winning resumed").toEqual(["resumed"]);
    expect(ok(await h.runs.get(h.s.open, { projectId: h.s.P, runId: h.run.id })).unresolved ?? []).toEqual([]);
    expect(await h.notes(), "no stale failure note").toBe(notesBefore);
    expect(JSON.stringify(after), "the winning run is preserved byte for byte").toBe(wonBytes);
  });

  it("control: an unrelated write while the sweep re-send is held does not suppress its legitimate failure record", async () => {
    const h = await heldHarness();
    h.plan.push(h.held(true));
    const sweeping = h.runs.sweep(h.s.open, { projectId: h.s.P });
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    const notesBefore = await h.notes();
    await h.s.transact((draft) => {
      draft.features.find((x) => x.id === h.s.prerequisite)!.title = "Prerequisite (renamed)"; // unrelated write
    });
    h.release();
    await sweeping;
    const after = (await h.s.allRuns())[0];
    expect(after).toMatchObject({ state: "paused", pauseReason: "owner" });
    expect(after.events.filter((e) => e.kind === "prompt_failed")).toHaveLength(2);
    expect((ok(await h.runs.get(h.s.open, { projectId: h.s.P, runId: h.run.id })).unresolved ?? []).length).toBeGreaterThan(0);
    expect(await h.notes()).toBe(notesBefore + 1);
  });
});
