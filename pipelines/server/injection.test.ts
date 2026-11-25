import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LABELS, METADATA_KEY } from "./agent-port";
import type { Grant } from "./grants";
import { injectFor, ROLE_INSTRUCTIONS, type InjectionDeps } from "./injection";
import { MCP_SERVER_NAME } from "./mcp-endpoint";
import { stopJob } from "./run-actions";
import { creationKey } from "./run-engine";
import { createDriverHarness, type DriverHarness } from "./test-support/driver-harness";

let h: DriverHarness;
const chats = new Set<string>();

beforeEach(async () => {
  h = await createDriverHarness();
  h.host.onCreateAgent = () => "hang";
  await h.start(`name: One
jobs:
  build: { uses: agent, with: { prompt: Build, agent: { model: provider-a/m1 } } }
`, { runId: "r1" });
});

afterEach(async () => {
  chats.clear();
  await h.dispose();
});

const deps = (): InjectionDeps => ({
  endpoint: () => ({ urlFor: (grant: Grant) => `http://127.0.0.1:1/mcp/${JSON.stringify(grant)}`, reservation: (subject: string) => `rsv_${subject}` }),
  readRun: (runId) => h.driver.read(runId).catch(() => null),
  isWorkflowChat: (projectId, agentId) => Promise.resolve(chats.has(`${projectId}:${agentId}`)),
  log: () => undefined,
});

const KEY = creationKey("r1", "build#1", "worker");

function open(x: Partial<PluginSessionOpenRequest> & { metadata?: Record<string, unknown> } = {}): PluginSessionOpenRequest {
  return {
    agentId: "agent-new",
    workspaceId: "wks",
    provider: "provider-a",
    cwd: "/fake/r1",
    reason: "create",
    purpose: "interactive",
    title: null,
    background: false,
    labels: { [LABELS.key]: KEY },
    metadata: { [METADATA_KEY]: { kind: "attempt", reservationId: `rsv_${KEY}`, runId: "r1", attemptId: "build#1", role: "worker", creationKey: KEY } },
    tools: [],
    env: {},
    mcpServers: {},
    ...x,
  } as PluginSessionOpenRequest;
}

describe("agent.open.before injection", () => {
  it("adds role instructions and the scoped MCP server to the reserved creation", async () => {
    const result = await injectFor(open(), deps());
    expect(result?.appendSystemPrompt).toEqual([ROLE_INSTRUCTIONS.worker]);
    const server = result?.mcpServers[MCP_SERVER_NAME];
    expect(server?.type).toBe("http");
    expect(server && "url" in server ? server.url : "").toContain(`"attemptId":"build#1","role":"worker","agentId":"agent-new"`);
  });

  it("gives an eligible interactive reopen the same context and a history open nothing", async () => {
    const agentId = h.workerAgent("r1", "build#1");
    await h.driver.bindFromGrant("r1", "build#1", "worker", agentId);
    const reopen = await injectFor(open({ agentId, reason: "resume" }), deps());
    expect(reopen?.appendSystemPrompt).toEqual([ROLE_INSTRUCTIONS.worker]);
    expect(Object.keys(reopen?.mcpServers ?? {})).toEqual([MCP_SERVER_NAME]);
    expect(await injectFor(open({ agentId, reason: "resume", purpose: "history" }), deps())).toBeUndefined();
  });

  it("gives an agent without a matching reservation neither instructions nor an MCP server", async () => {
    expect(await injectFor(open({ metadata: {} }), deps())).toBeUndefined();
    expect(await injectFor(open({ metadata: { [METADATA_KEY]: { kind: "attempt", reservationId: "rsv_forged", runId: "r1", attemptId: "build#1", role: "worker", creationKey: KEY } } }), deps())).toBeUndefined();
    expect(await injectFor(open({ metadata: { [METADATA_KEY]: { kind: "attempt", reservationId: `rsv_${KEY}`, runId: "r1", attemptId: "build#1", role: "reviewer", creationKey: KEY } } }), deps())).toBeUndefined();
    expect(await injectFor(open({ reason: "resume" }), deps())).toBeUndefined();
    await h.driver.bindFromGrant("r1", "build#1", "worker", "agent-bound");
    expect(await injectFor(open({ agentId: "agent-other", reason: "create" }), deps())).toBeUndefined();
  });

  it("refuses an attempt that has ended", async () => {
    const agentId = h.workerAgent("r1", "build#1");
    await h.driver.bindFromGrant("r1", "build#1", "worker", agentId);
    await h.driver.act("r1", (state) => stopJob(state, { jobId: "build" }));
    await h.settle("r1");
    expect((await h.driver.read("r1")).attempts["build#1"]?.endedAt).not.toBeNull();
    expect(await injectFor(open({ agentId, reason: "resume" }), deps())).toBeUndefined();
  });

  it("admits the recorded workflow chat of a project only", async () => {
    const metadata = { [METADATA_KEY]: { kind: "workflow", reservationId: "rsv_workflow:proj", projectId: "proj" } };
    expect(await injectFor(open({ metadata, labels: {} }), deps())).toBeUndefined();
    chats.add("proj:agent-new");
    expect((await injectFor(open({ metadata, labels: {} }), deps()))?.appendSystemPrompt).toEqual([ROLE_INSTRUCTIONS.workflow]);
  });
});
