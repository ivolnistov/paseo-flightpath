// Startup ordering and failure cleanup of the MCP endpoint (KensAI C17/C19/C20), over real local
// HTTP, real temp state and a real temp project store. Faults are injected by wrapping a real
// McpState; real node:http servers are recorded so a leaked listener can always be closed.
import { readFile, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMcpEndpoint, type McpEndpoint } from "./mcp-endpoint";
import { createGrantResolver } from "./mcp-grants";
import { createMcpState, type Grant, type McpState } from "./mcp-state";
import { buildTools, type McpToolTable } from "./mcp-tools";
import { createPaseoHolder } from "./paseo-holder";
import { createRoadmapCommands } from "./sessions";
import { openStore } from "./store";
import { fixedClock, nextId } from "./test-support/build";
import { recordingDirectory, rpc, tempStateDir } from "./test-support/mcp";
import { makeProject, type TestProject } from "./test-support/service";

const created = vi.hoisted(() => [] as Array<{ server: HttpServer; port?: number; requests: number }>);
vi.mock("node:http", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:http")>();
  const createServer = ((...args: Parameters<typeof real.createServer>) => {
    const server = real.createServer(...args);
    const entry: { server: HttpServer; port?: number; requests: number } = { server, requests: 0 };
    server.on("listening", () => {
      const a = server.address();
      if (a && typeof a === "object") entry.port = a.port;
    });
    server.on("request", () => void entry.requests++);
    created.push(entry);
    return server;
  }) as typeof real.createServer;
  return { ...real, default: { ...real, createServer }, createServer };
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const cleanups: Array<() => Promise<unknown>> = [];
let project: TestProject | undefined;
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  // Close anything a failed startup leaked, whatever the endpoint object did.
  for (const { server } of created.splice(0)) {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  }
  await project?.cleanup();
  project = undefined;
});

async function canBind(port: number): Promise<boolean> {
  const probe = createNetServer();
  return new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function occupyFreePort(): Promise<{ port: number; blocker: NetServer }> {
  const blocker = createNetServer();
  await new Promise<void>((resolve, reject) => blocker.once("error", reject).listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise((resolve) => blocker.close(() => resolve(undefined))));
  return { port: (blocker.address() as { port: number }).port, blocker };
}

/** Real project, state, tools and resolver; `wrap` injects faults into the real state. */
async function fixture(wrap: (real: McpState) => Partial<McpState> = () => ({})) {
  project = await makeProject();
  const p = project;
  if (!(await p.service.init(p.paseo, { projectId: p.projectId })).ok) throw new Error("init failed");
  const stateDir = await tempStateDir();
  cleanups.push(() => rm(join(stateDir, ".."), { recursive: true, force: true }));
  const logs: string[] = [];
  const log = (m: string) => void logs.push(m);
  const real = createMcpState({ stateDir, now: fixedClock, newId: nextId, log });
  const state: McpState = { ...real, ...wrap(real) };
  const dir = recordingDirectory({ projects: [{ projectId: p.projectId, projectRootPath: p.root, projectKind: "git" }] });
  const holder = createPaseoHolder();
  holder.set(p.paseo);
  const storeOptions = { now: fixedClock, newId: nextId, log };
  const commands = createRoadmapCommands({ directory: () => dir.directory, now: fixedClock, newId: nextId, storeOptions });
  let toolRuns = 0;
  const toolRan = deferred();
  const tools: McpToolTable = buildTools(commands).map((tool) => ({
    ...tool,
    run: (args: never, ctx: never) => {
      toolRuns++;
      toolRan.resolve();
      return tool.run(args, ctx);
    },
  }));
  const resolveGrant = createGrantResolver({ holder, directory: () => dir.directory, log, storeOptions });
  const start = () => startMcpEndpoint({ state, tools, resolveGrant, log });
  const revision = async () => (await openStore({ storeRoot: p.root, projectId: p.projectId }).version()).revision;
  const issue = (port: number) => real.issueGrant({ projectId: p.projectId, storeRoot: p.root, provider: "claude", cwd: p.root, port });
  const persistedPort = async () => JSON.parse(await readFile(join(stateDir, "mcp.json"), "utf8")).port as number;
  return { real, state, logs, start, revision, issue, persistedPort, toolRan, toolRuns: () => toolRuns, stateDir };
}

const createSession = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "roadmap_create_session", arguments: { expectedRevision: 1, title: "during startup" } } };
const toolSucceeded = (r: { status: number; json: any }) => r.status === 200 && r.json?.result && r.json.result.isError !== true;

describe("startup failure cleanup", () => {
  it("a first-start saveEndpoint failure rejects and releases the bound listener", async () => {
    const f = await fixture(() => ({ saveEndpoint: async () => Promise.reject(new Error("disk full")) }));
    await expect(f.start()).rejects.toThrow("disk full");
    expect(created).toHaveLength(1);
    const { server, port } = created[0];
    expect(port, "the endpoint bound a port before saving it").toBeTypeOf("number");
    expect(server.listening, "listener closed after the failed start").toBe(false);
    expect(await canBind(port!), `port ${port} can be rebound immediately`).toBe(true);
  });

  it("a markStale failure during fallback keeps the old persisted port, rejects and leaks no socket", async () => {
    const f = await fixture((_real) => ({ markStale: async () => Promise.reject(new Error("grants unwritable")) }));
    const { secret } = await f.real.loadOrCreateEndpoint();
    const { port: oldPort } = await occupyFreePort();
    await f.real.saveEndpoint({ version: 1, port: oldPort, secret });
    const old = await f.issue(oldPort);

    await expect(f.start()).rejects.toThrow("grants unwritable");
    expect(await f.persistedPort(), "the new port is never published before old grants are invalidated").toBe(oldPort);
    expect((await f.real.getGrant(old.grantId))?.stale).toBe(false);
    for (const { server, port } of created) {
      expect(server.listening, `fallback listener on ${port} closed`).toBe(false);
      if (port !== undefined && port !== oldPort) expect(await canBind(port)).toBe(true);
    }
    for (const line of f.logs) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("/mcp/");
    }
  });
});

describe("startup admission", () => {
  it("an old grant cannot run a tool on the fallback port before startup has invalidated it", async () => {
    const newPortSeen = deferred<number>();
    const release = deferred();
    const f = await fixture((real) => ({
      saveEndpoint: async (s) => {
        if (s.port !== 0) newPortSeen.resolve(s.port);
        await release.promise;
        return real.saveEndpoint(s);
      },
    }));
    const { secret } = await f.real.loadOrCreateEndpoint();
    const { port: oldPort } = await occupyFreePort();
    await f.real.saveEndpoint({ version: 1, port: oldPort, secret });
    const old: Grant = await f.issue(oldPort);
    const { signGrant } = await import("./mcp-endpoint");
    const oldPath = `/mcp/${old.grantId}.${signGrant(secret, old.grantId, old.projectId)}`;

    let endpoint: McpEndpoint | undefined;
    const starting = f.start().then((e) => (endpoint = e));
    cleanups.push(async () => {
      release.resolve();
      await starting.catch(() => undefined);
      await endpoint?.close();
    });
    // The fallback port is known once startup tries to persist it; startup is now held there.
    const newPort = await Promise.race([
      newPortSeen.promise,
      starting.then(() => created.find((c) => c.port !== undefined && c.port !== oldPort)?.port ?? -1),
    ]);
    expect(newPort).not.toBe(oldPort);
    expect(newPort).toBeGreaterThan(0);

    const during = rpc(`http://127.0.0.1:${newPort}${oldPath}`, createSession);
    // Current behaviour runs the tool while startup is held. A correct endpoint either answers
    // without running it or holds the request; the bounded fallback covers the holding case only.
    let fallback: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([during, f.toolRan.promise, new Promise((resolve) => (fallback = setTimeout(resolve, 2000)))]);
    clearTimeout(fallback);
    release.resolve();
    await starting;
    const answer = await during;

    expect(f.toolRuns(), "no tool runs for an old grant during startup").toBe(0);
    expect(toolSucceeded(answer)).toBe(false);
    expect(await f.revision(), "the project is not mutated").toBe(1);

    expect(endpoint!.port).toBe(newPort);
    expect(await f.persistedPort()).toBe(newPort);
    expect((await f.real.getGrant(old.grantId))?.stale).toBe(true);
    expect((await rpc(`http://127.0.0.1:${newPort}${oldPath}`, createSession)).status).toBe(404);
    const fresh = await f.issue(newPort);
    const ok = await rpc(endpoint!.urlFor(fresh), createSession);
    expect(toolSucceeded(ok), JSON.stringify(ok.json)).toBe(true);
    expect(await f.revision()).toBe(2);
    for (const line of f.logs) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("/mcp/");
    }
  });
});
