// Real MCP endpoint over temp state and temp project stores, a holder that starts empty, the
// official MCP SDK client (loaded lazily so non-SDK tests do not depend on it), raw fetch for
// transport-security cases, and a fake hook server for injection/hydration hooks.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type {
  PluginBeforeRequests,
  PluginHookContext,
  PluginLifecycleEvents,
  PluginServerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { nodeStoreFs } from "../fs-port";
import { startMcpEndpoint, type GrantResolver, type McpEndpoint } from "../mcp-endpoint";
import { createGrantResolver } from "../mcp-grants";
import { createMcpState, type Grant, type McpState } from "../mcp-state";
import { buildTools, type McpToolTable } from "../mcp-tools";
import { createPaseoHolder } from "../paseo-holder";
import { createRoadmapCommands, type RoadmapCommands } from "../sessions";
import { openStore } from "../store";
import { resolveProject, type ProjectDirectory } from "../store-root";
import { fixedClock, nextId } from "./build";
import { recordingFs } from "./fault-fs";
import { makeProject } from "./service";

export type PaseoHolder = ReturnType<typeof createPaseoHolder>;
type DirProject = { projectId: string; projectRootPath: string; projectKind: string };
type DirWorkspace = { id: string; projectId: string; directory?: string };

/** Mutable registry standing in for the daemon directory, counting every lookup. */
export function recordingDirectory(init: { projects: DirProject[]; workspaces?: DirWorkspace[] }) {
  const registry = { projects: [...init.projects], workspaces: [...(init.workspaces ?? [])] };
  const calls: string[] = [];
  const directory: ProjectDirectory = {
    listProjects: async () => {
      calls.push("listProjects");
      return registry.projects.map((p) => ({ ...p }));
    },
    listWorkspaces: async () => {
      calls.push("listWorkspaces");
      return registry.workspaces.map((w) => ({ ...w }));
    },
  };
  return { directory, registry, calls };
}

export async function startTestEndpoint(
  opts: { stateDir?: string; extraTools?: (commands: RoadmapCommands, open: { stateDir: string }) => McpToolTable } = {},
) {
  const ownsState = opts.stateDir === undefined;
  const stateDir = opts.stateDir ?? (await tempStateDir());
  const project = await makeProject();
  const { paseo } = project;
  if (!(await project.service.init(paseo, { projectId: project.projectId })).ok) throw new Error("init failed");
  const logs: string[] = [];
  const log = (m: string) => void logs.push(m);
  const dir = recordingDirectory({ projects: [{ projectId: project.projectId, projectRootPath: project.root, projectKind: "git" }] });
  const holder = createPaseoHolder();
  const directoryFor = (p: PaseoApi) => {
    if (p !== paseo) throw new Error("unexpected PaseoApi instance");
    return dir.directory;
  };
  const storeFs = recordingFs(nodeStoreFs);
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string) => log(m) };
  const commands: RoadmapCommands = createRoadmapCommands({ directory: directoryFor, now: fixedClock, newId: nextId, storeOptions });
  const state: McpState = createMcpState({ stateDir, now: fixedClock, newId: nextId, log });

  // The production resolver (server/mcp-grants.ts) over the test holder, directory and recording fs.
  const resolveGrant: GrantResolver = createGrantResolver({
    holder,
    directory: directoryFor,
    log,
    storeOptions: { ...storeOptions, fs: storeFs.fs },
  });

  const start = () => startMcpEndpoint({ state, tools: buildTools(commands, opts.extraTools?.(commands, { stateDir }) ?? []), resolveGrant, log });
  let endpoint: McpEndpoint = await start();
  const extraRoots: string[] = [];

  return {
    get endpoint(): McpEndpoint {
      return endpoint;
    },
    /** Closes the endpoint and starts a new one over the same state, tools and resolver. */
    async restart(): Promise<McpEndpoint> {
      await endpoint.close();
      endpoint = await start();
      return endpoint;
    },
    resolveGrant,
    state,
    stateDir,
    logs,
    project,
    paseo,
    holder,
    dir,
    commands,
    /** fs calls made by stores opened through grants. */
    storeCalls: storeFs.calls,
    /** Hydrate the holder the way an RPC or hook would. */
    ready: () => holder.set(paseo),
    /** Registers and initialises another project in its own temp root. */
    async addProject(projectId: string): Promise<string> {
      const root = await realpath(await mkdtemp(join(tmpdir(), `dr-mcp-${projectId}-`)));
      extraRoots.push(root);
      dir.registry.projects.push({ projectId, projectRootPath: root, projectKind: "git" });
      await openStore({ storeRoot: root, projectId, ...storeOptions }).init();
      return root;
    },
    async grantFor(projectId: string = project.projectId): Promise<{ grant: Grant; url: string }> {
      const { storeRoot } = await resolveProject(dir.directory, projectId);
      const grant = await state.issueGrant({ projectId, storeRoot, provider: "claude", cwd: storeRoot, port: endpoint.port });
      return { grant, url: endpoint.urlFor(grant) };
    },
    async stop(): Promise<void> {
      await endpoint.close().catch(() => undefined);
      await project.cleanup();
      await Promise.all(extraRoots.map((r) => rm(r, { recursive: true, force: true })));
      if (ownsState) await rm(join(stateDir, ".."), { recursive: true, force: true });
    },
  };
}
export type TestEndpoint = Awaited<ReturnType<typeof startTestEndpoint>>;

/** Fresh temp state directory (not yet created inside its temp parent). */
export async function tempStateDir(): Promise<string> {
  return join(await realpath(await mkdtemp(join(tmpdir(), "dr-state-"))), "state");
}

export async function rpc(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
): Promise<{ status: number; json: unknown; text: string; headers: Headers }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    ...(method === "POST" || method === "PUT" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

export const initializeBody = (id: number, protocolVersion = "2025-06-18") => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "t2-raw", version: "0" } },
});

export async function sdkClient(url: string): Promise<Client> {
  const { Client: SdkClient } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new SdkClient({ name: "t2", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; value?: unknown }> {
  const res = await client.callTool({ name, arguments: args });
  const content: unknown[] = "content" in res && Array.isArray(res.content) ? res.content : [];
  const text = content.map((c) => (typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : "")).join("");
  const isError = "isError" in res && res.isError === true;
  return { isError, text, ...(isError ? {} : { value: JSON.parse(text) as unknown }) };
}

type BeforeHandler = (input: { request: any }, ctx: PluginHookContext) => unknown;
type OnHandler = (event: any, ctx: PluginHookContext) => unknown;

export function fakeHookServer() {
  const regs: Array<{ kind: "before" | "on"; name: string }> = [];
  const before = new Map<string, BeforeHandler>();
  const on = new Map<string, OnHandler>();
  const ctx = (paseo: PaseoApi): PluginHookContext => ({ paseo, signal: new AbortController().signal });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- fake hook server: one heterogeneous handler map behind the SDK's generic before/on
  const server = {
    before(name: string, handler: BeforeHandler) {
      regs.push({ kind: "before", name });
      before.set(name, handler);
      return () => void before.delete(name);
    },
    on(name: string, handler: OnHandler) {
      regs.push({ kind: "on", name });
      on.set(name, handler);
      return () => void on.delete(name);
    },
  } as unknown as Pick<PluginServerContext, "before" | "on">;
  return {
    server,
    async runBefore(request: PluginBeforeRequests["agent.create"], paseo: PaseoApi) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- fake hook server: one heterogeneous handler map behind the SDK's generic before/on
      return (await before.get("agent.create")!({ request }, ctx(paseo))) as PluginBeforeRequests["agent.create"] | void;
    },
    async runSessionOpen(request: PluginSessionOpenRequest, paseo: PaseoApi) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- fake hook server: one heterogeneous handler map behind the SDK's generic before/on
      return (await before.get("agent.session_open")!({ request }, ctx(paseo))) as PluginSessionOpenRequest | void;
    },
    async emit(name: "agent.turn_started", event: PluginLifecycleEvents["agent.turn_started"], paseo: PaseoApi) {
      await on.get(name)!(event, ctx(paseo));
    },
    registrations: () => regs.map((r) => ({ ...r })),
  };
}
