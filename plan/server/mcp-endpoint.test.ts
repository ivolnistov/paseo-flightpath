import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:net";
import { mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { openStore } from "./store";
import { signGrant, verifyGrantPath } from "./mcp-endpoint";
import { fingerprint, type Grant } from "./mcp-state";
import { TOOL_NAMES, type McpTool } from "./mcp-tools";
import { registerInjection } from "./injection";
import { isJsonObject, readJsonObject } from "./test-support/build";
import { callTool, fakeHookServer, initializeBody, rpc, sdkClient, startTestEndpoint, type TestEndpoint } from "./test-support/mcp";

const STAGE3_TOOL_NAMES = ["roadmap_plan_draft", "roadmap_plan_status", "roadmap_task_update"];
const FORBIDDEN_ARGS = new Set(["projectId", "storeRoot", "path", "root", "cwd"]);

// Collected across the file for the final redaction check.
const allLogs: string[] = [];
const sensitive: string[] = [];

// Load the official SDK once up front: its cold import under a parallel full run can exceed the
// 5 s per-test default on the first SDK test. Test timeouts and assertions are unchanged.
beforeAll(async () => {
  await import("@modelcontextprotocol/sdk/client/index.js");
  await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
}, 60_000);

let t: TestEndpoint | undefined;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  if (t) {
    allLogs.push(...t.logs);
    sensitive.push((await t.state.loadOrCreateEndpoint()).secret);
    await t.stop();
    t = undefined;
  }
});

async function setup(ready = true) {
  t = await startTestEndpoint();
  if (ready) t.ready();
  return t;
}
async function grantUrl(projectId?: string) {
  const g = await t!.grantFor(projectId);
  const path = new URL(g.url).pathname;
  sensitive.push(path, path.split(".").pop()!);
  return g;
}
async function client(url: string) {
  const c = await sdkClient(url);
  cleanups.push(() => c.close());
  return c;
}

/** node:http request so Host/Origin and methods can be set exactly. */
function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      { host: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        // Without setEncoding the response yields Buffers; the bytes are kept as received.
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function schemaKeys(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) schema.forEach((s) => schemaKeys(s, out));
  else if (isJsonObject(schema)) {
    const o = schema;
    if (o.properties && typeof o.properties === "object") out.push(...Object.keys(o.properties));
    Object.values(o).forEach((v) => schemaKeys(v, out));
  }
  return out;
}

const tree = async (dir: string) => {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out[relative(dir, full)] = await readFile(full, "utf8");
    }
  };
  await walk(dir);
  return out;
};

// A JSON-RPC response as sent: result and error are both optional so an error envelope stays assertable.
const Envelope = z.object({ result: z.unknown().optional(), error: z.object({ code: z.number() }).optional() });
const InitializeResult = z.object({ protocolVersion: z.string(), serverInfo: z.object({ name: z.string() }), capabilities: z.unknown(), instructions: z.string() });
const RevisionValue = z.object({ revision: z.number() });

describe("protocol", () => {
  it("initialize echoes a supported version, falls back to 2025-06-18, and returns serverInfo and instructions", async () => {
    await setup();
    const { url } = await grantUrl();
    const res = await rpc(url, initializeBody(1, "2025-03-26"));
    expect(res.status).toBe(200);
    const init = InitializeResult.parse(Envelope.parse(res.json).result);
    expect(init.protocolVersion).toBe("2025-03-26");
    expect(init.serverInfo.name).toBe("paseo-decision-roadmap");
    expect(init.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.instructions).toContain("expectedRevision");
    expect(init.instructions).toContain("never claim approval");
    expect(InitializeResult.parse(Envelope.parse((await rpc(url, initializeBody(2, "1999-01-01"))).json).result).protocolVersion).toBe("2025-06-18");
    expect(Envelope.parse((await rpc(url, { jsonrpc: "2.0", id: 3, method: "ping" })).json).result).toEqual({});
    expect(Envelope.parse((await rpc(url, { jsonrpc: "2.0", id: 4, method: "nope/unknown" })).json).error?.code).toBe(-32601);
  });

  it("tools/list (official client) is exactly TOOL_NAMES, with no approval/deletion powers and no path or project argument", async () => {
    await setup();
    const { url } = await grantUrl();
    const { tools } = await (await client(url)).listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([...TOOL_NAMES].sort());
    // Automatic grilling S2 (task card §4.2): + roadmap_pause_instructions and roadmap_grill_complete.
    // Feature discussion: + roadmap_resolve_link (read-only), roadmap_out_of_scope, roadmap_cancel_question
    // roadmap_block_accept and roadmap_grill_propose_finish.
    expect(TOOL_NAMES).toHaveLength(17);
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/approve|delete|skip|init|ticket|tracker/);
      expect(STAGE3_TOOL_NAMES).not.toContain(tool.name);
      expect(schemaKeys(tool.inputSchema).filter((k) => FORBIDDEN_ARGS.has(k)), tool.name).toEqual([]);
    }
  });
});

describe("grant signature contract (card ruling 2)", () => {
  const secret = "synthetic-secret-0001";
  const grant: Grant = { grantId: "grant-0001", projectId: "prj_test", storeRoot: "/synthetic/a", provider: "claude", cwd: "/synthetic/a", port: 1, issuedAt: "2026-10-20T10:00:00.000Z", stale: false };
  // Independently computed: base64url(HMAC-SHA256(secret, "v1\n" + grantId + "\n" + projectId)).
  const REQUIRED = "Z-mTFxNckXNkJhRVxTTeOPIvcAaEwyIfncJEx6d884s";

  it("signGrant matches the v1-framed known-answer vector", () => {
    expect(createHmac("sha256", secret).update(`v1\n${grant.grantId}\n${grant.projectId}`, "utf8").digest("base64url")).toBe(REQUIRED);
    expect(signGrant(secret, grant.grantId, grant.projectId)).toBe(REQUIRED);
  });

  it("verifyGrantPath accepts the v1-framed signature and rejects unframed or cross-project ones", async () => {
    const lookup = async (id: string) => (id === grant.grantId ? grant : null);
    expect(await verifyGrantPath(secret, `${grant.grantId}.${REQUIRED}`, lookup)).toEqual(grant);
    const unframed = createHmac("sha256", secret).update(`${grant.grantId}\n${grant.projectId}`, "utf8").digest("base64url");
    expect(await verifyGrantPath(secret, `${grant.grantId}.${unframed}`, lookup)).toBeNull();
    const otherProject = createHmac("sha256", secret).update(`v1\n${grant.grantId}\nprj_other`, "utf8").digest("base64url");
    expect(await verifyGrantPath(secret, `${grant.grantId}.${otherProject}`, lookup)).toBeNull();
  });
});

describe("transport security", () => {
  it("forged, cross-project, unknown, stale and malformed paths all give an identical 404", async () => {
    await setup();
    const { grant, url } = await grantUrl();
    const { secret } = await t!.state.loadOrCreateEndpoint();
    const base = `http://127.0.0.1:${t!.endpoint.port}/mcp/`;
    const sig = url.split(".").pop()!;
    const forged = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    const staleGrant = await t!.state.issueGrant({ projectId: grant.projectId, storeRoot: grant.storeRoot, provider: "claude", cwd: grant.cwd, port: 1 });
    await t!.state.markStale(1);
    const cases = [
      `${base}${grant.grantId}.${forged}`,
      `${base}${grant.grantId}.${signGrant(secret, grant.grantId, "prj_other")}`,
      `${base}nogrant.${signGrant(secret, "nogrant", grant.projectId)}`,
      `${base}${staleGrant.grantId}.${signGrant(secret, staleGrant.grantId, staleGrant.projectId)}`,
      `${base}${grant.grantId}`,
      `${base}x.y`,
      `http://127.0.0.1:${t!.endpoint.port}/other`,
    ];
    expect((await rpc(url, initializeBody(1))).status).toBe(200);
    const bodies = new Set<string>();
    for (const u of cases) {
      const res = await rpc(u, initializeBody(1));
      expect(res.status, u.replace(/\.[^.]*$/, "")).toBe(404);
      bodies.add(res.text);
    }
    expect(bodies.size).toBe(1);
  });

  it("rejects a foreign Host or any Origin (403), non-POST (405), oversize bodies (413) and invalid JSON (400/-32700)", async () => {
    await setup();
    const { url } = await grantUrl();
    const body = JSON.stringify(initializeBody(1));
    expect((await raw(url, { headers: { host: `evil.example:${t!.endpoint.port}` }, body })).status).toBe(403);
    expect((await raw(url, { headers: { origin: "http://127.0.0.1" }, body })).status).toBe(403);
    expect((await raw(url, { headers: { host: `localhost:${t!.endpoint.port}` }, body })).status).toBe(200);
    const get = await raw(url, { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
    expect((await raw(url, { body: Buffer.alloc(1024 * 1024 + 1, 0x20) })).status).toBe(413);
    const bad = await raw(url, { body: "{ not json" });
    expect(bad.status).toBe(400);
    expect(Envelope.parse(JSON.parse(bad.text)).error?.code).toBe(-32700);
  });

  it("answers only requests in a batch and 202 for pure notifications", async () => {
    await setup();
    const { url } = await grantUrl();
    const batch = await rpc(url, [{ jsonrpc: "2.0", id: 7, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(batch.status).toBe(200);
    expect(batch.json).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
    expect((await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });
});

describe("project scope and root re-checks", () => {
  it("a grant for project A writes only A; B stays byte-identical and a projectId argument is rejected", async () => {
    await setup();
    const rootB = await t!.addProject("prj_b");
    const bBefore = await tree(join(rootB, ".decisions"));
    const { url } = await grantUrl();
    const c = await client(url);
    const out = await callTool(c, "roadmap_create_session", { expectedRevision: 1, title: "A only" });
    expect(out.isError).toBe(false);
    expect(RevisionValue.parse(out.value).revision).toBe(2);
    expect(await tree(join(rootB, ".decisions"))).toEqual(bBefore);
    const redirected = await callTool(c, "roadmap_create_session", { expectedRevision: 2, title: "to B", projectId: "prj_b" });
    expect(redirected.isError).toBe(true);
    expect(redirected.text).toContain("Invalid arguments");
    expect(await tree(join(rootB, ".decisions"))).toEqual(bBefore);
    expect((await openStore({ storeRoot: t!.project.root, projectId: "prj_test" }).version()).revision).toBe(2);
  });

  it("a .decisions replaced by a symlink after the grant gives unsafe_root", async () => {
    await setup();
    const { url } = await grantUrl();
    const root = t!.project.root;
    const moved = await realpath(await mkdtemp(join(tmpdir(), "dr-moved-")));
    cleanups.push(() => rm(moved, { recursive: true, force: true }));
    await rename(join(root, ".decisions"), join(moved, ".decisions"));
    await symlink(join(moved, ".decisions"), join(root, ".decisions"));
    const out = await callTool(await client(url), "roadmap_overview", {});
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/^unsafe_root/);
  });

  it("a registry that now maps the project elsewhere gives project_mismatch; one without it gives unknown_project", async () => {
    await setup();
    const { url } = await grantUrl();
    const c = await client(url);
    const other = await realpath(await mkdtemp(join(tmpdir(), "dr-other-")));
    cleanups.push(() => rm(other, { recursive: true, force: true }));
    t!.dir.registry.projects[0] = { ...t!.dir.registry.projects[0], projectRootPath: other };
    expect((await callTool(c, "roadmap_overview", {})).text).toMatch(/^project_mismatch/);
    t!.dir.registry.projects.splice(0, 1);
    const out = await callTool(c, "roadmap_overview", {});
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/^unknown_project/);
  });

  it("a manifest rewritten to another projectId gives project_mismatch", async () => {
    await setup();
    const { url } = await grantUrl();
    const manifestPath = join(t!.project.root, ".decisions", "manifest.json");
    const manifest = readJsonObject(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, projectId: "prj_other" }));
    const out = await callTool(await client(url), "roadmap_overview", {});
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/^project_mismatch/);
  });

  it("with an empty holder a tool call is not_ready with zero directory or store reads; turn_started hydrates it", async () => {
    await setup(false);
    const { url } = await grantUrl();
    const callsBefore = t!.dir.calls.length; // grantFor itself used the directory
    const c = await client(url);
    const cold = await callTool(c, "roadmap_overview", {});
    expect(cold.isError).toBe(true);
    expect(cold.text.startsWith("not_ready:")).toBe(true);
    expect(cold.text).toContain("retry");
    expect(t!.dir.calls.length).toBe(callsBefore);
    expect(t!.storeCalls.filter((x) => x.path.startsWith(t!.project.root))).toEqual([]);

    const hooks = fakeHookServer();
    const unregister = registerInjection(hooks.server, {
      endpoint: Promise.resolve(t!.endpoint), state: t!.state, holder: t!.holder,
      directory: () => t!.dir.directory, openStore, log: (m: string) => void t!.logs.push(m),
    });
    cleanups.push(async () => unregister());
    await hooks.emit("agent.turn_started", { agent: { id: "a1", workspaceId: null, parentAgentId: null, provider: "claude", cwd: t!.project.root, title: null }, turnId: "t1" }, t!.paseo);
    const warm = await callTool(c, "roadmap_overview", {});
    expect(warm.isError).toBe(false);
    expect(RevisionValue.parse(warm.value).revision).toBe(1);
    expect(t!.storeCalls.some((x) => x.path.startsWith(t!.project.root))).toBe(true);
  });

  it("session_open hydration also restores readiness and returns undefined", async () => {
    await setup(false);
    const { url } = await grantUrl();
    const c = await client(url);
    expect((await callTool(c, "roadmap_overview", {})).text.startsWith("not_ready:")).toBe(true);
    const hooks = fakeHookServer();
    const unregister = registerInjection(hooks.server, {
      endpoint: Promise.resolve(t!.endpoint), state: t!.state, holder: t!.holder,
      directory: () => t!.dir.directory, openStore, log: (m: string) => void t!.logs.push(m),
    });
    cleanups.push(async () => unregister());
    const returned = await hooks.runSessionOpen(
      { agentId: "a1", workspaceId: null, provider: "claude", cwd: t!.project.root, reason: "resume", purpose: "interactive", env: {} },
      t!.paseo,
    );
    expect(returned).toBeUndefined();
    expect((await callTool(c, "roadmap_overview", {})).isError).toBe(false);
  });
});

describe("persistence, port fallback and shutdown", () => {
  it("a restart on the same state keeps port and URL; the old URL still works", async () => {
    await setup();
    const { grant, url } = await grantUrl();
    const port = t!.endpoint.port;
    await t!.restart();
    expect(t!.endpoint.port).toBe(port);
    expect(t!.endpoint.urlFor(grant)).toBe(url);
    expect((await callTool(await client(url), "roadmap_overview", {})).isError).toBe(false);
  });

  it("an occupied persisted port moves the endpoint, marks old grants stale and logs one redacted line", async () => {
    await setup();
    const g1 = await grantUrl();
    const g2 = await grantUrl();
    const oldPort = t!.endpoint.port;
    await t!.endpoint.close();
    const blocker: Server = createServer();
    await new Promise<void>((resolve, reject) => blocker.once("error", reject).listen(oldPort, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise((resolve) => blocker.close(() => resolve(undefined))));
    const logStart = t!.logs.length;

    const moved = await t!.restart();
    expect(moved.port).not.toBe(oldPort);
    expect(readJsonObject(await readFile(join(t!.stateDir, "mcp.json"), "utf8")).port).toBe(moved.port);
    expect((await t!.state.getGrant(g1.grant.grantId))?.stale).toBe(true);
    expect((await t!.state.getGrant(g2.grant.grantId))?.stale).toBe(true);

    const lines = t!.logs.slice(logStart).filter((l) => l.includes("MCP port changed"));
    expect(lines).toHaveLength(1);
    const line = lines[0];
    for (const part of [String(oldPort), String(moved.port), "2", fingerprint(g1.grant.grantId), fingerprint(g2.grant.grantId), "recreate them"]) {
      expect(line).toContain(part);
    }
    const { secret } = await t!.state.loadOrCreateEndpoint();
    expect(line).not.toContain("/mcp/");
    expect(line).not.toContain(secret);
    expect(line).not.toContain(g1.url.split(".").pop()!);

    const oldPathOnNewPort = `http://127.0.0.1:${moved.port}${new URL(g1.url).pathname}`;
    expect((await rpc(oldPathOnNewPort, initializeBody(1))).status).toBe(404);
    const fresh = await grantUrl();
    expect(fresh.url).toContain(`:${moved.port}/`);
    expect((await rpc(fresh.url, initializeBody(1))).status).toBe(200);
  });

  it("close() is idempotent and refuses connections afterwards", async () => {
    await setup();
    const { url } = await grantUrl();
    await t!.endpoint.close();
    await expect(t!.endpoint.close()).resolves.toBeUndefined();
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

describe("redaction (runs last)", () => {
  it("no endpoint log contains a secret, signature, /mcp/ path, quote or answer text", async () => {
    expect(allLogs.length).toBeGreaterThan(0);
    expect(sensitive.length).toBeGreaterThan(0);
    for (const line of allLogs) {
      expect(line).not.toContain("/mcp/");
      for (const s of sensitive) expect(line).not.toContain(s);
    }
  });
});

// Stage R3.2 (task card 2026-10-29 R3 §3.2): a tool sees the bound agent of its grant. For a bound
// grant the context carries agentId and origin.actor.agentId; for an unbound grant neither is set.
// Authentication, HMAC, root and origin checks are unchanged (tests above).
describe("R3.2 bound agent in the tool context", () => {
  it("a bound grant's tool context carries agentId and origin.actor.agentId; an unbound grant's does not", async () => {
    const { z } = await import("zod");
    const { createHash } = await import("node:crypto");
    type RunContext = Parameters<McpTool<z.ZodType>["run"]>[1];
    const seen: Array<Omit<RunContext, "open"> & { open: undefined }> = [];
    const probe = {
      name: "roadmap_probe_context",
      description: "Synthetic probe that records its run context.",
      input: z.object({}).strict(),
      run: async (_a: unknown, ctx: RunContext) => {
        seen.push({ ...ctx, open: undefined });
        return { ok: true as const, value: {} };
      },
    };
    t = await startTestEndpoint({ extraTools: () => [probe] });
    t.ready();
    const unbound = await grantUrl();
    const bound = await grantUrl();
    const fp32 = createHash("sha256").update(bound.grant.grantId, "utf8").digest("hex").slice(0, 32);
    expect(typeof t.state.bindByFingerprint, "McpState.bindByFingerprint exists (R3.2)").toBe("function");
    await t.state.bindByFingerprint(fp32, { agentId: "agent-bound", workspaceId: "ws-1", at: "2026-10-29T10:00:00.000Z" });

    const c1 = await client(unbound.url);
    expect((await callTool(c1, "roadmap_probe_context", {})).isError).toBe(false);
    const c2 = await client(bound.url);
    expect((await callTool(c2, "roadmap_probe_context", {})).isError).toBe(false);
    expect(seen).toHaveLength(2);
    const [u, b] = seen;
    expect(u.agentId).toBeUndefined();
    // R3.4 (card §5.1): the bound grant's workspaceId is passed next to agentId; unbound grants pass neither.
    expect("workspaceId" in u).toBe(false);
    expect("agentId" in u.origin.actor ? u.origin.actor.agentId : undefined).toBeUndefined();
    expect(u.origin.source).toBe("chat");
    expect(b.agentId).toBe("agent-bound");
    expect(b.workspaceId).toBe("ws-1");
    expect(b.origin).toMatchObject({ source: "chat", actor: { kind: "agent", agentId: "agent-bound" } });
  });
});
