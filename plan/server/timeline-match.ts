// Pure matching of agent timeline tool calls to decision-question row references. A candidate is
// never authority: callers re-check it against the canonical store before appending a row.
// Items must parse with the installed 0.12.0 protocol timeline item schema; only tool calls with the
// generic `unknown` detail are read. Provider output envelopes follow
// `@getpaseo/server/dist/server/server/agent/providers/`.
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";

/** Row kind and schema version registered by the client renderer (`client/timeline-data.ts`). */
export const ROW_KIND = "decision-question";
export const ROW_VERSION = 1;

/** Run row kind and schema version (Stage R3.5), registered by `client/run-timeline-card.tsx`. */
export const RUN_ROW_KIND = "decision-run";
export const RUN_ROW_VERSION = 1;

const TOOLS = ["roadmap_ask", "roadmap_answer", "roadmap_confirm"] as const;
/** Run-scoped tools whose input names a run; `roadmap_start` and `roadmap_feature_bind` give no row. */
const RUN_TOOLS = ["roadmap_run_next", "roadmap_task_claim", "roadmap_task_progress", "roadmap_run_ack"] as const;

const NAMERS: Partial<Record<string, (tool: string) => string>> = {
  claude: (t) => `mcp__decision-roadmap__${t}`,
  codex: (t) => `decision-roadmap.${t}`,
};
/**
 * Extra exact names per provider beyond the roadmap server's: a Codex discussion chat may also ask
 * through its preapproval entry `decision-roadmap-discuss`, whose enabled tools include roadmap_ask
 * but no answer, confirm or run tool.
 */
const EXTRA_QUESTION_NAMES: Partial<Record<string, readonly string[]>> = { codex: ["decision-roadmap-discuss.roadmap_ask"] };
const namesFor = (tools: readonly string[], extra: Partial<Record<string, readonly string[]>> = {}) =>
  Object.fromEntries(Object.entries(NAMERS).map(([provider, name]) => [provider, new Set([...tools.map(name!), ...(extra[provider] ?? [])])])) as Partial<
    Record<string, ReadonlySet<string>>
  >;
const QUESTION_NAMES = namesFor(TOOLS, EXTRA_QUESTION_NAMES);
const RUN_NAMES = namesFor(RUN_TOOLS);

/** Exact server-bound names per provider. OpenCode and Pi are absent until their names are known (E6). */
export const TOOL_NAME_SET: Partial<Record<string, ReadonlySet<string>>> = namesFor([...TOOLS, ...RUN_TOOLS], EXTRA_QUESTION_NAMES);

export type CandidateRef = { sessionId: string; questionId: string };

export const rowIdFor = (r: CandidateRef) => `q.${r.sessionId}.${r.questionId}`;

export type RunCandidateRef = { runId: string };
export const runRowIdFor = (r: RunCandidateRef) => `run.${r.runId}`;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const parseJson = (text: unknown): unknown => {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const textOf = (block: unknown): unknown => (isObj(block) && block.type === "text" ? block.text : undefined);

/** The `roadmap_ask` result payload, from the bounded set of evidenced output forms only. */
function askPayload(provider: string, output: unknown): unknown {
  if (typeof output === "string") return parseJson(output);
  if (!isObj(output)) return undefined;
  if (output.type === "text") return parseJson(output.text);
  // Claude: buildToolOutput parses the MCP JSON and the detail keeps { output: payload }.
  if (provider === "claude" && "output" in output) return isObj(output.output) ? output.output : undefined;
  // Codex: mapMcpToolCallItem keeps the MCP result envelope { content: [text block] }.
  if (provider === "codex" && "content" in output) {
    if (output.isError === true || !Array.isArray(output.content) || output.content.length !== 1) return undefined;
    return parseJson(textOf(output.content[0]));
  }
  return undefined;
}

/** The name and generic detail of a completed, exactly named tool call; null for anything else. */
function completedCall(names: ReadonlySet<string> | undefined, raw: unknown): { name: string; detail: Obj & { input: Obj } } | null {
  if (!names) return null;
  const parsed = AgentTimelineItemPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item: unknown = parsed.data;
  if (!isObj(item) || item.type !== "tool_call" || item.status !== "completed") return null;
  if (typeof item.name !== "string" || !names.has(item.name)) return null;
  const detail = item.detail;
  if (!isObj(detail) || detail.type !== "unknown") return null;
  const input = detail.input;
  if (!isObj(input)) return null;
  return { name: item.name, detail: { ...detail, input } };
}

/** The run named by one completed, exactly named run-scoped tool call; `[]` for anything else. */
export function extractRunCandidates(provider: string, raw: unknown): RunCandidateRef[] {
  const call = completedCall(RUN_NAMES[provider], raw);
  if (!call) return [];
  const { runId } = call.detail.input;
  return isId(runId) ? [{ runId }] : [];
}

/** Candidate refs from one completed, exactly named tool call; `[]` for anything else. */
export function extractCandidates(provider: string, raw: unknown): CandidateRef[] {
  const call = completedCall(QUESTION_NAMES[provider], raw);
  if (!call) return [];
  const item = { name: call.name };
  const detail = call.detail;
  const { sessionId } = detail.input;
  if (!isId(sessionId)) return [];
  if (!item.name.endsWith("roadmap_ask")) {
    const { questionId } = detail.input;
    return isId(questionId) ? [{ sessionId, questionId }] : [];
  }
  const payload = askPayload(provider, detail.output);
  if (!isObj(payload) || !Array.isArray(payload.questionIds) || !payload.questionIds.every(isId)) return [];
  return payload.questionIds.map((questionId: string) => ({ sessionId, questionId }));
}

// ---- Decision references: roadmap links an agent's turn mentioned ----

/** Reference row kind and schema version, registered by `client/references-card.tsx`. */
export const REF_ROW_KIND = "decision-references";
export const REF_ROW_VERSION = 1;
export const MAX_REFERENCES = 20;
export const refRowIdFor = (turnId: string) => `refs.${turnId}`;

export type Reference = { link: string; sessionId: string; number: number; kind: "question" | "answer" };

const LINK_TOKEN = /roadmap:\/\/[A-Za-z0-9_/-]+/g;
// Structured tool output is searched for strings within these bounds only.
const MAX_DEPTH = 6;
const MAX_TEXT = 256 * 1024;

/** Strings inside a tool's output (a string, or strings nested in its structured result), bounded. */
function outputText(output: unknown): string {
  const parts: string[] = [];
  let size = 0;
  const walk = (v: unknown, depth: number) => {
    if (size >= MAX_TEXT || depth > MAX_DEPTH) return;
    if (typeof v === "string") {
      parts.push(v);
      size += v.length;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (isObj(v)) Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(output, 0);
  return parts.join("\n");
}

/** The text of an item that may carry references: assistant messages and completed tool results. */
function referenceText(item: unknown): string | null {
  if (!isObj(item)) return null;
  if (item.type === "assistant_message") return typeof item.text === "string" ? item.text : null;
  if (item.type === "tool_call" && item.status === "completed" && isObj(item.detail)) {
    const detail = item.detail;
    return "output" in detail ? outputText(detail.output) : null;
  }
  return null;
}

/**
 * This project's links to known sessions in assistant messages and completed tool results, in
 * first-seen order, deduplicated, at most MAX_REFERENCES. User messages and running tools are not
 * read. `parse` is the shared link parser, passed in to keep this module free of client code.
 */
export function extractReferences(
  projectId: string,
  items: readonly unknown[],
  knownSessions: ReadonlySet<string>,
  parse: (raw: string) => { projectId: string; sessionId: string; number: number; kind: "question" | "answer" } | null,
): Reference[] {
  const out: Reference[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const text = referenceText(item);
    if (text === null) continue;
    for (const raw of text.match(LINK_TOKEN) ?? []) {
      const link = parse(raw);
      if (link === null || link.projectId !== projectId || !knownSessions.has(link.sessionId) || seen.has(raw)) continue;
      seen.add(raw);
      out.push({ link: raw, sessionId: link.sessionId, number: link.number, kind: link.kind });
      if (out.length >= MAX_REFERENCES) return out;
    }
  }
  return out;
}
