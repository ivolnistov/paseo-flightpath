import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { RunSnapshot } from "../../shared/run";
import { reservationOf } from "../agent-port";
import { createNodeFs } from "../fs-port";
import { callTool, type ToolDeps, type ToolResult } from "../mcp-tools";
import { createRunDriver, type RunDriver, type RunDriverDeps } from "../run-driver";
import { creationKey } from "../run-engine";
import { createRunStore, type RunStore } from "../run-store";
import { snapshotBody } from "../run-test-kit";
import { FakeChecks, FakeHost, FakeProcesses, fakeCopies, type FakeCopies } from "./fake-host";

export type DriverHarness = {
  dir: string;
  store: RunStore;
  host: FakeHost;
  checks: FakeChecks;
  processes: FakeProcesses;
  copies: FakeCopies;
  driver: RunDriver;
  logs: string[];
  tools: ToolDeps;
  /** A new driver over the same disk and host, as after a server restart. */
  restart(overrides?: Partial<RunDriverDeps>): RunDriver;
  start(yaml: string, x?: Parameters<typeof snapshotBody>[1]): Promise<RunSnapshot>;
  settle(runId: string): Promise<void>;
  workerAgent(runId: string, attemptId: string): string;
  reviewerAgent(runId: string, attemptId: string): string;
  complete(runId: string, attemptId: string, outputs?: Record<string, unknown>): Promise<ToolResult>;
  endTurn(agentId: string, outcome?: PluginTurnOutcome): Promise<void>;
  review(runId: string, attemptId: string, x?: { outcome?: "approved" | "changes_requested"; criteria?: Array<{ index: number; met: boolean }>; findings?: Array<{ title: string; detail: string; tasks: string[] }> }): Promise<ToolResult>;
  kinds(runId: string): Promise<string[]>;
  dispose(): Promise<void>;
};

export async function createDriverHarness(options: { quiesceTimeoutMs?: number; idempotentCreate?: boolean } = {}): Promise<DriverHarness> {
  const dir = await mkdtemp(join(tmpdir(), "fp-driver-"));
  const fs = createNodeFs();
  const store = createRunStore({ stateDir: dir, fs });
  const host = new FakeHost();
  const checks = new FakeChecks(host);
  const processes = new FakeProcesses();
  const copies = fakeCopies();
  const logs: string[] = [];
  let clock = Date.parse("2026-11-21T00:00:00.000Z");
  const deps = (): RunDriverDeps => ({
    store: createRunStore({ stateDir: dir, fs }),
    processes,
    identity: host.identity,
    headCommit: host.headCommit,
    checks: checks.start,
    copies,
    copiesDir: (projectId, runId) => join(dir, "runs", projectId, runId, "copies"),
    reservation: (key) => `rsv_${key}`,
    settings: () => ({ checkTimeoutMs: 1_000, maxOutputBytes: 4_096, quiesceTimeoutMs: options.quiesceTimeoutMs ?? 400 }),
    now: () => new Date((clock += 1_000)),
    log: (line) => logs.push(line),
    idempotentCreate: options.idempotentCreate ?? false,
    pollMs: 10,
    retryDelayMs: 50,
    createTimeoutMs: 300,
  });
  const harness: DriverHarness = {
    dir,
    store,
    host,
    checks,
    processes,
    copies,
    logs,
    driver: createRunDriver(deps()),
    tools: {
      runs: {
        read: (runId) => harness.driver.read(runId),
        act: (runId, action) => harness.driver.act(runId, (state) => action(state)),
        bindFromGrant: (...args) => harness.driver.bindFromGrant(...args),
        holdReview: (runId, submission) => harness.driver.holdReview(runId, submission),
      },
      workflows: {
        get: () => Promise.reject(new Error("no workflow store in this harness")),
        addProposal: () => Promise.reject(new Error("no workflow store in this harness")),
      },
    },
    restart(overrides = {}) {
      harness.driver = createRunDriver({ ...deps(), ...overrides });
      return harness.driver;
    },
    async start(yaml, x = {}) {
      const snapshot = await store.create(snapshotBody(yaml, x));
      await harness.driver.register(snapshot);
      await harness.driver.attach(host);
      await harness.settle(snapshot.runId);
      return snapshot;
    },
    async settle(runId) {
      await harness.driver.tick(runId);
      await harness.driver.idle(runId);
    },
    workerAgent(runId, attemptId) {
      const agent = host.agentFor(creationKey(runId, attemptId, "worker"));
      if (!agent) throw new Error(`no worker agent for ${attemptId}`);
      return agent.id;
    },
    reviewerAgent(runId, attemptId) {
      const agent = host.agentFor(creationKey(runId, attemptId, "reviewer"));
      if (!agent) throw new Error(`no reviewer agent for ${attemptId}`);
      return agent.id;
    },
    async complete(runId, attemptId, outputs = {}) {
      const agentId = harness.workerAgent(runId, attemptId);
      const state = await harness.driver.read(runId);
      const directory = state.workspace?.directory;
      if (directory) host.write(directory);
      const result = await callTool(harness.tools, { kind: "attempt", runId, attemptId, role: "worker", agentId }, "pipeline_job_complete", { outputs, summary: "done" });
      await harness.endTurn(agentId);
      return result;
    },
    async endTurn(agentId, outcome) {
      const event = host.turnEnded(agentId, outcome);
      await harness.driver.onTurnEnded(event);
      const reservation = reservationOf(event.agent.metadata);
      if (reservation?.kind === "attempt") await harness.driver.idle(reservation.runId);
    },
    async review(runId, attemptId, x = {}) {
      const agentId = harness.reviewerAgent(runId, attemptId);
      const result = await callTool(harness.tools, { kind: "attempt", runId, attemptId, role: "reviewer", agentId }, "pipeline_review_submit", {
        outcome: x.outcome ?? "approved",
        findings: x.findings ?? [],
        criteria: x.criteria ?? [],
      });
      await harness.endTurn(agentId);
      return result;
    },
    async kinds(runId) {
      return (await store.load(runId)).events.map((event) => event.kind);
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
  return harness;
}
