import { describe, expect, it } from "vitest";
import { acceptJob, approveJob, cancelRun, providerFailed, requestChanges, retryJob, submitOutputs, submitReview } from "./run-actions";
import { attemptId, creationKey, decide, EngineError, initialState, reduce, replay, runStatus, stampEvents, toRunView } from "./run-engine";
import { identity, Sim, snapshotOf } from "./run-test-kit";

const TASKS_WORKFLOW = `name: Tasks
inputs: { goal: { type: string }, tasks: { type: tasks, required: false } }
defaults:
  max-parallel: 3
  agent: { profile: implementer, fallback: { model: provider-b/model-b, reasoning: medium }, retries: 2 }
jobs:
  implement:
    uses: run-tasks
    with: { prompt: "\${{ inputs.goal }}", tasks: "\${{ inputs.tasks }}", reviewer: { profile: reviewer } }
  lint: { needs: [implement], uses: checks, with: { run: [npm run lint] } }
  review: { needs: [lint], uses: review, with: { agent: { profile: reviewer } }, rework: { to: implement, max: 2 } }
  accept: { needs: [review], uses: approval }
`;
const TASKS = "- { id: t1, title: One }\n- { id: t2, title: Two, needs: [t1], done: [{ run: [npm, test] }, { criterion: Works }] }\n- { id: t3, title: Three, needs: [t1], acceptance: human }\n";

function tasksRun(seed?: number, policy: ConstructorParameters<typeof Sim>[1] = {}): Sim {
  return new Sim(snapshotOf(TASKS_WORKFLOW, { inputs: { goal: "ship" }, tasks: TASKS }), policy, seed);
}

function kinds(sim: Sim, kind: string, jobId?: string): number {
  return sim.events.filter((event) => event.kind === kind && (jobId === undefined || ("jobId" in event && event.jobId === jobId))).length;
}

describe("ordering and the writer slot", () => {
  it("starts t2 and t3 only after t1 succeeded and never runs two writers at once", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const sim = tasksRun(seed);
      sim.runAll();
      expect(runStatus(sim.state)).toBe("finished");
      const t1Done = sim.successSeq("implement.t1");
      expect(t1Done).toBeGreaterThan(0);
      expect(sim.startSeq("implement.t2")).toBeGreaterThan(t1Done);
      expect(sim.startSeq("implement.t3")).toBeGreaterThan(t1Done);
      expect(sim.maxHolders).toBe(1);
    }
  });

  it("never overlaps a writer with isolated checks, while isolated checks overlap each other", () => {
    const yaml = `name: Iso
jobs:
  a: { uses: agent, with: { prompt: a, agent: { model: p/m } } }
  c1: { needs: [a], uses: checks, with: { isolated: true, run: [one] } }
  c2: { needs: [a], uses: checks, with: { isolated: true, run: [two] } }
  b: { needs: [a], uses: agent, with: { prompt: b, agent: { model: p/m } } }
`;
    for (let seed = 1; seed <= 20; seed += 1) {
      const sim = new Sim(snapshotOf(yaml), {}, seed);
      sim.run();
      expect(runStatus(sim.state)).toBe("finished");
      expect(sim.writerWithIsolated).toBe(false);
    }
    const held = new Sim(snapshotOf(yaml), { check: () => "hold" });
    held.run();
    const running = Object.values(held.state.attempts).filter((a) => a.endedAt === null).map((a) => a.attemptId);
    expect(running.sort()).toEqual(["c1#1", "c2#1"]);
    expect(held.jobStarts("b")).toBe(0);
    expect(held.state.cycles["c1#1/c1"]?.identity).toEqual(held.state.cycles["c2#1/c1"]?.identity);
  });

  it("keeps an independent branch running after a job fails", () => {
    const yaml = `name: Branches
jobs:
  a: { uses: agent, with: { prompt: a, agent: { model: p/m, retries: 0 } }, done: [{ run: [fail] }] }
  after-a: { needs: [a], uses: agent, with: { prompt: x, agent: { model: p/m } } }
  b: { uses: agent, with: { prompt: b, agent: { model: p/m } } }
`;
    const sim = new Sim(snapshotOf(yaml), { check: (jobId) => (jobId === "a" ? 1 : 0) });
    sim.run();
    expect(sim.state.jobs.a?.terminal).toBe("failed");
    expect(sim.state.jobs.a?.reason).toBe("check_failed");
    expect(sim.successSeq("b")).toBeGreaterThan(0);
    expect(sim.jobStarts("after-a")).toBe(0);
    expect(runStatus(sim.state)).toBe("running");
    expect(decide(sim.state)).toEqual([]);
  });

  it("replays a journal to equal states", () => {
    const sim = tasksRun(7);
    sim.runAll();
    const first = replay(sim.snapshot, sim.events);
    const second = replay(sim.snapshot, sim.events);
    expect(second).toEqual(first);
    expect(first).toEqual(sim.state);
    expect(decide(first)).toEqual(decide(second));
  });

  it("starts nothing while paused", () => {
    const sim = tasksRun();
    sim.apply([{ kind: "workspace.intent", branchName: "flightpath/run-run1" }, { kind: "workspace.bound", workspaceId: "w", directory: "/w", baseCommit: "b" }, { kind: "run.paused", reason: "human" }]);
    expect(decide(sim.state)).toEqual([]);
    sim.apply([{ kind: "run.resumed" }]);
    expect(decide(sim.state).map((effect) => effect.kind)).toEqual(["start_attempt"]);
  });
});

describe("evidence identity", () => {
  it("invalidates a cycle when the worktree drifts between two check commands and reruns the checks", () => {
    const yaml = `name: Drift
jobs:
  c: { uses: checks, with: { run: [one, two] } }
`;
    let drifted = false;
    const sim = new Sim(snapshotOf(yaml), {
      duringCheck: (_jobId, index, s) => {
        if (index === 1 && !drifted) {
          drifted = true;
          s.write();
        }
      },
    });
    sim.run();
    const invalidated = sim.events.filter((event) => event.kind === "cycle.invalidated");
    expect(invalidated).toEqual([expect.objectContaining({ cycleId: "c#1/c1", explained: false })]);
    expect(sim.state.evidence.filter((evidence) => evidence.cycleId === "c#1/c1").every((evidence) => evidence.result === "late")).toBe(true);
    expect(sim.state.attempts["c#1"]?.cycles).toEqual(["c#1/c1", "c#1/c2"]);
    expect(toRunView(sim.state).invalidatedCycles).toEqual(["c#1/c1"]);
    expect(sim.jobStarts("c")).toBe(1);
    expect(runStatus(sim.state)).toBe("finished");
  });

  it("fails the attempt with worktree_unstable after three unexplained invalidations", () => {
    const yaml = `name: Unstable
jobs:
  c: { uses: checks, with: { run: [one, two] } }
`;
    const sim = new Sim(snapshotOf(yaml), { duringCheck: (_jobId, index, s) => (index === 1 ? s.write() : undefined) });
    sim.run();
    expect(kinds(sim, "cycle.invalidated")).toBe(3);
    expect(sim.state.attempts["c#1"]).toMatchObject({ outcome: "failed", reason: "worktree_unstable" });
  });

  it("invalidates a cycle when the worktree drifts during a review", () => {
    let reviews = 0;
    const sim = tasksRun(undefined, {
      reviewer: (attempt, _cycle, s) => {
        if (attempt === "review#1" && reviews++ === 0) s.write();
      },
    });
    sim.runAll();
    expect(sim.events.filter((event) => event.kind === "cycle.invalidated").map((event) => [event.cycleId, event.reason])).toEqual([["review#1/c1", "review_drift"]]);
    expect(kinds(sim, "review.submitted", undefined)).toBeGreaterThanOrEqual(3);
    expect(sim.jobStarts("review")).toBe(1);
    expect(runStatus(sim.state)).toBe("finished");
  });

  it("invalidates a parked cycle when another writer changes the worktree, and repeats verification only", () => {
    const yaml = `name: Park
jobs:
  h: { uses: agent, acceptance: human, with: { prompt: h, agent: { model: p/m } }, done: [{ run: [test] }] }
  w: { uses: agent, with: { prompt: w, agent: { model: p/m } } }
`;
    const sim = new Sim(snapshotOf(yaml), { human: () => "hold" });
    sim.run();
    const drift = sim.events.filter((event) => event.kind === "cycle.invalidated");
    expect(drift).toEqual([expect.objectContaining({ cycleId: "h#1/c1", explained: true, reason: "human_wait_drift" })]);
    expect(sim.state.attempts["h#1"]?.cycles).toEqual(["h#1/c1", "h#1/c2"]);
    expect(sim.state.attempts["h#1"]?.parked).toBe(true);
    expect(sim.jobStarts("h")).toBe(1);
    expect(kinds(sim, "attempt.outputs_accepted")).toBe(2);
    expect(sim.state.cycles["h#1/c2"]?.checks).not.toBeNull();
    expect(sim.state.attempts["h#1"]?.unexplained).toBe(0);
  });

  it("reruns an isolated job whose group drifted in exclusive mode for the rest of the run", () => {
    const yaml = `name: Escape
jobs:
  c: { uses: checks, with: { isolated: true, run: [escape] } }
`;
    let escaped = false;
    const sim = new Sim(snapshotOf(yaml), {
      duringCheck: (_jobId, _index, s) => {
        if (!escaped) {
          escaped = true;
          s.write();
        }
      },
    });
    sim.run();
    expect(sim.state.jobs.c?.exclusive).toBe(true);
    expect(sim.state.evidence.filter((evidence) => evidence.kind === "check").map((evidence) => [evidence.mode, evidence.result])).toEqual([
      ["isolated", "late"],
      ["exclusive", "pass"],
    ]);
    expect(runStatus(sim.state)).toBe("finished");
  });

  it("starts a manual attempt with the note when a human requests changes on a waiting job", () => {
    const yaml = `name: Changes
jobs:
  h: { uses: agent, acceptance: human, with: { prompt: h, agent: { model: p/m, retries: 0 } } }
`;
    let asked = false;
    const sim = new Sim(snapshotOf(yaml), { human: () => (asked ? "accept" : "hold") });
    sim.run();
    const result = requestChanges(sim.state, { jobId: "h", note: "rename it" });
    expect(result.ok).toBe(true);
    asked = true;
    sim.apply(result.events);
    sim.runAll();
    expect(sim.state.attempts["h#1"]).toMatchObject({ outcome: "failed", reason: "changes_requested" });
    expect(sim.state.attempts["h#2"]).toMatchObject({ cause: "manual", note: "rename it", outcome: "succeeded" });
    expect(sim.state.jobs.h?.retriesUsed).toBe(0);
  });

  it("refuses Accept on a changed identity with evidence_stale", () => {
    const yaml = `name: Accept
jobs:
  h: { uses: agent, acceptance: human, with: { prompt: h, agent: { model: p/m } }, done: [{ criterion: Looks right }] }
`;
    const sim = new Sim(snapshotOf(yaml), { human: () => "hold" });
    sim.run();
    const result = acceptJob(sim.state, { jobId: "h", cycleId: "h#1/c1", identity: identity("changed"), criteria: [0] });
    expect(result).toMatchObject({ ok: false, code: "evidence_stale" });
    expect(result.events).toEqual([expect.objectContaining({ kind: "cycle.invalidated", cycleId: "h#1/c1", explained: true })]);
    expect(acceptJob(sim.state, { jobId: "h", cycleId: "h#1/c1", identity: identity("t1"), criteria: [] })).toMatchObject({ ok: false, code: "criteria_invalid" });
    const accepted = acceptJob(sim.state, { jobId: "h", cycleId: "h#1/c1", identity: identity("t1"), criteria: [0] });
    expect(accepted.ok).toBe(true);
    sim.apply(accepted.events);
    sim.run();
    expect(runStatus(sim.state)).toBe("finished");
  });

  it("reruns lint with cause stale after a later write, before review uses it, without using retries", () => {
    const yaml = `name: Stale
jobs:
  a: { uses: agent, with: { prompt: a, agent: { model: p/m } } }
  lint: { needs: [a], uses: checks, with: { run: [lint] } }
  b: { needs: [a], uses: agent, with: { prompt: b, agent: { model: p/m } } }
  review: { needs: [lint, b], uses: review, with: { agent: { model: p/r } } }
`;
    const sim = new Sim(snapshotOf(yaml));
    sim.run();
    expect(sim.successSeq("lint")).toBeLessThan(sim.startSeq("b"));
    const second = sim.events.find((event) => event.kind === "attempt.started" && event.attemptId === "lint#2");
    expect(second).toMatchObject({ cause: "stale" });
    expect(second?.seq).toBeLessThan(sim.startSeq("review"));
    expect(sim.state.attempts["lint#1"]).toMatchObject({ outcome: "superseded", reason: "evidence_stale" });
    expect(sim.state.jobs.lint?.retriesUsed).toBe(0);
    expect(sim.jobStarts("lint")).toBe(2);
    expect(runStatus(sim.state)).toBe("finished");
  });

  it("refreshes lint once at the finish on the final identity and relaunches no writer", () => {
    const yaml = `name: Finish
jobs:
  a: { uses: agent, acceptance: human, with: { prompt: a, agent: { model: p/m } } }
  lint: { needs: [a], uses: checks, with: { run: [lint] } }
  b: { needs: [lint], uses: agent, acceptance: human, with: { prompt: b, agent: { model: p/m } } }
`;
    const sim = new Sim(snapshotOf(yaml));
    sim.runAll();
    expect(sim.jobStarts("a")).toBe(1);
    expect(sim.jobStarts("b")).toBe(1);
    expect(sim.jobStarts("lint")).toBe(2);
    const finishes = sim.effectsSeen.filter((effect) => effect.kind === "finish_run");
    expect(finishes.length).toBeGreaterThan(0);
    const lint2 = sim.state.cycles["lint#2/c1"];
    expect(lint2?.identity).toEqual(sim.state.cycles["b#1/c1"]?.identity);
    expect(sim.state.cycles["a#1/c1"]?.identity).not.toEqual(lint2?.identity);
    expect(runStatus(sim.state)).toBe("finished");
    expect(decide(sim.state)).toEqual([]);
  });

  it("supersedes a waiting approval when a file changed before Approve, reruns checks and review, and relaunches no task", () => {
    let changed = false;
    const sim = tasksRun();
    const original = sim.humans.bind(sim);
    sim.humans = () => {
      const approval = Object.values(sim.state.attempts).find((a) => a.jobId === "accept" && a.parked && a.endedAt === null);
      if (approval && !changed) {
        changed = true;
        sim.write();
        const cycleId = approval.cycles[approval.cycles.length - 1] ?? "";
        const refused = approveJob(sim.state, { jobId: "accept", cycleId, identity: { ...sim.worktree } });
        expect(refused).toMatchObject({ ok: false, code: "evidence_stale" });
        sim.apply(refused.events);
        return true;
      }
      return original();
    };
    sim.runAll();
    expect(runStatus(sim.state)).toBe("finished");
    expect(sim.state.attempts["accept#1"]).toMatchObject({ outcome: "superseded", reason: "evidence_stale" });
    expect(sim.jobStarts("lint")).toBe(2);
    expect(sim.jobStarts("review")).toBe(2);
    for (const task of ["implement.t1", "implement.t2", "implement.t3"]) expect(sim.jobStarts(task)).toBe(1);
  });
});

describe("roles and creation keys", () => {
  it("binds distinct worker and reviewer agents with distinct keys", () => {
    const sim = tasksRun();
    sim.runAll();
    const t2 = sim.state.attempts["implement.t2#1"];
    expect(t2?.roles.worker?.binding.creationKey).toBe("run1:implement.t2#1:worker");
    expect(t2?.roles.reviewer?.binding.creationKey).toBe("run1:implement.t2#1:reviewer");
    expect(t2?.roles.worker?.binding.agentId).not.toBe(t2?.roles.reviewer?.binding.agentId);
    expect(attemptId("implement.t2", 1)).toBe("implement.t2#1");
  });

  it("gives the same job and attempt number in two runs different creation keys", () => {
    const one = new Sim(snapshotOf(TASKS_WORKFLOW, { runId: "runA", inputs: { goal: "x" }, tasks: TASKS }));
    const two = new Sim(snapshotOf(TASKS_WORKFLOW, { runId: "runB", inputs: { goal: "x" }, tasks: TASKS }));
    one.runAll();
    two.runAll();
    const keys = (sim: Sim): string[] => sim.events.flatMap((event) => (event.kind === "agent.intent" ? [event.creationKey] : []));
    expect(keys(one).filter((key) => keys(two).includes(key))).toEqual([]);
    expect(creationKey("runA", "implement.t1#1", "worker")).not.toBe(creationKey("runB", "implement.t1#1", "worker"));
  });

  it("refuses a reviewer outcome on a worker binding", () => {
    const sim = tasksRun(undefined, { reviewer: () => "hold" });
    sim.runAll();
    const t2 = sim.state.attempts["implement.t2#1"];
    const worker = t2?.roles.worker?.binding.agentId ?? "";
    const [event] = stampEvents(sim.state, [
      { kind: "review.submitted", attemptId: "implement.t2#1", cycleId: "implement.t2#1/c1", role: "worker", agentId: worker, outcome: "approved", findings: [], criteria: [{ index: 1, met: true }], identity: sim.worktree },
    ], "now");
    if (!event) throw new Error("no event");
    expect(() => reduce(sim.state, event)).toThrow(EngineError);
    const [asReviewer] = stampEvents(sim.state, [
      { kind: "review.submitted", attemptId: "implement.t2#1", cycleId: "implement.t2#1/c1", role: "reviewer", agentId: worker, outcome: "approved", findings: [], criteria: [{ index: 1, met: true }], identity: sim.worktree },
    ], "now");
    if (!asReviewer) throw new Error("no event");
    expect(() => reduce(sim.state, asReviewer)).toThrow(EngineError);
    expect(submitReview(sim.state, { attemptId: "implement.t2#1", agentId: worker, outcome: "approved", findings: [], criteria: [], identity: sim.worktree })).toMatchObject({ ok: false, code: "role_forbidden" });
    const reviewer = t2?.roles.reviewer?.binding.agentId ?? "";
    expect(submitOutputs(sim.state, { attemptId: "implement.t2#1", agentId: reviewer, outputs: {}, summary: "" })).toMatchObject({ ok: false, code: "role_forbidden" });
  });

  it("repeats an unbound agent intent with its one key and never mints another", () => {
    const sim = tasksRun();
    let effects = sim.settle();
    while (!effects.some((effect) => effect.kind === "create_agent")) {
      const next = effects[0];
      if (!next) throw new Error("no effect");
      sim.execute(next);
      effects = sim.settle();
    }
    const create = effects.find((effect) => effect.kind === "create_agent");
    for (let i = 0; i < 3; i += 1) {
      const again = replay(sim.snapshot, sim.events);
      expect(decide(again).filter((effect) => effect.kind === "create_agent")).toEqual([create]);
    }
    expect(kinds(sim, "agent.intent")).toBe(1);
  });

  it("creates a reviewer intent only when the cycle reaches review", () => {
    const sim = tasksRun(undefined, { check: () => "hold" });
    sim.runAll();
    const t2 = sim.state.attempts["implement.t2#1"];
    expect(t2?.roles.worker).toBeDefined();
    expect(t2?.roles.reviewer).toBeUndefined();
  });

  it("asks once for a missing completion and then fails with no_result", () => {
    const yaml = `name: Idle
jobs:
  a: { uses: agent, with: { prompt: a, agent: { model: p/m, retries: 0 } } }
`;
    const sim = new Sim(snapshotOf(yaml), {
      worker: (attempt, s) => {
        const agentId = s.state.attempts[attempt]?.roles.worker?.binding.agentId ?? "";
        return [{ kind: "agent.turn_ended", attemptId: attempt, role: "worker", agentId, result: "no_completion" }];
      },
    });
    sim.run();
    expect(sim.effectsSeen.filter((effect) => effect.kind === "remind")).toHaveLength(1);
    expect(sim.state.attempts["a#1"]).toMatchObject({ endedAt: null, outcome: null });
    const reminded = sim.events.find((event) => event.kind === "agent.reminded");
    if (!reminded) throw new Error("no reminder recorded");

    const agentId = sim.state.attempts["a#1"]?.roles.worker?.binding.agentId ?? "";
    const [second] = sim.apply([{ kind: "agent.turn_ended", attemptId: "a#1", role: "worker", agentId, result: "no_completion" }]);
    if (!second) throw new Error("no second turn");
    sim.run();
    const turns = sim.events.filter((event) => event.kind === "agent.turn_ended").map((event) => event.seq);
    const ended = sim.events.filter((event) => event.kind === "attempt.ended");
    expect(turns).toHaveLength(2);
    expect(turns[0]).toBeLessThan(reminded.seq);
    expect(reminded.seq).toBeLessThan(second.seq);
    expect(ended).toEqual([expect.objectContaining({ attemptId: "a#1", outcome: "failed", reason: "no_result" })]);
    expect(ended[0]?.seq).toBeGreaterThan(second.seq);
    expect(sim.state.jobs.a).toMatchObject({ terminal: "failed", reason: "no_result", retriesUsed: 0, targets: {}, switched: [] });
    expect(sim.events.some((event) => event.kind === "job.provider_switched" || event.kind === "quiesce.started")).toBe(false);
    expect(sim.jobStarts("a")).toBe(1);
    expect(decide(sim.state)).toEqual([]);
  });

  it("fails an attempt with outputs_invalid on the third rejected submission", () => {
    const yaml = `name: Outputs
jobs:
  a: { uses: agent, with: { prompt: a, agent: { model: p/m, retries: 0 } }, outputs: { n: { type: number } } }
`;
    const sim = new Sim(snapshotOf(yaml), {
      worker: (attempt, s) => {
        const agentId = s.state.attempts[attempt]?.roles.worker?.binding.agentId ?? "";
        const events = [];
        let state = s.state;
        for (let i = 0; i < 3; i += 1) {
          const result = submitOutputs(state, { attemptId: attempt, agentId, outputs: { n: "x" }, summary: "" });
          expect(result).toMatchObject({ ok: true, accepted: false });
          events.push(...result.events);
          for (const stamped of stampEvents(state, result.events, "now")) state = reduce(state, stamped);
        }
        return events;
      },
    });
    sim.run();
    expect(sim.state.attempts["a#1"]).toMatchObject({ outcome: "failed", reason: "outputs_invalid" });
  });
});

describe("provider failover", () => {
  const FAILOVER = `name: Failover
jobs:
  a:
    uses: agent
    with: { prompt: a, agent: { model: provider-a/model-a, fallback: { model: provider-b/model-b }, retries: 1 } }
    done: [{ run: [test] }]
  b: { uses: agent, with: { prompt: b, agent: { model: provider-a/model-a } } }
`;
  const failure = { provider: "provider-a", model: "model-a", class: "unavailable" as const, message: "down", at: "now" };

  function failing(targets: ReadonlySet<string>): Sim {
    return new Sim(snapshotOf(FAILOVER), {
      worker: (attempt, s) => {
        const a = s.state.attempts[attempt];
        if (a?.jobId !== "a" || !targets.has(a.target)) return "complete";
        const result = providerFailed(s.state, { attemptId: attempt, role: "worker", failure: { ...failure, provider: a.target === "primary" ? "provider-a" : "provider-b" } });
        expect(result.ok).toBe(true);
        return result.events;
      },
    });
  }

  it("switches once to the fallback after the turn is confirmed ended and keeps the retry count", () => {
    const sim = failing(new Set(["primary"]));
    sim.run();
    expect(sim.state.attempts["a#1"]).toMatchObject({ outcome: "provider_failed" });
    const started = sim.events.filter((event) => event.kind === "quiesce.started");
    expect(started).toEqual([expect.objectContaining({ attempts: ["a#1"], cause: "provider_failure" })]);
    const confirmed = sim.events.filter((event) => event.kind === "quiesce.confirmed");
    expect(confirmed).toEqual([expect.objectContaining({ barrierId: started[0]?.barrierId })]);
    const ended = sim.events.find((event) => event.kind === "attempt.ended" && event.attemptId === "a#1");
    const switched = sim.events.filter((event) => event.kind === "job.provider_switched");
    const failover = sim.events.find((event) => event.kind === "attempt.started" && event.attemptId === "a#2");
    if (!ended || !failover || !confirmed[0] || !started[0]) throw new Error("missing failover events");
    expect(switched).toEqual([expect.objectContaining({ jobId: "a", role: "worker", to: "fallback" })]);
    const order = [started[0].seq, confirmed[0].seq, ended.seq, switched[0]?.seq ?? -1, failover.seq];
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(new Set(order).size).toBe(order.length);
    expect(ended.kind === "attempt.ended" ? [ended.outcome, ended.failure?.target, ended.failure?.role] : []).toEqual(["provider_failed", "primary", "worker"]);
    expect(sim.state.attempts["a#2"]).toMatchObject({ cause: "failover", target: "fallback", outcome: "succeeded" });
    expect(sim.state.attempts["a#2"]?.roles.worker?.binding.settings.provider).toBe("provider-b");
    expect(sim.state.jobs.a?.retriesUsed).toBe(0);
  });

  it("never switches for a failed check, a rejected review, no_result or an unclassified failure", () => {
    const failedCheck = new Sim(snapshotOf(FAILOVER), { check: () => 1 });
    failedCheck.run();
    const unclassified = new Sim(snapshotOf(FAILOVER), {
      worker: (attempt, s) => {
        const agentId = s.state.attempts[attempt]?.roles.worker?.binding.agentId ?? "";
        return [{ kind: "agent.turn_ended", attemptId: attempt, role: "worker", agentId, result: "failed", message: "boom" }];
      },
    });
    unclassified.run();
    const noResultSnapshot = snapshotOf(FAILOVER.replace("fallback: { model: provider-b/model-b }, retries: 1", "fallback: { model: provider-b/model-b }, retries: 0"));
    expect(noResultSnapshot.settings.a?.worker).toMatchObject({ retries: 0, fallback: { provider: "provider-b", model: "model-b" } });
    const noResult = new Sim(noResultSnapshot, {
      worker: (attempt, s) => {
        const agentId = s.state.attempts[attempt]?.roles.worker?.binding.agentId ?? "";
        return [{ kind: "agent.turn_ended", attemptId: attempt, role: "worker", agentId, result: "no_completion" }];
      },
    });
    noResult.run();
    const reminded = noResult.events.find((event) => event.kind === "agent.reminded" && event.attemptId === "a#1");
    if (!reminded) throw new Error("no reminder recorded");
    expect(noResult.state.attempts["a#1"]).toMatchObject({ endedAt: null, outcome: null });
    const idleAgent = noResult.state.attempts["a#1"]?.roles.worker?.binding.agentId ?? "";
    const [secondIdle] = noResult.apply([{ kind: "agent.turn_ended", attemptId: "a#1", role: "worker", agentId: idleAgent, result: "no_completion" }]);
    if (!secondIdle) throw new Error("no second turn");
    expect(secondIdle.seq).toBeGreaterThan(reminded.seq);
    noResult.run();
    const noResultEnds = noResult.events.filter((event) => event.kind === "attempt.ended" && event.attemptId.startsWith("a#"));
    expect(noResultEnds).toEqual([expect.objectContaining({ attemptId: "a#1", outcome: "failed", reason: "no_result" })]);
    expect(noResultEnds[0]?.seq).toBeGreaterThan(secondIdle.seq);
    expect(noResult.state.jobs.a).toMatchObject({ terminal: "failed", reason: "no_result", retriesUsed: 0, targets: {}, switched: [] });
    expect(noResult.jobStarts("a")).toBe(1);
    expect(noResult.events.some((event) => event.kind === "quiesce.started" || event.kind === "job.needs_human")).toBe(false);
    const rejected = tasksRun(undefined, {});
    rejected.policy.reviewer = (attempt, cycleId, s) => {
      if (!attempt.startsWith("implement.t2#")) return "approve";
      const a = s.state.attempts[attempt];
      const agentId = a?.roles.reviewer?.binding.agentId ?? "";
      s.apply([{ kind: "review.submitted", attemptId: attempt, cycleId, role: "reviewer", agentId, outcome: "changes_requested", findings: [], criteria: [{ index: 1, met: false }], identity: { ...s.worktree } }]);
      return "hold";
    };
    rejected.runAll();
    for (const sim of [failedCheck, unclassified, noResult, rejected]) {
      expect(kinds(sim, "job.provider_switched")).toBe(0);
      expect(Object.values(sim.state.attempts).every((a) => a.target === "primary")).toBe(true);
    }
    expect(failedCheck.state.jobs.a).toMatchObject({ terminal: "failed", reason: "check_failed", retriesUsed: 1 });
    expect(unclassified.state.jobs.a).toMatchObject({ terminal: "failed", reason: "turn_failed" });
    expect(rejected.state.jobs["implement.t2"]).toMatchObject({ terminal: "failed", reason: "criterion_not_met", retriesUsed: 2 });
  });

  it("waits as needs_human with both failures and starts exactly one manual attempt per retry", () => {
    const sim = failing(new Set(["primary", "fallback"]));
    sim.run();
    const needs = sim.events.filter((event) => event.kind === "job.needs_human");
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ failures: [expect.objectContaining({ target: "primary", provider: "provider-a" }), expect.objectContaining({ target: "fallback", provider: "provider-b" })] });
    expect(decide(sim.state)).toEqual([]);
    expect(sim.successSeq("b")).toBeGreaterThan(0);

    const retry = retryJob(sim.state, { jobId: "a", target: "primary" });
    expect(retry.ok).toBe(true);
    sim.apply(retry.events);
    const starts = sim.settle().filter((effect) => effect.kind === "start_attempt");
    expect(starts).toEqual([expect.objectContaining({ jobId: "a", cause: "manual", target: "primary" })]);
    sim.run();
    expect(sim.jobStarts("a")).toBe(3);
    expect(sim.events.filter((event) => event.kind === "job.needs_human")).toHaveLength(2);
    expect(decide(sim.state)).toEqual([]);
  });
});

describe("cancel", () => {
  it("does not reduce run.cancelled before the stopping work is confirmed", () => {
    const sim = tasksRun(undefined, { worker: () => "hold", quiesce: () => "hold" });
    sim.run();
    sim.apply(cancelRun(sim.state).events);
    const [cancelled] = stampEvents(sim.state, [{ kind: "run.cancelled" }], "now");
    if (!cancelled) throw new Error("no event");
    expect(() => reduce(sim.state, cancelled)).toThrow(EngineError);
  });
});

describe("initial state", () => {
  it("records the deterministic workspace intent before any host effect", () => {
    const state = initialState(snapshotOf(TASKS_WORKFLOW, { inputs: { goal: "x" }, tasks: TASKS }));
    expect(decide(state)).toEqual([{ kind: "record", key: "workspace.intent", events: [{ kind: "workspace.intent", branchName: "flightpath/run-run1" }] }]);
  });
});
