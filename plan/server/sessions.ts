import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract, RpcInput } from "@getpaseo/plugin";
import { DomainError, isDomainError } from "../shared/errors";
import {
  addRelation,
  applyAnswer,
  computeVisibility,
  confirmAnswer,
  findQuestion,
  insertQuestion,
  removeRelation,
  markOutOfScope,
  skipQuestion,
  updateDefinition,
  type GraphChange,
} from "../shared/graph";
import { canonicalJson } from "../shared/canonical";
import { childIndex, dependentsOf } from "../shared/dependents";
import { linksOf } from "../shared/links";
import { questionNumber } from "../shared/numbering";
import {
  isTerminalContinuation,
  refKey,
  type Actor,
  type Block,
  type Continuation,
  type Feature,
  type ContinuationState,
  type LinkEnd,
  type Option,
  type Question,
  type Ref,
  type RoadmapData,
  type Session,
  type SessionClosure,
} from "../shared/model";
import type { BlockAccept, QuestionCreateV2Input } from "../shared/rpc-blocks";
import type { DecisionCancel } from "../shared/rpc-decisions";
import { SessionFinishInput, type QuestionOutOfScope, type SessionFinish } from "../shared/rpc-discussion";
import type { SessionLanguageNoticeAck, SessionPlannerSet, SessionReopen } from "../shared/rpc-grilling";
import type {
  LinkCreate,
  LinkDelete,
  QuestionAnswer,
  QuestionConfirm,
  QuestionCreate,
  QuestionDiscuss,
  QuestionSkip,
  QuestionUpdate,
  RelationAdd,
  RelationRemove,
  Result,
  RoadmapInit,
  RoadmapOverview,
  RoadmapVersion,
  SessionCreate,
  SessionGet,
  ValueOf,
} from "../shared/rpc";
import { automaticContinuation, retriesOf } from "./continuation-retry";
import { ulid } from "./ids";
import { toolsState, type GrantReader } from "./tools-state";
import {
  ANSWERING_TEXT,
  CLOSED_TEXT,
  MANUAL_TEXT,
  NO_BLOCKS_TEXT,
  PAUSED_TEXT,
  PRIOR_PLANNER_TEXT,
  NO_OPERATION_TEXT,
  NO_PLANNER_TEXT,
  NOT_PLANNER_TEXT,
  pauseContractText,
  RESUMED_TEXT,
  UNSUPPORTED_TEXT,
  AUTO_SENT_TEXT,
  AUTO_WAIT_TEXT,
  DISCUSSION_UNSUPPORTED_TEXT,
} from "./pause-contract";
import type { PauseSupport } from "./pause-support";
import type { Store, StoreOptions } from "./store";
import { openProjectStore, type ProjectDirectory } from "./store-root";
import { buildBlockSummary } from "./summary";
import { buildOverview, buildSessionView } from "./views";

export interface RoadmapServiceDeps {
  directory: (paseo: PaseoApi) => ProjectDirectory;
  now?: () => Date;
  newId?: () => string;
  storeOptions?: Omit<StoreOptions, "storeRoot" | "projectId">;
  /**
   * Called once after an Accept commits an operation that now waits on the planner's pause card
   * (`resolving` or `accepted_awaiting_pause`), or that a chat bound by Discuss needs continued
   * without a card (`needs_manual`, see `automaticContinuation`); the pause engine takes it from there.
   */
  afterAccept?: (x: { projectId: string; sessionId: string; operationId: string }) => void;
  /**
   * The plugin's grant state. With it, the panel's `session.get` of a session whose planner is a
   * discussion chat reports that chat's roadmap tools state; without it the view carries none.
   */
  state?: GrantReader;
}

/** A grant issued at creation can precede the binding by the creation itself. */
const GRANT_WINDOW_MS = 60_000;

export type WriteOrigin =
  | { source: "ui"; actor: { kind: "human" } }
  | { source: "chat"; actor: { kind: "agent"; agentId?: string }; quoted?: string };
export const UI_ORIGIN: WriteOrigin = { source: "ui", actor: { kind: "human" } };
/**
 * The agent of a bound MCP grant, the only tool-driven source of a planner binding (TR6);
 * `session.planner.set` binds with `boundBy: "ui"`. It is passed beside the origin by the tools that
 * may bind; the UI and unbound grants pass none. `support` is the caller's own native-pause support
 * as the MCP tool read it from the host; absent means not read.
 */
export type PlannerCaller = { agentId: string; workspaceId: string | null; support?: PauseSupport };

/**
 * What a chat is told about pausing after a batch into a session with blocks (TR11): the pause
 * contract only for the bound planner of a live operation, a do-not-pause notice for everyone else.
 */
export type AskGrilling = { operationId?: string; state?: ContinuationState; instructions: string };
export type StoreOpener = (projectId: string) => Promise<Store>;

type Cmd<C extends PluginRpcContract> = (open: StoreOpener, input: RpcInput<C>, origin: WriteOrigin) => Promise<Result<ValueOf<C>>>;

export type BatchParent = Ref | { batchIndex: number };
export interface QuestionBatchInput {
  projectId: string;
  expectedRevision: number;
  sessionId: string;
  /** The block every question of the batch joins; required for a session that uses blocks. */
  blockId?: string;
  questions: Array<{
    title: string;
    context: string;
    options: Option[];
    recommendedOptionId?: string;
    /** `language` marks the session-language question. */
    tag?: "language";
    allowFreeText: boolean;
    activatedBy: Array<{ parent: BatchParent; optionIds: string[] }>;
    invalidatedBy: Array<{ upstream: BatchParent }>;
  }>;
}
export const MAX_BATCH = 20;

export interface RoadmapCommands {
  version: Cmd<typeof RoadmapVersion>;
  init: Cmd<typeof RoadmapInit>;
  overview: Cmd<typeof RoadmapOverview>;
  sessionGet: Cmd<typeof SessionGet>;
  sessionCreate: Cmd<typeof SessionCreate>;
  /** Accepts `blockId`, which the `question.create` contract gains in Task R0.6. */
  questionCreate(open: StoreOpener, input: QuestionCreateV2Input, origin: WriteOrigin): Promise<Result<ValueOf<typeof QuestionCreate>>>;
  questionUpdate: Cmd<typeof QuestionUpdate>;
  questionAnswer: Cmd<typeof QuestionAnswer>;
  questionConfirm: Cmd<typeof QuestionConfirm>;
  questionSkip: Cmd<typeof QuestionSkip>;
  /** A chat origin must quote the human; the mark is recorded with a note quoting them. */
  questionOutOfScope: Cmd<typeof QuestionOutOfScope>;
  questionDiscuss: Cmd<typeof QuestionDiscuss>;
  relationAdd: Cmd<typeof RelationAdd>;
  relationRemove: Cmd<typeof RelationRemove>;
  linkCreate: Cmd<typeof LinkCreate>;
  linkDelete: Cmd<typeof LinkDelete>;
  blockAccept: Cmd<typeof BlockAccept>;
  decisionCancel: Cmd<typeof DecisionCancel>;
  /** MCP only: see the command for the consent rule. */
  questionCancelByAgent(
    open: StoreOpener,
    input: { projectId: string; expectedRevision: number; sessionId: string; questionId: string; reason: string },
    origin: WriteOrigin,
  ): Promise<Result<{ revision: number; cancellationId: string }>>;
  /** The first call with a `caller` into a session without a planner binds that caller. */
  questionCreateBatch(
    open: StoreOpener,
    input: QuestionBatchInput,
    origin: WriteOrigin,
    caller?: PlannerCaller,
  ): Promise<
    Result<{
      revision: number;
      questionIds: string[];
      /** Stable numbers and canonical links of the created questions, in batch order. */
      numbers: number[];
      links: Array<{ question: string; answer: string }>;
      visibilityChanged: Ref[];
      grilling?: AskGrilling;
    }>
  >;
  /** UI only. `workspaceId` is resolved from the host by the service, never taken from RPC input. */
  plannerSet(
    open: StoreOpener,
    input: { projectId: string; sessionId: string; expectedRevision: number; agentId: string; workspaceId: string | null },
    origin: WriteOrigin,
  ): Promise<Result<{ revision: number; epoch: number }>>;
  sessionReopen: Cmd<typeof SessionReopen>;
  /** UI only: the owner's Got it on the no-translation notice; the same language again writes nothing. */
  sessionLanguageNoticeAck: Cmd<typeof SessionLanguageNoticeAck>;
  /**
   * Read-only (nothing is minted): for a session with blocks, the advice for this caller in the stored
   * operation's current state; the exact pause instructions only while the card is awaited
   * (`awaiting_pause`, `accepted_awaiting_pause`). It need not equal what a new batch would return, since a
   * batch may start a new operation. For a session without blocks, which `roadmap_ask` gives no `grilling`
   * value, the no-blocks notice.
   */
  pauseInstructions(open: StoreOpener, input: { projectId: string; sessionId: string }, caller?: PlannerCaller): Promise<Result<AskGrilling>>;
  /** The bound planner proposes finishing; the owner confirms with `sessionFinish`. Closes nothing. */
  grillProposeFinish(
    open: StoreOpener,
    input: { projectId: string; sessionId: string; expectedRevision: number; summary: string },
    origin: WriteOrigin,
    caller?: PlannerCaller,
  ): Promise<Result<{ revision: number; instructions: string }>>;
  /**
   * Feature discussion store steps (UI only, used by the Discuss command). `discussionReserve` records
   * the reservation (and creates the feature's session when absent) before the host creates the agent;
   * `discussionSettle` records a host refusal or an unresolved outcome; `discussionBind` records the
   * binding and sets the session planner through the rebind path, in one transaction.
   */
  discussionReserve(
    open: StoreOpener,
    input: {
      projectId: string;
      expectedRevision: number;
      featureId: string;
      workspaceId: string;
      profileRef: string;
      reservationId: string;
      sessionId: string;
      /** The reservation in flight the caller resolved (its agent archived, or retried); else none may exist. */
      previous?: string;
      /** Recorded on the feature: the owner confirmed that no chat exists for the unresolved reservation. */
      confirmedNoChat?: true;
      /** A language other than English, already checked against the settings; absent means English. */
      language?: string;
    },
    origin: WriteOrigin,
  ): Promise<Result<{ revision: number; sessionId: string }>>;
  discussionSettle(
    open: StoreOpener,
    input: { projectId: string; expectedRevision: number; featureId: string; reservationId: string } & ({ state: "failed"; error: string } | { state: "unresolved" }),
    origin: WriteOrigin,
  ): Promise<Result<{ revision: number }>>;
  discussionBind(
    open: StoreOpener,
    input: {
      projectId: string;
      expectedRevision: number;
      featureId: string;
      reservationId: string;
      agentId: string;
      /** The binding press's language (absent: English), applied while no chat has used the session. */
      language?: string;
    },
    origin: WriteOrigin,
  ): Promise<Result<{ revision: number; sessionId: string; epoch: number }>>;
  /** UI only: the owner's Finish closes the session and marks an open proposal finished. */
  sessionFinish: Cmd<typeof SessionFinish>;
  /** The bound planner ends grilling: its current operation becomes `complete` and the session closes. */
  grillComplete(
    open: StoreOpener,
    input: { projectId: string; sessionId: string; expectedRevision: number; operationId: string },
    origin: WriteOrigin,
    caller?: PlannerCaller,
  ): Promise<Result<{ revision: number; state: "complete" }>>;
}

type Fn<C extends PluginRpcContract> = (paseo: PaseoApi, input: RpcInput<C>) => Promise<Result<ValueOf<C>>>;

export interface RoadmapService {
  version: Fn<typeof RoadmapVersion>;
  init: Fn<typeof RoadmapInit>;
  overview: Fn<typeof RoadmapOverview>;
  sessionGet: Fn<typeof SessionGet>;
  sessionCreate: Fn<typeof SessionCreate>;
  questionCreate: Fn<typeof QuestionCreate>;
  questionUpdate: Fn<typeof QuestionUpdate>;
  questionAnswer: Fn<typeof QuestionAnswer>;
  questionConfirm: Fn<typeof QuestionConfirm>;
  questionSkip: Fn<typeof QuestionSkip>;
  questionOutOfScope: Fn<typeof QuestionOutOfScope>;
  questionDiscuss: Fn<typeof QuestionDiscuss>;
  relationAdd: Fn<typeof RelationAdd>;
  relationRemove: Fn<typeof RelationRemove>;
  linkCreate: Fn<typeof LinkCreate>;
  linkDelete: Fn<typeof LinkDelete>;
  blockAccept: Fn<typeof BlockAccept>;
  decisionCancel: Fn<typeof DecisionCancel>;
  plannerSet: Fn<typeof SessionPlannerSet>;
  sessionReopen: Fn<typeof SessionReopen>;
  sessionLanguageNoticeAck: Fn<typeof SessionLanguageNoticeAck>;
  sessionFinish: Fn<typeof SessionFinish>;
}

/** Copy of the origin's actor; `agentId` only when present. */
const actorOf = (origin: WriteOrigin): Actor =>
  origin.actor.kind === "agent" && origin.actor.agentId !== undefined
    ? { kind: "agent", agentId: origin.actor.agentId }
    : { kind: origin.actor.kind };

/** Chat answers and confirmations must quote the human; an agent never answers on its own authority. */
function chatQuote(origin: WriteOrigin): { quoted?: string } {
  if (origin.source !== "chat") return {};
  if (typeof origin.quoted !== "string" || origin.quoted.trim() === "") {
    throw new DomainError("invalid_input", "A chat answer must quote the person's words.");
  }
  return { quoted: origin.quoted };
}

/** A block derived for a legacy session. It records no times or acceptor, because none exist. */
export type LegacyBlock = { id: string; order: number; state: "open" | "accepted"; legacy: true };
export type EffectiveBlock = Block | LegacyBlock;

/**
 * The blocks of a session: its stored `blocks` unchanged, or for a legacy session one derived,
 * never stored block, open while the session is active and accepted once it is closed.
 */
export function effectiveBlocks(session: Session): EffectiveBlock[] {
  if (session.blocks !== undefined) return session.blocks;
  return [{ id: session.id, order: 0, state: session.status === "active" ? "open" : "accepted", legacy: true }];
}

/** Which automatic-grilling fields a command may change; every other command leaves them unchanged. */
type GrillingWrites = {
  /** Set a planner on a session that has none (the first bound `roadmap_ask`). */
  bind?: true;
  /** Replace a binding and append the previous one to the history (the UI rebind). */
  rebind?: true;
  /** Change `continuation` / `continuations`. */
  continuation?: true;
  /** Set the absent `reopenedAt` of the last closure of this session (the UI reopen). */
  reopenLastClosure?: string;
};

/**
 * Closures are append-only. The one exception is `allowed.reopenLastClosure`: on that session the list
 * keeps its length, and its last entry may gain a `reopenedAt` it did not have, all else unchanged.
 */
function checkClosures(sessionId: string, before: SessionClosure[], after: SessionClosure[], reopen: boolean): void {
  const refuse = () => {
    throw new DomainError("invalid_input", `the closures of session ${sessionId} are append-only; only reopen stamps the last one`, { sessionId });
  };
  if (!reopen) {
    if (canonicalJson(after.slice(0, before.length)) !== canonicalJson(before)) refuse();
    return;
  }
  if (after.length !== before.length) refuse();
  if (before.length === 0) return;
  const lastIndex = before.length - 1;
  if (canonicalJson(after.slice(0, lastIndex)) !== canonicalJson(before.slice(0, lastIndex))) refuse();
  const was = before[lastIndex];
  const now = after[lastIndex];
  if (was.reopenedAt !== undefined || now.reopenedAt === undefined) {
    if (canonicalJson(now) !== canonicalJson(was)) refuse();
    return;
  }
  const { reopenedAt: _stamp, ...rest } = now;
  if (canonicalJson(rest) !== canonicalJson(was)) refuse();
}

/** Canonical binding and continuation fields per session id. */
function grillingState(sessions: Session[]): Map<string, { planner: Session["planner"]; binding: string; continuation: string }> {
  return new Map(
    sessions.map((s) => [
      s.id,
      {
        planner: s.planner,
        binding: canonicalJson({ planner: s.planner, plannerHistory: s.plannerHistory }),
        continuation: canonicalJson({ continuation: s.continuation, continuations: s.continuations }),
      },
    ]),
  );
}

/**
 * Mint (PLAN §3.3): a batch into an active, planner-bound session with blocks keeps the operation
 * that is `awaiting_pause` or `paused` for the current open block, or starts a new one for the open
 * block, moving the previous one to the history. A live operation of an earlier block (its answer
 * still in flight or unconfirmed) is replaced only by the bound planner's own batch, which shows the
 * planner moved on; it is recorded as `superseded (block_advanced)`, never as resumed. Only the bound
 * planner's own unsupported support makes the new operation `unsupported`.
 */
function mintOrKeep(session: Session, at: string, newId: () => string, caller?: PlannerCaller): void {
  const planner = session.planner;
  if (session.blocks === undefined || session.status !== "active" || planner === undefined) return;
  const open = session.blocks.find((b) => b.state === "open");
  if (open === undefined) return;
  const byPlanner = caller !== undefined && caller.agentId === planner.agentId;
  let current = session.continuation;
  if (current !== undefined && !isTerminalContinuation(current.state)) {
    const keep = (current.state === "awaiting_pause" || current.state === "paused") && current.openBlockId === open.id;
    if (keep) {
      // The bound planner's own fresh read says it cannot pause now: a kept operation still waiting for
      // its card becomes unsupported (same operation). A card already shown (`paused`) stays authoritative.
      if (byPlanner && current.state === "awaiting_pause" && caller.support?.kind === "unsupported") {
        session.continuation = { ...current, state: "unsupported", reason: caller.support.reason, at };
      }
      return;
    }
    if (!byPlanner) return;
    current = { ...current, state: "superseded", reason: "block_advanced", at };
  }
  const support = byPlanner ? caller.support : undefined;
  if (current !== undefined) session.continuations = [...(session.continuations ?? []), current];
  session.continuation = {
    operationId: newId(),
    openBlockId: open.id,
    target: { agentId: planner.agentId, epoch: planner.epoch },
    state: support?.kind === "unsupported" ? "unsupported" : "awaiting_pause",
    attempts: 0,
    at,
    ...(support?.kind === "unsupported" ? { reason: support.reason } : {}),
  };
}

/** The `grilling` value for a caller (TR11); undefined for a session without blocks. */
function grillingValue(session: Session, caller?: PlannerCaller): AskGrilling | undefined {
  if (session.blocks === undefined) return undefined;
  const planner = session.planner;
  if (planner === undefined) return { instructions: NO_PLANNER_TEXT };
  const c = session.continuation;
  const head = c !== undefined ? { operationId: c.operationId, state: c.state } : {};
  if (session.status === "closed") return { ...head, instructions: CLOSED_TEXT };
  if (caller?.agentId !== planner.agentId) return { ...head, instructions: NOT_PLANNER_TEXT };
  if (c === undefined) return { instructions: NO_OPERATION_TEXT };
  // A terminal operation of a previous binding (live ones are superseded by the rebind): no advice that
  // depends on it, and neither its id nor its reason (c75, c80).
  if (isTerminalContinuation(c.state) && (c.target.agentId !== planner.agentId || c.target.epoch !== planner.epoch)) {
    return { state: c.state, instructions: PRIOR_PLANNER_TEXT };
  }
  if (c.state === "unsupported") {
    const reason = c.reason ?? "unsupported";
    return { ...head, instructions: planner.boundBy === "discussion" ? DISCUSSION_UNSUPPORTED_TEXT(reason) : UNSUPPORTED_TEXT(reason) };
  }
  // The card is already shown (and matched) or already being answered: never ask for a second one.
  if (c.state === "paused") return { ...head, instructions: PAUSED_TEXT(c.openBlockId) };
  if (c.state === "resolving") return { ...head, instructions: ANSWERING_TEXT(c.openBlockId) };
  // Completion is advised only where it is accepted (COMPLETABLE): resumed among the terminal states.
  if (c.state === "resumed") return { ...head, instructions: RESUMED_TEXT(c.operationId) };
  if (isTerminalContinuation(c.state)) {
    // A chat bound by Discuss that the plugin continues itself is not told to wait for the owner.
    if (automaticContinuation(session) !== null) return { ...head, instructions: AUTO_WAIT_TEXT(c.openBlockId) };
    const automatic = c.acceptedBlockId !== undefined ? retriesOf(session, { blockId: c.acceptedBlockId, operationId: c.operationId, agentId: planner.agentId, epoch: planner.epoch }).at(-1) : undefined;
    if (automatic?.origin === "automatic" && automatic.state !== "failed") return { ...head, instructions: AUTO_SENT_TEXT(c.openBlockId) };
    return { ...head, instructions: MANUAL_TEXT(c.state) };
  }
  return { ...head, instructions: pauseContractText({ openBlockId: c.openBlockId, operationId: c.operationId }) };
}

/** What the planner is told after proposing to finish. */
const FINISH_PROPOSED_TEXT =
  "Finish proposal recorded. Wait for the owner to confirm with Finish in the Paseo panel; you cannot close the session. " +
  "Do not ask further questions unless the owner continues the conversation.";

/** States from which the bound planner may complete grilling (PLAN §3.5 completion). */
const COMPLETABLE: readonly ContinuationState[] = ["awaiting_pause", "accepted_awaiting_pause", "resumed"];

/**
 * Accept of the operation's own block (PLAN §3.5): the claim of attempt 1, the wait for a card that
 * has not appeared yet, or the manual recovery of a pause that is gone; anything else is unchanged.
 */
function acceptTransition(c: Continuation, accepted: { acceptedBlockId: string; nextBlockId: string; summary: string }, at: string): Continuation | null {
  if (c.state === "paused") return { ...c, ...accepted, state: "resolving", attempts: c.attempts + 1, at };
  if (c.state === "awaiting_pause") return { ...c, ...accepted, state: "accepted_awaiting_pause", at };
  if (c.state === "unsupported" || c.state === "pause_lost" || c.state === "pause_answered_externally" || c.state === "pause_mismatch") {
    return { ...c, ...accepted, state: "needs_manual", reason: c.reason !== undefined ? `${c.state}: ${c.reason}` : c.state, at };
  }
  return null;
}

/** The question ref of a command input, without the input's other fields. */
const refOf = (i: Ref): Ref => ({ sessionId: i.sessionId, questionId: i.questionId });

/**
 * The accepted definition of a question: what Accept froze. Answers, revisions, notes and the
 * derived `validity`, `stale` and `review` stay editable on an accepted block.
 */
function frozenContent(q: Question): string {
  const { id, order, number, blockId, title, context, options, recommendedOptionId, allowFreeText, definitionRev, activatedBy, invalidatedBy, tag } = q;
  return canonicalJson({ id, order, number, blockId, title, context, options, recommendedOptionId, allowFreeText, definitionRev, activatedBy, invalidatedBy, tag });
}

/**
 * The record of a cancelled question: everything except the derived `validity`, `stale` and
 * `review`, which graph propagation may still update. A cancelled decision is read-only history.
 */
function cancelledContent(q: Question): string {
  const { validity: _validity, stale: _stale, review: _review, ...content } = q;
  return canonicalJson(content);
}

/**
 * Canonical accepted content of every question in an accepted stored block, and the full accepted
 * blocks themselves, keyed by ref. Legacy sessions are never frozen by this rule.
 */
function frozenState(sessions: Session[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sessions) {
    if (s.blocks === undefined) continue;
    const accepted = new Set(s.blocks.filter((b) => b.state === "accepted").map((b) => b.id));
    for (const b of s.blocks) if (b.state === "accepted") out.set(`${s.id}#${b.id}`, canonicalJson(b));
    for (const q of s.questions) {
      if (q.blockId !== undefined && accepted.has(q.blockId)) out.set(refKey({ sessionId: s.id, questionId: q.id }), frozenContent(q));
    }
  }
  return out;
}

/**
 * Recorded content of every explicitly cancelled question, keyed by ref. A cancelled decision is
 * read-only history: only derived `validity`, `stale` and `review` may still change.
 */
function cancelledState(data: RoadmapData): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of data.meta.cancellations ?? []) {
    const q = data.sessions.find((s) => s.id === c.ref.sessionId)?.questions.find((x) => x.id === c.ref.questionId);
    if (q) out.set(refKey(c.ref), cancelledContent(q));
  }
  return out;
}

/**
 * The UI rebind: the epoch increments, the previous binding moves to `plannerHistory` and a live
 * operation is superseded with reason `rebind`, so the previous planner's card is never answered.
 */
function rebindPlanner(session: Session, x: { agentId: string; workspaceId: string | null; at: string; boundBy: "ui" | "discussion" }): number {
  const previous = session.planner;
  const epoch = (previous?.epoch ?? 0) + 1;
  if (previous !== undefined) session.plannerHistory = [...(session.plannerHistory ?? []), previous];
  session.planner = { agentId: x.agentId, workspaceId: x.workspaceId, boundAt: x.at, boundBy: x.boundBy, epoch };
  const live = session.continuation;
  if (live !== undefined && !isTerminalContinuation(live.state)) {
    session.continuation = { ...live, state: "superseded", reason: "rebind", at: x.at };
  }
  return epoch;
}

type BlockAcceptor = Extract<Block, { state: "accepted" }>["acceptedBy"];

/** UI → the human; a chat bound to an agent with the human's quoted consent → that agent; else refused. */
function acceptorOf(origin: WriteOrigin): BlockAcceptor {
  if (origin.source === "ui") return { kind: "human" };
  const agentId = origin.actor.agentId;
  const quoted = origin.quoted?.trim() ?? "";
  if (agentId === undefined || quoted === "") {
    throw new DomainError("invalid_input", "accepting a block from chat needs a chat bound to an agent and the human's quoted consent");
  }
  return { kind: "agent", agentId, quoted };
}

/** The feature card a discussion belongs to; bugs have none. */
function discussableFeature(data: RoadmapData, featureId: string) {
  const f = data.features.find((x) => x.id === featureId);
  if (f === undefined) throw new DomainError("not_found", `feature ${featureId} not found`, { featureId });
  if (f.kind !== "feature") throw new DomainError("invalid_input", "only features have a discussion chat", { featureId });
  return f;
}

/** Whether `ref` depends (activation or invalidation, transitively) on an explicitly cancelled decision. */
function inCancelledChain(data: RoadmapData, ref: Ref): boolean {
  const records = data.meta.cancellations ?? [];
  if (records.length === 0) return false;
  const children = childIndex(data.sessions);
  const key = refKey(ref);
  return records.some((c) => dependentsOf(data.sessions, c.ref, children).some((d) => refKey(d) === key));
}

/** Rejects any direct mutation of an explicitly cancelled question. */
function assertNotCancelled(data: RoadmapData, ref: Ref): void {
  if ((data.meta.cancellations ?? []).some((c) => c.ref.sessionId === ref.sessionId && c.ref.questionId === ref.questionId)) {
    throw new DomainError("decision_cancelled", `decision ${refKey(ref)} was cancelled`, { ref });
  }
}

/** Rejects any direct mutation of a question that belongs to an accepted block. */
function assertNotFrozen(sessions: Session[], ref: Ref): void {
  const s = sessions.find((x) => x.id === ref.sessionId);
  const q = s?.questions.find((x) => x.id === ref.questionId);
  if (s?.blocks === undefined || q?.blockId === undefined) return;
  const block = s.blocks.find((b) => b.id === q.blockId);
  if (block?.state === "accepted") {
    throw new DomainError("block_frozen", `question ${refKey(ref)} belongs to accepted block ${block.id}`, { ref, blockId: block.id });
  }
}

/**
 * Where a new question goes. Returns the session's blocks after placement when the question joins a
 * block, or undefined for a legacy question. An empty session converts to blocks on its first
 * block-scoped question; a session with legacy questions stays legacy; a session with blocks needs
 * the id of its open block.
 */
function blockPlacement(session: Session, blockId: string | undefined, at: string): Block[] | undefined {
  if (session.blocks === undefined) {
    if (blockId === undefined) return undefined;
    if (session.questions.length > 0) {
      throw new DomainError("invalid_input", "a session with legacy questions cannot use blocks", { sessionId: session.id });
    }
    return [{ id: blockId, order: 0, state: "open", openedAt: at }];
  }
  if (blockId === undefined) throw new DomainError("invalid_input", "a session with blocks needs the blockId of its open block");
  const block = session.blocks.find((b) => b.id === blockId);
  if (block === undefined) throw new DomainError("invalid_input", `block ${blockId} is not a block of this session`, { blockId });
  if (block.state === "accepted") throw new DomainError("block_frozen", `block ${blockId} is accepted`, { blockId });
  return session.blocks;
}

/**
 * The Result boundary of commands and services: a DomainError keeps its code, message and details;
 * anything else is logged through the configured log and becomes a fixed, sanitised `internal`.
 */
function resultBoundary(deps: RoadmapServiceDeps): <T>(body: () => Promise<T>) => Promise<Result<T>> {
  const log = deps.storeOptions?.log ?? ((m: string, e?: unknown) => console.error(m, e));
  return async <T>(body: () => Promise<T>): Promise<Result<T>> => {
    try {
      return { ok: true, value: await body() };
    } catch (e) {
      if (isDomainError(e)) {
        return { ok: false, error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
      }
      log("decision-roadmap: unexpected error", e);
      return { ok: false, error: { code: "internal", message: "Unexpected error; see plugin logs." } };
    }
  };
}

export function createRoadmapCommands(deps: RoadmapServiceDeps): RoadmapCommands {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => ulid());
  const toResult = resultBoundary(deps);

  const uiOnly = <T>(message: string): Promise<Result<T>> =>
    toResult(async () => {
      throw new DomainError("invalid_input", message);
    });

  async function readOk(open: StoreOpener, projectId: string) {
    const read = await (await open(projectId)).read();
    if (read.status === "missing") throw new DomainError("store_missing", "No decision roadmap in this project.");
    if (read.status === "invalid") throw new DomainError("store_invalid", read.error.message, read.error);
    return read;
  }

  /** One transaction; `fn` edits the draft and returns the value fields besides `revision`. */
  function mutate<T extends object>(
    open: StoreOpener,
    input: { projectId: string; expectedRevision: number },
    fn: (draft: RoadmapData, at: string) => T,
    allowed: GrillingWrites = {},
  ): Promise<Result<T & { revision: number }>> {
    return toResult(async () => {
      const store = await open(input.projectId);
      const out = await store.transact(input.expectedRevision, (draft) => {
        // Whatever the command, the accepted definition of a frozen question, the record of every
        // question cancelled before it, and every accepted block (with its summary snapshot) must
        // come out unchanged; existing cancellation records are append-only. Answers and notes on
        // accepted questions and derived staleness may change. Numbers are backfilled first, so the
        // projections already hold them (the store backfills them before this callback runs).
        const frozen = frozenState(draft.sessions);
        const cancelled = cancelledState(draft);
        const records = canonicalJson(draft.meta.cancellations ?? []);
        const recordCount = draft.meta.cancellations?.length ?? 0;
        const marks = canonicalJson(draft.meta.outOfScopeMarks ?? []);
        const markCount = draft.meta.outOfScopeMarks?.length ?? 0;
        const finishHistory = new Map(draft.sessions.map((s) => [s.id, { text: canonicalJson(s.finishHistory ?? []), count: s.finishHistory?.length ?? 0 }] as const));
        const closures = new Map(draft.sessions.map((s) => [s.id, structuredClone(s.closures ?? [])] as const));
        const grilling = grillingState(draft.sessions);
        const result = fn(draft, now().toISOString());
        // A planner binding changes only by the first bound ask or the UI rebind; a continuation only
        // where the command declares it. Agents can never move the binding.
        const grillingAfter = grillingState(draft.sessions);
        for (const [id, before] of grilling) {
          const after = grillingAfter.get(id);
          if (after === undefined) continue;
          const firstBinding = allowed.bind === true && before.planner === undefined;
          if (after.binding !== before.binding && allowed.rebind !== true && !firstBinding) {
            throw new DomainError("invalid_input", `the planner binding of session ${id} cannot change here`, { sessionId: id });
          }
          if (after.continuation !== before.continuation && allowed.continuation !== true) {
            throw new DomainError("invalid_input", `the grilling operation of session ${id} cannot change here`, { sessionId: id });
          }
        }
        const after = frozenState(draft.sessions);
        for (const [key, value] of frozen) {
          if (after.get(key) !== value) throw new DomainError("block_frozen", `${key} belongs to an accepted block`, { key });
        }
        const cancelledAfter = cancelledState(draft);
        for (const [key, value] of cancelled) {
          if (cancelledAfter.get(key) !== value) throw new DomainError("decision_cancelled", `decision ${key} was cancelled`, { key });
        }
        if (canonicalJson((draft.meta.cancellations ?? []).slice(0, recordCount)) !== records) {
          throw new DomainError("decision_cancelled", "cancellation records are append-only");
        }
        if (canonicalJson((draft.meta.outOfScopeMarks ?? []).slice(0, markCount)) !== marks) {
          throw new DomainError("invalid_input", "out-of-scope marks are append-only");
        }
        for (const s of draft.sessions) {
          const before = finishHistory.get(s.id);
          if (before === undefined) continue;
          if (canonicalJson((s.finishHistory ?? []).slice(0, before.count)) !== before.text) {
            throw new DomainError("invalid_input", `the finish history of session ${s.id} is append-only`, { sessionId: s.id });
          }
          const closuresBefore = closures.get(s.id);
          if (closuresBefore !== undefined) checkClosures(s.id, closuresBefore, s.closures ?? [], allowed.reopenLastClosure === s.id);
        }
        return result;
      });
      return { ...out.result, revision: out.revision };
    });
  }

  const apply = <C extends GraphChange>(draft: RoadmapData, change: C): C => {
    draft.sessions = change.sessions;
    return change;
  };

  function checkLinkEnd(data: RoadmapData, end: LinkEnd): void {
    const s = data.sessions.find((x) => x.id === end.sessionId);
    const missing = !s || ("questionId" in end && !s.questions.some((q) => q.id === end.questionId));
    if (missing) throw new DomainError("unresolved_ref", "link refers to an unknown session or question", { ref: end });
  }

  return {
    version: (open, i) =>
      toResult(async () => {
        const read = await (await open(i.projectId)).read();
        if (read.status === "ok") return { status: "ok" as const, revision: read.revision };
        if (read.status === "invalid") return { status: "invalid" as const, revision: read.revision ?? null, error: read.error.message };
        return { status: "missing" as const, revision: null };
      }),
    init: (open, i) => toResult(async () => (await open(i.projectId)).init()),
    overview: (open, i) =>
      toResult(async () => {
        const read = await readOk(open, i.projectId);
        return buildOverview(read.data, read.revision, read.disabled);
      }),
    sessionGet: (open, i) =>
      toResult(async () => {
        const read = await readOk(open, i.projectId);
        const view = buildSessionView(read.data, read.revision, i.sessionId);
        // session.get always reports the retry count; the view builder omits a zero.
        return view.grilling === undefined ? view : { ...view, grilling: { ...view.grilling, retryCount: view.grilling.retryCount ?? 0 } };
      }),
    sessionCreate: (open, i) =>
      mutate(open, i, (draft, at) => {
        const sessionId = newId();
        draft.sessions.push({ id: sessionId, title: i.title, createdAt: at, status: "active", questions: [] });
        return { sessionId };
      }),
    questionCreate: (open, i, origin) => {
      if (i.answerText !== undefined && origin.source !== "ui") return uiOnly("a first answer is written with a question only in the Paseo UI");
      return mutate(open, i, (draft, at) => {
        const session = draft.sessions.find((s) => s.id === i.sessionId);
        const blocks = session ? blockPlacement(session, i.blockId, at) : undefined;
        const change = apply(
          draft,
          insertQuestion(draft.sessions, i.sessionId, newId(), {
            title: i.title,
            context: i.context,
            options: i.options,
            ...(i.recommendedOptionId !== undefined ? { recommendedOptionId: i.recommendedOptionId } : {}),
            allowFreeText: i.allowFreeText,
            activatedBy: i.activatedBy,
            invalidatedBy: i.invalidatedBy,
          }),
        );
        if (blocks !== undefined) {
          const created = draft.sessions.find((s) => s.id === i.sessionId)!;
          created.blocks = blocks;
          created.questions.find((q) => q.id === change.questionId)!.blockId = i.blockId;
        }
        // The owner's first text answer goes through the same rules as question.answer; a refusal
        // throws and the transaction writes neither the question nor the answer.
        const answered =
          i.answerText === undefined
            ? undefined
            : apply(draft, applyAnswer(draft.sessions, { sessionId: i.sessionId, questionId: change.questionId }, { text: i.answerText, source: origin.source, actor: actorOf(origin), at }));
        const target = draft.sessions.find((s) => s.id === i.sessionId);
        if (target !== undefined) mintOrKeep(target, at, newId);
        const visibilityChanged = [...change.visibilityChanged];
        for (const ref of answered?.visibilityChanged ?? []) {
          if (!visibilityChanged.some((r) => refKey(r) === refKey(ref))) visibilityChanged.push(ref);
        }
        return { questionId: change.questionId, visibilityChanged, ...(answered !== undefined ? { rev: 1 as const } : {}) };
      }, { continuation: true });
    },
    questionUpdate: (open, i) =>
      mutate(open, i, (draft, at) => {
        assertNotFrozen(draft.sessions, refOf(i));
        assertNotCancelled(draft, refOf(i));
        const change = apply(draft, updateDefinition(draft.sessions, refOf(i), i.patch, at));
        return { definitionRev: change.definitionRev, staleMarked: change.staleMarked };
      }),
    questionAnswer: (open, i, origin) =>
      mutate(open, i, (draft, at) => {
        assertNotCancelled(draft, refOf(i));
        // Recorded only for a UI answer that is the question's recommended option.
        const recommended = findQuestion(draft.sessions, refOf(i)).recommendedOptionId;
        const defaulted = origin.source === "ui" && i.defaulted === true && i.optionId !== undefined && i.optionId === recommended;
        const change = apply(
          draft,
          applyAnswer(draft.sessions, refOf(i), {
            ...(i.optionId !== undefined ? { optionId: i.optionId } : {}),
            ...(defaulted ? { defaulted: true as const } : {}),
            ...(i.text !== undefined ? { text: i.text } : {}),
            ...(i.note !== undefined && i.note !== "" ? { note: i.note } : {}),
            ...chatQuote(origin),
            source: origin.source,
            actor: actorOf(origin),
            at,
          }),
        );
        return {
          rev: change.rev,
          valueChanged: change.valueChanged,
          staleMarked: change.staleMarked,
          visibilityChanged: change.visibilityChanged,
        };
      }),
    questionConfirm: (open, i, origin) =>
      mutate(open, i, (draft, at) => {
        assertNotCancelled(draft, refOf(i));
        const change = apply(draft, confirmAnswer(draft.sessions, refOf(i), { ...chatQuote(origin), source: origin.source, actor: actorOf(origin), at }));
        return { rev: change.rev, visibilityChanged: change.visibilityChanged };
      }),
    questionSkip: (open, i) =>
      mutate(open, i, (draft, at) => {
        assertNotCancelled(draft, refOf(i));
        const change = apply(draft, skipQuestion(draft.sessions, refOf(i), at));
        return { visibilityChanged: change.visibilityChanged };
      }),
    // Allowed on accepted blocks: the question's validity and stale change, which the frozen check
    // ignores, and the mark is appended to the out-of-scope history in meta.
    questionOutOfScope: (open, i, origin) =>
      mutate(open, i, (draft, at) => {
        assertNotCancelled(draft, refOf(i));
        const { quoted } = chatQuote(origin);
        const afterRev = findQuestion(draft.sessions, refOf(i)).answer?.rev;
        const markId = newId();
        const change = apply(draft, markOutOfScope(draft.sessions, refOf(i), at, markId));
        const reason = i.reason?.trim() ?? "";
        draft.meta.outOfScopeMarks = [
          ...(draft.meta.outOfScopeMarks ?? []),
          {
            id: markId,
            ref: refOf(i),
            at,
            source: origin.source,
            actor: actorOf(origin),
            ...(quoted !== undefined ? { quoted } : {}),
            ...(reason !== "" ? { reason } : {}),
            ...(afterRev !== undefined ? { afterRev } : {}),
          },
        ];
        const parts = [...(quoted !== undefined ? [`quoted: "${quoted}"`] : []), ...(reason !== "" ? [reason] : [])];
        if (parts.length > 0) {
          findQuestion(draft.sessions, refOf(i)).discussion.push({ id: newId(), at, actor: actorOf(origin), text: `Out of scope (${parts.join("; ")})` });
        }
        return { visibilityChanged: change.visibilityChanged };
      }),
    questionDiscuss: (open, i, origin) =>
      mutate(open, i, (draft, at) => {
        assertNotCancelled(draft, refOf(i));
        const noteId = newId();
        findQuestion(draft.sessions, refOf(i)).discussion.push({ id: noteId, at, actor: actorOf(origin), text: i.text });
        return { noteId };
      }),
    relationAdd: (open, i) =>
      mutate(open, i, (draft) => {
        // A relation is stored on its target only; a frozen parent or upstream is not changed.
        assertNotFrozen(draft.sessions, refOf(i.relation.target));
        assertNotCancelled(draft, refOf(i.relation.target));
        const change = apply(draft, addRelation(draft.sessions, i.relation));
        return { staleMarked: change.staleMarked, visibilityChanged: change.visibilityChanged };
      }),
    relationRemove: (open, i) =>
      mutate(open, i, (draft) => {
        // A relation is stored on its target only; a frozen parent or upstream is not changed.
        assertNotFrozen(draft.sessions, refOf(i.relation.target));
        assertNotCancelled(draft, refOf(i.relation.target));
        const change = apply(draft, removeRelation(draft.sessions, i.relation));
        return { staleMarked: change.staleMarked, visibilityChanged: change.visibilityChanged };
      }),
    linkCreate: (open, i) =>
      mutate(open, i, (draft) => {
        checkLinkEnd(draft, i.from);
        checkLinkEnd(draft, i.to);
        const linkId = newId();
        draft.meta.links.push({
          id: linkId,
          kind: i.kind,
          from: i.from,
          to: i.to,
          ...(i.note !== undefined ? { note: i.note } : {}),
        });
        return { linkId };
      }),
    linkDelete: (open, i) =>
      mutate(open, i, (draft) => {
        const index = draft.meta.links.findIndex((l) => l.id === i.linkId);
        if (index < 0) throw new DomainError("not_found", `link ${i.linkId} not found`, { linkId: i.linkId });
        draft.meta.links.splice(index, 1);
        return {};
      }),
    // From the UI (human acceptor) or from a chat bound to an agent that reports the human's quoted
    // consent (agent acceptor); anything else is refused inside the transaction, after the revision
    // check, so it writes nothing and is never downgraded. The quote is the agent's attribution of
    // the human's words, not authentication.
    blockAccept: (open, i, origin) => {
      // Set when the committed Accept leaves an operation waiting on the planner's pause card.
      let waiting: string | undefined;
      const out = mutate(open, i, (draft, at) => {
        const acceptedBy = acceptorOf(origin);
        const session = draft.sessions.find((s) => s.id === i.sessionId);
        if (!session) throw new DomainError("not_found", `session ${i.sessionId} not found`, { sessionId: i.sessionId });
        if (session.blocks === undefined) throw new DomainError("invalid_input", "this session has no blocks", { sessionId: i.sessionId });
        const index = session.blocks.findIndex((b) => b.id === i.blockId);
        const block = session.blocks[index];
        if (block === undefined || block.state !== "open") {
          throw new DomainError("invalid_input", `block ${i.blockId} is not the open block of this session`, { blockId: i.blockId });
        }
        const nextBlockId = newId();
        const order = session.blocks.reduce((max, b) => Math.max(max, b.order), block.order) + 1;
        // The summary at acceptance is kept on the block and is the text the operation carries.
        const summary = buildBlockSummary(draft, session.id, block.id);
        session.blocks[index] = {
          id: block.id,
          order: block.order,
          state: "accepted",
          openedAt: block.openedAt,
          acceptedAt: at,
          acceptedBy,
          summary,
        };
        session.blocks.push({ id: nextBlockId, order, state: "open", openedAt: at });
        // Only the operation of this block moves.
        const c = session.continuation;
        if (c !== undefined && c.openBlockId === block.id) {
          const next = acceptTransition(c, { acceptedBlockId: block.id, nextBlockId, summary }, at);
          if (next !== null) {
            session.continuation = next;
            if (next.state === "resolving" || next.state === "accepted_awaiting_pause") waiting = next.operationId;
            // A chat bound by Discuss that cannot be given the block through its card is continued by the engine.
            else if (automaticContinuation(session) !== null) waiting = next.operationId;
          }
        }
        return { blockId: block.id, nextBlockId };
      }, { continuation: true });
      return out.then((result) => {
        if (result.ok && waiting !== undefined) deps.afterAccept?.({ projectId: i.projectId, sessionId: i.sessionId, operationId: waiting });
        return result;
      });
    },
    // UI only, like block acceptance. Accepted (frozen) decisions can be cancelled: there is no
    // frozen check here, and the decision's own record is never changed.
    decisionCancel: (open, i, origin) => {
      if (origin.source !== "ui") {
        return toResult(async () => {
          throw new DomainError("invalid_input", "decisions are cancelled only in the Paseo UI");
        });
      }
      return mutate(open, i, (draft, at) => {
        const reason = i.reason.trim();
        if (reason === "") throw new DomainError("invalid_input", "a cancellation needs a reason");
        const ref = { sessionId: i.sessionId, questionId: i.questionId };
        findQuestion(draft.sessions, ref);
        assertNotCancelled(draft, ref);
        const cancellationId = newId();
        draft.meta.cancellations = [...(draft.meta.cancellations ?? []), { id: cancellationId, ref, reason, at, actor: { kind: "human" } }];
        return { cancellationId };
      });
    },
    // Chat only, by a bound agent. On its own the agent may cancel an unanswered question or any
    // dependent of a cancelled decision; any other answered decision needs the human's quoted words,
    // which are kept on the record.
    questionCancelByAgent: (open, i, origin) =>
      mutate(open, i, (draft, at) => {
        if (origin.source !== "chat" || origin.actor.agentId === undefined) {
          throw new DomainError("invalid_input", "an agent cancellation needs a chat bound to an agent");
        }
        const agentId = origin.actor.agentId;
        const reason = i.reason.trim();
        if (reason === "") throw new DomainError("invalid_input", "a cancellation needs a reason");
        const ref = refOf(i);
        const q = findQuestion(draft.sessions, ref);
        assertNotCancelled(draft, ref);
        const quoted = origin.quoted !== undefined && origin.quoted.trim() !== "" ? origin.quoted : undefined;
        if (q.answer !== undefined && quoted === undefined && !inCancelledChain(draft, ref)) {
          throw new DomainError("invalid_input", "Cancelling an answered decision needs the human's quoted words.", { ref });
        }
        const cancellationId = newId();
        draft.meta.cancellations = [
          ...(draft.meta.cancellations ?? []),
          { id: cancellationId, ref, reason, at, actor: { kind: "agent", agentId }, ...(quoted !== undefined ? { quoted } : {}) },
        ];
        return { cancellationId };
      }),
    // Question definitions carry no provenance; the origin matters only for answers and notes.
    questionCreateBatch: (open, i, _origin, caller) => {
      return mutate(open, i, (draft, at) => {
        if (!Array.isArray(i.questions) || i.questions.length < 1 || i.questions.length > MAX_BATCH) {
          throw new DomainError("invalid_input", `A batch holds 1 to ${MAX_BATCH} questions.`);
        }
        // Placement is decided once for the whole batch; a failing question rolls the batch back.
        const session = draft.sessions.find((s) => s.id === i.sessionId);
        const blocks = session ? blockPlacement(session, i.blockId, at) : undefined;
        const before = computeVisibility(draft.sessions);
        const ids: string[] = [];
        const resolve = (parent: BatchParent, index: number): Ref => {
          if (!("batchIndex" in parent)) return parent;
          const k = parent.batchIndex;
          if (!Number.isInteger(k) || k < 0 || k >= index) {
            throw new DomainError("invalid_input", `Question ${index + 1} may only refer to an earlier question in the batch.`, {
              index,
              batchIndex: k,
            });
          }
          return { sessionId: i.sessionId, questionId: ids[k] };
        };
        i.questions.forEach((q, index) => {
          const id = newId();
          const change = apply(
            draft,
            insertQuestion(draft.sessions, i.sessionId, id, {
              title: q.title,
              context: q.context,
              options: q.options,
              ...(q.recommendedOptionId !== undefined ? { recommendedOptionId: q.recommendedOptionId } : {}),
              ...(q.tag !== undefined ? { tag: q.tag } : {}),
              allowFreeText: q.allowFreeText,
              activatedBy: q.activatedBy.map((a) => ({ parent: resolve(a.parent, index), optionIds: a.optionIds })),
              invalidatedBy: q.invalidatedBy.map((v) => ({ upstream: resolve(v.upstream, index) })),
            }),
          );
          if (blocks !== undefined) {
            const placed = draft.sessions.find((s) => s.id === i.sessionId)!;
            placed.blocks = blocks;
            placed.questions.find((x) => x.id === change.questionId)!.blockId = i.blockId;
          }
          ids.push(change.questionId);
        });
        // New questions count as visible before the batch; report those created hidden and any existing change.
        const after = computeVisibility(draft.sessions);
        const visibilityChanged: Ref[] = [];
        for (const s of draft.sessions) {
          for (const q of s.questions) {
            const key = refKey({ sessionId: s.id, questionId: q.id });
            if ((before.get(key) ?? "active") !== after.get(key)) visibilityChanged.push({ sessionId: s.id, questionId: q.id });
          }
        }
        // The first bound caller becomes the planner (TR6); later callers never change the binding.
        const target = draft.sessions.find((s) => s.id === i.sessionId);
        if (caller !== undefined && target !== undefined && target.planner === undefined) {
          target.planner = { agentId: caller.agentId, workspaceId: caller.workspaceId, boundAt: at, boundBy: "ask", epoch: 1 };
        }
        if (target !== undefined) mintOrKeep(target, at, newId, caller);
        const grilling = target !== undefined ? grillingValue(target, caller) : undefined;
        const created = draft.sessions.find((s) => s.id === i.sessionId)!.questions;
        const numbers = ids.map((id) => questionNumber(created.find((q) => q.id === id)!));
        const links = numbers.map((number) => linksOf({ projectId: i.projectId, sessionId: i.sessionId, number }));
        return { questionIds: ids, numbers, links, visibilityChanged, ...(grilling !== undefined ? { grilling } : {}) };
      }, { bind: true, continuation: true });
    },
    // UI only. A rebind bumps the epoch, keeps the previous binding as history and supersedes a live
    // operation in place, so the previous planner's pending card is never answered.
    plannerSet: (open, i, origin) => {
      if (origin.source !== "ui") {
        return toResult(async () => {
          throw new DomainError("invalid_input", "the planner chat is set only in the Paseo UI");
        });
      }
      return mutate(
        open,
        i,
        (draft, at) => {
          const session = draft.sessions.find((s) => s.id === i.sessionId);
          if (!session) throw new DomainError("not_found", `session ${i.sessionId} not found`, { sessionId: i.sessionId });
          return { epoch: rebindPlanner(session, { agentId: i.agentId, workspaceId: i.workspaceId, at, boundBy: "ui" }) };
        },
        { rebind: true, continuation: true },
      );
    },
    discussionReserve: (open, i, origin) => {
      if (origin.source !== "ui") return uiOnly("a discussion chat is opened only in the Paseo UI");
      return mutate(open, i, (draft, at) => {
        const f = discussableFeature(draft, i.featureId);
        const d = f.discussion;
        if (d?.state === "bound") throw new DomainError("invalid_input", "the feature already has a discussion chat", { featureId: i.featureId });
        if ((d?.state === "creating" || d?.state === "unresolved") && d.reservationId !== i.previous) {
          throw new DomainError("invalid_input", "the discussion chat is being created; try again in a moment", { featureId: i.featureId });
        }
        let sessionId = f.grillSessionId;
        if (sessionId === undefined) {
          sessionId = i.sessionId;
          draft.sessions.push({ id: sessionId, title: `[feature] ${f.title}`, createdAt: at, status: "active", questions: [], ...(i.language !== undefined ? { language: i.language } : {}) });
          f.grillSessionId = sessionId;
        } else if (i.previous === undefined || i.previous !== i.reservationId) {
          // A session no chat has used yet takes the language chosen now; the same reservation retried keeps its own.
          const session = draft.sessions.find((x) => x.id === sessionId);
          if (session !== undefined && session.planner === undefined && session.questions.length === 0) {
            if (i.language !== undefined) session.language = i.language;
            else delete session.language;
          }
        }
        if (i.confirmedNoChat === true && d?.state === "unresolved") {
          f.events.push({ at, actor: { kind: "human" }, kind: "note", reason: retryNote(d.reservationId) });
        }
        f.discussion = { state: "creating", reservationId: i.reservationId, profileRef: i.profileRef, workspaceId: i.workspaceId, at };
        return { sessionId };
      });
    },
    discussionSettle: (open, i, origin) => {
      if (origin.source !== "ui") return uiOnly("a discussion chat is opened only in the Paseo UI");
      return mutate(open, i, (draft, at) => {
        const f = discussableFeature(draft, i.featureId);
        const d = f.discussion;
        if ((d?.state !== "creating" && d?.state !== "unresolved") || d.reservationId !== i.reservationId) {
          throw new DomainError("invalid_input", "the discussion reservation changed", { featureId: i.featureId });
        }
        const base = { reservationId: d.reservationId, profileRef: d.profileRef, workspaceId: d.workspaceId, at: d.at };
        f.discussion = i.state === "failed" ? { state: "failed", ...base, error: i.error } : { state: "unresolved", ...base, checkedAt: at };
        return {};
      });
    },
    discussionBind: (open, i, origin) => {
      if (origin.source !== "ui") return uiOnly("a discussion chat is opened only in the Paseo UI");
      return mutate(
        open,
        i,
        (draft, at) => {
          const f = discussableFeature(draft, i.featureId);
          const d = f.discussion;
          if ((d?.state !== "creating" && d?.state !== "unresolved") || d.reservationId !== i.reservationId) {
            throw new DomainError("invalid_input", "the discussion reservation changed", { featureId: i.featureId });
          }
          const session = f.grillSessionId !== undefined ? draft.sessions.find((s) => s.id === f.grillSessionId) : undefined;
          if (session === undefined) throw new DomainError("not_found", `the session of feature ${i.featureId} is missing`, { featureId: i.featureId });
          // The press that binds the chat sets its language, unless a chat already used the session.
          if (session.planner === undefined && session.questions.length === 0) {
            if (i.language !== undefined) session.language = i.language;
            else delete session.language;
          }
          f.discussion = { state: "bound", reservationId: d.reservationId, agentId: i.agentId, workspaceId: d.workspaceId, boundAt: at, profileRef: d.profileRef };
          f.events.push({ at, actor: { kind: "human" }, kind: "note", reason: `discussion chat bound: ${i.agentId}` });
          const epoch = rebindPlanner(session, { agentId: i.agentId, workspaceId: d.workspaceId, at, boundBy: "discussion" });
          return { sessionId: session.id, epoch };
        },
        { rebind: true, continuation: true },
      );
    },
    // UI only: a completed (closed) session becomes active again; its operation history is kept.
    sessionReopen: (open, i, origin) => {
      if (origin.source !== "ui") {
        return toResult(async () => {
          throw new DomainError("invalid_input", "sessions are reopened only in the Paseo UI");
        });
      }
      return mutate(open, i, (draft, at) => {
        const session = draft.sessions.find((s) => s.id === i.sessionId);
        if (!session) throw new DomainError("not_found", `session ${i.sessionId} not found`, { sessionId: i.sessionId });
        if (session.status !== "closed") throw new DomainError("invalid_input", `session ${i.sessionId} is not closed`, { sessionId: i.sessionId });
        session.status = "active";
        // The close being undone is recorded only when the last closure is still open. A session
        // closed otherwise (by an earlier version, or by the planner's completion) reopens as before.
        const last = session.closures?.at(-1);
        if (session.closures !== undefined && last !== undefined && last.reopenedAt === undefined) {
          session.closures = [...session.closures.slice(0, -1), { ...last, reopenedAt: at }];
        }
        return {};
      }, { reopenLastClosure: i.sessionId });
    },
    sessionLanguageNoticeAck: (open, i, origin) => {
      if (origin.source !== "ui") {
        return toResult(async () => {
          throw new DomainError("invalid_input", "the language notice is acknowledged only in the Paseo UI");
        });
      }
      return toResult(async () => {
        const store = await open(i.projectId);
        const read = await readOk(open, i.projectId);
        if (read.revision !== i.expectedRevision) throw new DomainError("revision_conflict", "store revision changed");
        const current = read.data.sessions.find((s) => s.id === i.sessionId);
        if (!current) throw new DomainError("not_found", `session ${i.sessionId} not found`, { sessionId: i.sessionId });
        // Already acknowledged for this label: nothing to write.
        if (current.languageNoticeAck?.language === i.language) return { revision: read.revision };
        const out = await store.transact(i.expectedRevision, (draft) => {
          const session = draft.sessions.find((s) => s.id === i.sessionId);
          if (!session) throw new DomainError("not_found", `session ${i.sessionId} not found`, { sessionId: i.sessionId });
          session.languageNoticeAck = { language: i.language, at: now().toISOString() };
        });
        return { revision: out.revision };
      });
    },
    pauseInstructions: (open, i, caller) =>
      toResult(async () => {
        const read = await readOk(open, i.projectId);
        const session = read.data.sessions.find((s) => s.id === i.sessionId);
        if (!session) throw new DomainError("not_found", `session ${i.sessionId} not found`, { sessionId: i.sessionId });
        return grillingValue(session, caller) ?? { instructions: NO_BLOCKS_TEXT };
      }),
    // Planner-only and fenced on the current operation. The store revision is checked first, as for
    // every write; the caller and operation checks run inside the transaction.
    grillProposeFinish: (open, i, _origin, caller) =>
      mutate(open, i, (draft, at) => {
        const session = draft.sessions.find((s) => s.id === i.sessionId);
        if (!session) throw new DomainError("not_found", `session ${i.sessionId} not found`, { sessionId: i.sessionId });
        const planner = session.planner;
        if (caller === undefined || planner === undefined || caller.agentId !== planner.agentId) {
          throw new DomainError("planner_bound", "only the session's bound planner chat can propose finishing", { sessionId: i.sessionId });
        }
        if (session.status !== "active") throw new DomainError("invalid_input", "the session is closed; the owner may reopen it", { sessionId: i.sessionId });
        const visibility = computeVisibility(draft.sessions);
        const active = session.questions
          .filter((q) => visibility.get(refKey({ sessionId: session.id, questionId: q.id })) === "active")
          .sort((a, b) => questionNumber(a) - questionNumber(b));
        // The previous proposal, finished or not, moves to the append-only history.
        if (session.finishProposal !== undefined) session.finishHistory = [...(session.finishHistory ?? []), session.finishProposal];
        session.finishProposal = {
          at,
          agentId: caller.agentId,
          summary: i.summary,
          skipped: active.filter((q) => q.validity === "skipped").map(questionNumber),
          outOfScope: active.filter((q) => q.validity === "out_of_scope").map(questionNumber),
        };
        return { instructions: FINISH_PROPOSED_TEXT };
      }),
    // UI only: Finish is the owner's confirmation; no chat or MCP origin may close the session here.
    sessionFinish: (open, i, origin) => {
      if (origin.source !== "ui") {
        return toResult(async () => {
          throw new DomainError("invalid_input", "a session is finished only in the Paseo UI");
        });
      }
      // The basis is checked again here, so a malformed request can never close the session manually.
      const parsed = SessionFinishInput.safeParse(i);
      if (!parsed.success) return uiOnly('session.finish needs basis "proposal" with the proposal\'s proposalAt, or basis "manual"');
      const input = parsed.data;
      return mutate(open, input, (draft, at) => {
        const session = draft.sessions.find((s) => s.id === input.sessionId);
        if (!session) throw new DomainError("not_found", `session ${input.sessionId} not found`, { sessionId: input.sessionId });
        if (session.status === "closed") throw new DomainError("invalid_input", `session ${input.sessionId} is already closed`, { sessionId: input.sessionId });
        // Only a proposal not finished yet is open; one finished by an earlier close is never touched again.
        const standing = session.finishProposal?.finishedAt === undefined ? session.finishProposal : undefined;
        if (input.basis === "proposal") {
          if (standing === undefined) {
            throw new DomainError("invalid_input", "there is no open finish proposal to accept", { sessionId: input.sessionId });
          }
          if (standing.at !== input.proposalAt) {
            throw new DomainError("invalid_input", "the proposal changed; review the new one", { sessionId: input.sessionId, proposalAt: standing.at });
          }
        }
        session.status = "closed";
        if (standing !== undefined) session.finishProposal = { ...standing, finishedAt: at, finishedBy: input.basis };
        // The origin check above admits only the UI, whose actor is the human.
        const base = { at, source: "ui" as const, actor: { kind: "human" as const } };
        const closure: SessionClosure = input.basis === "proposal" ? { ...base, basis: "proposal", proposalAt: input.proposalAt } : { ...base, basis: "manual" };
        session.closures = [...(session.closures ?? []), closure];
        return {};
      });
    },
    grillComplete: (open, i, _origin, caller) =>
      mutate(open, i, (draft, at) => {
        const session = draft.sessions.find((s) => s.id === i.sessionId);
        if (!session) throw new DomainError("not_found", `session ${i.sessionId} not found`, { sessionId: i.sessionId });
        const planner = session.planner;
        if (caller === undefined || planner === undefined || caller.agentId !== planner.agentId) {
          throw new DomainError("planner_bound", "only the session's bound planner chat can complete grilling", { sessionId: i.sessionId });
        }
        // A discussion, or a session with a finish proposal, is finished only by the owner's Finish.
        if (planner.boundBy === "discussion" || session.finishProposal !== undefined) {
          throw new DomainError("invalid_input", "propose finishing with roadmap_grill_propose_finish; the owner confirms with Finish in the panel", {
            sessionId: i.sessionId,
          });
        }
        const c = session.continuation;
        if (c === undefined) throw new DomainError("stale_operation", `operation ${i.operationId} is not the current operation of this session`);
        const current = c.operationId === i.operationId && c.target.agentId === planner.agentId && c.target.epoch === planner.epoch;
        if (!current) {
          throw new DomainError("stale_operation", `operation ${i.operationId} is not the current operation of this session`, { state: c.state });
        }
        if (!COMPLETABLE.includes(c.state)) {
          throw new DomainError(
            "stale_operation",
            `operation ${i.operationId} is the current operation but its state is ${c.state}; completion is accepted only ` +
              "while its card is not shown yet (awaiting_pause, accepted_awaiting_pause) or after the accepted summary was delivered (resumed)",
            { state: c.state },
          );
        }
        session.continuation = { ...c, state: "complete", at };
        session.status = "closed";
        return { state: "complete" as const };
      }, { continuation: true }),
  };
}

/** The feature note recorded, with the new reservation, when the owner confirms a retry of an unresolved creation. */
const retryNote = (reservationId: string) => `owner confirmed no discussion chat was created for reservation ${reservationId}; creating it again`;

/**
 * Whether the owner confirmed a retry under this reservation. The earlier attempt may then have
 * issued a grant marked with the same reservation, which cannot be told apart from the retry's own.
 * The note is written in the reservation's transaction, before the retry creates anything.
 */
export function reservationRetried(feature: Pick<Feature, "events">, reservationId: string): boolean {
  const note = retryNote(reservationId);
  return feature.events.some((e) => e.kind === "note" && e.reason === note);
}

/**
 * The start of the directory counts for an already bound chat: the earlier of the session's creation
 * (a reservation creates the session or finds it, so no grant of the chat's creation predates it) and
 * the binding less `windowMs`.
 */
export function creationWindowStart(sessionCreatedAt: string | undefined, boundAt: string, windowMs: number): string {
  const start = Date.parse(boundAt) - windowMs;
  const created = sessionCreatedAt !== undefined ? Date.parse(sessionCreatedAt) : Number.NaN;
  return new Date(Number.isNaN(created) ? start : Math.min(start, created)).toISOString();
}

type DiscussionAttribution = { reservationId?: string; retried: boolean; since: string };

/**
 * What the tools state of this discussion planner may rely on: the reservation of the Discuss
 * creation that bound it, when a feature records it, whether that reservation was retried, and the
 * start of the directory counts (the earlier of the session's creation and the binding less 60 s);
 * null when the store cannot be read.
 */
async function discussionAttribution(
  open: StoreOpener,
  projectId: string,
  sessionId: string,
  planner: { agentId: string; boundAt: string },
): Promise<DiscussionAttribution | null> {
  try {
    const read = await (await open(projectId)).read();
    if (read.status !== "ok") return null;
    const since = creationWindowStart(read.data.sessions.find((s) => s.id === sessionId)?.createdAt, planner.boundAt, GRANT_WINDOW_MS);
    const feature = read.data.features.find((f) => f.grillSessionId === sessionId);
    const d = feature?.discussion;
    if (feature === undefined || d?.state !== "bound" || d.agentId !== planner.agentId) return { retried: false, since };
    return { reservationId: d.reservationId, retried: reservationRetried(feature, d.reservationId), since };
  } catch {
    return null;
  }
}

export function createRoadmapService(deps: RoadmapServiceDeps): RoadmapService {
  const commands = createRoadmapCommands(deps);
  const toResult = resultBoundary(deps);
  const opener =
    (paseo: PaseoApi): StoreOpener =>
    (projectId) =>
      openProjectStore(deps.directory(paseo), projectId, deps.storeOptions);
  return {
    version: (paseo, i) => commands.version(opener(paseo), i, UI_ORIGIN),
    init: (paseo, i) => commands.init(opener(paseo), i, UI_ORIGIN),
    overview: (paseo, i) => commands.overview(opener(paseo), i, UI_ORIGIN),
    // Only the panel's read of a discussion planner's session reads the grant state and the host's
    // workspaces; other sessions and the MCP tools never do.
    sessionGet: async (paseo, i) => {
      const out = await commands.sessionGet(opener(paseo), i, UI_ORIGIN);
      const planner = out.ok ? out.value.session.planner : undefined;
      if (!out.ok || deps.state === undefined || out.value.grilling === undefined || planner?.boundBy !== "discussion") return out;
      // The workspace is listed only when grants must be counted by directory: unmarked ones for a
      // planner with a reservation, every live unbound one for a planner without; both only those
      // issued at or after the attribution's `since`.
      const cwd = async () => {
        if (planner.workspaceId === null) return undefined;
        try {
          const workspace = (await deps.directory(paseo).listWorkspaces()).find((w) => w.id === planner.workspaceId && w.projectId === i.projectId);
          return workspace?.directory;
        } catch {
          return undefined;
        }
      };
      const attribution = await discussionAttribution(opener(paseo), i.projectId, i.sessionId, planner);
      const tools = attribution === null ? "unknown" : await toolsState(deps.state, { agentId: planner.agentId, ...attribution, cwd });
      return { ...out, value: { ...out.value, grilling: { ...out.value.grilling, tools } } };
    },
    sessionCreate: (paseo, i) => commands.sessionCreate(opener(paseo), i, UI_ORIGIN),
    questionCreate: (paseo, i) => commands.questionCreate(opener(paseo), i, UI_ORIGIN),
    questionUpdate: (paseo, i) => commands.questionUpdate(opener(paseo), i, UI_ORIGIN),
    questionAnswer: (paseo, i) => commands.questionAnswer(opener(paseo), i, UI_ORIGIN),
    questionConfirm: (paseo, i) => commands.questionConfirm(opener(paseo), i, UI_ORIGIN),
    questionSkip: (paseo, i) => commands.questionSkip(opener(paseo), i, UI_ORIGIN),
    questionOutOfScope: (paseo, i) => commands.questionOutOfScope(opener(paseo), i, UI_ORIGIN),
    questionDiscuss: (paseo, i) => commands.questionDiscuss(opener(paseo), i, UI_ORIGIN),
    relationAdd: (paseo, i) => commands.relationAdd(opener(paseo), i, UI_ORIGIN),
    relationRemove: (paseo, i) => commands.relationRemove(opener(paseo), i, UI_ORIGIN),
    linkCreate: (paseo, i) => commands.linkCreate(opener(paseo), i, UI_ORIGIN),
    linkDelete: (paseo, i) => commands.linkDelete(opener(paseo), i, UI_ORIGIN),
    blockAccept: (paseo, i) => commands.blockAccept(opener(paseo), i, UI_ORIGIN),
    decisionCancel: (paseo, i) => commands.decisionCancel(opener(paseo), i, UI_ORIGIN),
    // The planner's workspace comes from the host snapshot, never from the RPC input.
    plannerSet: async (paseo, i) => {
      // The host read sits inside the same Result boundary as the commands: a rejecting refresh is
      // logged and becomes `internal`, never a raw rejection.
      const host = await toResult(async () => {
        const found = await paseo.agents.ref(i.agentId).refresh();
        if (found === null) throw new DomainError("not_found", `agent ${i.agentId} not found`, { agentId: i.agentId });
        const { archivedAt, workspaceId } = found.agent;
        if (typeof archivedAt === "string" && archivedAt !== "") {
          throw new DomainError("invalid_input", `agent ${i.agentId} is archived`, { agentId: i.agentId });
        }
        return workspaceId ?? null;
      });
      if (!host.ok) return host;
      return commands.plannerSet(opener(paseo), { ...i, workspaceId: host.value }, UI_ORIGIN);
    },
    sessionReopen: (paseo, i) => commands.sessionReopen(opener(paseo), i, UI_ORIGIN),
    sessionLanguageNoticeAck: (paseo, i) => commands.sessionLanguageNoticeAck(opener(paseo), i, UI_ORIGIN),
    sessionFinish: (paseo, i) => commands.sessionFinish(opener(paseo), i, UI_ORIGIN),
  };
}
