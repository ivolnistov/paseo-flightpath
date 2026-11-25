// Stage R3.1 (task card 2026-10-29 R3 §2.2, §2.3): pure task readiness. A task is ready only when
// every design §3.3 precondition holds: feature executing, run running, start authorised (UI, or an
// unrevoked delegation covering the feature), approval current, prerequisites done, dependencies
// verified, task run todo, below the ceiling (ceiling + extraBudget), and parallel granted when
// another task is active. Approval alone never makes a task ready. `./readiness` is new in R3.1, so
// it is loaded from the module namespace and each export is checked before use.
import { describe, expect, it } from "vitest";
import type { ExecutionRun, Feature, Plan, StartDelegation, TaskDefinitionV2, TaskRun } from "./model";

const AT = "2026-10-29T10:00:00.000Z";
const CEILING = 3;

const load = async () => {
  const mod: Record<string, unknown> = await import("./readiness");
  for (const name of ["readyTasks", "runBlockers", "ceilingReached", "prerequisitesDone"]) {
    expect(typeof mod[name], `shared/readiness exports ${name}`).toBe("function");
  }
  return import("./readiness");
};

const feature = (id: string, partial: Partial<Feature> = {}): Feature => ({
  id, title: `Feature ${id}`, description: "", kind: "feature", status: "executing", dependsOn: [], relatedTo: [],
  everStarted: true, createdAt: AT, createdBy: { kind: "human" }, coordinatorHistory: [], events: [], ...partial,
});
/** t1; t2 depends on t1; t3 parallel; t4 sequential with no dependency. */
const plan = (): Plan => {
  const task = (id: string, partial: { dependsOn?: string[]; parallel?: boolean } = {}): TaskDefinitionV2 => ({
    id, title: `Task ${id}`, description: "", dependsOn: partial.dependsOn ?? [], parallel: partial.parallel ?? false, completion: "auto", grill: false, dod: "x",
  });
  return {
    id: "plan1", title: "Plan", sessionIds: ["s1"], approvals: [], taskStates: [], intents: [], tickets: [], featureId: "f1",
    revisions: [{ rev: 1, createdAt: AT, schema: 2, contentHash: "a".repeat(64), markdown: "# P", basedOn: [], decisionSnapshotHash: "b".repeat(64), tasks: [task("t1"), task("t2", { dependsOn: ["t1"] }), task("t3", { parallel: true }), task("t4")] }],
  };
};
const taskRun = (taskId: string, partial: Partial<TaskRun> = {}): TaskRun => ({ taskId, state: "todo", failedCycles: 0, extraBudget: 0, unresolved: [], ...partial });
const run = (partial: Partial<ExecutionRun> = {}, tasks: Partial<Record<string, Partial<TaskRun>>> = {}): ExecutionRun => ({
  id: "run1", featureId: "f1", planId: "plan1", planRev: 1, runToken: "tok1", state: "running", startAuth: { kind: "ui", at: AT },
  tasks: ["t1", "t2", "t3", "t4"].map((id) => taskRun(id, tasks[id] ?? {})), acks: [], events: [{ at: AT, kind: "started" }], lateEvidence: [], ...partial,
});
const delegation = (partial: Partial<StartDelegation> = {}): StartDelegation => ({
  id: "d1", scope: "feature", featureId: "f1", grantedAt: AT,
  provenance: { agentId: "agent-1", seqStart: 1, timestamp: AT, quoted: "start it" }, ...partial,
});
const base = () => ({ feature: feature("f1"), features: [feature("f1")], run: run(), plan: plan(), approvedCurrent: true, ceiling: CEILING });
const codes = (blocked: Array<{ code: string; taskId?: string }>) => blocked.map((b) => (b.taskId ? `${b.code}:${b.taskId}` : b.code));

describe("R3.1 readyTasks truth table", () => {
  it("baseline: independent todo tasks are ready; a task with an unverified dependency is not", async () => {
    const r = await load();
    const out = r.readyTasks(base());
    expect([...out.ready].sort()).toEqual(["t1", "t3", "t4"]);
    expect(codes(out.blocked)).toContain("dependency_not_verified:t2");
  });

  it("each run-level precondition alone blocks every task", async () => {
    const r = await load();
    const cases: Array<[string, ReturnType<typeof base>]> = [
      ["feature_not_executing", { ...base(), feature: feature("f1", { status: "planned" }) }],
      ["run_not_running", { ...base(), run: run({ state: "paused", pauseReason: "owner" }) }],
      ["approval_not_current", { ...base(), approvedCurrent: false }],
      ["prerequisite_not_done", { ...base(), feature: feature("f1", { dependsOn: ["f0"] }), features: [feature("f0", { status: "planned" }), feature("f1", { dependsOn: ["f0"] })] }],
    ];
    for (const [code, input] of cases) {
      const out = r.readyTasks(input);
      expect(out.ready, code).toEqual([]);
      expect(codes(out.blocked), code).toContain(code);
      expect(codes(r.runBlockers(input)), `runBlockers ${code}`).toContain(code);
    }
    // Control: a done prerequisite does not block.
    const done = { ...base(), feature: feature("f1", { dependsOn: ["f0"] }), features: [feature("f0", { status: "done" }), feature("f1", { dependsOn: ["f0"] })] };
    expect(r.readyTasks(done).ready.length).toBe(3);
    expect(r.runBlockers(done)).toEqual([]);
  });

  it("start authorisation: UI, or an unrevoked delegation covering the feature (feature or roadmap scope)", async () => {
    const r = await load();
    const viaDelegation = (d?: StartDelegation) => ({ ...base(), run: run({ startAuth: { kind: "delegation", delegationId: "d1", at: AT } }), ...(d ? { delegation: d } : {}) });
    expect(r.readyTasks(viaDelegation(delegation())).ready.length).toBe(3);
    expect(r.readyTasks(viaDelegation(delegation({ scope: "roadmap", featureId: undefined }))).ready.length).toBe(3);
    for (const d of [undefined, delegation({ revokedAt: AT }), delegation({ featureId: "other" })]) {
      const out = r.readyTasks(viaDelegation(d));
      expect(out.ready, JSON.stringify(d ?? null)).toEqual([]);
      expect(codes(out.blocked)).toContain("start_unauthorised");
    }
  });

  it("dependencies, task state, ceiling (ceiling + extraBudget) and the parallel grant", async () => {
    const r = await load();
    // A verified dependency releases the dependent task.
    expect(r.readyTasks({ ...base(), run: run({}, { t1: { state: "verified" } }) }).ready).toContain("t2");
    // Not todo.
    const active = r.readyTasks({ ...base(), run: run({}, { t1: { state: "in_progress" } }) });
    expect(active.ready).not.toContain("t1");
    expect(codes(active.blocked)).toContain("not_todo:t1");
    // Another active task: only parallel tasks are ready.
    expect(active.ready).toContain("t3");
    expect(active.ready).not.toContain("t4");
    expect(codes(active.blocked)).toContain("parallel_not_granted:t4");
    for (const state of ["claimed", "checks_pending", "review_pending"] as const) {
      expect(r.readyTasks({ ...base(), run: run({}, { t1: { state } }) }).ready, state).not.toContain("t4");
    }
    // Control: awaiting_acceptance or verified do not count as active.
    expect(r.readyTasks({ ...base(), run: run({}, { t1: { state: "verified" } }) }).ready).toContain("t4");
    // Ceiling at ceiling + extraBudget.
    const atCeiling = r.readyTasks({ ...base(), run: run({}, { t1: { failedCycles: CEILING } }) });
    expect(atCeiling.ready).not.toContain("t1");
    expect(codes(atCeiling.blocked)).toContain("ceiling:t1");
    expect(r.readyTasks({ ...base(), run: run({}, { t1: { failedCycles: CEILING, extraBudget: 1 } }) }).ready).toContain("t1");
    expect(r.readyTasks({ ...base(), run: run({}, { t1: { failedCycles: CEILING - 1 } }) }).ready).toContain("t1");
  });

  it("approval alone never makes a task ready", async () => {
    const r = await load();
    const out = r.readyTasks({ ...base(), feature: feature("f1", { status: "planned" }), approvedCurrent: true });
    expect(out.ready).toEqual([]);
    expect(codes(r.runBlockers({ ...base(), feature: feature("f1", { status: "planned" }), run: undefined }))).toContain("feature_not_executing");
  });

  it("ceilingReached and prerequisitesDone", async () => {
    const r = await load();
    expect(r.ceilingReached(taskRun("t1", { failedCycles: 2 }), 3)).toBe(false);
    expect(r.ceilingReached(taskRun("t1", { failedCycles: 3 }), 3)).toBe(true);
    expect(r.ceilingReached(taskRun("t1", { failedCycles: 3, extraBudget: 2 }), 3)).toBe(false);
    expect(r.ceilingReached(taskRun("t1", { failedCycles: 5, extraBudget: 2 }), 3)).toBe(true);
    const f = feature("f1", { dependsOn: ["a", "b"] });
    expect(r.prerequisitesDone(f, [feature("a", { status: "done" }), feature("b", { status: "done" }), f])).toBe(true);
    expect(r.prerequisitesDone(f, [feature("a", { status: "done" }), feature("b", { status: "executing" }), f])).toBe(false);
    expect(r.prerequisitesDone(feature("f1"), [feature("f1")])).toBe(true);
  });

  it("is pure: inputs are not modified", async () => {
    const r = await load();
    const input = base();
    const before = JSON.stringify(input);
    r.readyTasks(input);
    r.runBlockers(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// Stage R3.4 (task card 2026-10-29 R3 §1.2, §5.2): NotReady gains coordinator_unavailable (a staged
// start whose SDK creation failed); the run_not_ready details shape parses it.
describe("R3.4 coordinator_unavailable", () => {
  it("is a NotReady code in the run contracts", async () => {
    const { NotReady } = await import("./rpc-runs");
    expect(NotReady.safeParse({ code: "coordinator_unavailable" }).success).toBe(true);
    expect(NotReady.safeParse({ code: "approval_not_current" }).success, "control").toBe(true);
    expect(NotReady.safeParse({ code: "coordinator_missing" }).success).toBe(false);
  });
});

// Stage R4.4 (task card §5.0 Fable ruling): start authorisation is evaluated against the CURRENT
// covering delegation of the run's feature, not the original id. A UI run is always authorised; a
// delegated run is authorised by any unrevoked delegation covering its feature (feature scope for
// that feature, or roadmap scope), whatever its id. No other blocker changes.
describe("R4.4 startAuthorised against the current covering delegation", () => {
  const delegatedRun = () => run({ startAuth: { kind: "delegation", delegationId: "d1", at: AT } });
  type In = Parameters<Awaited<ReturnType<typeof load>>["runBlockers"]>[0];
  const unauthorised = async (x: In) => (await load()).runBlockers(x).some((b) => b.code === "start_unauthorised");

  it("a UI run is authorised with no delegation and with a revoked one", async () => {
    expect(await unauthorised({ ...base() })).toBe(false);
    expect(await unauthorised({ ...base(), delegation: delegation({ revokedAt: AT }) })).toBe(false);
  });

  it("a delegated run is authorised by its original covering delegation, a different-id feature-scope one, or a different-id roadmap-scope one", async () => {
    expect(await unauthorised({ ...base(), run: delegatedRun(), delegation: delegation() })).toBe(false);
    expect(await unauthorised({ ...base(), run: delegatedRun(), delegation: delegation({ id: "d2" }) }), "different id, feature scope").toBe(false);
    expect(await unauthorised({ ...base(), run: delegatedRun(), delegation: delegation({ id: "d3", scope: "roadmap", featureId: undefined }) }), "different id, roadmap scope").toBe(false);
  });

  it("a delegated run is start_unauthorised when the delegation is revoked, missing, or a feature-scope one for another feature", async () => {
    expect(await unauthorised({ ...base(), run: delegatedRun(), delegation: delegation({ revokedAt: AT }) })).toBe(true);
    expect(await unauthorised({ ...base(), run: delegatedRun() })).toBe(true);
    expect(await unauthorised({ ...base(), run: delegatedRun(), delegation: delegation({ id: "d4", featureId: "f-other" }) })).toBe(true);
  });

  it("no other blocker changes: the ready set is identical for an authorised delegated run and a UI run", async () => {
    const r = await load();
    const ui = r.readyTasks({ ...base() });
    const del = r.readyTasks({ ...base(), run: delegatedRun(), delegation: delegation({ id: "d9", scope: "roadmap", featureId: undefined }) });
    expect(del).toEqual(ui);
  });
});
