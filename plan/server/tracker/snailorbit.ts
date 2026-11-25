// SnailOrbit live adapter (O1/O3): a plugin-owned MCP client on the configured connection. Every
// unconfirmed outcome after a write call has started is ambiguous; only failures before any write
// (connect, tool listing, contract) are definitive. Errors carry codes only, never the URL.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { TrackerError, type RemoteIssue, type TrackerAdapter, type WirePayload } from "./adapter";
import type { ConnectionSnapshot } from "./connection";

/** A fetched issue with its project identity, for read-only verification of a ticket. */
export type FetchedIssue = RemoteIssue & { project: { id: string; slug: string } };

export interface TrackerSession {
  send(kind: "create" | "close", wire: WirePayload, signal: AbortSignal): Promise<RemoteIssue>;
  get(remoteKey: string, signal: AbortSignal): Promise<FetchedIssue | null>;
  /** Idempotent; closes the client and its transport. */
  close(): Promise<void>;
}

export type CloseConfig = { field: string; value: string };

/** The exact SnailOrbit request arguments, in every mode. */
export function renderSnailOrbit(kind: "create" | "close", neutral: unknown, destination: { projectKey: string }, close?: CloseConfig): WirePayload {
  if (kind === "create") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- produced only by createPayload (sync.ts) for kind "create"
    const n = neutral as { title: string; body: string };
    return { project_id: destination.projectKey, subject: n.title, text: n.body };
  }
  if (!close) throw new TrackerError("definitive", "close_not_configured");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- produced only as { remoteKey } (sync.ts) for kind "close"
  return { issue_id: (neutral as { remoteKey: string }).remoteKey, fields: { [close.field]: close.value } };
}

const IssueResponse = z
  .object({
    id: z.string().min(1),
    id_readable: z.string().min(1),
    is_closed: z.boolean(),
    project: z.object({ id: z.string(), slug: z.string() }).passthrough(),
  })
  .passthrough();
type Issue = z.infer<typeof IssueResponse>;

const REQUIRED_TOOLS: Record<string, string[]> = {
  create_issue: ["project_id", "subject"],
  update_issue: ["issue_id"],
  get_issue: ["issue_id"],
};

type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };

function parseIssue(result: ToolResult): Issue | null {
  let raw: unknown = result.structuredContent;
  if (raw === undefined) {
    const text = result.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") return null;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const parsed = IssueResponse.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const toRemote = (issue: Issue): RemoteIssue => ({ remoteId: issue.id, remoteKey: issue.id_readable, url: "", closed: issue.is_closed });

export function createSnailOrbitAdapter(deps: {
  /** Budget for each send/get call. */
  timeoutMs?: number;
  /** Separate budget for connecting and listing tools (no write happens there). */
  connectTimeoutMs?: number;
  clientInfo?: { name: string; version: string };
}): TrackerAdapter {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const connectTimeoutMs = deps.connectTimeoutMs ?? 15_000;
  const clientInfo = deps.clientInfo ?? { name: "paseo-decision-roadmap", version: "0.0.0" };

  /** Runs `call` under the caller's signal combined with the timeout; aborting cancels the request. */
  async function guarded<T>(signal: AbortSignal, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await call(ac.signal);
    } catch (e) {
      if (e instanceof TrackerError) throw e;
      throw new TrackerError("ambiguous", ac.signal.aborted ? "timeout" : "transport_error");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    provider: "snailorbit",
    render: (action) => renderSnailOrbit(action.kind, action.neutral, action.destination, action.settings.closeByProject?.[action.destination.projectKey]),

    async connect(snapshot: ConnectionSnapshot, signal: AbortSignal): Promise<TrackerSession> {
      const client = new Client(clientInfo);
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await client.close().catch(() => undefined);
      };
      try {
        await client.connect(new StreamableHTTPClientTransport(snapshot.urlForTransport()), { signal, timeout: connectTimeoutMs });
        const { tools } = await client.listTools({}, { signal, timeout: connectTimeoutMs });
        for (const [name, required] of Object.entries(REQUIRED_TOOLS)) {
          const tool = tools.find((t) => t.name === name);
          const props = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
          if (!tool || required.some((k) => !(k in props))) throw new TrackerError("definitive", "contract_mismatch");
        }
      } catch (e) {
        await close();
        if (e instanceof TrackerError) throw e;
        throw new TrackerError("definitive", "connect_failed");
      }

      const call = (name: string, args: WirePayload, sig: AbortSignal) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- MCP SDK callTool result typing; the caller validates the tool result shape
        client.callTool({ name, arguments: args }, undefined, { signal: sig, timeout: timeoutMs }) as Promise<ToolResult>;

      return {
        send: (kind, wire, outer) =>
          guarded(outer, async (sig) => {
            const result = await call(kind === "create" ? "create_issue" : "update_issue", wire, sig);
            if (result.isError) throw new TrackerError("ambiguous", "tool_error");
            const issue = parseIssue(result);
            if (!issue) throw new TrackerError("ambiguous", "unparsed_response");
            if (kind === "create") {
              const project = String(wire.project_id);
              if (issue.project.id !== project && issue.project.slug !== project) throw new TrackerError("ambiguous", "project_mismatch");
            } else {
              const target = String(wire.issue_id);
              if (issue.id !== target && issue.id_readable !== target) throw new TrackerError("ambiguous", "issue_mismatch");
              if (!issue.is_closed) throw new TrackerError("ambiguous", "close_unconfirmed");
            }
            return toRemote(issue);
          }),
        get: (remoteKey, outer) =>
          guarded(outer, async (sig) => {
            const result = await call("get_issue", { issue_id: remoteKey }, sig);
            if (result.isError) throw new TrackerError("ambiguous", "tool_error");
            const issue = parseIssue(result);
            if (!issue) throw new TrackerError("ambiguous", "unparsed_response");
            const fetched: FetchedIssue = { ...toRemote(issue), project: { id: issue.project.id, slug: issue.project.slug } };
            return fetched;
          }),
        close,
      };
    },
  };
}
