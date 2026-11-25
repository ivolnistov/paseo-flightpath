import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PaseoWorkspaceAgentCreateOptions, PaseoWorkspaceCreateOptions } from "@getpaseo/client";
import type { PluginRpcContract, PluginSubscriptionContract } from "@getpaseo/plugin";
import type { PluginSessionOpenRequest, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z, type ZodType } from "zod";
import contribute from "../index.server";
import {
  jobAccept,
  jobApprove,
  jobChanges,
  jobRetry,
  runGet,
  runList,
  runPreview,
  runResume,
  runStart,
  runWatch,
  workflowChatOpen,
  workflowDraftDiscard,
  workflowDraftSetText,
  workflowGet,
  workflowProposalApply,
  workflowSave,
  type RunDetail,
} from "../shared/rpc";
import { defaultView, openChats, proposalDelta, statusLabel, taskText } from "../client/view-model";
import { METADATA_KEY, type CreateAgentInput } from "./agent-port";
import { MCP_SERVER_NAME } from "./mcp-endpoint";
import { projectPaths } from "./paths";
import { creationKey } from "./run-engine";
import type { pipelineSettings } from "../shared/settings";
import { FakeHost, type FakeAgent } from "./test-support/fake-host";
import { createTempRepo, type TempRepo } from "./test-support/temp-repo";

const PROJECT = "acceptance";

function workflowYaml(proposed: boolean, matrixScript: string, canonicalDir: string, journal: string): string {
  const lint = proposed ? `  lint: { needs: [implement], uses: checks, with: { run: [[${JSON.stringify(process.execPath)}, lint.mjs]] } }\n` : "";
  const reviewNeeds = proposed ? "[lint, module-tests]" : "[module-tests]";
  return `name: Feature delivery
inputs: { goal: { type: string }, tasks: { type: tasks, required: false } }
defaults:
  max-parallel: 3
  agent: { model: alpha/primary, fallback: { model: beta/fallback, reasoning: medium }, retries: 2 }
jobs:
  discover:
    uses: agent
    acceptance: human
    with: { prompt: "List the modules affected by: \${{ inputs.goal }}" }
    outputs: { modules: { type: list, items: string } }
    done: [{ criterion: Every affected module is listed. }]
  implement:
    needs: [discover]
    uses: run-tasks
    with: { prompt: "\${{ inputs.goal }}", tasks: "\${{ inputs.tasks }}", context: "\${{ needs.discover.outputs.modules }}", reviewer: { model: alpha/reviewer, fallback: { model: beta/reviewer } } }
${lint}  module-tests:
    needs: [discover, implement]
    uses: checks
    strategy: { matrix: { module: "\${{ needs.discover.outputs.modules }}" }, max-parallel: 2 }
    with: { isolated: true, run: [[${JSON.stringify(process.execPath)}, ${JSON.stringify(matrixScript)}, "\${{ matrix.module }}", ${JSON.stringify(canonicalDir)}, ${JSON.stringify(journal)}]] }
  review: { needs: ${reviewNeeds}, uses: review, with: { agent: { model: alpha/reviewer, fallback: { model: beta/reviewer }, retries: 1 } }, rework: { to: implement, max: 2 } }
  accept: { needs: [review], uses: approval }
`;
}

class JourneyHost extends FakeHost {
  constructor(private readonly directory: string) {
    super();
  }

  override async createWorkspace(x: { projectId: string; branchName: string; runId: string }): Promise<{ workspaceId: string; directory: string }> {
    const created = await super.createWorkspace(x);
    const workspace = this.workspaces.find((candidate) => candidate.workspaceId === created.workspaceId);
    if (workspace) workspace.directory = this.directory;
    return { ...created, directory: this.directory };
  }
}

type Registered = { contract: PluginRpcContract | { name: string }; handler: unknown };
type Failure = { code: string; message: string };
type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`RPC failed: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

class JourneyServer {
  readonly handlers = new Map<string, Registered>();
  readonly hooks = new Map<string, unknown>();
  settingsListener: ((state: unknown) => void) | null = null;

  constructor(readonly paseo: unknown) {}

  context(dataDir: string): unknown {
    return {
      registerSettings: (definition: typeof pipelineSettings) => ({
        read: () => Promise.resolve({ status: "ready" as const, revision: "1", values: definition.schema.parse({ dataDir, checkTimeoutMs: 10_000, quiesceTimeoutMs: 1_000 }) }),
        subscribe: (listener: (state: unknown) => void) => {
          this.settingsListener = listener;
          return () => undefined;
        },
      }),
      handle: (contract: PluginRpcContract, handler: unknown) => {
        this.handlers.set(contract.name, { contract, handler });
      },
      addHook: (name: string, handler: unknown) => {
        this.hooks.set(name, handler);
        return () => this.hooks.delete(name);
      },
    };
  }

  async call<I extends ZodType, O extends ZodType>(contract: PluginRpcContract<I, O>, input: z.input<I>): Promise<z.output<O>> {
    const registered = this.handlers.get(contract.name);
    if (!registered || typeof registered.handler !== "function") throw new Error(`RPC ${contract.name} was not registered.`);
    const result: unknown = await Reflect.apply(registered.handler, undefined, [contract.input.parse(input), { paseo: this.paseo }]);
    return contract.output.parse(result);
  }

  watch<I extends ZodType, E extends ZodType>(contract: PluginSubscriptionContract<I, E>, input: z.input<I>, onEvent: (event: z.output<E>) => void): () => void {
    const registered = this.handlers.get(contract.name);
    if (!registered || typeof registered.handler !== "function") throw new Error(`Subscription ${contract.name} was not registered.`);
    const controller = new AbortController();
    const result: unknown = Reflect.apply(registered.handler, undefined, [contract.input.parse(input), {
      paseo: this.paseo,
      signal: controller.signal,
      push: (event: unknown) => {
        onEvent(contract.event.parse(event));
        return Promise.resolve();
      },
    }]);
    if (!(result instanceof Promise)) throw new Error(`Subscription ${contract.name} must return its lifetime.`);
    result.catch((error: unknown) => {
      throw new Error(`Subscription ${contract.name} closed with an error.`, { cause: error });
    });
    return () => controller.abort();
  }

  async hook(name: string, payload: unknown): Promise<unknown> {
    const handler = this.hooks.get(name);
    if (typeof handler !== "function") throw new Error(`Hook ${name} was not registered.`);
    const result: unknown = await Reflect.apply(handler, undefined, [payload, { paseo: this.paseo, signal: new AbortController().signal }]);
    return result;
  }
}

function fakePaseo(host: JourneyHost): unknown {
  const workspaceHandle = (workspaceId: string): unknown => ({
    id: workspaceId,
    directory: host.workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.directory ?? null,
    agents: {
      create: async (options: PaseoWorkspaceAgentCreateOptions): Promise<unknown> => {
        const metadata = options.metadata ?? {};
        const parsed = z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("attempt"), reservationId: z.string(), runId: z.string(), attemptId: z.string(), role: z.enum(["worker", "reviewer"]), creationKey: z.string() }),
          z.object({ kind: z.literal("workflow"), reservationId: z.string(), projectId: z.string() }),
        ]).parse(metadata[METADATA_KEY]);
        const [provider = "", model = ""] = options.config.provider.split("/");
        const reasoning = options.config.thinkingOptionId;
        const input: CreateAgentInput = {
          workspaceId,
          runId: parsed.kind === "attempt" ? parsed.runId : `workflow:${parsed.projectId}`,
          attemptId: parsed.kind === "attempt" ? parsed.attemptId : "workflow",
          role: parsed.kind === "attempt" ? parsed.role : "worker",
          creationKey: parsed.kind === "attempt" ? parsed.creationKey : `workflow:${parsed.projectId}:${options.title ?? "chat"}`,
          title: options.title ?? "Pipeline agent",
          agent: {
            provider,
            model,
            ...(reasoning === "low" || reasoning === "medium" || reasoning === "high" ? { reasoning } : {}),
            ...(options.config.modeId === undefined ? {} : { modeId: options.config.modeId }),
          },
          reservationId: parsed.reservationId,
          prompt: options.prompt ?? "",
        };
        const created = await host.createAgent(input);
        const agent = host.agents.get(created.agentId);
        if (agent && parsed.kind === "workflow") {
          agent.metadata = metadata;
          agent.labels = options.labels ?? {};
        }
        return { id: created.agentId };
      },
    },
    refresh: () => Promise.resolve({ workspaceDirectory: host.workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.directory ?? null }),
  });

  return {
    config: { get: () => Promise.resolve({ requestId: "config", config: {} }) },
    providers: {
      snapshot: () => Promise.resolve({
        entries: [
          { provider: "alpha", models: [{ id: "primary" }, { id: "reviewer" }] },
          { provider: "beta", models: [{ id: "fallback" }, { id: "reviewer" }] },
        ],
      }),
    },
    workspaces: {
      create: async (options: PaseoWorkspaceCreateOptions): Promise<unknown> => {
        if (options.source.kind !== "worktree" || options.source.action !== "branch-off") throw new Error("The fake accepts only branch-off worktrees.");
        const reservation = z.object({ runId: z.string(), branchName: z.string() }).parse(options.metadata?.[METADATA_KEY]);
        const projectId = z.string().parse(options.source.projectId);
        const created = await host.createWorkspace({ projectId, branchName: reservation.branchName, runId: reservation.runId });
        return workspaceHandle(created.workspaceId);
      },
      list: (options?: { filter?: { projectId?: string } }) => Promise.resolve({
        requestId: "workspaces",
        entries: host.workspaces.filter((workspace) => options?.filter?.projectId === undefined || workspace.projectId === options.filter.projectId).map((workspace) => ({
          id: workspace.workspaceId,
          workspaceDirectory: workspace.directory,
          gitRuntime: { currentBranch: workspace.branchName },
          metadata: { [METADATA_KEY]: { runId: workspace.runId, branchName: workspace.branchName } },
        })),
        pageInfo: { hasMore: false, nextCursor: null },
      }),
      ref: workspaceHandle,
    },
    agents: {
      list: (options?: { filter?: { labels?: Record<string, string> } }) => Promise.resolve({
        requestId: "agents",
        entries: [...host.agents.values()].filter((agent) => Object.entries(options?.filter?.labels ?? {}).every(([key, value]) => agent.labels[key] === value)).map((agent) => ({ agent: { id: agent.id, labels: agent.labels } })),
        pageInfo: { hasMore: false, nextCursor: null },
      }),
      ref: (agentId: string) => ({
        refresh: () => {
          const agent = host.agents.get(agentId);
          return Promise.resolve(agent ? { agent: { id: agent.id, status: agent.status, labels: agent.labels, metadata: agent.metadata, archivedAt: null } } : null);
        },
        reload: async () => {
          await host.interrupt(agentId);
          const agent = host.agents.get(agentId);
          return agent ? { agent: { id: agent.id, status: agent.status, labels: agent.labels, metadata: agent.metadata, archivedAt: null } } : null;
        },
        send: (text: string) => host.send(agentId, text),
      }),
    },
  };
}

function openRequest(agent: FakeAgent, directory: string): PluginSessionOpenRequest {
  return {
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    provider: `${agent.input.agent.provider}/${agent.input.agent.model}`,
    cwd: directory,
    reason: "resume",
    purpose: "interactive",
    title: agent.input.title,
    background: false,
    labels: agent.labels,
    metadata: z.record(z.string(), z.json()).parse(agent.metadata),
    tools: [],
    env: {},
    mcpServers: {},
  };
}

async function tool(server: JourneyServer, agent: FakeAgent, directory: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: unknown }> {
  const opened = await server.hook("agent.open.before", { request: openRequest(agent, directory) });
  const injected = z.object({ mcpServers: z.record(z.string(), z.object({ type: z.literal("http"), url: z.string() }).passthrough()) }).parse(opened);
  const mcp = injected.mcpServers[MCP_SERVER_NAME];
  if (!mcp) throw new Error(`No scoped MCP server was injected for ${agent.id}.`);
  const client = new Client({ name: "acceptance-journey", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
    const raw: unknown = await client.callTool({ name, arguments: args });
    const result = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough()) }).passthrough().parse(raw);
    const text = result.content[0];
    if (!text) throw new Error(`Tool ${name} returned no text result.`);
    return { isError: result.isError === true, body: JSON.parse(text.text) as unknown };
  } finally {
    await client.close();
  }
}

async function getRun(runId: string): Promise<RunDetail> {
  return unwrap(await server.call(runGet, { runId }));
}

async function waitRun(runId: string, predicate: (current: RunDetail) => boolean): Promise<RunDetail> {
  let current: RunDetail | null = null;
  try {
    await vi.waitFor(async () => {
      current = await getRun(runId);
      expect(predicate(current)).toBe(true);
    }, { timeout: 8_000, interval: 10 });
  } catch (error) {
    throw new Error(`Run ${runId} did not reach the requested state: ${JSON.stringify(current)}`, { cause: error });
  }
  if (!current) throw new Error(`Run ${runId} did not reach the requested state.`);
  return current;
}

function jobOf(run: RunDetail, jobId: string): RunDetail["view"]["jobs"][number] {
  const job = run.view.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`Run ${run.view.runId} has no job ${jobId}.`);
  return job;
}

async function waitJob(runId: string, jobId: string, status: RunDetail["view"]["jobs"][number]["status"]): Promise<RunDetail> {
  return waitRun(runId, (current) => jobOf(current, jobId).status === status);
}

async function agentFor(runId: string, attemptId: string, role: "worker" | "reviewer"): Promise<FakeAgent> {
  const key = creationKey(runId, attemptId, role);
  await vi.waitFor(() => expect(host.agentFor(key)).toBeDefined(), { timeout: 8_000, interval: 10 });
  const agent = host.agentFor(key);
  if (!agent) throw new Error(`No ${role} agent for ${attemptId}.`);
  return agent;
}

async function endTurn(agent: FakeAgent, outcome: PluginTurnOutcome = { kind: "completed" }, keepRunning = false): Promise<void> {
  const event = host.turnEnded(agent.id, outcome);
  if (keepRunning) agent.status = "running";
  await server.hook("agent.turn.after", {
    agent: {
      id: agent.id,
      workspaceId: agent.workspaceId,
      parentAgentId: null,
      provider: `${agent.input.agent.provider}/${agent.input.agent.model}`,
      cwd: repo.dir,
      title: agent.input.title,
      background: false,
      metadata: agent.metadata,
    },
    turnId: event.turnId,
    outcome: event.outcome,
  });
}

async function submitWorker(runId: string, attemptId: string, outputs: Record<string, unknown>, change?: string) {
  const agent = await agentFor(runId, attemptId, "worker");
  if (change) {
    await mkdir(join(repo.dir, "work"), { recursive: true });
    await writeFile(join(repo.dir, "work", change), `${runId} ${attemptId}\n`);
  }
  return tool(server, agent, repo.dir, "pipeline_job_complete", { outputs, summary: `Completed ${attemptId}` });
}

async function completeWorker(runId: string, attemptId: string, outputs: Record<string, unknown> = {}, change?: string): Promise<void> {
  const agent = await agentFor(runId, attemptId, "worker");
  const result = await submitWorker(runId, attemptId, outputs, change);
  expect(result.isError, JSON.stringify(result.body)).toBe(false);
  await endTurn(agent);
}

async function submitReview(runId: string, attemptId: string, input: { outcome: "approved" | "changes_requested"; criteria?: Array<{ index: number; met: boolean; note?: string }>; findings?: Array<{ title: string; detail: string; tasks: string[] }> }) {
  const agent = await agentFor(runId, attemptId, "reviewer");
  const result = await tool(server, agent, repo.dir, "pipeline_review_submit", { outcome: input.outcome, findings: input.findings ?? [], criteria: input.criteria ?? [] });
  expect(result.isError, JSON.stringify(result.body)).toBe(false);
  return agent;
}

async function completeReview(runId: string, attemptId: string, input: { outcome: "approved" | "changes_requested"; criteria?: Array<{ index: number; met: boolean; note?: string }>; findings?: Array<{ title: string; detail: string; tasks: string[] }> } = { outcome: "approved" }): Promise<void> {
  const agent = await submitReview(runId, attemptId, input);
  await endTurn(agent);
}

async function accept(runId: string, jobId: string, criteria: number[] = []): Promise<RunDetail> {
  const run = await waitJob(runId, jobId, "awaiting_human");
  const cycleId = jobOf(run, jobId).activeCycleId;
  if (!cycleId) throw new Error(`${jobId} has no active verification cycle.`);
  return unwrap(await server.call(jobAccept, { runId, jobId, cycleId, criteria }));
}

async function approve(runId: string, cycleId?: string): Promise<RunDetail> {
  const run = await waitJob(runId, "accept", "awaiting_human");
  const selected = cycleId ?? jobOf(run, "accept").activeCycleId;
  if (!selected) throw new Error("The approval has no active verification cycle.");
  return unwrap(await server.call(jobApprove, { runId, jobId: "accept", cycleId: selected }));
}

async function startRun(inputs: Record<string, unknown>, startKey: string): Promise<string> {
  const preview = unwrap(await server.call(runPreview, { projectId: PROJECT, inputs }));
  expect(preview.blockers).toEqual([]);
  const digest = preview.workflowDigest;
  if (!digest) throw new Error("Start preview has no saved workflow digest.");
  return unwrap(await server.call(runStart, { projectId: PROJECT, inputs, workflowDigest: digest, startKey })).runId;
}

type MatrixRecord = { event: "start" | "end"; module: string; cwd: string; hasGit: boolean; pid: number };

async function matrixRecords(path: string): Promise<MatrixRecord[]> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  const rows: unknown[] = text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as unknown);
  return z.array(z.object({ event: z.enum(["start", "end"]), module: z.string(), cwd: z.string(), hasGit: z.boolean(), pid: z.number() })).parse(rows);
}

function releaseFile(control: string, module: string): string {
  return join(control, `${Buffer.from(module).toString("base64url")}.release`);
}

let root = "";
let stateDir = "";
let repo: TempRepo;
let host: JourneyHost;
let server: JourneyServer;
let cleanup: (() => void | Promise<void>) | null = null;

async function compose(): Promise<void> {
  if (cleanup) await cleanup();
  const contributed: unknown = Reflect.apply(contribute, undefined, [server.context(stateDir)]);
  if (typeof contributed !== "function") throw new Error("The server contribution returned no cleanup.");
  cleanup = async () => {
    const result: unknown = await Reflect.apply(contributed, undefined, []);
    void result;
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fp-journey-"));
  stateDir = join(root, "state");
  repo = await createTempRepo();
  await writeFile(join(repo.dir, "README.md"), "acceptance fixture\n");
  repo.git("add", "README.md");
  repo.git("commit", "-m", "fixture");
  host = new JourneyHost(repo.dir);
  server = new JourneyServer(fakePaseo(host));
  await compose();
});

afterEach(async () => {
  try {
    // Removing `hold` releases every waiting matrix check; wait for each started one to end.
    await rm(join(root, "matrix-journal.jsonl.control", "hold"), { force: true });
    await matrixChecksEnded(join(root, "matrix-journal.jsonl"));
    if (cleanup) await cleanup();
  } finally {
    cleanup = null;
    await repo.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function matrixChecksEnded(journal: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = await readFile(journal, "utf8").catch(() => "");
    const records = text.split("\n").filter(Boolean).map((line) => z.object({ event: z.string(), pid: z.number() }).parse(JSON.parse(line)));
    const ended = new Set(records.filter((record) => record.event === "end").map((record) => record.pid));
    const running = records.filter((record) => record.event === "start" && !ended.has(record.pid) && processExists(record.pid));
    if (running.length === 0) return;
    if (Date.now() > deadline) throw new Error("matrix checks did not end after their release");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("acceptance journey", () => {
  it("closes its MCP endpoint when startup preparation fails and retries startup on the next request", async () => {
    unwrap(await server.call(runList, { projectId: PROJECT }));
    const { port } = z.object({ port: z.number() }).parse(JSON.parse(await readFile(join(stateDir, "endpoint.json"), "utf8")));
    await mkdir(join(stateDir, "runs", PROJECT, "rbroken"), { recursive: true });
    await writeFile(join(stateDir, "runs", PROJECT, "rbroken", "snapshot.json"), "not json");
    await compose();
    const failed = await server.call(runList, { projectId: PROJECT });
    expect(failed).toMatchObject({ ok: false });
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await rm(join(stateDir, "runs", PROJECT, "rbroken"), { recursive: true, force: true });
    expect(unwrap(await server.call(runList, { projectId: PROJECT }))).toEqual({ runs: [] });
  });

  it("keeps workflows in the data directory fixed at startup after a dataDir change", async () => {
    unwrap(await server.call(runList, { projectId: PROJECT }));
    const moved = join(root, "moved");
    server.settingsListener?.({ status: "ready", revision: "2", values: { dataDir: moved, checkTimeoutMs: 10_000, maxOutputBytes: 1_048_576, quiesceTimeoutMs: 1_000 } });
    unwrap(await server.call(workflowDraftSetText, { projectId: PROJECT, editableDigest: "absent", yaml: "jobs:\n  build: { uses: checks, with: { run: [\"true\"] } }\n" }));
    expect(await readFile(projectPaths(stateDir, PROJECT).draft, "utf8")).toContain("build");
    await expect(readdir(moved)).rejects.toMatchObject({ code: "ENOENT", path: moved });
  });

  it("runs Planning and both execution runs through RPC and MCP boundaries", async () => {
    const matrixScript = join(repo.dir, "matrix.mjs");
    const matrixJournal = join(root, "matrix-journal.jsonl");
    const baseYaml = workflowYaml(false, matrixScript, repo.dir, matrixJournal);
    const proposedYaml = workflowYaml(true, matrixScript, repo.dir, matrixJournal);

    let view = unwrap(await server.call(workflowDraftSetText, { projectId: PROJECT, editableDigest: "absent", yaml: baseYaml }));
    expect(view.diagnostics).toEqual([]);
    expect(view.model?.jobs.map((job) => job.id)).toEqual(["discover", "implement", "module-tests", "review", "accept"]);
    expect(new Set(view.graph?.jobs.map((job) => job.sourceJobId))).toEqual(new Set(view.model?.jobs.map((job) => job.id)));

    const planning = await host.createWorkspace({ projectId: PROJECT, branchName: "main", runId: "planning" });
    const chat = unwrap(await server.call(workflowChatOpen, { projectId: PROJECT, workspaceId: planning.workspaceId }));
    const chatAgent = host.agents.get(chat.agentId);
    if (!chatAgent) throw new Error("The workflow chat was not created.");
    const editable = await tool(server, chatAgent, repo.dir, "pipeline_workflow_get", {});
    expect(editable.isError).toBe(false);
    const editableBody = z.object({ token: z.string(), yaml: z.string() }).parse(editable.body);
    expect(editableBody).toEqual({ token: view.editableDigest, yaml: baseYaml });
    const proposed = await tool(server, chatAgent, repo.dir, "pipeline_workflow_propose", { baseToken: editableBody.token, yaml: proposedYaml, summary: "Add lint and include it in review." });
    expect(proposed.isError).toBe(false);
    const proposalId = z.object({ proposalId: z.string() }).parse(proposed.body).proposalId;

    view = unwrap(await server.call(workflowGet, { projectId: PROJECT }));
    const proposal = view.proposals.find((candidate) => candidate.id === proposalId);
    expect(proposal?.diagnostics).toEqual([]);
    expect(proposalDelta(view.model, proposal?.model ?? null)).toEqual({ added: ["lint"], removed: [], changed: ["review"] });
    view = unwrap(await server.call(workflowProposalApply, { projectId: PROJECT, proposalId, editableDigest: view.editableDigest }));
    expect(view.draft?.yaml).toBe(proposedYaml);
    view = unwrap(await server.call(workflowSave, { projectId: PROJECT, savedDigest: view.saved?.digest ?? "absent", draftDigest: view.draft?.digest ?? "absent" }));
    expect(view.saved?.yaml).toBe(proposedYaml);
    expect(view.draft).toBeNull();

    const savedPath = projectPaths(stateDir, PROJECT).workflow;
    const savedBytes = await readFile(savedPath, "utf8");
    view = unwrap(await server.call(workflowDraftSetText, { projectId: PROJECT, editableDigest: view.editableDigest, yaml: proposedYaml.replace("Feature delivery", "Conflicting delivery") }));
    const conflict = await server.call(workflowSave, { projectId: PROJECT, savedDigest: "0".repeat(64), draftDigest: view.draft?.digest ?? "absent" });
    expect(conflict).toMatchObject({ ok: false, error: { code: "workflow_conflict" } });
    expect(await readFile(savedPath, "utf8")).toBe(savedBytes);

    view = unwrap(await server.call(workflowDraftSetText, { projectId: PROJECT, editableDigest: view.editableDigest, yaml: proposedYaml.replace("uses: agent", "uses: unknown") }));
    expect(view.diagnostics.map((diagnostic) => diagnostic.code)).toContain("uses_unknown");
    const invalid = await server.call(workflowSave, { projectId: PROJECT, savedDigest: view.saved?.digest ?? "absent", draftDigest: view.draft?.digest ?? "absent" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "workflow_invalid" } });
    expect(await readFile(savedPath, "utf8")).toBe(savedBytes);
    view = unwrap(await server.call(workflowDraftDiscard, { projectId: PROJECT, editableDigest: view.editableDigest }));
    expect(view.saved?.yaml).toBe(proposedYaml);
    expect((await readdir(projectPaths(stateDir, PROJECT).dir)).filter((name) => name.startsWith("workflow"))).toEqual(["workflow.yaml"]);

    await writeFile(matrixScript, "process.exit(0);\n");
    await writeFile(join(repo.dir, "lint.mjs"), "process.exit(0);\n");
    repo.git("add", "matrix.mjs", "lint.mjs");
    repo.git("commit", "-m", "checks");

    const runA = await startRun({ goal: "Run A" }, "run-a");
    const runAViews: RunDetail[] = [];
    const stopA = server.watch(runWatch, { runId: runA }, (event) => runAViews.push(event));
    try {
      await completeWorker(runA, "discover#1", { modules: ["core"] });
      let current = await waitJob(runA, "discover", "awaiting_human");
      expect(jobOf(current, "implement.main").attempts).toEqual([]);
      expect(host.calls.createAgent.filter((key) => key.startsWith(`${runA}:implement.main`))).toEqual([]);
      current = await accept(runA, "discover", [0]);
      expect(jobOf(current, "discover").status).not.toBe("waiting");
      await completeWorker(runA, "implement.main#1", {}, "run-a.txt");
      await completeReview(runA, "review#1");
      await approve(runA);
      current = await waitRun(runA, (candidate) => candidate.view.status === "finished");
      expect(current.graph.jobs.some((job) => job.id === "implement.main")).toBe(true);
      expect(current.graph.jobs.some((job) => job.id === "implement.t1")).toBe(false);
      expect(jobOf(current, "implement.main").status).toBe("succeeded");
      expect(jobOf(current, "accept").status).toBe("succeeded");
      const writers = new Set(current.graph.jobs.filter((job) => job.uses === "agent" || job.uses === "run-task").map((job) => job.id));
      const activeRunAViews = runAViews.filter((observed) => observed.view.jobs.some((job) => writers.has(job.id) && job.attempts.some((attempt) => attempt.endedAt === null)));
      expect(activeRunAViews.length).toBeGreaterThan(0);
      for (const observed of activeRunAViews) {
        const active = observed.view.jobs.filter((job) => writers.has(job.id) && job.attempts.some((attempt) => attempt.endedAt === null));
        expect(active.length).toBeLessThanOrEqual(1);
      }
    } finally {
      stopA();
    }

    await writeFile(matrixScript, `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [moduleName, canonicalDir, journal] = process.argv.slice(2);
const control = journal + ".control";
const record = (event) => appendFileSync(journal, JSON.stringify({ event, module: moduleName, cwd: process.cwd(), hasGit: existsSync(join(process.cwd(), ".git")), pid: process.pid }) + "\\n");
record("start");
if (moduleName === "escape" && !existsSync(join(control, "escaped"))) {
  writeFileSync(join(control, "escaped"), "once\\n");
  writeFileSync(join(canonicalDir, "escape.txt"), "canonical write\\n");
}
if (existsSync(join(control, "hold"))) {
  const release = join(control, Buffer.from(moduleName).toString("base64url") + ".release");
  while (existsSync(join(control, "hold")) && !existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 10));
}
record("end");
`);
    await writeFile(join(repo.dir, "task-check.mjs"), `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counter = process.argv[2];
const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
writeFileSync(counter, String(count));
process.exitCode = count === 1 ? 1 : 0;
`);
    repo.git("add", "matrix.mjs", "task-check.mjs");
    repo.git("commit", "-m", "scripted acceptance checks");
    const control = `${matrixJournal}.control`;
    await mkdir(control, { recursive: true });
    await writeFile(join(control, "hold"), "held\n");
    const checkCounter = join(root, "task-check-counter");
    const tasks = [
      { id: "t1", title: "Task one", needs: [], done: [], acceptance: "auto" },
      { id: "t2", title: "Task two", description: "Second task text", needs: ["t1"], done: [{ run: [process.execPath, join(repo.dir, "task-check.mjs"), checkCounter] }, { criterion: "Task two is correct." }], acceptance: "auto" },
      { id: "t3", title: "Task three", needs: ["t1"], done: [], acceptance: "human" },
    ];

    const runB = await startRun({ goal: "Run B", tasks: JSON.stringify(tasks) }, "run-b");
    const runBViews: RunDetail[] = [];
    let stopB = server.watch(runWatch, { runId: runB }, (event) => runBViews.push(event));
    const discoverAgent = await agentFor(runB, "discover#1", "worker");
    const rejected = await submitWorker(runB, "discover#1", { modules: "not-a-list" });
    expect(rejected.isError).toBe(true);
    expect(rejected.body).toMatchObject({ error: { code: "outputs_invalid" } });
    const accepted = await submitWorker(runB, "discover#1", { modules: ["core", `quoted " module`, "escape"] });
    expect(accepted.isError).toBe(false);
    await endTurn(discoverAgent);
    let current = await waitJob(runB, "discover", "awaiting_human");
    expect(jobOf(current, "implement.t1").attempts).toEqual([]);

    host.onCreateAgent = (input) => input.runId === runB && input.attemptId === "implement.t1#1" && input.role === "worker" ? "hang" : "ok";
    await accept(runB, "discover", [0]);
    const crashed = await agentFor(runB, "implement.t1#1", "worker");
    const crashedKey = creationKey(runB, "implement.t1#1", "worker");
    expect(host.agentsFor(crashedKey)).toHaveLength(1);
    host.onCreateAgent = () => "ok";
    crashed.status = "idle";
    stopB();
    await compose();
    stopB = server.watch(runWatch, { runId: runB }, (event) => runBViews.push(event));
    current = await waitRun(runB, (candidate) => candidate.view.pauseReason === "recovery" && jobOf(candidate, "implement.t1").attempts[0]?.outcome === "lost");
    expect(jobOf(current, "implement.t1").attempts[0]?.agents[0]?.agentId).toBe(crashed.id);
    expect(host.agentsFor(crashedKey)).toHaveLength(1);
    expect(host.calls.createAgent.filter((key) => key === crashedKey)).toHaveLength(1);
    expect(host.agentFor(creationKey(runB, "implement.t1#2", "worker"))).toBeUndefined();
    unwrap(await server.call(runResume, { runId: runB }));
    await completeWorker(runB, "implement.t1#2", {}, "run-b-t1.txt");

    const t2Primary = await agentFor(runB, "implement.t2#1", "worker");
    current = await getRun(runB);
    expect(jobOf(current, "implement.t3").attempts).toEqual([]);
    await endTurn(t2Primary, { kind: "failed", error: { message: "Provider unavailable", code: "provider_unavailable" } });
    const t2Fallback = await agentFor(runB, "implement.t2#2", "worker");
    expect(t2Fallback.input.agent).toMatchObject({ provider: "beta", model: "fallback" });
    current = await getRun(runB);
    expect(jobOf(current, "implement.t2").attempts.map((attempt) => [attempt.n, attempt.cause, attempt.target, attempt.outcome])).toEqual([
      [1, "first", "primary", "provider_failed"],
      [2, "failover", "fallback", null],
    ]);
    await completeWorker(runB, "implement.t2#2", {}, "run-b-t2.txt");
    const t2Retry = await agentFor(runB, "implement.t2#3", "worker");
    expect(t2Retry.input.agent).toMatchObject({ provider: "beta", model: "fallback" });
    current = await getRun(runB);
    expect(jobOf(current, "implement.t2").attempts[2]).toMatchObject({ cause: "retry", target: "fallback" });
    expect(jobOf(current, "implement.t3").attempts).toEqual([]);
    await completeWorker(runB, "implement.t2#3", {}, "run-b-t2-retry.txt");
    await completeReview(runB, "implement.t2#3", { outcome: "approved", criteria: [{ index: 1, met: true, note: "Criterion verified." }] });
    current = await waitJob(runB, "implement.t2", "succeeded");
    expect(current.view.evidence.filter((item) => item.attemptId === "implement.t2#3" && item.kind === "check")).toEqual([
      expect.objectContaining({ result: "pass", mode: "exclusive", exitCode: 0 }),
    ]);
    expect(current.view.evidence.filter((item) => item.attemptId === "implement.t2#3" && item.kind === "criterion")).toEqual([
      expect.objectContaining({ result: "pass", item: 1 }),
    ]);

    await completeWorker(runB, "implement.t3#1", {}, "run-b-t3.txt");
    await accept(runB, "implement.t3");
    current = await getRun(runB);
    expect(jobOf(current, "implement.t3").status).toBe("succeeded");
    expect(jobOf(current, "accept").status).toBe("waiting");
    expect(current.view.evidence.some((item) => item.kind === "approval")).toBe(false);

    await vi.waitFor(async () => {
      const starts = (await matrixRecords(matrixJournal)).filter((record) => record.event === "start");
      expect(starts.map((record) => record.module).sort()).toEqual(["core", `quoted " module`].sort());
    }, { timeout: 8_000, interval: 10 });
    let records = await matrixRecords(matrixJournal);
    expect(records.some((record) => record.module === "escape")).toBe(false);
    await writeFile(releaseFile(control, "core"), "release\n");
    await writeFile(releaseFile(control, `quoted " module`), "release\n");
    await vi.waitFor(async () => {
      const starts = (await matrixRecords(matrixJournal)).filter((record) => record.event === "start");
      expect(starts.some((record) => record.module === "escape")).toBe(true);
    }, { timeout: 8_000, interval: 10 });
    expect(await readFile(join(repo.dir, "escape.txt"), "utf8")).toBe("canonical write\n");
    records = await matrixRecords(matrixJournal);
    expect(records.some((record) => record.event === "end" && record.module === "core")).toBe(true);
    expect(records.some((record) => record.event === "end" && record.module === `quoted " module`)).toBe(true);
    await writeFile(releaseFile(control, "escape"), "release\n");
    const reviewPrimary = await agentFor(runB, "review#1", "reviewer");
    current = await getRun(runB);
    expect(current.view.evidence.filter((item) => item.attemptId === "lint#1" && item.kind === "check")).toEqual([
      expect.objectContaining({ result: "pass", mode: "exclusive" }),
    ]);
    expect(current.view.evidence.filter((item) => item.attemptId === "module-tests[0]#1" && item.kind === "check").map((item) => [item.result, item.mode])).toEqual([["pass", "isolated"]]);
    expect(current.view.evidence.filter((item) => item.attemptId === "module-tests[1]#1" && item.kind === "check").map((item) => [item.result, item.mode])).toEqual([["pass", "isolated"]]);
    expect(current.view.evidence.filter((item) => item.attemptId === "module-tests[2]#1" && item.kind === "check").map((item) => [item.result, item.mode])).toEqual([["late", "isolated"], ["pass", "exclusive"]]);
    expect(current.view.evidence.filter((item) => item.attemptId === "module-tests[0]#2" && item.kind === "check").map((item) => [item.result, item.mode])).toEqual([["pass", "isolated"]]);
    expect(current.view.evidence.filter((item) => item.attemptId === "module-tests[1]#2" && item.kind === "check").map((item) => [item.result, item.mode])).toEqual([["pass", "isolated"]]);
    records = await matrixRecords(matrixJournal);
    const firstStarts = ["core", `quoted " module`, "escape"].map((module) => records.find((record) => record.event === "start" && record.module === module));
    for (const started of firstStarts) {
      expect(started?.cwd).not.toBe(repo.dir);
      expect(started?.hasGit).toBe(false);
    }
    expect(records.filter((record) => record.event === "start" && record.module === "core")).toHaveLength(2);
    const quotedStarts = records.filter((record) => record.event === "start" && record.module === `quoted " module`);
    expect(quotedStarts).toHaveLength(2);
    expect(quotedStarts.every((record) => record.cwd !== repo.dir && !record.hasGit)).toBe(true);
    const exclusiveEscape = records.filter((record) => record.event === "start" && record.module === "escape")[1]?.cwd;
    if (!exclusiveEscape) throw new Error("The escaping instance did not rerun exclusively.");
    expect(await realpath(exclusiveEscape)).toBe(await realpath(repo.dir));
    let activeChecks = 0;
    let activePeak = 0;
    for (const record of records) {
      activeChecks += record.event === "start" ? 1 : -1;
      activePeak = Math.max(activePeak, activeChecks);
    }
    expect(activePeak).toBe(2);

    await endTurn(reviewPrimary, { kind: "failed", error: { message: "Primary unavailable", code: "provider_unavailable" } });
    const reviewFallback = await agentFor(runB, "review#2", "reviewer");
    expect(reviewFallback.input.agent).toMatchObject({ provider: "beta", model: "reviewer" });
    await endTurn(reviewFallback, { kind: "failed", error: { message: "Fallback unavailable", code: "provider_unavailable" } });
    current = await waitJob(runB, "review", "needs_human");
    expect(statusLabel(jobOf(current, "review"))).toBe("Needs attention");
    expect(jobOf(current, "review").providerFailures.map((failure) => [failure.target, failure.provider, failure.class])).toEqual([
      ["primary", "alpha", "unavailable"],
      ["fallback", "beta", "unavailable"],
    ]);
    expect(host.agentFor(creationKey(runB, "review#3", "reviewer"))).toBeUndefined();
    unwrap(await server.call(jobRetry, { runId: runB, jobId: "review", target: "primary" }));
    const reviewRetry = await agentFor(runB, "review#3", "reviewer");
    expect(reviewRetry.input.agent).toMatchObject({ provider: "alpha", model: "reviewer" });

    await submitReview(runB, "review#3", { outcome: "changes_requested", findings: [{ title: "Rework task two", detail: "Add the requested correction.", tasks: ["t2"] }] });
    host.interruptMode = "ignore";
    await endTurn(reviewRetry, { kind: "completed" }, true);
    await vi.waitFor(() => expect(host.calls.interrupt).toContain(reviewRetry.id), { timeout: 8_000, interval: 10 });
    expect(host.agentFor(creationKey(runB, "implement.t2#4", "worker"))).toBeUndefined();
    current = await getRun(runB);
    expect(current.view.barrier).toMatchObject({ cause: "rework" });
    await endTurn(reviewRetry);
    host.interruptMode = "stop";
    const reworkedT2 = await agentFor(runB, "implement.t2#4", "worker");
    expect(reworkedT2.input.agent).toMatchObject({ provider: "beta", model: "fallback" });
    current = await getRun(runB);
    expect(jobOf(current, "implement.t1").attempts.map((attempt) => attempt.attemptId)).toEqual(["implement.t1#1", "implement.t1#2"]);
    expect(jobOf(current, "implement.t3").attempts.map((attempt) => attempt.attemptId)).toEqual(["implement.t3#1"]);
    expect(jobOf(current, "implement.t2").attempts[3]).toMatchObject({ cause: "rework", target: "fallback" });
    await completeWorker(runB, "implement.t2#4", {}, "run-b-t2-rework.txt");
    await completeReview(runB, "implement.t2#4", { outcome: "approved", criteria: [{ index: 1, met: true }] });

    const reviewAfterRework = await agentFor(runB, "review#4", "reviewer");
    current = await getRun(runB);
    const matrixIds = current.graph.jobs.filter((job) => job.sourceJobId === "module-tests").map((job) => job.id);
    expect(matrixIds).toEqual(["module-tests[0]", "module-tests[1]", "module-tests[2]"]);
    expect(jobOf(current, "lint").attempts.some((attempt) => attempt.cause === "rework")).toBe(true);
    for (const matrixId of matrixIds) expect(jobOf(current, matrixId).attempts.some((attempt) => attempt.cause === "rework")).toBe(true);
    stopB();
    await compose();
    stopB = server.watch(runWatch, { runId: runB }, (event) => runBViews.push(event));
    current = await getRun(runB);
    expect(current.view.status).toBe("running");
    expect(current.graph.jobs.filter((job) => job.sourceJobId === "module-tests").map((job) => job.id)).toEqual(matrixIds);
    expect(jobOf(current, "review").attempts[3]?.agents[0]?.agentId).toBe(reviewAfterRework.id);
    expect(host.calls.createAgent.filter((key) => key === creationKey(runB, "review#4", "reviewer"))).toHaveLength(1);
    await completeReview(runB, "review#4");

    current = await waitJob(runB, "accept", "awaiting_human");
    const taskAttempts = ["implement.t1", "implement.t2", "implement.t3"].map((jobId) => jobOf(current, jobId).attempts.map((attempt) => attempt.attemptId));
    const staleCycle = jobOf(current, "accept").activeCycleId;
    if (!staleCycle) throw new Error("The first approval cycle is missing.");
    await writeFile(join(repo.dir, "work", "stale-before-approve.txt"), "stale\n");
    const stale = await server.call(jobApprove, { runId: runB, jobId: "accept", cycleId: staleCycle });
    expect(stale).toMatchObject({ ok: false, error: { code: "evidence_stale" } });
    await completeReview(runB, "review#5");
    current = await waitJob(runB, "accept", "awaiting_human");
    const freshCycle = jobOf(current, "accept").activeCycleId;
    expect(freshCycle).not.toBe(staleCycle);
    expect(["implement.t1", "implement.t2", "implement.t3"].map((jobId) => jobOf(current, jobId).attempts.map((attempt) => attempt.attemptId))).toEqual(taskAttempts);
    await approve(runB, freshCycle ?? undefined);
    current = await waitRun(runB, (candidate) => candidate.view.status === "finished");

    expect(jobOf(current, "lint").attempts.some((attempt) => attempt.cause === "stale")).toBe(true);
    for (const matrixId of matrixIds) expect(jobOf(current, matrixId).attempts.some((attempt) => attempt.cause === "stale")).toBe(true);
    expect(current.graph.jobs.map((job) => job.id)).toEqual(expect.arrayContaining(["discover", "implement.t1", "implement.t2", "implement.t3", "lint", "module-tests[0]", "module-tests[1]", "module-tests[2]", "review", "accept"]));
    expect(jobOf(current, "review").attempts.map((attempt) => attempt.attemptId)).toEqual(["review#1", "review#2", "review#3", "review#4", "review#5"]);
    expect(jobOf(current, "review").attempts.map((attempt) => attempt.cause)).toEqual(expect.arrayContaining(["rework", "stale"]));
    expect(current.view.evidence.filter((item) => item.attemptId === "implement.t2#4" && item.kind === "criterion")).toEqual([
      expect.objectContaining({ item: 1, result: "pass" }),
    ]);
    const graphT2 = current.graph.jobs.find((job) => job.id === "implement.t2");
    expect(graphT2 && taskText(graphT2)).toEqual([
      { label: "Title", text: "Task two" },
      { label: "Description", text: "Second task text" },
      { label: "Prompt", text: "${{ inputs.goal }}" },
    ]);
    expect(openChats(jobOf(current, "implement.t2")).map((chat) => chat.label)).toEqual(["Open worker chat", "Open reviewer chat"]);
    const changes = unwrap(await server.call(jobChanges, { runId: runB, jobId: "implement.t2" }));
    expect(changes.diff).toContain("run-b-t2-rework.txt");
    expect(changes.attempts.some((attempt) => attempt.attemptId === "implement.t2#4" && attempt.files?.includes("work/run-b-t2-rework.txt"))).toBe(true);
    expect(defaultView(true)).toBe("list");
    const listed = unwrap(await server.call(runList, { projectId: PROJECT }));
    expect(listed.runs).toHaveLength(2);
    expect(listed.runs.map((run) => [run.runId, run.status])).toEqual(expect.arrayContaining([[runA, "finished"], [runB, "finished"]]));

    const repeatedInputs = { goal: "Run B", tasks: JSON.stringify(tasks) };
    expect(await startRun(repeatedInputs, "run-b")).toBe(runB);
    const racing = await Promise.all([startRun(repeatedInputs, "run-b"), startRun(repeatedInputs, "run-b")]);
    expect(racing).toEqual([runB, runB]);
    const workspaceCount = host.workspaces.length;
    const agentCount = host.agents.size;
    stopB();
    await compose();
    expect(await startRun(repeatedInputs, "run-b")).toBe(runB);
    expect(host.workspaces).toHaveLength(workspaceCount);
    expect(host.agents.size).toBe(agentCount);

    const writers = new Set(current.graph.jobs.filter((job) => job.uses === "agent" || job.uses === "run-task").map((job) => job.id));
    const activeRunBViews = runBViews.filter((observed) => observed.view.jobs.some((job) => writers.has(job.id) && job.attempts.some((attempt) => attempt.endedAt === null)));
    expect(activeRunBViews.length).toBeGreaterThan(0);
    for (const observed of activeRunBViews) {
      const active = observed.view.jobs.filter((job) => writers.has(job.id) && job.attempts.some((attempt) => attempt.endedAt === null));
      expect(active.length).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});
