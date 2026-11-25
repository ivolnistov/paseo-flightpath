import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelRun, retryJob, stopJob } from "./run-actions";
import { creationKey, pauseReason, runStatus } from "./run-engine";
import { createDriverHarness, type DriverHarness } from "./test-support/driver-harness";

let h: DriverHarness;

beforeEach(async () => {
  h = await createDriverHarness();
});

afterEach(async () => {
  await h.dispose();
});

const AGENT_WITH_REVIEW = `name: Build
jobs:
  build:
    uses: agent
    with: { prompt: Build it, agent: { model: provider-a/m1 } }
    done:
      - run: [make]
      - criterion: It builds
  lint: { needs: [build], uses: checks, with: { run: [npm run lint] } }
`;

const FAILOVER = `name: Failover
jobs:
  build:
    uses: agent
    with: { prompt: Build it, agent: { model: provider-a/m1, fallback: { model: provider-b/model-b }, retries: 1 } }
`;

const SINGLE = `name: Single
jobs:
  build: { uses: agent, with: { prompt: Build it, agent: { model: provider-a/m1, retries: 1 } } }
`;

const REWORK = `name: Rework
jobs:
  build: { uses: agent, with: { prompt: Build it, agent: { model: provider-a/m1 } } }
  review: { needs: [build], uses: review, with: { agent: { model: provider-a/m1 } }, rework: { to: build, max: 2 } }
`;

const ISOLATED = `name: Iso
jobs:
  build: { uses: agent, with: { prompt: Build it, agent: { model: provider-a/m1 } } }
  c1: { needs: [build], uses: checks, with: { isolated: true, run: [one] } }
  c2: { needs: [build], uses: checks, with: { isolated: true, run: [two] } }
  after: { needs: [build], uses: agent, with: { prompt: More, agent: { model: provider-a/m1 } } }
`;

const MATRIX_CHECKS = `name: Matrix checks
jobs:
  build: { uses: agent, with: { prompt: Build it, agent: { model: provider-a/m1 } } }
  tests:
    needs: [build]
    uses: checks
    strategy: { matrix: { module: [api, web, cli] }, max-parallel: 2 }
    with: { isolated: true, run: [[npm, test, --, "\${{ matrix.module }}"]] }
  after: { needs: [tests], uses: checks, with: { run: [done] } }
`;

const MATRIX_DYNAMIC = `name: Matrix dynamic
jobs:
  discover:
    uses: agent
    with: { prompt: Find, agent: { model: provider-a/m1 } }
    outputs: { modules: { type: list, items: string } }
  tests:
    needs: [discover]
    uses: checks
    strategy: { matrix: { module: "\${{ needs.discover.outputs.modules }}" }, max-parallel: 2 }
    with: { run: [[npm, test, --, "\${{ matrix.module }}"]] }
  fix:
    needs: [discover]
    uses: agent
    strategy: { matrix: { module: "\${{ needs.discover.outputs.modules }}" } }
    with: { prompt: "Fix \${{ matrix.module }}", agent: { model: provider-a/m1 } }
`;

describe("driver: a run end to end on the fake host", () => {
  it("creates the workspace, the worker, runs checks, binds a separate reviewer and finishes", async () => {
    const snapshot = await h.start(AGENT_WITH_REVIEW, { runId: "r1" });
    expect(h.host.calls.createWorkspace).toBe(1);
    expect(h.host.calls.createAgent).toEqual([creationKey("r1", "build#1", "worker")]);
    expect(await h.complete("r1", "build#1")).toEqual({ ok: true, value: { status: "accepted" } });
    expect(h.host.calls.createAgent).toEqual([creationKey("r1", "build#1", "worker"), creationKey("r1", "build#1", "reviewer")]);
    expect(h.reviewerAgent("r1", "build#1")).not.toBe(h.workerAgent("r1", "build#1"));
    expect((await h.review("r1", "build#1", { criteria: [{ index: 1, met: true }] })).ok).toBe(true);
    await h.settle(snapshot.runId);
    const state = await h.driver.read("r1");
    expect(runStatus(state)).toBe("finished");
    const kinds = await h.kinds("r1");
    expect(kinds.indexOf("workspace.intent")).toBeLessThan(kinds.indexOf("workspace.bound"));
    expect(kinds.filter((kind) => kind === "check.launched")).toHaveLength(2);
    expect(h.checks.batches.map((batch) => batch.input.mode)).toEqual(["exclusive", "exclusive"]);
  });

  it("refuses tool calls from the wrong role and from a superseded attempt", async () => {
    await h.start(SINGLE, { runId: "r1" });
    const { callTool } = await import("./mcp-tools");
    const worker = h.workerAgent("r1", "build#1");
    expect(await callTool(h.tools, { kind: "attempt", runId: "r1", attemptId: "build#1", role: "worker", agentId: worker }, "pipeline_review_submit", { outcome: "approved", findings: [], criteria: [] })).toMatchObject({ ok: false, code: "role_forbidden" });
    await h.driver.act("r1", (state) => stopJob(state, { jobId: "build" }));
    await h.settle("r1");
    expect(await callTool(h.tools, { kind: "attempt", runId: "r1", attemptId: "build#1", role: "worker", agentId: worker }, "pipeline_job_context", {})).toMatchObject({ ok: false, code: "stale_attempt" });
  });
});

describe("driver: listing", () => {
  it("peeks at a run that is not loaded without keeping it in memory", async () => {
    const snapshot = await h.start(SINGLE, { runId: "r1" });
    await h.settle(snapshot.runId);
    const fresh = h.restart();
    expect((await fresh.peek("r1")).health).toBe("ok");
    await rm(join(h.dir, "runs", snapshot.projectId, "r1"), { recursive: true, force: true });
    await expect(fresh.peek("r1")).rejects.toMatchObject({ code: "run_not_found", message: "Run r1 was not found." });
  });
});

describe("driver: subscriptions", () => {
  it("notifies a listener that subscribes again after the last one released", async () => {
    await h.start(SINGLE, { runId: "r1" });
    let first = 0;
    let second = 0;
    const releaseFirst = h.driver.subscribe("r1", () => (first += 1));
    releaseFirst();
    const releaseSecond = h.driver.subscribe("r1", () => (second += 1));
    releaseFirst();
    await h.driver.act("r1", (state) => stopJob(state, { jobId: "build" }));
    await h.settle("r1");
    releaseSecond();
    expect(first).toBe(0);
    expect(second).toBeGreaterThan(0);
  });
});

describe("driver: two isolated checks", () => {
  it("overlap on one identity while no writer is active, and a failed copy reruns exclusive", async () => {
    h.checks.script = () => ({ hold: true });
    await h.start(ISOLATED, { runId: "r1" });
    await h.complete("r1", "build#1");
    await h.settle("r1");
    expect(h.checks.batches.map((batch) => batch.input.attemptId).sort()).toEqual(["c1#1", "c2#1"]);
    expect(h.checks.activePeak).toBe(2);
    expect(h.host.calls.createAgent.filter((key) => key.includes(":after#"))).toEqual([]);
    expect(h.checks.batches[0]?.input.identity).toEqual(h.checks.batches[1]?.input.identity);
    for (const batch of h.checks.batches) batch.release();
    await h.settle("r1");
    expect(h.host.calls.createAgent.filter((key) => key.includes(":after#"))).toHaveLength(1);
  });

  it("holds an unchanged overlapping group's results until the whole group drains", async () => {
    h.checks.script = () => ({ hold: true });
    await h.start(ISOLATED, { runId: "r1" });
    await h.complete("r1", "build#1");
    await h.settle("r1");
    const [first, second] = h.checks.batches;
    first?.release();
    await h.settle("r1");
    let state = await h.driver.read("r1");
    expect(state.evidence.filter((item) => item.kind === "check")).toEqual([]);
    expect(state.attempts[first?.input.attemptId ?? ""]?.endedAt).toBeNull();
    expect(h.host.calls.createAgent.filter((key) => key.includes(":after#"))).toEqual([]);
    second?.release();
    await h.settle("r1");
    state = await h.driver.read("r1");
    expect(state.evidence.filter((item) => item.kind === "check").map((item) => [item.attemptId, item.result, item.mode])).toEqual([
      [first?.input.attemptId, "pass", "isolated"],
      [second?.input.attemptId, "pass", "isolated"],
    ]);
    expect(state.jobs.c1?.succeeded).toBe("c1#1");
    expect(state.jobs.c2?.succeeded).toBe("c2#1");
    expect(h.host.calls.createAgent.filter((key) => key.includes(":after#"))).toHaveLength(1);
  });

  it("an escape by a later batch makes the earlier finished batch late too, and both rerun exclusive", async () => {
    let starts = 0;
    h.checks.script = (input) => {
      starts += 1;
      if (input.mode === "exclusive") return {};
      return input.attemptId === "c2#1" ? { hold: true, during: () => h.host.write(input.canonicalDir) } : {};
    };
    await h.start(ISOLATED, { runId: "r1" });
    await h.complete("r1", "build#1");
    await h.settle("r1");
    const c2 = h.checks.batches.find((batch) => batch.input.attemptId === "c2#1");
    expect(h.checks.batches.map((batch) => batch.input.attemptId).sort()).toEqual(["c1#1", "c2#1"]);
    expect((await h.driver.read("r1")).evidence.filter((item) => item.kind === "check")).toEqual([]);
    c2?.release();
    await h.settle("r1");
    const state = await h.driver.read("r1");
    const first = state.evidence.filter((item) => item.kind === "check" && (item.cycleId === "c1#1/c1" || item.cycleId === "c2#1/c1"));
    expect(first.map((item) => item.result)).toEqual(["late", "late"]);
    expect(state.jobs.c1?.exclusive).toBe(true);
    expect(state.jobs.c2?.exclusive).toBe(true);
    const reruns = h.checks.batches.filter((batch) => batch.input.cycleId.endsWith("/c2"));
    expect(reruns.map((batch) => [batch.input.attemptId, batch.input.mode]).sort()).toEqual([
      ["c1#1", "exclusive"],
      ["c2#1", "exclusive"],
    ]);
    expect(state.jobs.c1?.succeeded).toBe("c1#1");
    expect(state.jobs.c2?.succeeded).toBe("c2#1");
    expect(starts).toBe(4);
  });

  it("a scratch copy that cannot be created invalidates the cycle and the job reruns exclusive", async () => {
    h.copies.fail = true;
    await h.start(ISOLATED, { runId: "r1" });
    await h.complete("r1", "build#1");
    await h.settle("r1");
    const state = await h.driver.read("r1");
    expect(state.jobs.c1?.exclusive).toBe(true);
    expect(h.checks.batches.filter((batch) => batch.input.attemptId === "c1#1").map((batch) => batch.input.mode)).toEqual(["exclusive"]);
  });
});

describe("driver: matrix", () => {
  it("never runs three isolated instances at once with max-parallel 2, and joins after all of them", async () => {
    h.checks.script = () => ({ hold: true });
    await h.start(MATRIX_CHECKS, { runId: "r1" });
    await h.complete("r1", "build#1");
    await h.settle("r1");
    expect(h.checks.batches.map((batch) => batch.input.attemptId)).toEqual(["tests[0]#1", "tests[1]#1"]);
    expect(h.checks.batches.map((batch) => batch.input.mode)).toEqual(["isolated", "isolated"]);
    h.checks.script = () => ({});
    for (const batch of h.checks.batches) batch.release();
    await h.settle("r1");
    const state = await h.driver.read("r1");
    expect(h.checks.batches.map((batch) => batch.input.attemptId)).toEqual(["tests[0]#1", "tests[1]#1", "tests[2]#1", "after#1"]);
    expect(h.checks.activePeak).toBe(2);
    expect(state.finished).toBe(true);
  });

  it("the run cap of 1 wins over a matrix cap of 2: one instance at a time, then all finish", async () => {
    h.checks.script = () => ({ hold: true });
    await h.start(MATRIX_CHECKS.replace("jobs:\n", "defaults: { max-parallel: 1 }\njobs:\n"), { runId: "r1" });
    await h.complete("r1", "build#1");
    await h.settle("r1");
    const snapshot = (await h.driver.read("r1")).snapshot;
    expect(snapshot.graph.maxParallel).toBe(1);
    expect(snapshot.graph.jobs.find((job) => job.id === "tests[0]")?.matrix?.maxParallel).toBe(2);
    const order = ["tests[0]#1", "tests[1]#1", "tests[2]#1", "after#1"];
    for (const step of order.keys()) {
      expect(h.checks.batches.map((batch) => batch.input.attemptId)).toEqual(order.slice(0, step + 1));
      expect(h.checks.active).toBe(1);
      h.checks.batches[step]?.release();
      await h.settle("r1");
    }
    const state = await h.driver.read("r1");
    expect(h.checks.batches.map((batch) => batch.input.attemptId)).toEqual(["tests[0]#1", "tests[1]#1", "tests[2]#1", "after#1"]);
    expect(h.checks.activePeak).toBe(1);
    expect(state.jobs["tests[2]"]?.succeeded).toBe("tests[2]#1");
    expect(state.finished).toBe(true);
  });

  it("expands from the submitted outputs and passes a hostile value as exactly one argv argument", async () => {
    const value = `it's "a b" $(touch /tmp/pwned) \`id\``;
    await h.start(MATRIX_DYNAMIC, { runId: "r1" });
    expect(h.checks.batches).toEqual([]);
    expect(await h.complete("r1", "discover#1", { modules: [value, "web"] })).toMatchObject({ ok: true });
    await h.settle("r1");
    expect(h.checks.batches.map((batch) => [batch.input.attemptId, batch.input.commands])).toEqual([
      ["tests[0]#1", [{ argv: ["npm", "test", "--", value] }]],
      ["tests[1]#1", [{ argv: ["npm", "test", "--", "web"] }]],
    ]);
    const kinds = await h.kinds("r1");
    expect(kinds.filter((kind) => kind === "matrix.expanded")).toHaveLength(2);
  });

  it("a restart mid-matrix rebuilds the same instances, attempts and keys and creates no second agent", async () => {
    await h.start(MATRIX_DYNAMIC.replace(/  tests:[\s\S]*?(?=  fix:)/, ""), { runId: "r1" });
    await h.complete("r1", "discover#1", { modules: ["api", "web", "cli"] });
    await h.settle("r1");
    await h.complete("r1", "fix[0]#1");
    await h.settle("r1");
    const keys = [creationKey("r1", "discover#1", "worker"), creationKey("r1", "fix[0]#1", "worker"), creationKey("r1", "fix[1]#1", "worker")];
    expect(h.host.calls.createAgent).toEqual(keys);
    const before = await h.driver.read("r1");
    const driver = h.restart();
    await driver.attach(h.host);
    await h.settle("r1");
    const after = await driver.read("r1");
    expect(after.order).toEqual(["discover", "fix[0]", "fix[1]", "fix[2]"]);
    expect(after.order).toEqual(before.order);
    expect(Object.keys(after.attempts)).toEqual(Object.keys(before.attempts));
    expect(after.attempts["fix[1]#1"]?.roles.worker?.binding).toEqual(before.attempts["fix[1]#1"]?.roles.worker?.binding);
    expect(h.host.calls.createAgent).toEqual(keys);
    for (const key of keys) expect(h.host.agentsFor(key)).toHaveLength(1);
  });
});

describe("driver: stopping", () => {
  it("a rework while the old turn still runs starts no new agent until the turn ends", async () => {
    const slow = await createDriverHarness({ quiesceTimeoutMs: 5_000 });
    try {
      slow.host.interruptMode = "ignore";
      await slow.start(REWORK, { runId: "r1" });
      await slow.complete("r1", "build#1");
      await slow.settle("r1");
      const reviewer = slow.reviewerAgent("r1", "review#1");
      const { callTool } = await import("./mcp-tools");
      await callTool(slow.tools, { kind: "attempt", runId: "r1", attemptId: "review#1", role: "reviewer", agentId: reviewer }, "pipeline_review_submit", { outcome: "changes_requested", findings: [{ title: "Fix", detail: "x", tasks: [] }], criteria: [] });
      const event = slow.host.turnEnded(reviewer);
      const agent = slow.host.agents.get(reviewer);
      if (agent) agent.status = "running";
      await slow.driver.onTurnEnded(event);
      const deadline = Date.now() + 2_000;
      while (!slow.host.calls.interrupt.includes(reviewer)) {
        if (Date.now() > deadline) throw new Error("the reviewer was never interrupted");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const state = await slow.driver.read("r1");
      expect(state.barriers.map((barrier) => [barrier.cause, barrier.status])).toEqual([["rework", "pending"]]);
      expect(slow.host.calls.interrupt).toContain(reviewer);
      expect(slow.host.calls.createAgent.filter((key) => key.includes("build#2"))).toEqual([]);
      await slow.endTurn(reviewer);
      await slow.settle("r1");
      const kinds = await slow.kinds("r1");
      expect(kinds.indexOf("quiesce.confirmed")).toBeGreaterThan(kinds.indexOf("rework.started"));
      expect(slow.host.calls.createAgent.filter((key) => key.includes("build#2"))).toHaveLength(1);
    } finally {
      await slow.dispose();
    }
  });

  it("a throwing interrupt pauses with quiesce_unconfirmed and Retry stop with a confirmation releases it", async () => {
    h.host.interruptMode = "throw";
    await h.start(SINGLE, { runId: "r1" });
    const stopped = await h.driver.act("r1", (state) => stopJob(state, { jobId: "build" }));
    expect(stopped.ok).toBe(true);
    await h.settle("r1");
    let state = await h.driver.read("r1");
    expect(pauseReason(state)).toBe("quiesce_unconfirmed");
    expect(state.attempts["build#1"]?.endedAt).toBeNull();
    h.host.interruptMode = "stop";
    expect((await h.driver.retryStop("r1")).ok).toBe(true);
    await h.settle("r1");
    state = await h.driver.read("r1");
    expect(pauseReason(state)).toBeNull();
    expect(state.attempts["build#1"]?.outcome).toBe("stopped");
  });

  it("a cancel during a check is cancelled only after the observed exit, and an unobserved exit stays paused", async () => {
    h.checks.script = () => ({ hold: true });
    h.checks.cancelResult = { exited: true, delayMs: 150 };
    await h.start(AGENT_WITH_REVIEW, { runId: "r1" });
    await h.complete("r1", "build#1");
    await h.settle("r1");
    expect(h.checks.batches).toHaveLength(1);
    await h.driver.act("r1", (state) => cancelRun(state));
    expect(runStatus(await h.driver.read("r1"))).not.toBe("cancelled");
    await h.settle("r1");
    expect(h.checks.batches[0]?.cancelled).toBe(true);
    expect(runStatus(await h.driver.read("r1"))).toBe("cancelled");

    const other = await createDriverHarness();
    try {
      other.checks.script = () => ({ hold: true });
      other.checks.cancelResult = { exited: false, delayMs: 0 };
      await other.start(AGENT_WITH_REVIEW, { runId: "r2" });
      await other.complete("r2", "build#1");
      await other.settle("r2");
      await other.driver.act("r2", (state) => cancelRun(state));
      await other.settle("r2");
      const state = await other.driver.read("r2");
      expect(runStatus(state)).toBe("paused");
      expect(pauseReason(state)).toBe("quiesce_unconfirmed");
    } finally {
      await other.dispose();
    }
  });

  it("a check whose group exit is not observed publishes no evidence and starts nothing until it is confirmed", async () => {
    h.checks.unconfirmedExit = true;
    h.processes.states.set(5001, "unknown");
    await h.start(AGENT_WITH_REVIEW, { runId: "r1" });
    await h.complete("r1", "build#1");
    await h.settle("r1");
    const state = await h.driver.read("r1");
    expect(state.evidence.filter((item) => item.kind === "check")).toEqual([]);
    expect(state.barriers.map((barrier) => [barrier.cause, barrier.status])).toEqual([["recovery", "unconfirmed"]]);
    expect(pauseReason(state)).toBe("quiesce_unconfirmed");
    expect(h.checks.batches).toHaveLength(1);
    expect(h.host.calls.createAgent.some((key) => key.endsWith("reviewer"))).toBe(false);
  });
});

describe("driver: failover", () => {
  it("drains a classified provider failure, then creates the fallback agent", async () => {
    await h.start(FAILOVER, { runId: "r1" });
    const worker = h.workerAgent("r1", "build#1");
    await h.endTurn(worker, { kind: "failed", error: { message: "Rate limit reached", code: "rate_limit" } });
    await h.settle("r1");
    const kinds = await h.kinds("r1");
    const confirmed = kinds.indexOf("quiesce.confirmed");
    expect(confirmed).toBeGreaterThan(kinds.indexOf("quiesce.started"));
    expect(kinds.indexOf("job.provider_switched")).toBeGreaterThan(confirmed);
    expect(h.host.calls.createAgent).toEqual([creationKey("r1", "build#1", "worker"), creationKey("r1", "build#2", "worker")]);
    expect(h.host.agentFor(creationKey("r1", "build#2", "worker"))?.input.agent).toMatchObject({ provider: "provider-b", model: "model-b" });
  });

  it("with both targets failing the job needs a human and nothing is created until Retry names a target", async () => {
    await h.start(FAILOVER, { runId: "r1" });
    await h.endTurn(h.workerAgent("r1", "build#1"), { kind: "failed", error: { message: "quota", code: "insufficient_quota" } });
    await h.settle("r1");
    await h.endTurn(h.workerAgent("r1", "build#2"), { kind: "failed", error: { message: "401 Unauthorized" } });
    await h.settle("r1");
    let state = await h.driver.read("r1");
    expect(state.jobs.build?.needsHuman).toBe("worker");
    expect(h.host.calls.createAgent).toHaveLength(2);
    expect((await h.driver.act("r1", (latest) => retryJob(latest, { jobId: "build", target: "primary" }))).ok).toBe(true);
    await h.settle("r1");
    state = await h.driver.read("r1");
    expect(h.host.calls.createAgent).toHaveLength(3);
    expect(state.attempts["build#3"]).toMatchObject({ cause: "manual", target: "primary" });
  });

  it("retries an unclassified failure on the same target", async () => {
    await h.start(FAILOVER, { runId: "r1" });
    await h.endTurn(h.workerAgent("r1", "build#1"), { kind: "failed", error: { message: "TypeError: x is undefined" } });
    await h.settle("r1");
    const state = await h.driver.read("r1");
    expect(state.attempts["build#2"]).toMatchObject({ cause: "retry", target: "primary" });
    expect(h.host.agentFor(creationKey("r1", "build#2", "worker"))?.input.agent).toMatchObject({ provider: "provider-a" });
    expect((await h.kinds("r1")).includes("job.provider_switched")).toBe(false);
  });
});

describe("driver: crash and recovery", () => {
  it("binds an agent created before its binding was appended and keeps one agent for the key", async () => {
    h.host.onCreateAgent = () => "hang";
    await h.start(SINGLE, { runId: "r1" });
    const key = creationKey("r1", "build#1", "worker");
    expect(h.host.agentsFor(key)).toHaveLength(1);
    h.host.onCreateAgent = () => "ok";
    const driver = h.restart();
    await driver.attach(h.host);
    await h.settle("r1");
    const state = await driver.read("r1");
    expect(state.attempts["build#1"]?.roles.worker?.binding.agentId).toBe(h.host.agentFor(key)?.id);
    expect(h.host.agentsFor(key)).toHaveLength(1);
    expect(h.host.calls.createAgent).toEqual([key]);
    expect(pauseReason(state)).toBe("recovery");
  });

  it("keeps an acknowledged review across a restart and submits it once when the reviewer's turn ends", async () => {
    const { callTool } = await import("./mcp-tools");
    await h.start(AGENT_WITH_REVIEW, { runId: "r1" });
    await h.complete("r1", "build#1");
    const reviewer = h.reviewerAgent("r1", "build#1");
    const grant = { kind: "attempt" as const, runId: "r1", attemptId: "build#1", role: "reviewer" as const, agentId: reviewer };
    const submission = { outcome: "approved", findings: [], criteria: [{ index: 1, met: true }] };
    expect(await callTool(h.tools, grant, "pipeline_review_submit", submission)).toMatchObject({ ok: true });
    expect(await callTool(h.tools, grant, "pipeline_review_submit", submission)).toMatchObject({ ok: true });
    const driver = h.restart();
    await driver.attach(h.host);
    await h.settle("r1");
    expect(await h.kinds("r1")).not.toContain("review.submitted");
    await h.endTurn(reviewer);
    await h.settle("r1");
    expect((await h.kinds("r1")).filter((kind) => kind === "review.submitted")).toHaveLength(1);
    expect(runStatus(await driver.read("r1"))).toBe("finished");
  });

  it("submits a held review during recovery when the reviewer is already idle", async () => {
    const { callTool } = await import("./mcp-tools");
    await h.start(AGENT_WITH_REVIEW, { runId: "r1" });
    await h.complete("r1", "build#1");
    const reviewer = h.reviewerAgent("r1", "build#1");
    const grant = { kind: "attempt" as const, runId: "r1", attemptId: "build#1", role: "reviewer" as const, agentId: reviewer };
    expect(await callTool(h.tools, grant, "pipeline_review_submit", { outcome: "approved", findings: [], criteria: [{ index: 1, met: true }] })).toMatchObject({ ok: true });
    const agent = h.host.agents.get(reviewer);
    if (agent) agent.status = "idle";
    const driver = h.restart();
    await driver.attach(h.host);
    await h.settle("r1");
    const kinds = await h.kinds("r1");
    expect(kinds.filter((kind) => kind === "review.submitted")).toHaveLength(1);
    expect((await driver.read("r1")).attempts["build#1"]?.outcome).not.toBe("lost");
    expect(runStatus(await driver.read("r1"))).toBe("finished");
  });

  it("coalesces concurrent attaches and retries recovery after a failed one", async () => {
    h.host.onCreateAgent = () => "hang";
    await h.start(SINGLE, { runId: "r1" });
    h.host.onCreateAgent = () => "ok";
    let listings = 0;
    const store = { ...h.store, listLive: () => (++listings === 1 ? Promise.reject(new Error("snapshot read failed")) : h.store.listLive()) };
    const driver = h.restart({ store });
    const results = await Promise.allSettled([driver.attach(h.host), driver.attach(h.host)]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(listings).toBe(1);
    await driver.attach(h.host);
    expect(listings).toBe(2);
    await h.settle("r1");
    const key = creationKey("r1", "build#1", "worker");
    expect((await driver.read("r1")).attempts["build#1"]?.roles.worker?.binding.agentId).toBe(h.host.agentFor(key)?.id);
    expect(h.host.agentsFor(key)).toHaveLength(1);
  });

  it("binds a workspace created before its binding was appended", async () => {
    h.host.onCreateWorkspace = () => "hang";
    await h.start(SINGLE, { runId: "r1" });
    expect(h.host.workspaces).toHaveLength(1);
    h.host.onCreateWorkspace = () => "ok";
    const driver = h.restart();
    await driver.attach(h.host);
    await h.settle("r1");
    const state = await driver.read("r1");
    expect(state.workspace?.workspaceId).toBe(h.host.workspaces[0]?.workspaceId);
    expect(h.host.calls.createWorkspace).toBe(1);
  });

  it("with lookups unavailable pauses with binding_unknown, creates nothing and accepts Cancel", async () => {
    h.host.onCreateAgent = () => "hang";
    await h.start(SINGLE, { runId: "r1" });
    h.host.lookups = "unavailable";
    const driver = h.restart();
    await driver.attach(h.host);
    await h.settle("r1");
    const state = await driver.read("r1");
    expect(pauseReason(state)).toBe("binding_unknown");
    expect(h.host.calls.createAgent).toHaveLength(1);
    const resumed = await driver.resume("r1");
    expect(resumed.ok).toBe(true);
    expect(pauseReason(await driver.read("r1"))).toBe("binding_unknown");
    expect((await driver.act("r1", (latest) => cancelRun(latest))).ok).toBe(true);
    await h.settle("r1");
    expect(h.host.calls.createAgent).toHaveLength(1);
    expect(runStatus(await driver.read("r1"))).not.toBe("running");
  });

  it("recoverAll creates no agent for a run whose agent is gone", async () => {
    await h.start(SINGLE, { runId: "r1" });
    const agent = h.host.agents.get(h.workerAgent("r1", "build#1"));
    if (agent) agent.status = "closed";
    const driver = h.restart();
    await driver.attach(h.host);
    await h.settle("r1");
    const state = await driver.read("r1");
    expect(state.attempts["build#1"]?.outcome).toBe("lost");
    expect(pauseReason(state)).toBe("recovery");
    expect(h.host.calls.createAgent).toHaveLength(1);
  });

  it("terminates a recorded live check at recovery and pauses with quiesce_unconfirmed when its exit is not observed", async () => {
    h.checks.script = () => ({ hold: true });
    await h.start(AGENT_WITH_REVIEW, { runId: "r1" });
    await h.complete("r1", "build#1");
    await h.settle("r1");
    const launched = (await h.driver.read("r1")).cycles["build#1/c1"]?.launched.get(0);
    expect(launched).toBeDefined();
    if (!launched) return;
    h.processes.states.set(launched.pid, "alive");
    h.processes.terminateExits = false;
    const driver = h.restart();
    await driver.attach(h.host);
    await h.settle("r1");
    const state = await driver.read("r1");
    expect(h.processes.terminated).toContain(launched.pid);
    expect(pauseReason(state)).toBe("quiesce_unconfirmed");
    expect(h.host.calls.createAgent.some((key) => key.endsWith("reviewer"))).toBe(false);
  });
});
