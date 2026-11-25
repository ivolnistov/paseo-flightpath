import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventBody } from "../shared/run";
import { jobContext } from "./mcp-tools";
import { resolveCommand } from "./commands";
import { resolveText, resolveWith, UnresolvedReferenceError } from "./outputs";
import { retryJob } from "./run-actions";
import { creationKey, cycleCommands, decide, graphJob, isActive, jobStatus, replay, runStatus, toRunView, type Effect } from "./run-engine";
import { Sim, snapshotOf, type Policy } from "./run-test-kit";
import { expandWorkflow } from "./workflow-expand";
import { FULL_WORKFLOW, parseValid } from "./test-fixtures";

const STATIC_CHECKS = `name: Static
jobs:
  build: { uses: agent, with: { prompt: Build, agent: { model: provider-a/m1 } } }
  tests:
    needs: [build]
    uses: checks
    strategy: { matrix: { module: [api, web, cli] }, max-parallel: 2 }
    with: { isolated: true, run: [[npm, test, --, "\${{ matrix.module }}"]] }
  after: { needs: [tests], uses: checks, with: { run: [done] } }
`;

const STATIC_AGENTS = `name: Agents
jobs:
  write:
    uses: agent
    strategy: { matrix: { lang: [en, de, fr] }, max-parallel: 3 }
    with: { prompt: "Translate into \${{ matrix.lang }}", agent: { model: provider-a/m1 } }
  after: { needs: [write], uses: checks, with: { run: [done] } }
`;

const DYNAMIC = `name: Dynamic
jobs:
  discover:
    uses: agent
    with: { prompt: Find, agent: { model: provider-a/m1 } }
    outputs: { modules: { type: list, items: string } }
  tests:
    needs: [discover]
    uses: checks
    strategy: { matrix: { module: "\${{ needs.discover.outputs.modules }}" }, max-parallel: 2 }
    with: { isolated: true, run: [[npm, test, --, "\${{ matrix.module }}"]] }
  review: { needs: [tests], uses: review, with: { agent: { model: provider-a/m1 } }, rework: { to: discover, max: 1 } }
`;

const DYNAMIC_AGENTS = `name: Dynamic agents
jobs:
  discover:
    uses: agent
    with: { prompt: Find, agent: { model: provider-a/m1 } }
    outputs: { modules: { type: list, items: string } }
  fix:
    needs: [discover]
    uses: agent
    strategy: { matrix: { module: "\${{ needs.discover.outputs.modules }}" } }
    with: { prompt: "Fix \${{ matrix.module }}", agent: { model: provider-a/m1 } }
`;

/** A Sim that records the highest number of simultaneously active instances of each matrix. */
class MatrixSim extends Sim {
  peak = new Map<string, number>();

  override apply(bodies: readonly RunEventBody[]): RunEvent[] {
    const stamped = super.apply(bodies);
    const counts = new Map<string, number>();
    for (const a of Object.values(this.state.attempts)) {
      if (!isActive(a)) continue;
      const gj = graphJob(this.state, a.jobId);
      if (gj.matrixIndex !== undefined) counts.set(gj.sourceJobId, (counts.get(gj.sourceJobId) ?? 0) + 1);
    }
    for (const [id, count] of counts) this.peak.set(id, Math.max(this.peak.get(id) ?? 0, count));
    return stamped;
  }
}

/** A worker policy that submits `modules` for each attempt of `discover`, in order. */
function discovering(lists: unknown[][]): Policy["worker"] {
  return (attemptId, sim) => {
    if (!attemptId.startsWith("discover#")) return undefined;
    const a = sim.state.attempts[attemptId];
    const agentId = a?.roles.worker?.binding.agentId ?? "";
    sim.write();
    return [
      { kind: "attempt.outputs_accepted", attemptId, role: "worker", agentId, outputs: { modules: lists[(a?.n ?? 1) - 1] ?? [] }, summary: "found" },
      { kind: "agent.turn_ended", attemptId, role: "worker", agentId, result: "completed" },
    ];
  };
}

const matrixEvents = (sim: Sim): RunEvent[] => sim.events.filter((event) => event.kind === "matrix.expanded" || event.kind === "matrix.failed");
const started = (sim: Sim, prefix: string): string[] => sim.events.flatMap((event) => (event.kind === "attempt.started" && event.jobId.startsWith(prefix) ? [event.attemptId] : []));
const checkEffects = (sim: Sim): Array<Extract<Effect, { kind: "run_checks" }>> => sim.effectsSeen.filter((effect): effect is Extract<Effect, { kind: "run_checks" }> => effect.kind === "run_checks");

describe("matrix expansion at Start", () => {
  it("expands the full example's dynamic matrix as one unexpanded job carrying its declaration", () => {
    const graph = expandWorkflow(parseValid(FULL_WORKFLOW), { goal: "x" });
    const job = graph.jobs.find((gj) => gj.id === "module-tests");
    expect(job?.matrix).toEqual({ key: "module", source: { ref: { jobId: "discover", output: "modules" } }, maxParallel: 2 });
    expect(job?.matrixIndex).toBeUndefined();
    expect(graph.groups.filter((group) => group.kind === "matrix")).toEqual([]);
    expect(graph.edges.filter((edge) => edge.to === "module-tests" || edge.from === "module-tests")).toEqual([
      { from: "discover", to: "module-tests" },
      { from: "implement.main", to: "module-tests" },
      { from: "module-tests", to: "review" },
    ]);
  });

  it("replaces a static matrix by indexed instances in one group, each wired to the job's needs and dependents", () => {
    const graph = expandWorkflow(parseValid(STATIC_CHECKS), {});
    expect(graph.jobs.map((gj) => gj.id)).toEqual(["build", "tests[0]", "tests[1]", "tests[2]", "after"]);
    expect(graph.jobs.filter((gj) => gj.matrixIndex !== undefined).map((gj) => [gj.id, gj.sourceJobId, gj.matrixIndex, gj.name])).toEqual([
      ["tests[0]", "tests", 0, "tests (api)"],
      ["tests[1]", "tests", 1, "tests (web)"],
      ["tests[2]", "tests", 2, "tests (cli)"],
    ]);
    expect(graph.groups).toEqual([{ id: "tests", kind: "matrix", jobIds: ["tests[0]", "tests[1]", "tests[2]"] }]);
    expect(graph.edges).toEqual([
      { from: "build", to: "tests[0]" },
      { from: "build", to: "tests[1]" },
      { from: "build", to: "tests[2]" },
      { from: "tests[0]", to: "after" },
      { from: "tests[1]", to: "after" },
      { from: "tests[2]", to: "after" },
    ]);
  });
});

describe("matrix scheduling", () => {
  it("never runs more isolated check instances than max-parallel and joins only after every instance succeeds", () => {
    const held = new MatrixSim(snapshotOf(STATIC_CHECKS), { check: () => "hold" });
    held.runAll();
    expect(started(held, "tests[")).toEqual(["tests[0]#1", "tests[1]#1"]);
    expect(held.peak.get("tests")).toBe(2);
    for (let seed = 1; seed <= 20; seed += 1) {
      const shuffled = new MatrixSim(snapshotOf(STATIC_CHECKS), {}, seed);
      shuffled.runAll();
      expect(runStatus(shuffled.state)).toBe("finished");
      expect(shuffled.peak.get("tests") ?? 0).toBeLessThanOrEqual(2);
      expect(shuffled.writerWithIsolated).toBe(false);
    }
    const sim = new MatrixSim(snapshotOf(STATIC_CHECKS));
    sim.runAll();
    expect(runStatus(sim.state)).toBe("finished");
    expect(started(sim, "tests[")).toEqual(["tests[0]#1", "tests[1]#1", "tests[2]#1"]);
    expect(sim.events.flatMap((event) => (event.kind === "attempt.started" && event.jobId.startsWith("tests[") ? [event.matrixValue] : []))).toEqual(["api", "web", "cli"]);
    const after = sim.startSeq("after");
    for (const id of ["tests[0]", "tests[1]", "tests[2]"]) expect(sim.successSeq(id)).toBeLessThan(after);
    expect(checkEffects(sim).filter((effect) => effect.jobId.startsWith("tests[")).map((effect) => [effect.mode, effect.commands])).toEqual([
      ["isolated", [{ argv: ["npm", "test", "--", "api"] }]],
      ["isolated", [{ argv: ["npm", "test", "--", "web"] }]],
      ["isolated", [{ argv: ["npm", "test", "--", "cli"] }]],
    ]);
  });

  it("runs agent instances one at a time even with room under max-parallel", () => {
    const held = new MatrixSim(snapshotOf(STATIC_AGENTS), { worker: () => "hold" });
    held.runAll();
    expect(started(held, "write[")).toEqual(["write[0]#1"]);
    const sim = new MatrixSim(snapshotOf(STATIC_AGENTS));
    sim.runAll();
    expect(runStatus(sim.state)).toBe("finished");
    expect(sim.peak.get("write")).toBe(1);
    expect(sim.maxHolders).toBe(1);
    expect(sim.state.attempts["write[1]#1"]?.matrixValue).toBe("de");
    expect(Object.values(sim.state.attempts).flatMap((a) => a.roles.worker?.binding.creationKey ?? [])).toEqual([
      creationKey("run1", "write[0]#1", "worker"),
      creationKey("run1", "write[1]#1", "worker"),
      creationKey("run1", "write[2]#1", "worker"),
    ]);
  });

  it("a failed instance fails the matrix: unstarted instances wait, dependents never start, and a human Retry releases them", () => {
    let failOnce = true;
    const sim = new MatrixSim(
      snapshotOf(STATIC_CHECKS.replace("max-parallel: 2", "max-parallel: 1")),
      {
        check: (jobId) => {
          if (jobId !== "tests[1]" || !failOnce) return 0;
          failOnce = false;
          return 1;
        },
      },
    );
    sim.runAll();
    expect(jobStatus(sim.state, "tests[0]")).toBe("succeeded");
    expect(jobStatus(sim.state, "tests[1]")).toBe("failed");
    expect(jobStatus(sim.state, "tests[2]")).toBe("waiting");
    expect(sim.jobStarts("tests[2]")).toBe(0);
    expect(sim.jobStarts("after")).toBe(0);
    expect(runStatus(sim.state)).toBe("running");
    const retry = retryJob(sim.state, { jobId: "tests[1]" });
    if (!retry.ok) throw new Error(retry.message);
    sim.apply(retry.events);
    sim.runAll();
    expect(started(sim, "tests[")).toEqual(["tests[0]#1", "tests[1]#1", "tests[1]#2", "tests[2]#1"]);
    expect(runStatus(sim.state)).toBe("finished");
  });
});

describe("dynamic matrix", () => {
  it("expands only after its source succeeds, pinned to that attempt, and joins after every instance", () => {
    const sim = new MatrixSim(snapshotOf(DYNAMIC), { worker: discovering([["api", "web", "cli"]]) });
    const held = new MatrixSim(snapshotOf(DYNAMIC), { worker: () => "hold" });
    held.runAll();
    expect(matrixEvents(held)).toEqual([]);
    expect(held.state.order).toEqual(["discover", "tests", "review"]);
    expect(jobStatus(held.state, "tests")).toBe("waiting");

    sim.runAll();
    expect(runStatus(sim.state)).toBe("finished");
    const [expanded] = matrixEvents(sim);
    expect(expanded).toMatchObject({ kind: "matrix.expanded", jobId: "tests", sourceAttemptId: "discover#1", values: ["api", "web", "cli"] });
    expect(expanded?.seq).toBeGreaterThan(sim.successSeq("discover"));
    expect(sim.startSeq("tests[0]")).toBeGreaterThan(expanded?.seq ?? Infinity);
    expect(sim.state.order).toEqual(["discover", "tests[0]", "tests[1]", "tests[2]", "review"]);
    expect(sim.state.graph.groups).toEqual([{ id: "tests", kind: "matrix", jobIds: ["tests[0]", "tests[1]", "tests[2]"] }]);
    const capped = new MatrixSim(snapshotOf(DYNAMIC), { worker: discovering([["api", "web", "cli"]]), check: () => "hold" });
    capped.runAll();
    expect(started(capped, "tests[")).toEqual(["tests[0]#1", "tests[1]#1"]);
    for (const id of ["tests[0]", "tests[1]", "tests[2]"]) expect(sim.successSeq(id)).toBeLessThan(sim.startSeq("review"));
    expect(matrixEvents(sim)).toHaveLength(1);
  });

  it.each([
    ["matrix_empty", []],
    ["matrix_too_large", Array.from({ length: 65 }, (_, index) => `m${index}`)],
    ["matrix_invalid", ["api", "api"]],
  ])("fails the matrix job with %s and starts no instance", (reason, modules) => {
    const sim = new MatrixSim(snapshotOf(DYNAMIC), { worker: discovering([modules]) });
    sim.runAll();
    expect(matrixEvents(sim)).toEqual([expect.objectContaining({ kind: "matrix.failed", jobId: "tests", sourceAttemptId: "discover#1", reason })]);
    expect(jobStatus(sim.state, "tests")).toBe("failed");
    expect(sim.state.jobs.tests?.reason).toBe(reason);
    expect(started(sim, "tests")).toEqual([]);
    expect(sim.jobStarts("review")).toBe(0);
    expect(runStatus(sim.state)).toBe("running");
    expect(retryJob(sim.state, { jobId: "tests" })).toMatchObject({ ok: false, code: "not_retryable" });
  });

  it("rebuilds the same state, instance ids, attempt ids and creation keys from the journal mid-matrix", () => {
    const sim = new MatrixSim(snapshotOf(DYNAMIC_AGENTS), {
      worker: (attemptId, s) => (attemptId === "fix[1]#1" ? "hold" : discovering([["api", "web", "cli"]])?.(attemptId, s)),
    });
    sim.runAll();
    expect(sim.state.attempts["fix[1]#1"]?.endedAt).toBeNull();
    const rebuilt = replay(sim.snapshot, sim.events);
    expect(rebuilt).toEqual(sim.state);
    expect(rebuilt.order).toEqual(["discover", "fix[0]", "fix[1]", "fix[2]"]);
    expect(rebuilt.attempts["fix[1]#1"]?.roles.worker?.binding).toMatchObject({ creationKey: creationKey("run1", "fix[1]#1", "worker"), agentId: `agent-${creationKey("run1", "fix[1]#1", "worker")}` });
    expect(decide(rebuilt)).toEqual(decide(sim.state));
    expect(decide(rebuilt).filter((effect) => effect.kind === "create_agent" || effect.kind === "start_attempt")).toEqual([]);
    expect(sim.agentCount).toBe(3);
  });

  it("a rework of the source with a shorter list supersedes every instance, re-expands and retires the extra indexes", () => {
    let reviews = 0;
    const emit = discovering([["api", "web", "cli"], ["api"]]);
    const sim = new MatrixSim(snapshotOf(DYNAMIC), {
      worker: (attemptId, s) => (attemptId === "discover#2" ? "hold" : emit?.(attemptId, s)),
      reviewer: (attemptId, cycleId, s) => {
        reviews += 1;
        if (reviews > 1) return "approve";
        const agentId = s.state.attempts[attemptId]?.roles.reviewer?.binding.agentId ?? "";
        s.apply([{ kind: "review.submitted", attemptId, cycleId, role: "reviewer", agentId, outcome: "changes_requested", findings: [{ title: "Too many", detail: "", tasks: [] }], criteria: [], identity: { ...s.worktree } }]);
        return "hold";
      },
    });
    sim.runAll();

    // discover#2 is running: the superseded source result and the instances' values resolve nowhere.
    const windowState = sim.state;
    expect(windowState.attempts["discover#2"]).toMatchObject({ endedAt: null, outputs: null });
    expect(windowState.attempts["discover#1"]?.outcome).toBe("superseded");
    expect(windowState.jobs.discover?.succeeded).toBeNull();
    const instance = graphJob(windowState, "tests[0]");
    expect(() => resolveText("${{ needs.discover.outputs.modules }}", instance, windowState)).toThrow(UnresolvedReferenceError);
    for (const id of ["tests[0]", "tests[1]", "tests[2]"]) {
      const gj = graphJob(windowState, id);
      expect(windowState.attempts[`${id}#1`]?.outcome).toBe("superseded");
      expect(() => resolveWith(gj, windowState)).toThrow(UnresolvedReferenceError);
      expect(cycleCommands(gj).map((command) => resolveCommand(command, gj, windowState))).toEqual([{ ok: false, reason: "ref_value_invalid" }]);
    }
    expect(decide(windowState).filter((effect) => effect.kind === "start_attempt" || effect.kind === "create_agent" || effect.kind === "record")).toEqual([]);
    expect(matrixEvents(sim)).toHaveLength(1);
    const startsBefore = sim.events.filter((event) => event.kind === "attempt.started").length;
    const reworkSeq = sim.events.find((event) => event.kind === "rework.started")?.seq ?? Infinity;
    expect(sim.events.flatMap((event) => (event.kind === "attempt.started" && event.seq > reworkSeq ? [event.attemptId] : []))).toEqual(["discover#2"]);

    const agentId = windowState.attempts["discover#2"]?.roles.worker?.binding.agentId ?? "";
    sim.write();
    sim.apply([
      { kind: "attempt.outputs_accepted", attemptId: "discover#2", role: "worker", agentId, outputs: { modules: ["api"] }, summary: "found" },
      { kind: "agent.turn_ended", attemptId: "discover#2", role: "worker", agentId, result: "completed" },
    ]);
    sim.runAll();
    expect(sim.events.filter((event) => event.kind === "attempt.started").length).toBeGreaterThan(startsBefore);
    expect(sim.successSeq("tests[0]")).toBeLessThan(sim.startSeq("review"));
    expect(runStatus(sim.state)).toBe("finished");
    const rework = sim.events.find((event) => event.kind === "rework.started");
    expect(rework).toMatchObject({ to: "discover", affected: ["discover", "tests[0]", "tests[1]", "tests[2]", "review"] });
    expect(rework?.kind === "rework.started" ? rework.superseded : []).toEqual(expect.arrayContaining(["discover#1", "tests[0]#1", "tests[1]#1", "tests[2]#1"]));
    expect(matrixEvents(sim).map((event) => (event.kind === "matrix.expanded" ? [event.sourceAttemptId, event.values] : []))).toEqual([
      ["discover#1", ["api", "web", "cli"]],
      ["discover#2", ["api"]],
    ]);
    expect(sim.state.order).toEqual(["discover", "tests[0]", "review"]);
    expect(sim.state.graph.edges).toEqual([
      { from: "discover", to: "tests[0]" },
      { from: "tests[0]", to: "review" },
    ]);
    expect(started(sim, "tests[")).toEqual(["tests[0]#1", "tests[1]#1", "tests[2]#1", "tests[0]#2"]);
    expect(sim.state.attempts["tests[0]#2"]).toMatchObject({ cause: "rework", matrixValue: "api", outcome: "succeeded" });
    const view = toRunView(sim.state);
    expect(view.jobs.map((job) => [job.id, job.status, job.retired ?? false])).toEqual([
      ["discover", "succeeded", false],
      ["tests[0]", "succeeded", false],
      ["review", "succeeded", false],
      ["tests[1]", "waiting", true],
      ["tests[2]", "waiting", true],
    ]);
    expect(view.jobs.find((job) => job.id === "tests[2]")?.attempts.map((a) => [a.attemptId, a.outcome, a.matrixValue])).toEqual([["tests[2]#1", "superseded", "cli"]]);
    expect(retryJob(sim.state, { jobId: "tests[2]" })).toMatchObject({ ok: false });
  });

  it("passes a value with quotes, spaces and a command substitution to argv as one argument and to the job context", () => {
    const value = `it's "a b" $(touch /tmp/pwned) \`id\``;
    const sim = new MatrixSim(snapshotOf(DYNAMIC), { worker: discovering([[value]]) });
    sim.runAll();
    expect(checkEffects(sim).find((effect) => effect.jobId === "tests[0]")?.commands).toEqual([{ argv: ["npm", "test", "--", value] }]);
    const agents = new MatrixSim(snapshotOf(DYNAMIC_AGENTS), { worker: (attemptId, s) => (attemptId.startsWith("fix[") ? "hold" : discovering([[value]])?.(attemptId, s)) });
    agents.runAll();
    const a = agents.state.attempts["fix[0]#1"];
    if (!a) throw new Error("no instance attempt");
    expect(jobContext(agents.state, a, "worker")).toMatchObject({ prompt: `Fix ${value}`, matrix: { key: "module", index: 0, value } });
  });
});
