// In-process MCP endpoint (Streamable HTTP, JSON responses only) on 127.0.0.1. The URL path
// carries a grant id and an HMAC over (grantId, projectId); every failure to authenticate gets
// the same 404. Logs carry ports, counts, fingerprints and error names only.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { z } from "zod";
import { errnoCode, isDomainError } from "../shared/errors";
import type { Result } from "../shared/rpc";
import { fingerprint, type Grant, type McpState } from "./mcp-state";
import { INSTRUCTIONS, type McpToolTable } from "./mcp-tools";
import type { StoreOpener, WriteOrigin } from "./sessions";
import { isRecord } from "../shared/canonical";

export interface McpEndpoint {
  port: number;
  urlFor(grant: Grant): string;
  close(): Promise<void>;
}
export type GrantResolver = (grant: Grant) => Promise<StoreOpener>;
export interface EndpointDeps {
  state: McpState;
  tools: McpToolTable;
  resolveGrant: GrantResolver;
  log: (m: string) => void;
  host?: "127.0.0.1";
}

export const NOT_READY_TEXT =
  "not_ready: decision roadmap is starting; retry this tool call in a few seconds (opening the roadmap panel also makes it ready)";

/** No PaseoApi has been captured yet; the call must not touch the registry or any store. */
export class NotReadyError extends Error {
  constructor() {
    super(NOT_READY_TEXT);
    this.name = "NotReadyError";
  }
}

const SERVER_VERSION = "0.0.0";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1024 * 1024;
const PATH_RE = /^\/mcp\/([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/;
const KEY_RE = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/;
const NOT_FOUND_BODY = JSON.stringify({ error: "not found" });
const CHAT_ORIGIN: WriteOrigin = { source: "chat", actor: { kind: "agent" } };
const CONFLICT_HINT = " Re-read with roadmap_overview or roadmap_get_session and retry with the current revision.";

export function signGrant(secret: string, grantId: string, projectId: string): string {
  return createHmac("sha256", secret).update(`v1\n${grantId}\n${projectId}`, "utf8").digest("base64url");
}

/** `key` is `<grantId>.<signature>`; returns the live grant only when the signature matches. */
export async function verifyGrantPath(
  secret: string,
  key: string,
  lookup: (id: string) => Promise<Grant | null>,
): Promise<Grant | null> {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const grant = await lookup(m[1]);
  if (!grant || grant.stale || grant.grantId !== m[1]) return null;
  const expected = Buffer.from(signGrant(secret, grant.grantId, grant.projectId), "utf8");
  const given = Buffer.from(m[2], "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given) ? grant : null;
}

// The request id is echoed exactly as received (any JSON value); it is not validated.
type Reply = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } };

const toolText = (text: string, isError: boolean) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export async function startMcpEndpoint(deps: EndpointDeps): Promise<McpEndpoint> {
  const { state, tools, resolveGrant, log } = deps;
  const host = deps.host ?? "127.0.0.1";
  const saved = await state.loadOrCreateEndpoint();
  const secret = saved.secret;
  const toolList = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }),
  }));
  const byName = new Map(tools.map((t) => [t.name, t]));
  let port = 0;
  let ready = false;

  async function callTool(grant: Grant, params: unknown) {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const t = typeof p.name === "string" ? byName.get(p.name) : undefined;
    if (!t) return toolText("invalid_input: unknown tool", true);
    const parsed = t.input.safeParse(p.arguments ?? {});
    if (!parsed.success) return toolText(`Invalid arguments: ${issuesText(parsed.error)}`, true);
    let open: StoreOpener;
    try {
      open = await resolveGrant(grant);
    } catch (e) {
      if (e instanceof NotReadyError) return toolText(NOT_READY_TEXT, true);
      if (isDomainError(e)) return toolText(`${e.code}: ${e.message}`, true);
      log(`tool ${t.name} failed: ${e instanceof Error ? e.name : "error"}`);
      return toolText("internal error", true);
    }
    let out: Result<unknown>;
    try {
      // A grant bound to its agent (Stage R3.2) names that agent; an unbound grant names none.
      if (grant.agentId !== undefined) {
        const origin: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: grant.agentId } };
        out = await t.run(parsed.data, { open, projectId: grant.projectId, agentId: grant.agentId, workspaceId: grant.workspaceId ?? null, origin });
      } else {
        out = await t.run(parsed.data, { open, projectId: grant.projectId, origin: CHAT_ORIGIN });
      }
    } catch (e) {
      log(`tool ${t.name} failed: ${e instanceof Error ? e.name : "error"}`);
      return toolText("internal error", true);
    }
    if (out.ok) return toolText(JSON.stringify(out.value), false);
    const hint = out.error.code === "revision_conflict" ? CONFLICT_HINT : "";
    return toolText(`${out.error.code}: ${out.error.message}${hint}`, true);
  }

  async function dispatch(grant: Grant, message: unknown): Promise<Reply | null> {
    const m = isRecord(message) ? message : null;
    const hasId = m !== null && typeof m === "object" && "id" in m;
    const id = (hasId ? m.id : null) ?? null;
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
    }
    if (!hasId) return null; // notification
    switch (m.method) {
      case "initialize": {
        const requested = isRecord(m.params) ? m.params.protocolVersion : undefined;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "paseo-decision-roadmap", version: SERVER_VERSION },
            instructions: INSTRUCTIONS,
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: toolList } };
      case "tools/call":
        return { jsonrpc: "2.0", id, result: await callTool(grant, m.params) };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
  }

  function send(res: ServerResponse, status: number, body?: string, headers: Record<string, string> = {}) {
    res.writeHead(status, { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers });
    res.end(body);
  }

  function readBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      req.on("data", (chunk: Buffer) => {
        if (over) return;
        size += chunk.length;
        if (size > MAX_BODY) {
          over = true;
          chunks.length = 0;
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!over) resolve(Buffer.concat(chunks));
      });
      req.on("error", reject);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Fail closed until startup has finished invalidating old grants and persisting the port.
    if (!ready) return send(res, 503, JSON.stringify({ error: "starting" }), { "retry-after": "1" });
    const hostHeader = req.headers.host;
    if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) return send(res, 403, JSON.stringify({ error: "forbidden" }));
    if (req.headers.origin !== undefined) return send(res, 403, JSON.stringify({ error: "forbidden" }));

    const path = (req.url ?? "").split("?")[0];
    const m = PATH_RE.exec(path);
    const grant = m ? await verifyGrantPath(secret, `${m[1]}.${m[2]}`, (gid) => state.getGrant(gid)) : null;
    if (!grant) return send(res, 404, NOT_FOUND_BODY);

    if (req.method !== "POST") return send(res, 405, JSON.stringify({ error: "method not allowed" }), { allow: "POST" });
    const body = await readBody(req);
    if (body === null) return send(res, 413, JSON.stringify({ error: "payload too large" }), { connection: "close" });
    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      return send(res, 400, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    }
    if (Array.isArray(message)) {
      if (message.length === 0) {
        return send(res, 400, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }));
      }
      const replies = (await Promise.all(message.map((x) => dispatch(grant, x)))).filter((r): r is Reply => r !== null);
      return replies.length === 0 ? send(res, 202) : send(res, 200, JSON.stringify(replies));
    }
    const reply = await dispatch(grant, message);
    return reply === null ? send(res, 202) : send(res, 200, JSON.stringify(reply));
  }

  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`request failed: ${e instanceof Error ? e.name : "error"}`);
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: "internal error" }));
      else res.destroy();
    });
  });
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  const listen = (p: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (e: Error) => {
        server.off("listening", onListening);
        reject(e);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : p);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(p, host);
    });

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      for (const s of sockets) s.destroy();
    });
    return closing;
  };

  // Order on fallback: invalidate the old port's grants, then publish the new port, then admit
  // requests. Any failure after a successful listen closes the listener and rethrows.
  let stage = "listen";
  try {
    if (saved.port === 0) {
      port = await listen(0);
      stage = "persist port";
      await state.saveEndpoint({ ...saved, port });
    } else {
      try {
        port = await listen(saved.port);
      } catch (e) {
        if (errnoCode(e) !== "EADDRINUSE") throw e;
        port = await listen(0);
        stage = "invalidate old grants";
        const stale = await state.markStale(saved.port);
        stage = "persist port";
        await state.saveEndpoint({ ...saved, port });
        log(
          `MCP port changed ${saved.port}→${port}; ${stale.length} grants stale (fp: ${stale.map((g) => fingerprint(g.grantId)).join(",")}); ` +
            "agents created before this change lose roadmap tools; recreate them",
        );
      }
    }
  } catch (e) {
    log(`MCP endpoint startup failed at ${stage}: ${e instanceof Error ? e.name : "error"}`);
    await close();
    throw e;
  }
  ready = true;

  return {
    get port() {
      return port;
    },
    urlFor: (grant) => `http://127.0.0.1:${port}/mcp/${grant.grantId}.${signGrant(secret, grant.grantId, grant.projectId)}`,
    close,
  };
}
