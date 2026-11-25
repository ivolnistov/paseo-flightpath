import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MAX_SUMMARY_CHARS, MAX_WORKFLOW_CHARS } from "../shared/rpc";
import type { PipelineFs } from "./fs-port";
import { reservationId, signGrant, verifyGrant, type Grant } from "./grants";
import { callTool, TOOL_DESCRIPTIONS, TOOL_INPUTS, TOOL_NAMES, type ToolDeps } from "./mcp-tools";

export const ENDPOINT_HOST = "127.0.0.1";
/**
 * Fits the largest `pipeline_workflow_propose` request the tool schema accepts: JSON escapes a
 * character to at most six bytes (`\uXXXX`), plus room for the JSON-RPC envelope.
 */
export const DEFAULT_MAX_BODY_BYTES = 6 * (MAX_WORKFLOW_CHARS + MAX_SUMMARY_CHARS) + 64 * 1024;
export const MCP_SERVER_NAME = "flightpath-pipeline";
const DEFAULT_SAVED_PORT_WAIT_MS = 3_000;
const SAVED_PORT_RETRY_MS = 100;

const EndpointFileSchema = z.object({ port: z.number().int().min(1).max(65_535), secret: z.string().min(32).max(256) }).strict();

export type McpEndpoint = {
  port: number;
  /** The tool URL an agent with this grant uses. */
  urlFor(grant: Grant): string;
  reservation(subject: string): string;
  close(): Promise<void>;
};

export type McpEndpointOptions = {
  stateDir: string;
  fs: PipelineFs;
  tools: ToolDeps;
  log: (message: string) => void;
  maxBodyBytes?: number;
  /** How long a saved port held by another process is retried before moving to a new port. */
  savedPortWaitMs?: number;
  /** Pause between attempts on a saved port that is in use; defaults to a short timer. */
  retryPause?: () => Promise<void>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > limit) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners("data");
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(size > limit ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function register(server: McpServer, deps: ToolDeps, grant: Grant): void {
  for (const name of TOOL_NAMES) {
    server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: TOOL_INPUTS[name] }, async (input: unknown) => {
      const result = await callTool(deps, grant, name, input);
      const body = result.ok ? result.value : { error: { code: result.code, message: result.message, ...(result.details === undefined ? {} : { details: result.details }) } };
      return { content: [{ type: "text" as const, text: JSON.stringify(body) }], ...(result.ok ? {} : { isError: true }) };
    });
  }
}

async function loadEndpointFile(fs: PipelineFs, path: string): Promise<z.output<typeof EndpointFileSchema> | null> {
  const bytes = await fs.readFile(path);
  if (bytes === null) return null;
  try {
    const parsed = EndpointFileSchema.safeParse(JSON.parse(decoder.decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function defaultRetryPause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SAVED_PORT_RETRY_MS));
}

async function listenSaved(server: Server, savedPort: number, waitMs: number, pause: () => Promise<void>, log: (message: string) => void): Promise<number> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await listen(server, savedPort);
    } catch (error) {
      const inUse = error instanceof Error && "code" in error && error.code === "EADDRINUSE";
      if (!inUse || Date.now() >= deadline) {
        log(`mcp endpoint port ${savedPort} is unavailable; moving to a new port, so MCP URLs given to running agents stop working`);
        return listen(server, 0);
      }
      await pause();
    }
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, ENDPOINT_HOST);
  });
}

/**
 * The loopback MCP endpoint. A request needs a signed grant in its path, a loopback Host header,
 * no Origin header and a POST body under the limit; every refusal is the same 404. The secret
 * and port persist in `endpoint.json` so the URLs given to running agents survive a restart. A
 * saved port still held by another process is retried briefly; if it stays taken, the endpoint
 * moves to a new port and URLs issued earlier stop working, which is logged.
 */
export async function startMcpEndpoint(opts: McpEndpointOptions): Promise<McpEndpoint> {
  const limit = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const file = join(opts.stateDir, "endpoint.json");
  await opts.fs.ensureDir(opts.stateDir);
  const saved = await loadEndpointFile(opts.fs, file);
  const secret = saved?.secret ?? randomBytes(32).toString("base64url");
  let port = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const match = /^\/mcp\/([A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,128})$/.exec(req.url ?? "");
      const host = req.headers.host;
      if (!match?.[1] || req.headers.origin !== undefined || (host !== `${ENDPOINT_HOST}:${port}` && host !== `localhost:${port}`)) return notFound(res);
      const grant = verifyGrant(secret, match[1]);
      if (grant === null) return notFound(res);
      if (req.method !== "POST") return notFound(res);
      const body = await readBody(req, limit);
      if (body === null) return notFound(res);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return notFound(res);
      }
      const mcp = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
      register(mcp, opts.tools, grant);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    })().catch((error: unknown) => {
      opts.log(`mcp request failed: ${error instanceof Error ? error.message : "unknown error"}`);
      if (!res.headersSent) notFound(res);
      else res.end();
    });
  });

  port = saved === null ? await listen(server, 0) : await listenSaved(server, saved.port, opts.savedPortWaitMs ?? DEFAULT_SAVED_PORT_WAIT_MS, opts.retryPause ?? defaultRetryPause, opts.log);
  try {
    await opts.fs.replaceFile(file, encoder.encode(`${JSON.stringify({ port, secret })}\n`));
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  return {
    port,
    urlFor: (grant) => `http://${ENDPOINT_HOST}:${port}/mcp/${signGrant(secret, grant)}`,
    reservation: (subject) => reservationId(secret, subject),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
