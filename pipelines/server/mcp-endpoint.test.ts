import { createServer, request } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFs } from "./fs-port";
import type { Grant } from "./grants";
import { DEFAULT_MAX_BODY_BYTES, startMcpEndpoint, type McpEndpoint } from "./mcp-endpoint";
import { MAX_SUMMARY_CHARS, MAX_WORKFLOW_CHARS } from "../shared/rpc";
import type { ToolDeps } from "./mcp-tools";

let dir = "";
let endpoint: McpEndpoint | null = null;
const seen: Array<{ grant: string; tool: string }> = [];

const tools: ToolDeps = {
  runs: {
    read: () => Promise.reject(new Error("unused")),
    act: () => Promise.reject(new Error("unused")),
    bindFromGrant: () => Promise.resolve(),
    holdReview: () => Promise.resolve({ ok: true, events: [] }),
  },
  workflows: {
    get: (projectId) => {
      seen.push({ grant: projectId, tool: "get" });
      return Promise.resolve({ saved: { yaml: "jobs: {}\n", digest: "a".repeat(64) }, draft: null, editableDigest: "a".repeat(64), diagnostics: [], model: null, graph: null, savedPlan: null, proposals: [] });
    },
    addProposal: () => Promise.reject(new Error("unused")),
  },
};

const chat: Grant = { kind: "workflow", projectId: "proj", agentId: "agent-1" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fp-mcp-"));
  endpoint = await startMcpEndpoint({ stateDir: dir, fs: createNodeFs(), tools, log: () => undefined, maxBodyBytes: 4_096 });
});

afterEach(async () => {
  await endpoint?.close();
  endpoint = null;
  seen.length = 0;
  await rm(dir, { recursive: true, force: true });
});

function raw(path: string, x: { method?: string; host?: string; origin?: string; body?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: endpoint?.port,
        path,
        method: x.method ?? "POST",
        headers: {
          host: x.host ?? `127.0.0.1:${endpoint?.port ?? 0}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(x.origin ? { origin: x.origin } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(x.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  });
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe("MCP endpoint", () => {
  it("serves the tools to a client with a valid grant", async () => {
    const client = await connect(endpoint?.urlFor(chat) ?? "");
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["pipeline_job_complete", "pipeline_job_context", "pipeline_review_submit", "pipeline_workflow_get", "pipeline_workflow_propose"]);
    const result = await client.callTool({ name: "pipeline_workflow_get", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("jobs: {}");
    const refused = await client.callTool({ name: "pipeline_job_context", arguments: {} });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("role_forbidden");
    await client.close();
  });

  it("refuses a wrong signature, a foreign Host, an Origin header, an oversized body and a GET with the same 404", async () => {
    const url = new URL(endpoint?.urlFor(chat) ?? "");
    const good = url.pathname;
    const [payload] = good.slice("/mcp/".length).split(".");
    expect(await raw(`/mcp/${payload ?? ""}.AAAA`, {})).toBe(404);
    expect(await raw(good, { host: `evil.example:${endpoint?.port ?? 0}` })).toBe(404);
    expect(await raw(good, { origin: "http://127.0.0.1" })).toBe(404);
    expect(await raw(good, { body: JSON.stringify({ pad: "x".repeat(5_000) }) })).toBe(404);
    expect(await raw("/other", {})).toBe(404);
    expect(await raw(good, { method: "GET" })).toBe(404);
    expect(seen).toEqual([]);
  });

  it("keeps its port and secret owner-only in endpoint.json and reuses them after a restart", async () => {
    const file = join(dir, "endpoint.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved: unknown = JSON.parse(await readFile(file, "utf8"));
    expect(saved).toMatchObject({ port: endpoint?.port });
    const url = endpoint?.urlFor(chat) ?? "";
    const port = endpoint?.port;
    await endpoint?.close();
    endpoint = await startMcpEndpoint({ stateDir: dir, fs: createNodeFs(), tools, log: () => undefined });
    expect(endpoint.port).toBe(port);
    const client = await connect(url);
    expect((await client.listTools()).tools).toHaveLength(5);
    await client.close();
  });

  it("waits for its saved port to be released instead of moving the URLs of running agents", async () => {
    const port = endpoint?.port ?? 0;
    await endpoint?.close();
    const holder = await hold(port);
    let pauses = 0;
    const retryPause = async (): Promise<void> => {
      pauses += 1;
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    };
    endpoint = await startMcpEndpoint({ stateDir: dir, fs: createNodeFs(), tools, log: () => undefined, savedPortWaitMs: 60_000, retryPause });
    expect(pauses).toBe(1);
    expect(endpoint.port).toBe(port);
  });

  it("closes its listener when endpoint.json cannot be written", async () => {
    const port = endpoint?.port ?? 0;
    await endpoint?.close();
    endpoint = null;
    const fs = createNodeFs();
    const failing = { ...fs, replaceFile: () => Promise.reject(new Error("disk full")) };
    await expect(startMcpEndpoint({ stateDir: dir, fs: failing, tools, log: () => undefined })).rejects.toThrow("disk full");
    const holder = await hold(port);
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  });
});

function hold(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

describe("MCP body limit", () => {
  it("fits the largest workflow proposal the tool schema accepts", () => {
    for (const unit of ["a", "\u0001", "\"", "\ud800", "é", "€"]) expect(Buffer.byteLength(JSON.stringify(unit)) - 2).toBeLessThanOrEqual(6);
    expect(Buffer.byteLength(JSON.stringify("😀")) - 2).toBeLessThanOrEqual(12);
    const envelope = { jsonrpc: "2.0", id: 2_147_483_647, method: "tools/call", params: { name: "pipeline_workflow_propose", arguments: { baseToken: "f".repeat(64), yaml: "", summary: "" } } };
    expect(Buffer.byteLength(JSON.stringify(envelope)) + 6 * (MAX_WORKFLOW_CHARS + MAX_SUMMARY_CHARS)).toBeLessThanOrEqual(DEFAULT_MAX_BODY_BYTES);
  });
});
