// One-click Discuss on a feature card: reservation, creation without a prompt, binding, prompt.
//
// 1. The reservation is committed first (and the feature's session when absent); its id labels the
//    agent and is the creation's idempotency key.
// 2. The agent is created in the panel's workspace from a saved profile, with no prompt.
// 3. The binding and the session planner (through the rebind path) are committed in one transaction.
// 4. Only then is the prompt sent; an undelivered prompt leaves the binding in place.
//
// An uncertain creation keeps the reservation `creating`. After the timeout the next press looks for
// the agent by its reservation label, archived agents included. A live agent is bound; an archived
// one means the creation happened, so a new reservation may create again. When no agent carries
// the label the outcome stays unknown: the host does not promise that its listing is complete
// after an interrupted creation, so the reservation becomes `unresolved` and only the owner's
// explicit retry creates again, under the same reservation id and idempotency key.
import type { PaseoApi } from "@getpaseo/client";
import { DomainError, isDomainError, type ErrorCode } from "../shared/errors";
import type { RoadmapData } from "../shared/model";
import type { Result } from "../shared/rpc";
import type { DiscussionTools } from "../shared/rpc-discussion";
import { discussionLanguageChoices, ENGLISH, isEnglishLabel, type RoadmapSettings } from "../shared/settings";
import { agentConfig, findProfile, type AgentProfile } from "./coordinator";
import { DISCUSSION_PREAPPROVED_TOOLS, DISCUSSION_SERVER } from "./injection";
import { PLUGIN_ID, RESERVATION_ENV } from "./mcp-state";
import { toolsState as readToolsState, type GrantReader } from "./tools-state";
import { creationWindowStart, reservationRetried, UI_ORIGIN, type RoadmapCommands, type StoreOpener } from "./sessions";
import type { ProjectDirectory } from "./store-root";
import { acceptedSummary, classifySendError, recordedError, RETRY_PREFIX, retryText, retryToken } from "./continuation-retry";
import { grillingView } from "./views";

export const RESERVATION_TIMEOUT_MS = 60_000;
export const RESERVATION_LABEL = "decision-roadmap.reservation";
const LIST_PAGE = 200;
const BIND_ATTEMPTS = 3;

export interface DiscussionDeps {
  open: StoreOpener;
  commands: Pick<RoadmapCommands, "discussionReserve" | "discussionSettle" | "discussionBind">;
  settings(): Promise<RoadmapSettings>;
  directory(paseo: PaseoApi): ProjectDirectory;
  state: GrantReader;
  now(): Date;
  newId(): string;
  log(m: string): void;
  reservationTimeoutMs?: number;
}

export type OpenDiscussionInput = {
  projectId: string;
  expectedRevision: number;
  featureId: string;
  workspaceId: string;
  profileRef?: string;
  retryUnresolved?: true;
  /** The owner checked and confirms that no chat was created for the unresolved reservation. */
  confirmedNoChat?: true;
  /** The discussion language: English when absent; otherwise one of the settings' discussion languages. */
  language?: string;
};
export type OpenDiscussionValue = { revision: number; sessionId: string; agentId: string; workspaceId: string; created: boolean; tools: DiscussionTools };

const fail = (code: ErrorCode, message: string): { ok: false; error: { code: ErrorCode; message: string } } => ({
  ok: false,
  error: { code, message },
});

/**
 * For a Codex chat: its read and ask preapprovals sit on a second server entry (see injection), so it
 * is told to prefer that entry for them and to use the roadmap server for everything else. This only
 * directs the chat; which entry it calls is the model's choice.
 */
const codexEntriesText = (): string[] => [
  `For ${DISCUSSION_PREAPPROVED_TOOLS.join(", ")}, prefer the "${DISCUSSION_SERVER}" MCP server entry, which runs them without an approval prompt; if it is not available, use the same tools on "${PLUGIN_ID}".`,
  `Use the "${PLUGIN_ID}" entry for every other roadmap tool; those keep their approval.`,
];

/**
 * The discussion prompt (repository-authored English); `language` is the session's, English when
 * absent; `provider` is the chat's when known.
 */
export function discussionPrompt(x: {
  featureTitle: string;
  featureDescription: string;
  featureId: string;
  sessionId: string;
  projectId: string;
  language?: string;
  provider?: string;
}): string {
  const language = x.language ?? ENGLISH;
  return [
    `You are the discussion planner for the roadmap feature "${x.featureTitle}" (${x.featureId}). Its decision session is ${x.sessionId} (roadmap://${x.projectId}/s/${x.sessionId}).`,
    `Feature description: ${x.featureDescription || "(none)"}.`,
    "First read roadmap_overview, roadmap_get_session for this session, roadmap_feature_list, and the repository's README.md and AGENTS.md for project context.",
    ...(x.provider === "codex" ? codexEntriesText() : []),
    `Session language: ${language}. Write every question, option and context in ${language}; keep identifiers, links and tool arguments unchanged. The language is already chosen: do not ask about it.`,
    "Ask questions in rounds with roadmap_ask into the session's open block (pass blockId; start a new block id on an empty session).",
    "Every question has a stable number Q<n> and links; roadmap_get_session and roadmap_ask return them. Refer to questions and answers by their links.",
    "Record answers only with the human's exact words (roadmap_answer with quoted). Never answer on your own judgement. Mark a question out of scope only when the human says so (roadmap_out_of_scope).",
    "A skipped question was deliberately left unanswered: do not insist; ask it again only when new information makes it necessary.",
    "After the owner accepts a block, continue with the next round. When a cancelled decision lists dependents, cancel them with roadmap_cancel_question or re-ask them.",
    "When nothing remains to ask, call roadmap_grill_propose_finish with a short summary. Do not close the session; propose finishing and wait for the owner.",
  ].join("\n");
}

const toolsState = (deps: Pick<DiscussionDeps, "state">, q: { agentId: string; reservationId: string; retried: boolean; since: string; cwd: string | undefined }) =>
  readToolsState(deps.state, { ...q, cwd: async () => q.cwd });

/** The host refused the creation before processing it (authentication), so no agent exists. */
const isAuthenticationRefusal = (e: unknown): e is Error => e instanceof Error && e.name === "DaemonAuthenticationError";

type LabelSearch = { kind: "live"; agentId: string; provider?: string } | { kind: "archived" } | { kind: "none" };

/** Every agent carrying the reservation label, archived ones included, over all pages. */
async function findByReservation(paseo: PaseoApi, reservationId: string): Promise<LabelSearch> {
  let archived = false;
  let cursor: string | undefined;
  for (;;) {
    const page = await paseo.agents.list({
      filter: { labels: { [RESERVATION_LABEL]: reservationId }, includeArchived: true, includeBackground: true, includeInternal: true },
      page: { limit: LIST_PAGE, ...(cursor !== undefined ? { cursor } : {}) },
    });
    for (const { agent } of page.entries) {
      if (agent.labels?.[RESERVATION_LABEL] !== reservationId) continue;
      if (agent.archivedAt === null || agent.archivedAt === undefined) {
        const provider: unknown = agent.provider;
        return { kind: "live", agentId: agent.id, ...(typeof provider === "string" && provider !== "" ? { provider } : {}) };
      }
      archived = true;
    }
    const info: { hasMore?: boolean; nextCursor?: string | null } | undefined = page.pageInfo;
    if (info?.hasMore !== true || typeof info.nextCursor !== "string") break;
    cursor = info.nextCursor;
  }
  return archived ? { kind: "archived" } : { kind: "none" };
}

export async function openDiscussion(deps: DiscussionDeps, paseo: PaseoApi, i: OpenDiscussionInput): Promise<Result<OpenDiscussionValue>> {
  const timeout = deps.reservationTimeoutMs ?? RESERVATION_TIMEOUT_MS;
  const read = await (await deps.open(i.projectId)).read();
  if (read.status === "missing") return fail("store_missing", "No decision roadmap in this project.");
  if (read.status === "invalid") return fail("store_invalid", read.error.message);
  if (read.revision !== i.expectedRevision) return fail("revision_conflict", "store revision changed");
  const feature = read.data.features.find((f) => f.id === i.featureId);
  if (feature === undefined) return fail("not_found", `feature ${i.featureId} not found`);
  if (feature.kind !== "feature") return fail("invalid_input", "only features have a discussion chat");

  const workspaces = await deps.directory(paseo).listWorkspaces();
  const d = feature.discussion;
  if (d?.state === "bound" && feature.grillSessionId !== undefined) {
    const where = workspaces.find((w) => w.id === d.workspaceId)?.directory;
    // The grant may precede the binding by the creation itself, by any delay: count from the session's
    // creation at the latest.
    const sessionId = feature.grillSessionId;
    const since = creationWindowStart(read.data.sessions.find((s) => s.id === sessionId)?.createdAt, d.boundAt, timeout);
    const tools = await toolsState(deps, { agentId: d.agentId, reservationId: d.reservationId, retried: reservationRetried(feature, d.reservationId), since, cwd: where });
    return { ok: true, value: { revision: read.revision, sessionId: feature.grillSessionId, agentId: d.agentId, workspaceId: d.workspaceId, created: false, tools } };
  }
  // Checked before anything is reserved or created: English, or a language configured in the settings.
  let language: string | undefined;
  if (i.language !== undefined && !isEnglishLabel(i.language)) {
    const offered = discussionLanguageChoices((await deps.settings()).discussionLanguages);
    if (!offered.includes(i.language)) return fail("invalid_input", `unknown discussion language ${i.language}; configure it in the roadmap settings first`);
    language = i.language;
  }
  const workspace = workspaces.find((w) => w.id === i.workspaceId);
  if (workspace === undefined || workspace.projectId !== i.projectId || workspace.directory === undefined) {
    return fail("invalid_input", "the workspace does not belong to this project or has no directory");
  }

  const now = deps.now();
  // A reservation in flight: refused while recent; reconciled by its label afterwards.
  let reservationId: string | null = null;
  let profileRef: string | undefined = i.profileRef;
  // The workspace a new chat is created in: the panel's, or a reservation's own when it is retried.
  let target: { id: string; directory: string } = { id: workspace.id, directory: workspace.directory };
  if (d?.state === "creating" || d?.state === "unresolved") {
    const reserved = workspaces.find((w) => w.id === d.workspaceId);
    const reservedDirectory = reserved?.projectId === i.projectId ? reserved.directory : undefined;
    if (d.state === "creating" && now.getTime() - Date.parse(d.at) < timeout) {
      return fail("invalid_input", "the discussion chat is being created; try again in a moment");
    }
    let found: LabelSearch;
    try {
      found = await findByReservation(paseo, d.reservationId);
    } catch {
      return fail("internal", "the discussion chat's creation outcome is unknown and the agents could not be listed; try again later");
    }
    // A chat found by its label belongs to the reserved workspace, whichever panel pressed.
    if (found.kind === "live") {
      // The chat exists: its own provider, as listed, decides its prompt, not the saved profile now.
      if (found.provider === undefined) deps.log("discussion: the found chat's provider is not listed; its prompt names no preapproval entry");
      return bindAndPrompt(deps, paseo, i, read.revision, d.reservationId, found.agentId, d.workspaceId, d.at, reservedDirectory, false, language, found.provider);
    }
    if (found.kind === "none") {
      if (d.state === "creating") {
        const settled = await deps.commands.discussionSettle(deps.open, { projectId: i.projectId, expectedRevision: read.revision, featureId: i.featureId, reservationId: d.reservationId, state: "unresolved" }, UI_ORIGIN);
        if (!settled.ok) return settled;
      }
      if (i.retryUnresolved !== true || i.confirmedNoChat !== true || d.state !== "unresolved") {
        return fail(
          "invalid_input",
          "the discussion chat's creation is unresolved: no agent with its reservation was found, which does not prove none was created. " +
            "Check the workspace's chats; create it again only after confirming that no chat was created.",
        );
      }
      // The owner's explicit retry: the same reservation, so the label, idempotency key and workspace match.
      if (reservedDirectory === undefined) {
        return fail("invalid_input", "the workspace this chat was being created in is no longer part of the project; the creation cannot be retried there");
      }
      reservationId = d.reservationId;
      profileRef = d.profileRef;
      target = { id: d.workspaceId, directory: reservedDirectory };
    }
    // An archived agent carries the label: the creation happened, so a new reservation may create.
  }

  profileRef ??= (await deps.settings()).discussionProfile;
  if (profileRef === undefined) return fail("invalid_input", "no discussion profile configured; choose a profile");
  let profile: AgentProfile | null;
  try {
    profile = await findProfile(paseo, profileRef);
  } catch {
    return fail("internal", "the saved agent profiles could not be read");
  }
  if (profile === null) return fail("invalid_input", `unknown agent profile ${profileRef}`);

  // 1. The reservation, committed before anything is created.
  reservationId ??= deps.newId();
  const previous = d?.state === "creating" || d?.state === "unresolved" ? d.reservationId : undefined;
  const reserved = await deps.commands.discussionReserve(
    deps.open,
    {
      projectId: i.projectId,
      expectedRevision: read.revision,
      featureId: i.featureId,
      workspaceId: target.id,
      profileRef,
      reservationId,
      sessionId: deps.newId(),
      ...(previous !== undefined ? { previous } : {}),
      ...(previous !== undefined && previous === reservationId && i.confirmedNoChat === true ? { confirmedNoChat: true as const } : {}),
      ...(language !== undefined ? { language } : {}),
    },
    UI_ORIGIN,
  );
  if (!reserved.ok) return reserved;
  const reservedAt = now.toISOString();

  // 2. The agent, without a prompt.
  let agentId: string;
  try {
    const handle = await paseo.workspaces.ref(target.id).agents.create({
      config: agentConfig(profile),
      title: `Discussion: ${feature.title}`,
      labels: { "decision-roadmap.feature": feature.id, "decision-roadmap.role": "discussion", [RESERVATION_LABEL]: reservationId },
      idempotencyKey: reservationId,
      // Read by this plugin's own agent.create injection, which marks the chat's grant with it.
      env: { [RESERVATION_ENV]: reservationId },
    });
    agentId = handle.id;
  } catch (e) {
    if (isAuthenticationRefusal(e)) {
      const settled = await deps.commands.discussionSettle(
        deps.open,
        { projectId: i.projectId, expectedRevision: reserved.value.revision, featureId: i.featureId, reservationId, state: "failed", error: e.message },
        UI_ORIGIN,
      );
      if (!settled.ok) deps.log(`discussion: recording the refused creation failed: ${settled.error.code}`);
      return fail("internal", `the discussion chat could not be created: ${e.message}`);
    }
    // Any other rejection may come after the host created the agent: keep the reservation.
    deps.log(`discussion: creation outcome unknown: ${e instanceof Error ? e.name : "error"}`);
    return fail("internal", "the discussion chat's creation outcome is unknown; try again in a minute, when it is looked up by its reservation");
  }
  return bindAndPrompt(deps, paseo, i, reserved.value.revision, reservationId, agentId, target.id, reservedAt, target.directory, true, language, profile.provider);
}

/** 3 and 4: binding with the planner in one transaction, then the prompt. */
async function bindAndPrompt(
  deps: DiscussionDeps,
  paseo: PaseoApi,
  i: OpenDiscussionInput,
  revision: number,
  reservationId: string,
  agentId: string,
  workspaceId: string,
  reservedAt: string,
  cwd: string | undefined,
  created: boolean,
  /** This press's checked language (absent: English); it applies while no chat has used the session. */
  language: string | undefined,
  /** The chat's provider: its profile's for a new creation, its own as listed for a found chat. */
  provider: string | undefined,
): Promise<Result<OpenDiscussionValue>> {
  // The reservation guards the binding; another write in between only moves the revision.
  let bound: Awaited<ReturnType<DiscussionDeps["commands"]["discussionBind"]>> | undefined;
  let expectedRevision = revision;
  for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt++) {
    bound = await deps.commands.discussionBind(
      deps.open,
      { projectId: i.projectId, expectedRevision, featureId: i.featureId, reservationId, agentId, ...(language !== undefined ? { language } : {}) },
      UI_ORIGIN,
    );
    if (bound.ok || bound.error.code !== "revision_conflict") break;
    const now = await (await deps.open(i.projectId)).read();
    if (now.status !== "ok") break;
    expectedRevision = now.revision;
  }
  if (bound === undefined || !bound.ok) {
    deps.log(`discussion: agent ${agentId} created but not bound yet; it is found by its reservation on the next press`);
    return bound ?? fail("internal", "the discussion chat could not be bound");
  }
  const read = await (await deps.open(i.projectId)).read();
  const feature = read.status === "ok" ? read.data.features.find((f) => f.id === i.featureId) : undefined;
  const sessionLanguage = read.status === "ok" ? read.data.sessions.find((s) => s.id === bound.value.sessionId)?.language : undefined;
  try {
    await paseo.agents.ref(agentId).send(
      discussionPrompt({
        featureTitle: feature?.title ?? "",
        featureDescription: feature?.description ?? "",
        featureId: i.featureId,
        sessionId: bound.value.sessionId,
        projectId: i.projectId,
        ...(sessionLanguage !== undefined ? { language: sessionLanguage } : {}),
        ...(provider !== undefined ? { provider } : {}),
      }),
    );
  } catch (e) {
    // The binding stands; the owner continues in the chat.
    deps.log(`discussion: prompt not delivered: ${e instanceof Error ? e.name : "error"}`);
  }
  // A retry under the same reservation was noted with it; an unreadable store cannot rule one out.
  const retried = feature === undefined || reservationRetried(feature, reservationId);
  const tools = await toolsState(deps, { agentId, reservationId, retried, since: reservedAt, cwd });
  return { ok: true, value: { revision: bound.value.revision, sessionId: bound.value.sessionId, agentId, workspaceId, created, tools } };
}

// Retry of a manual continuation: at most one send per retry record, never exactly-once.
//
// The record is committed `sending` before the single send, whose message id is the record id and
// whose text carries the token [DR-RETRY-<id>]. No active-turn mode is passed: the SDK has none
// that queues, and omitting it lets the daemon interrupt an active turn, as for any user message.
// The host documents no deduplication by message id, so nothing relies on it and nothing is sent
// again automatically. The outcome is written with a bounded compare-and-set; a record still
// `sending` is turned `unknown` by the start-up sweep and settled only by the token observed in
// the planner's timeline or by the owner's mark.

export { classifySendError, RETRY_PREFIX, retryToken } from "./continuation-retry";
const CAS_ATTEMPTS = 3;
const TIMELINE_TAIL = 200;
export const STALE_SENDING_MS = 60_000;
type RetryState = "sending" | "sent" | "failed" | "unknown";
type RetryDeps = Pick<DiscussionDeps, "open" | "now" | "newId" | "log">;

/** A domain refusal as a Result; anything else propagates to the handler's boundary. */
const toFailure = (e: unknown): { ok: false; error: { code: ErrorCode; message: string } } => {
  if (isDomainError(e)) return { ok: false, error: { code: e.code, message: e.message } };
  throw e;
};

/** One write at the latest revision, retried after a revision conflict; false when it gave up. */
async function casWrite(deps: RetryDeps, projectId: string, fn: (draft: RoadmapData) => void): Promise<boolean> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const store = await deps.open(projectId);
    const read = await store.read();
    if (read.status !== "ok") return false;
    try {
      await store.transact(read.revision, fn);
      return true;
    } catch (e) {
      if (!isDomainError(e, "revision_conflict")) throw e;
    }
  }
  return false;
}

const retryOf = (data: RoadmapData, sessionId: string, retryId: string) => data.sessions.find((s) => s.id === sessionId)?.retries?.find((r) => r.id === retryId);

export async function retryContinuation(
  deps: RetryDeps,
  paseo: PaseoApi,
  i: { projectId: string; expectedRevision: number; sessionId: string },
): Promise<Result<{ revision: number; retryId: string; sentTo: string; state: "sent" | "sending" }>> {
  const read = await (await deps.open(i.projectId)).read();
  if (read.status === "missing") return fail("store_missing", "No decision roadmap in this project.");
  if (read.status === "invalid") return fail("store_invalid", read.error.message);
  const session = read.data.sessions.find((s) => s.id === i.sessionId);
  if (session === undefined) return fail("not_found", `session ${i.sessionId} not found`);
  const id = deps.newId();
  const at = deps.now().toISOString();
  let target: { agentId: string; text: string } | undefined;
  // The guard runs inside the transaction, on the state the record is written against.
  try {
    await (await deps.open(i.projectId)).transact(i.expectedRevision, (draft) => {
      const s = draft.sessions.find((x) => x.id === i.sessionId)!;
      const view = grillingView(s);
      if (view === undefined || !view.manualRecovery || s.planner === undefined) {
        throw new DomainError("invalid_input", "Retry is available only when the chat needs manual continuation");
      }
      // The block of the current operation, once accepted: never an earlier block's summary for an
      // operation still waiting on its own open block.
      const c = s.continuation;
      const blockId = c?.acceptedBlockId ?? c?.openBlockId;
      const accepted = s.blocks?.find((b) => b.id === blockId);
      if (c === undefined || accepted === undefined || accepted.state !== "accepted") {
        throw new DomainError("invalid_input", "the current operation has no accepted block to continue from; continue in the chat");
      }
      const operationId = c.operationId;
      const { agentId, epoch } = s.planner;
      // One retry per accepted block, operation and planner binding: a rebound planner may get its own.
      const previous = (s.retries ?? []).filter((r) => r.blockId === accepted.id && r.operationId === operationId && r.agentId === agentId && r.epoch === epoch).at(-1);
      if (previous?.state === "sent") throw new DomainError("invalid_input", `a retry was already sent at ${previous.at}`);
      if (previous?.state === "sending" || previous?.state === "unknown") {
        throw new DomainError("invalid_input", `the outcome of the retry of ${previous.at} is unknown: check the chat, then mark it delivered or not delivered`);
      }
      target = { agentId, text: retryText(RETRY_PREFIX, id, acceptedSummary(draft, s, accepted)) };
      s.retries = [
        ...(s.retries ?? []),
        { id, at, operationId, blockId: accepted.id, agentId, epoch, state: "sending" },
      ];
    });
  } catch (e) {
    return toFailure(e);
  }
  const { agentId, text } = target!;
  const settle = (state: "sent" | "failed" | "unknown", error?: string) =>
    casWrite(deps, i.projectId, (draft) => {
      const r = retryOf(draft, i.sessionId, id);
      // Only a record still sending is settled here; a check or the owner may have settled it.
      if (r === undefined || r.state !== "sending") return;
      r.state = state;
      if (error !== undefined) r.error = error;
    }).catch((e: unknown) => {
      deps.log(`discussion: retry outcome not written: ${e instanceof Error ? e.name : "error"}`);
      return false;
    });
  try {
    await paseo.agents.ref(agentId).send(text, { messageId: id });
  } catch (e) {
    const state = classifySendError(e);
    await settle(state, recordedError(e, state));
    deps.log(`discussion: retry ${state}: ${e instanceof Error ? e.name : "error"}`);
    return fail(
      "internal",
      state === "failed"
        ? "the host refused the retry before sending it; you may retry"
        : "the retry's outcome is unknown: check the chat, then mark it delivered or not delivered",
    );
  }
  const written = await settle("sent");
  const after = await (await deps.open(i.projectId)).read();
  return { ok: true, value: { revision: after.status === "ok" ? after.revision : i.expectedRevision + 1, retryId: id, sentTo: agentId, state: written ? "sent" : "sending" } };
}

/** The owner's mark of an uncertain retry; revision-checked, refused once the record is settled. */
export async function resolveRetry(
  deps: RetryDeps,
  i: { projectId: string; expectedRevision: number; sessionId: string; retryId: string; outcome: "delivered" | "not_delivered" },
): Promise<Result<{ revision: number }>> {
  const at = deps.now().toISOString();
  try {
    const out = await (await deps.open(i.projectId)).transact(i.expectedRevision, (draft) => {
      const r = retryOf(draft, i.sessionId, i.retryId);
      if (r === undefined) throw new DomainError("not_found", `retry ${i.retryId} not found`, { retryId: i.retryId });
      if (r.state !== "sending" && r.state !== "unknown") throw new DomainError("invalid_input", `the retry is already ${r.state}`, { retryId: i.retryId });
      r.state = i.outcome === "delivered" ? "sent" : "failed";
      r.resolvedAt = at;
      r.resolvedBy = "user";
    });
    return { ok: true, value: { revision: out.revision } };
  } catch (e) {
    return toFailure(e);
  }
}

/** Marks the record sent only when a user message of the planner's timeline tail shows its token or message id. */
export async function checkRetry(deps: RetryDeps, paseo: PaseoApi, i: { projectId: string; sessionId: string; retryId: string }): Promise<Result<{ state: RetryState }>> {
  const read = await (await deps.open(i.projectId)).read();
  if (read.status === "missing") return fail("store_missing", "No decision roadmap in this project.");
  if (read.status === "invalid") return fail("store_invalid", read.error.message);
  const r = retryOf(read.data, i.sessionId, i.retryId);
  if (r === undefined) return fail("not_found", `retry ${i.retryId} not found`);
  if (r.state === "sent" || r.state === "failed") return { ok: true, value: { state: r.state } };
  // A bounded tail: a token outside it, or an unavailable page, proves nothing either way.
  const page = await paseo.agents
    .ref(r.agentId)
    .timeline.refetch({ direction: "tail", projection: "canonical", limit: TIMELINE_TAIL })
    .catch(() => null);
  const token = retryToken(r.id);
  const seen = (page?.entries ?? []).some((e: { item: { type: string; text?: unknown; messageId?: unknown } }) => {
    const item = e.item;
    return item.type === "user_message" && ((typeof item.text === "string" && item.text.includes(token)) || item.messageId === r.id);
  });
  if (!seen) return { ok: true, value: { state: r.state } };
  const resolvedAt = deps.now().toISOString();
  let written = false;
  try {
    written = await casWrite(deps, i.projectId, (draft) => {
      const x = retryOf(draft, i.sessionId, i.retryId);
      if (x === undefined || (x.state !== "sending" && x.state !== "unknown")) return;
      x.state = "sent";
      x.resolvedAt = resolvedAt;
      x.resolvedBy = "timeline";
    });
  } catch (e) {
    return toFailure(e);
  }
  return { ok: true, value: { state: written ? "sent" : r.state } };
}

/** At plugin start: a record still `sending` after `olderThanMs` cannot complete; it becomes `unknown`. Sends nothing. */
export async function sweepStaleRetries(deps: RetryDeps, projectId: string, olderThanMs: number = STALE_SENDING_MS): Promise<number> {
  const read = await (await deps.open(projectId)).read();
  if (read.status !== "ok") return 0;
  const cutoff = deps.now().getTime() - olderThanMs;
  const stale = new Set(read.data.sessions.flatMap((s) => (s.retries ?? []).filter((r) => r.state === "sending" && Date.parse(r.at) < cutoff).map((r) => r.id)));
  if (stale.size === 0) return 0;
  const resolvedAt = deps.now().toISOString();
  await casWrite(deps, projectId, (draft) => {
    for (const s of draft.sessions) {
      for (const r of s.retries ?? []) {
        if (stale.has(r.id) && r.state === "sending") {
          r.state = "unknown";
          r.resolvedAt = resolvedAt;
          r.resolvedBy = "sweep";
        }
      }
    }
  });
  return stale.size;
}
