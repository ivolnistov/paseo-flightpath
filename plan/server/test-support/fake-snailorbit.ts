// Loopback fake SnailOrbit MCP server: official SDK 1.32.1 McpServer + streamable HTTP server
// transport on 127.0.0.1:0, exposing create_issue/update_issue/get_issue and recording every call.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export type FakeReply =
  | { kind: "issue"; issue: Record<string, unknown> }
  | { kind: "isError"; text: string }
  | { kind: "text"; text: string }
  | { kind: "hang" }
  | { kind: "destroy" };

/** The catalog example shape, with fields the adapter must ignore. */
export const richIssue = (n: number, closed = false): Record<string, unknown> => ({
  id: `3-${n}`,
  id_readable: `SYN-${n}`,
  is_closed: closed,
  summary: `Synthetic ${n}`,
  project: { id: "0-1", slug: "SYN", name: "Synthetic", is_encrypted: false, aliases: ["S"] },
  fields: [{ name: "State", value: closed ? "Done" : "Open" }],
  created_by: { login: "synthetic" },
  interlinks: [],
  tags: [],
  attachments: [],
  external_links: [],
});

export async function startFakeSnailOrbit(opts: { tools?: Array<"create_issue" | "update_issue" | "get_issue">; replies?: Partial<Record<string, FakeReply[]>>; initializeDelayMs?: number } = {}) {
  const tools = opts.tools ?? ["create_issue", "update_issue", "get_issue"];
  const calls: Array<{ tool: string; args: unknown }> = [];
  const aborted: string[] = [];
  const replies = opts.replies ?? {};
  let n = 0;

  const build = () => {
    const server = new McpServer({ name: "fake-snailorbit", version: "0" });
    const handler = (tool: string, closeDefault: boolean) => async (args: unknown, extra: { signal: AbortSignal }) => {
      calls.push({ tool, args });
      // get_issue answers for the issue actually requested unless a reply is scripted.
      const scripted = replies[tool]?.shift();
      const r: FakeReply =
        scripted ??
        (tool === "get_issue"
          ? { kind: "issue", issue: { ...richIssue(++n, closeDefault), id_readable: String(typeof args === "object" && args !== null && "issue_id" in args ? args.issue_id : undefined) } }
          : { kind: "issue", issue: richIssue(++n, closeDefault) });
      if (r.kind === "hang") {
        await new Promise<void>((resolve) => extra.signal.addEventListener("abort", () => (aborted.push(tool), resolve()), { once: true }));
        return { content: [{ type: "text" as const, text: "{}" }] };
      }
      if (r.kind === "destroy") {
        for (const s of sockets) s.destroy();
        return { content: [{ type: "text" as const, text: "{}" }] };
      }
      if (r.kind === "isError") return { isError: true, content: [{ type: "text" as const, text: r.text }] };
      if (r.kind === "text") return { content: [{ type: "text" as const, text: r.text }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(r.issue) }] };
    };
    if (tools.includes("create_issue"))
      server.registerTool("create_issue", { inputSchema: { project_id: z.string(), subject: z.string(), text: z.string().optional() } }, handler("create_issue", false));
    if (tools.includes("update_issue"))
      server.registerTool("update_issue", { inputSchema: { issue_id: z.string(), fields: z.record(z.string(), z.unknown()).optional() } }, handler("update_issue", true));
    if (tools.includes("get_issue")) server.registerTool("get_issue", { inputSchema: { issue_id: z.string() } }, handler("get_issue", false));
    return server;
  };

  const sockets = new Set<import("node:net").Socket>();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    // Without setEncoding the request yields Buffers.
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    // Optional slow handshake: delays only the initialize request (bounded real timer).
    if (opts.initializeDelayMs && typeof body === "object" && body !== null && "method" in body && body.method === "initialize") {
      await new Promise((resolve) => setTimeout(resolve, opts.initializeDelayMs));
    }
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
  // The handler promise is not awaited by node:http, exactly as before (no added catch or response).
  const http: Server = createServer((req, res) => void handle(req, res));
  http.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("fake SnailOrbit is not listening on a TCP port");
  const port = address.port;
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp/synthetic-secret-path`),
    calls,
    aborted,
    writes: () => calls.filter((c) => c.tool !== "get_issue"),
    async stop() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
export type FakeSnailOrbit = Awaited<ReturnType<typeof startFakeSnailOrbit>>;
