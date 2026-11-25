import { describe, expect, it } from "vitest";
import { reconcile, type HostFacts } from "./recovery";
import { resumeRun } from "./run-actions";
import { decide, pauseReason, reduce, replay, runStatus } from "./run-engine";
import { Sim, snapshotOf } from "./run-test-kit";

const WORKFLOW = `name: Recover
jobs:
  a: { uses: agent, with: { prompt: a, agent: { model: provider-a/model-a, retries: 1 } }, done: [{ run: [test] }] }
`;

function facts(over: Partial<HostFacts> = {}): HostFacts {
  return { agents: new Map(), workspaces: [], agentsByKey: new Map(), liveCheckGroups: new Set(), idempotentCreate: true, ...over };
}

/** A run stopped right after the worker intent was journalled, before its binding. */
function afterAgentIntent(): Sim {
  const sim = new Sim(snapshotOf(WORKFLOW));
  for (;;) {
    const effects = sim.settle();
    const next = effects[0];
    if (!next || next.kind === "create_agent") return sim;
    sim.execute(next);
  }
}

function restart(sim: Sim, host: HostFacts): Sim {
  const restarted = new Sim(sim.snapshot);
  restarted.state = replay(sim.snapshot, sim.events);
  restarted.events = [...sim.events];
  restarted.apply(reconcile(restarted.state, host, "later").map(({ seq: _seq, id: _id, at: _at, ...body }) => body));
  return restarted;
}

const KEY = "run1:a#1:worker";

describe("reconcile: agent intents", () => {
  it("binds the one agent carrying the key and pauses for recovery", () => {
    const sim = restart(afterAgentIntent(), facts({ agentsByKey: new Map([[KEY, ["agent-x"]]]), agents: new Map([["agent-x", "running"]]) }));
    expect(sim.state.attempts["a#1"]?.roles.worker?.binding.agentId).toBe("agent-x");
    expect(sim.state.attempts["a#1"]?.endedAt).toBeNull();
    expect(pauseReason(sim.state)).toBe("recovery");
    expect(sim.events.filter((event) => event.kind === "agent.intent")).toHaveLength(1);
  });

  it("ends the attempt as lost when the bound agent is no longer running, with one recovery pause", () => {
    const sim = restart(afterAgentIntent(), facts({ agentsByKey: new Map([[KEY, ["agent-x"]]]), agents: new Map([["agent-x", "idle"]]) }));
    expect(sim.state.attempts["a#1"]).toMatchObject({ outcome: "lost" });
    expect(sim.events.filter((event) => event.kind === "run.paused")).toEqual([expect.objectContaining({ reason: "recovery" })]);
    expect(decide(sim.state)).toEqual([]);
    sim.apply(resumeRun(sim.state).events);
    const starts = sim.settle().filter((effect) => effect.kind === "start_attempt");
    expect(starts).toEqual([expect.objectContaining({ jobId: "a", cause: "retry" })]);
  });

  it("repeats the creation with the same key when nothing matches", () => {
    const before = afterAgentIntent();
    const sim = restart(before, facts());
    expect(sim.events).toHaveLength(before.events.length);
    expect(decide(sim.state).filter((effect) => effect.kind === "create_agent")).toEqual([expect.objectContaining({ creationKey: KEY })]);
  });

  it("never repeats an unproven creation: it pauses with binding_unknown and keeps the intent", () => {
    const before = afterAgentIntent();
    const sim = restart(before, facts({ idempotentCreate: false }));
    expect(pauseReason(sim.state)).toBe("binding_unknown");
    expect(sim.state.attempts["a#1"]).toMatchObject({ endedAt: null, outcome: null });
    expect(sim.state.attempts["a#1"]?.roles.worker?.binding).toMatchObject({ creationKey: KEY, agentId: null });
    expect(decide(sim.state)).toEqual([]);
    expect(resumeRun(sim.state)).toMatchObject({ ok: false, code: "reconcile_required" });
    const again = restart(sim, facts({ idempotentCreate: false }));
    expect(again.events.filter((event) => event.kind === "run.paused")).toHaveLength(1);
    expect(decide(again.state)).toEqual([]);

    const found = restart(sim, facts({ idempotentCreate: false, agentsByKey: new Map([[KEY, ["agent-late"]]]), agents: new Map([["agent-late", "running"]]) }));
    expect(found.state.attempts["a#1"]?.roles.worker?.binding.agentId).toBe("agent-late");
    expect(pauseReason(found.state)).toBe("recovery");
    found.apply(resumeRun(found.state).events);
    const effects = found.settle();
    expect(effects.some((effect) => effect.kind === "create_agent" || effect.kind === "start_attempt")).toBe(false);
    expect(found.events.filter((event) => event.kind === "agent.intent")).toHaveLength(1);
  });

  it("treats a bound agent without a status fact as unknown, not as an ended turn", () => {
    const bound = restart(afterAgentIntent(), facts({ agentsByKey: new Map([[KEY, ["agent-x"]]]), agents: new Map([["agent-x", "running"]]) }));
    bound.apply(resumeRun(bound.state).events);
    const unknown = restart(bound, facts());
    expect(pauseReason(unknown.state)).toBe("binding_unknown");
    expect(unknown.state.attempts["a#1"]?.endedAt).toBeNull();
    expect(decide(unknown.state)).toEqual([]);
    expect(resumeRun(unknown.state)).toMatchObject({ ok: false, code: "reconcile_required" });

    const known = restart(bound, facts({ agents: new Map([["agent-x", "closed"]]) }));
    expect(known.state.attempts["a#1"]).toMatchObject({ outcome: "lost" });
    known.apply(resumeRun(known.state).events);
    expect(known.settle().filter((effect) => effect.kind === "start_attempt")).toEqual([expect.objectContaining({ attemptId: "a#2", cause: "retry" })]);
  });

  it("pauses with binding_unknown when the lookup is unavailable and accepts no Resume", () => {
    const sim = restart(afterAgentIntent(), facts({ agentsByKey: "unavailable" }));
    expect(pauseReason(sim.state)).toBe("binding_unknown");
    expect(sim.state.attempts["a#1"]?.endedAt).toBeNull();
    expect(decide(sim.state)).toEqual([]);
    expect(resumeRun(sim.state)).toMatchObject({ ok: false, code: "reconcile_required" });
  });

  it("pauses with binding_unknown and stops every agent when several carry the key", () => {
    const sim = restart(afterAgentIntent(), facts({ agentsByKey: new Map([[KEY, ["agent-x", "agent-y"]]]), agents: new Map([["agent-x", "running"], ["agent-y", "running"]]) }));
    expect(pauseReason(sim.state)).toBe("binding_unknown");
    const interrupts = decide(sim.state).filter((effect) => effect.kind === "interrupt_agent");
    expect(interrupts.map((effect) => (effect.kind === "interrupt_agent" ? effect.agentId : "")).sort()).toEqual(["agent-x", "agent-y"]);
    expect(decide(sim.state).some((effect) => effect.kind === "create_agent")).toBe(false);
  });
});

describe("reconcile: workspace intents", () => {
  function afterWorkspaceIntent(): Sim {
    const sim = new Sim(snapshotOf(WORKFLOW));
    sim.settle();
    return sim;
  }
  const workspace = { workspaceId: "ws-1", branchName: "flightpath/run-run1", directory: "/w", baseCommit: "base" };

  it("records the deterministic intent when a crash came before it, without a host call", () => {
    const sim = new Sim(snapshotOf(WORKFLOW));
    const events = reconcile(sim.state, facts(), "later");
    expect(events.map((event) => event.kind)).toEqual(["workspace.intent"]);
    expect(events[0]).toMatchObject({ branchName: "flightpath/run-run1" });
  });

  it("binds the one workspace on the run's branch with its base commit", () => {
    const sim = restart(afterWorkspaceIntent(), facts({ workspaces: [workspace, { ...workspace, workspaceId: "other", branchName: "flightpath/run-x" }] }));
    expect(sim.state.workspace).toEqual({ branchName: "flightpath/run-run1", workspaceId: "ws-1", directory: "/w", baseCommit: "base" });
  });

  it("repeats the creation with the same branch when nothing matches", () => {
    const sim = restart(afterWorkspaceIntent(), facts());
    expect(pauseReason(sim.state)).toBeNull();
    expect(decide(sim.state)).toEqual([expect.objectContaining({ kind: "create_workspace", branchName: "flightpath/run-run1" })]);
  });

  it("pauses with binding_unknown on several matches and on an unavailable lookup", () => {
    for (const workspaces of [[workspace, { ...workspace, workspaceId: "ws-2" }], "unavailable" as const]) {
      const sim = restart(afterWorkspaceIntent(), facts({ workspaces }));
      expect(pauseReason(sim.state)).toBe("binding_unknown");
      expect(decide(sim.state)).toEqual([]);
    }
  });
});

describe("reconcile: checks and barriers", () => {
  /** A run stopped after its check process was recorded and before its evidence. */
  function afterCheckLaunch(): Sim {
    const sim = new Sim(snapshotOf(WORKFLOW), { check: () => "hold" });
    sim.run();
    sim.apply([{ kind: "check.launched", attemptId: "a#1", cycleId: "a#1/c1", index: 0, pid: 4242, pgid: 4242, startedAt: "boot-1" }]);
    return sim;
  }

  it("keeps a run paused while a recorded check process is alive, then discards the batch", () => {
    const before = afterCheckLaunch();
    const sim = restart(before, facts({ agents: new Map([["agent-run1:a#1:worker", "idle"]]), liveCheckGroups: new Set(["4242:boot-1"]) }));
    expect(runStatus(sim.state)).toBe("paused");
    const effects = decide(sim.state);
    expect(effects.filter((effect) => effect.kind === "cancel_checks")).toEqual([expect.objectContaining({ processes: [{ pid: 4242, pgid: 4242, startedAt: "boot-1" }] })]);
    expect(effects.some((effect) => effect.kind === "start_attempt" || effect.kind === "open_cycle" || effect.kind === "run_checks")).toBe(false);
    expect(resumeRun(sim.state)).toMatchObject({ ok: false, code: "quiesce_pending" });
    sim.apply([{ kind: "quiesce.confirmed", barrierId: "q1" }]);
    expect(sim.state.cycles["a#1/c1"]?.status).toBe("invalidated");
    sim.apply(resumeRun(sim.state).events);
    expect(decide(sim.state)).toEqual([expect.objectContaining({ kind: "open_cycle", cycleId: "a#1/c2" })]);
    expect(sim.state.jobs.a?.retriesUsed).toBe(0);
  });

  it("discards an interrupted batch whose process is gone without a barrier", () => {
    const sim = restart(afterCheckLaunch(), facts({ agents: new Map([["agent-run1:a#1:worker", "idle"]]) }));
    expect(sim.state.barriers).toEqual([]);
    expect(sim.state.cycles["a#1/c1"]?.status).toBe("invalidated");
    expect(pauseReason(sim.state)).toBe("recovery");
  });

  it("resumes an open barrier by confirming it when its agents and processes are gone", () => {
    const sim = new Sim(snapshotOf(WORKFLOW), { worker: () => "hold", quiesce: () => "hold" });
    sim.run();
    sim.apply([{ kind: "quiesce.started", barrierId: "q1", attempts: ["a#1"], cause: "stop_job", jobId: "a" }]);
    const running = restart(sim, facts({ agents: new Map([["agent-run1:a#1:worker", "running"]]) }));
    expect(running.state.barriers[0]?.status).toBe("pending");
    expect(decide(running.state).map((effect) => effect.kind)).toEqual(["interrupt_agent"]);
    const gone = restart(sim, facts({ agents: new Map([["agent-run1:a#1:worker", "gone"]]) }));
    expect(gone.state.barriers[0]?.status).toBe("confirmed");
    gone.settle();
    expect(gone.state.attempts["a#1"]).toMatchObject({ outcome: "stopped" });
  });

  it("records the settled worker turn of an agent that finished while the server was down", () => {
    const sim = new Sim(snapshotOf(WORKFLOW), {
      worker: (attempt, s) => {
        s.write();
        const agentId = s.state.attempts[attempt]?.roles.worker?.binding.agentId ?? "";
        return [{ kind: "attempt.outputs_accepted", attemptId: attempt, role: "worker", agentId, outputs: {}, summary: "ok" }];
      },
    });
    sim.run();
    const restarted = restart(sim, facts({ agents: new Map([["agent-run1:a#1:worker", "idle"]]) }));
    expect(restarted.state.attempts["a#1"]).toMatchObject({ workerSettled: true, outcome: null });
  });

  it("emits no event for a healthy running run and never a new key", () => {
    const sim = new Sim(snapshotOf(WORKFLOW), { worker: () => "hold" });
    sim.run();
    expect(reconcile(sim.state, facts({ agents: new Map([["agent-run1:a#1:worker", "running"]]) }), "later")).toEqual([]);
    for (const status of [undefined, "gone" as const]) {
      const events = reconcile(sim.state, facts(status ? { agents: new Map([["agent-run1:a#1:worker", status]]) } : {}), "later");
      expect(events.some((event) => event.kind === "agent.intent")).toBe(false);
      let state = sim.state;
      for (const event of events) state = reduce(state, event);
      expect(state.attempts["a#1"]?.outcome).toBe(status ? "lost" : null);
    }
  });

  it("keeps an open barrier unconfirmed without an observed stop or with an unbound intent", () => {
    const sim = new Sim(snapshotOf(WORKFLOW), { worker: () => "hold", quiesce: () => "hold" });
    sim.run();
    sim.apply([{ kind: "quiesce.started", barrierId: "q1", attempts: ["a#1"], cause: "stop_job", jobId: "a" }]);
    expect(restart(sim, facts()).state.barriers[0]?.status).toBe("pending");
    expect(restart(sim, facts({ agents: new Map([["agent-run1:a#1:worker", "closed"]]) })).state.barriers[0]?.status).toBe("confirmed");

    const unbound = afterAgentIntent();
    unbound.apply([{ kind: "quiesce.started", barrierId: "q1", attempts: ["a#1"], cause: "stop_job", jobId: "a" }]);
    const restarted = restart(unbound, facts({ idempotentCreate: false }));
    expect(restarted.state.barriers[0]?.status).toBe("pending");
    expect(pauseReason(restarted.state)).toBe("binding_unknown");
    expect(decide(restarted.state).some((effect) => effect.kind === "create_agent" || effect.kind === "start_attempt")).toBe(false);
  });
});
