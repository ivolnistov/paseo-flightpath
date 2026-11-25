import { describe, expect, it } from "vitest";
import { cancelRun, grantReturn, pauseRun, requestChanges, resumeRun, retryStop, stopJob, submitReview } from "./run-actions";
import { decide, pauseReason, runStatus } from "./run-engine";
import { affectedSet, taskIdsOf } from "./rework";
import { Sim, snapshotOf } from "./run-test-kit";

const WORKFLOW = `name: Rework
inputs: { tasks: { type: tasks, required: false } }
defaults:
  agent: { model: provider-a/model-a, retries: 2 }
jobs:
  implement:
    uses: run-tasks
    with: { prompt: build, tasks: "\${{ inputs.tasks }}", reviewer: { model: provider-a/reviewer } }
  lint: { needs: [implement], uses: checks, with: { run: [lint] } }
  review: { needs: [lint], uses: review, with: { agent: { model: provider-a/reviewer } }, rework: { to: implement, max: 2 } }
  accept: { needs: [review], uses: approval }
`;
const TASKS = "- { id: t1, title: One }\n- { id: t2, title: Two, needs: [t1] }\n- { id: t3, title: Three, needs: [t1] }\n";

function snapshot() {
  return snapshotOf(WORKFLOW, { tasks: TASKS });
}

describe("affectedSet", () => {
  const graph = snapshot().graph;

  it("covers the target and everything downstream", () => {
    expect(affectedSet(graph, "lint")).toEqual(["lint", "review", "accept"]);
    expect(affectedSet(graph, "implement")).toEqual(["implement.t1", "implement.t2", "implement.t3", "lint", "review", "accept"]);
  });

  it("limits a run-tasks target to the named tasks, their dependants and the group's downstream", () => {
    expect(affectedSet(graph, "implement", ["t2"])).toEqual(["implement.t2", "lint", "review", "accept"]);
    expect(affectedSet(graph, "implement", ["t1"])).toEqual(["implement.t1", "implement.t2", "implement.t3", "lint", "review", "accept"]);
    expect(taskIdsOf(graph, "implement")).toEqual(["t1", "t2", "t3"]);
    expect(taskIdsOf(graph, "lint")).toBeNull();
  });
});

/** A reviewer for `review` that asks for changes on t2 the first `times` reviews. */
function requesting(times: number, hold = false): Sim {
  let asked = 0;
  return new Sim(snapshot(), {
    reviewer: (attempt, cycleId, s) => {
      if (!attempt.startsWith("review#") || asked >= times) return "approve";
      asked += 1;
      const agentId = s.state.attempts[attempt]?.roles.reviewer?.binding.agentId ?? "";
      const result = submitReview(s.state, {
        attemptId: attempt,
        agentId,
        outcome: "changes_requested",
        findings: [{ title: "Fix t2", detail: "broken", tasks: ["t2"] }],
        criteria: [],
        identity: { ...s.worktree },
      });
      expect(result.ok).toBe(true);
      s.apply(result.events);
      return "hold";
    },
    quiesce: () => (hold ? "hold" : "confirm"),
  });
}

describe("rework", () => {
  it("supersedes t2 and its downstream jobs, keeps t1 and t3, and restarts t2 with the findings", () => {
    const sim = requesting(1);
    sim.runAll();
    expect(runStatus(sim.state)).toBe("finished");
    const started = sim.events.find((event) => event.kind === "rework.started");
    expect(started).toMatchObject({ jobId: "review", to: "implement", taskIds: ["t2"], affected: ["implement.t2", "lint", "review", "accept"] });
    expect(started && "superseded" in started ? started.superseded.sort() : []).toEqual(["implement.t2#1", "lint#1", "review#1"]);
    expect(sim.jobStarts("implement.t1")).toBe(1);
    expect(sim.jobStarts("implement.t3")).toBe(1);
    expect(sim.jobStarts("implement.t2")).toBe(2);
    expect(sim.state.attempts["implement.t2#1"]).toMatchObject({ outcome: "superseded", reason: "rework" });
    expect(sim.state.attempts["implement.t2#2"]).toMatchObject({ cause: "rework", findings: [expect.objectContaining({ title: "Fix t2" })], outcome: "succeeded" });
    expect(sim.state.attempts["lint#2"]).toMatchObject({ cause: "rework" });
    expect(sim.state.jobs["implement.t2"]?.retriesUsed).toBe(0);
  });

  it("starts no attempt of the affected set before quiesce.confirmed", () => {
    const sim = requesting(1, true);
    sim.runAll();
    const barrier = sim.state.barriers[0];
    expect(barrier).toMatchObject({ cause: "rework", attempts: ["review#1"], status: "pending" });
    const effects = decide(sim.state);
    expect(effects.some((effect) => effect.kind === "start_attempt")).toBe(false);
    expect(effects.filter((effect) => effect.kind === "interrupt_agent")).toEqual([expect.objectContaining({ attemptId: "review#1", role: "reviewer" })]);
    sim.apply([{ kind: "quiesce.confirmed", barrierId: barrier?.barrierId ?? "" }]);
    const after = sim.settle();
    expect(after.filter((effect) => effect.kind === "start_attempt")).toEqual([expect.objectContaining({ jobId: "implement.t2", cause: "rework" })]);
  });

  it("pauses the run on quiesce.unconfirmed until Retry stop is confirmed", () => {
    let attempts = 0;
    const sim = requesting(1);
    sim.policy.quiesce = () => (attempts++ === 0 ? "unconfirm" : "confirm");
    sim.runAll();
    expect(sim.events.some((event) => event.kind === "quiesce.unconfirmed")).toBe(true);
    expect(runStatus(sim.state)).toBe("paused");
    expect(pauseReason(sim.state)).toBe("quiesce_unconfirmed");
    expect(decide(sim.state)).toEqual([]);
    expect(resumeRun(sim.state)).toMatchObject({ ok: false });
    const retry = retryStop(sim.state);
    expect(retry.ok).toBe(true);
    sim.apply(retry.events);
    sim.runAll();
    expect(runStatus(sim.state)).toBe("finished");
  });

  it("fails a third changes_requested with rework_exhausted and grants exactly one more return", () => {
    const sim = requesting(3);
    sim.runAll();
    expect(sim.events.filter((event) => event.kind === "rework.started")).toHaveLength(2);
    expect(sim.state.jobs.review).toMatchObject({ terminal: "failed", reason: "rework_exhausted" });
    expect(decide(sim.state)).toEqual([]);
    const grant = grantReturn(sim.state, { jobId: "review" });
    expect(grant.ok).toBe(true);
    sim.apply(grant.events);
    sim.runAll();
    expect(sim.events.filter((event) => event.kind === "rework.started")).toHaveLength(3);
    expect(runStatus(sim.state)).toBe("finished");
  });

  it("refuses a run-tasks return without task ids or with unknown ones", () => {
    const sim = new Sim(snapshot(), { reviewer: (attempt) => (attempt.startsWith("review#") ? "hold" : "approve") });
    sim.runAll();
    const agentId = sim.state.attempts["review#1"]?.roles.reviewer?.binding.agentId ?? "";
    const base = { attemptId: "review#1", agentId, outcome: "changes_requested" as const, criteria: [], identity: { ...sim.worktree } };
    expect(submitReview(sim.state, { ...base, findings: [{ title: "x", detail: "", tasks: [] }] })).toMatchObject({ ok: false, code: "task_ids_required" });
    expect(submitReview(sim.state, { ...base, findings: [{ title: "x", detail: "", tasks: ["t9"] }] })).toMatchObject({ ok: false, code: "task_ids_unknown" });
  });

  it("refuses an outcome from a superseded attempt as stale_attempt", () => {
    const sim = requesting(1, true);
    sim.runAll();
    const agentId = sim.state.attempts["review#1"]?.roles.reviewer?.binding.agentId ?? "";
    expect(submitReview(sim.state, { attemptId: "review#1", agentId, outcome: "approved", findings: [], criteria: [], identity: { ...sim.worktree } })).toMatchObject({ ok: false, code: "stale_attempt" });
  });

  it("returns from the approval job with the human's note", () => {
    let asked = false;
    const withReturn = WORKFLOW.replace("accept: { needs: [review], uses: approval }", "accept: { needs: [review], uses: approval, rework: { to: implement, max: 1 } }");
    const sim = new Sim(snapshotOf(withReturn, { tasks: TASKS }), { human: (jobId) => (jobId === "accept" && !asked ? "hold" : "accept") });
    sim.runAll();
    expect(requestChanges(sim.state, { jobId: "accept", note: "again" })).toMatchObject({ ok: false, code: "task_ids_required" });
    const result = requestChanges(sim.state, { jobId: "accept", note: "again", taskIds: ["t3"] });
    expect(result.ok).toBe(true);
    asked = true;
    sim.apply(result.events);
    sim.runAll();
    expect(sim.events.find((event) => event.kind === "rework.started")).toMatchObject({ jobId: "accept", taskIds: ["t3"], note: "again" });
    expect(sim.jobStarts("implement.t3")).toBe(2);
    expect(sim.state.attempts["implement.t3#2"]?.note).toBe("again");
    expect(runStatus(sim.state)).toBe("finished");
  });

  it("fails an approval without a return with the human's note", () => {
    const sim = new Sim(snapshot(), { human: (jobId) => (jobId === "accept" ? "hold" : "accept") });
    sim.runAll();
    const result = requestChanges(sim.state, { jobId: "accept", note: "no" });
    expect(result.ok).toBe(true);
    sim.apply(result.events);
    sim.runAll();
    expect(sim.state.attempts["accept#1"]).toMatchObject({ outcome: "failed", reason: "changes_requested" });
    expect(sim.state.jobs.accept).toMatchObject({ terminal: "failed", reason: "changes_requested" });
    expect(sim.events.some((event) => event.kind === "rework.started")).toBe(false);
  });
});

describe("stop and cancel", () => {
  it("stops a job only after confirmation and keeps it stopped", () => {
    const sim = new Sim(snapshot(), { worker: () => "hold", quiesce: () => "hold" });
    sim.runAll();
    const stop = stopJob(sim.state, { jobId: "implement.t1" });
    sim.apply(stop.events);
    expect(sim.state.attempts["implement.t1#1"]?.endedAt).toBeNull();
    sim.apply([{ kind: "quiesce.confirmed", barrierId: "q1" }]);
    sim.settle();
    expect(sim.state.attempts["implement.t1#1"]).toMatchObject({ outcome: "stopped" });
    expect(sim.state.jobs["implement.t1"]?.terminal).toBe("stopped");
    expect(decide(sim.state)).toEqual([]);
  });

  it("cancels the run only after the stopping work is confirmed", () => {
    const sim = new Sim(snapshot(), { worker: () => "hold", quiesce: () => "hold" });
    sim.runAll();
    sim.apply(cancelRun(sim.state).events);
    expect(sim.settle().some((effect) => effect.kind === "record")).toBe(false);
    expect(runStatus(sim.state)).toBe("running");
    sim.apply([{ kind: "quiesce.confirmed", barrierId: "q1" }]);
    sim.settle();
    expect(runStatus(sim.state)).toBe("cancelled");
    expect(sim.state.jobs.lint?.terminal).toBe("cancelled");
  });

  it("Stop run pauses and Resume restarts the stopped work as a manual attempt", () => {
    const sim = new Sim(snapshot(), { worker: (attempt) => (attempt === "implement.t1#1" ? "hold" : "complete") });
    sim.run();
    sim.apply(pauseRun(sim.state).events);
    sim.run();
    expect(pauseReason(sim.state)).toBe("human");
    expect(sim.state.attempts["implement.t1#1"]).toMatchObject({ outcome: "stopped" });
    sim.apply(resumeRun(sim.state).events);
    sim.runAll();
    expect(sim.state.attempts["implement.t1#2"]?.cause).toBe("manual");
    expect(runStatus(sim.state)).toBe("finished");
  });
});
