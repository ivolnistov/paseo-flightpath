// Host-event-scoped observer that adds decision-question rows (Stage 5 P5.3/P5.4) and run reference
// rows (Stage R3.5) to agent timelines.
// Host subscribe/append are not ownership-scoped, so this module scopes itself: it only observes
// and appends to agent ids delivered by host lifecycle events, after re-resolving the agent's cwd
// to an opted-in project. Rows are references; the renderer reads the current state from the store.
import type { PaseoApi } from "@getpaseo/client";
import { AgentStreamMessageSchema } from "@getpaseo/protocol/messages";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RoadmapData } from "../shared/model";
import { fingerprint } from "./mcp-state";
import type { createPaseoHolder } from "./paseo-holder";
import type { openStore as OpenStore } from "./store";
import { projectForCwd, resolveProject, type ProjectDirectory } from "./store-root";
import { parseLink } from "../shared/links";
import {
  extractCandidates,
  extractReferences,
  extractRunCandidates,
  refRowIdFor,
  REF_ROW_KIND,
  REF_ROW_VERSION,
  ROW_KIND,
  ROW_VERSION,
  rowIdFor,
  RUN_ROW_KIND,
  RUN_ROW_VERSION,
  runRowIdFor,
  TOOL_NAME_SET,
  type CandidateRef,
} from "./timeline-match";

export interface TimelineObserverDeps {
  directory: (p: PaseoApi) => ProjectDirectory;
  openStore: typeof OpenStore;
  holder: ReturnType<typeof createPaseoHolder>;
  log: (m: string) => void;
  maxSubscriptions?: number;
}

type HostAgent = { id: string; provider: string; cwd: string };
type Subscription = ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["subscribe"]>;
/** A live or still-establishing observation; `sub` is null until subscribe returns. */
type Entry = { agent: HostAgent; sub: Subscription | null };

type Obj = Record<string, unknown>;
const StreamPayload = AgentStreamMessageSchema.shape.payload;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const hostAgent = (a: unknown): HostAgent | null =>
  isObj(a) && typeof a.id === "string" && a.id !== "" && typeof a.provider === "string" && typeof a.cwd === "string"
    ? { id: a.id, provider: a.provider, cwd: a.cwd }
    : null;

const hasQuestion = (data: RoadmapData, r: CandidateRef) =>
  data.sessions.some((s) => s.id === r.sessionId && s.questions.some((q) => q.id === r.questionId));

export function registerTimelineObserver(
  server: Pick<PluginServerContext, "on">,
  deps: TimelineObserverDeps,
): () => Promise<void> {
  const { directory, openStore, holder, log } = deps;
  const max = deps.maxSubscriptions ?? 32;
  const live = new Map<string, Entry>();
  /** `agentId/rowId` already appended in this process; replays would only fold in place anyway. */
  const appended = new Set<string>();
  /** The references last appended per `agentId/rowId`: an identical rescan appends nothing. */
  const referenced = new Map<string, string>();
  const fp = (agentId: string) => fingerprint(agentId);

  /** Fresh opt-in check: cwd -> registered project -> safe root -> store ok and not disabled. */
  async function optedIn(paseo: PaseoApi, cwd: string): Promise<{ projectId: string; data: RoadmapData } | null> {
    try {
      const dir = directory(paseo);
      const projectId = await projectForCwd(dir, cwd);
      if (projectId === null) return null;
      const { storeRoot } = await resolveProject(dir, projectId);
      const read = await openStore({ storeRoot, projectId }).read();
      return read.status === "ok" && !read.disabled ? { projectId, data: read.data } : null;
    } catch {
      return null;
    }
  }

  /**
   * Appends rows for candidate refs that exist in the canonical store. Never retried here; a failed
   * append is forgotten so a later scan can add it. Rows are references only (Stage R3.5 run rows
   * carry `{ projectId, runId }`, never tokens, prompts, evidence or output).
   */
  async function scan(paseo: PaseoApi, agent: HostAgent, items: readonly unknown[]): Promise<void> {
    const candidates = items.flatMap((item) => extractCandidates(agent.provider, item));
    const runCandidates = items.flatMap((item) => extractRunCandidates(agent.provider, item));
    if (candidates.length === 0 && runCandidates.length === 0) return;
    const project = await optedIn(paseo, agent.cwd);
    if (project === null) return;
    const rows = [
      ...candidates.flatMap((ref) =>
        hasQuestion(project.data, ref)
          ? [{ id: rowIdFor(ref), kind: ROW_KIND, version: ROW_VERSION, data: { projectId: project.projectId, sessionId: ref.sessionId, questionId: ref.questionId } }]
          : [],
      ),
      ...runCandidates.flatMap((ref) =>
        project.data.runs.some((r) => r.id === ref.runId)
          ? [{ id: runRowIdFor(ref), kind: RUN_ROW_KIND, version: RUN_ROW_VERSION, data: { projectId: project.projectId, runId: ref.runId } }]
          : [],
      ),
    ];
    for (const row of rows) {
      const key = `${agent.id}/${row.id}`;
      if (appended.has(key)) continue;
      appended.add(key);
      try {
        await paseo.agents.ref(agent.id).timeline.append({ type: "plugin", ...row });
      } catch (e) {
        appended.delete(key);
        log(`timeline row append failed agent=${fp(agent.id)} ${e instanceof Error ? e.name : "error"}`);
      }
    }
  }

  /**
   * One decision-references row per turn, on this agent's own timeline: this project's links to known
   * sessions from the turn's assistant messages and completed tool results. The row id is the turn's,
   * so a rescan replaces the row in place. A turn without an id gets no row.
   */
  async function scanReferences(paseo: PaseoApi, agent: HostAgent, turnId: string | null, items: readonly unknown[]): Promise<void> {
    if (turnId === null || turnId === "") return;
    if (!items.some((item) => isObj(item) && (item.type === "assistant_message" || item.type === "tool_call"))) return;
    const project = await optedIn(paseo, agent.cwd);
    if (project === null) return;
    const refs = extractReferences(project.projectId, items, new Set(project.data.sessions.map((s) => s.id)), parseLink);
    if (refs.length === 0) return;
    const id = refRowIdFor(turnId);
    const key = `${agent.id}/${id}`;
    const value = JSON.stringify(refs);
    if (referenced.get(key) === value) return;
    referenced.set(key, value);
    try {
      await paseo.agents.ref(agent.id).timeline.append({
        type: "plugin",
        id,
        kind: REF_ROW_KIND,
        version: REF_ROW_VERSION,
        data: { projectId: project.projectId, turnId, refs },
      });
    } catch (e) {
      referenced.delete(key);
      log(`timeline reference row append failed agent=${fp(agent.id)} ${e instanceof Error ? e.name : "error"}`);
    }
  }

  async function refetchScan(paseo: PaseoApi, agent: HostAgent): Promise<void> {
    try {
      const page = await paseo.agents.ref(agent.id).timeline.refetch();
      await scan(paseo, agent, page.entries.map((e) => e.item));
    } catch (e) {
      log(`timeline refetch failed agent=${fp(agent.id)} ${e instanceof Error ? e.name : "error"}`);
    }
  }

  async function release(agentId: string): Promise<void> {
    const entry = live.get(agentId);
    if (!entry) return;
    live.delete(agentId);
    if (entry.sub) await entry.sub.release().catch(() => undefined);
  }

  function onEvent(paseo: PaseoApi, entry: Entry, message: unknown): void {
    if (live.get(entry.agent.id) !== entry || !isObj(message) || message.agentId !== entry.agent.id || !isObj(message.event)) return;
    // Client-synthesized controls first; everything else must be a valid agent_stream payload.
    const control = message.event.type;
    if (control === "subscription_restored" || control === "replacement") void refetchScan(paseo, entry.agent);
    else if (control === "error") {
      // The host releases an errored observation; forget it so the next turn subscribes again, and
      // release the local handle too (a no-op for an already released observation).
      live.delete(entry.agent.id);
      void entry.sub?.release().catch(() => undefined);
      log(`timeline subscription error agent=${fp(entry.agent.id)}`);
    } else {
      const parsed = StreamPayload.safeParse(message);
      if (parsed.success && parsed.data.agentId === entry.agent.id && parsed.data.event.type === "timeline") {
        void scan(paseo, entry.agent, [parsed.data.event.item]);
      }
    }
  }

  const offStarted = server.on("agent.turn_started", async (event, ctx) => {
    holder.set(ctx.paseo);
    const agent = hostAgent(event.agent);
    if (agent === null || TOOL_NAME_SET[agent.provider] === undefined || live.has(agent.id)) return;
    if (live.size >= max) {
      log(`timeline subscription cap reached (${max}); agent=${fp(agent.id)} relies on turn end`);
      return;
    }
    const entry: Entry = { agent, sub: null };
    live.set(agent.id, entry); // reserved before any await, so the cap holds
    if ((await optedIn(ctx.paseo, agent.cwd)) === null || live.get(agent.id) !== entry) {
      if (live.get(agent.id) === entry) live.delete(agent.id);
      return;
    }
    try {
      entry.sub = ctx.paseo.agents.ref(agent.id).timeline.subscribe((m) => onEvent(ctx.paseo, entry, m));
      await entry.sub.ready;
    } catch (e) {
      if (live.get(agent.id) === entry) live.delete(agent.id);
      // A handle whose establishment failed is still released, once, without retry.
      await entry.sub?.release().catch(() => undefined);
      log(`timeline subscribe failed agent=${fp(agent.id)} ${e instanceof Error ? e.name : "error"}`);
      return;
    }
    // Released (turn end, archive, close, cleanup) while establishing.
    if (live.get(agent.id) !== entry) await entry.sub.release().catch(() => undefined);
  });

  const offEnded = server.on("agent.turn_ended", async (event, ctx) => {
    holder.set(ctx.paseo);
    const agent = hostAgent(event.agent);
    if (agent === null) return;
    // The folded history covers agents without a live subscription (cap, restart, missed events).
    if (TOOL_NAME_SET[agent.provider] !== undefined) await scan(ctx.paseo, agent, event.timeline ?? []);
    await scanReferences(ctx.paseo, agent, event.turnId ?? null, event.timeline ?? []);
    await release(agent.id);
  });

  const offArchived = server.on("agent.archived", async (event, ctx) => {
    holder.set(ctx.paseo);
    const agent = hostAgent(event.agent);
    if (agent !== null) await release(agent.id);
  });

  const offClosed = server.on("agent.closed", async (event, ctx) => {
    holder.set(ctx.paseo);
    const agent = hostAgent(event.agent);
    if (agent !== null) await release(agent.id);
  });

  return async () => {
    for (const off of [offStarted, offEnded, offArchived, offClosed]) off();
    await Promise.all([...live.keys()].map(release));
  };
}
