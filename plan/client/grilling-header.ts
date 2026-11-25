// Automatic grilling header (S3/G5, PLAN §3.8): the status line of a session with blocks, the manual
// recovery hint and which grilling actions the screen offers. Pure; reads only the session view the
// server derives (`SessionView.grilling`, `session.planner`, `session.status`).
import type { GrillingView, SessionView } from "../shared/rpc";

export const MANUAL_RECOVERY_TEXT = "Continue the conversation in the chat, or bind another chat.";

const PHRASES: Partial<Record<GrillingView["status"], string>> = {
  no_planner: "No planner bound",
  idle: "waiting for the chat's next batch",
  waiting_for_answers: "waiting for answers",
  waiting_for_accept: "waiting for Accept (card shown in chat)",
  accepted_waiting_for_pause: "accepted; answering when the chat pauses",
  answering: "answering…",
  continued: "continued",
  outcome_unknown: "outcome unknown: check the chat",
  chat_moved_on: "the chat moved on; continue there",
  card_mismatch: "card mismatch",
  complete: "grilling complete",
};

function pauseLostPhrase(reason: string | undefined): string {
  if (reason === "archived") return "unavailable: archived";
  if (reason === "closed") return "unavailable: closed";
  if (reason === "unavailable") return "unavailable: chat not found";
  if (reason === "no_pause") return "the chat did not pause";
  if (reason === "restart") return "pause lost after host restart";
  if (reason?.startsWith("turn_ended:") === true) return `pause lost: turn ended (${reason.slice("turn_ended:".length)})`;
  return "pause lost";
}

function needsManualPhrase(reason: string | undefined): string {
  if (reason === "answer_failed") return "answer not delivered: answer the card in the chat";
  if (reason === "no_pause") return "the chat did not pause";
  if (reason === "pause_answered_externally") return "the chat moved on; continue there";
  if (reason?.startsWith("pause_mismatch") === true) return "card mismatch";
  if (reason?.startsWith("unsupported") === true) return "unsupported";
  if (reason?.startsWith("pause_lost") === true) return "pause lost";
  return "needs manual recovery";
}

/** The automatic continuation of a chat bound by Discuss, when there is one; null otherwise. */
function automaticPhrase(g: GrillingView): string | null {
  if (g.automatic === "waiting") return "accepted; the chat is given the block once it is idle with no pending prompt";
  const last = g.lastRetry;
  if (last?.origin !== "automatic") return null;
  switch (last.state) {
    case "sent":
      return "accepted; continuation sent to the chat";
    case "failed":
      return "continuation not delivered: Retry";
    default:
      return "continuation outcome unknown: check the chat";
  }
}

/** The status phrase of a grilling view; never empty. */
export function grillingStatusText(g: GrillingView): string {
  if (g.status === "needs_manual") {
    const automatic = automaticPhrase(g);
    if (automatic !== null) return automatic;
  }
  switch (g.status) {
    case "pause_lost":
      return pauseLostPhrase(g.reason);
    case "needs_manual":
      return needsManualPhrase(g.reason);
    case "unsupported":
      return g.reason !== undefined && g.reason !== "" ? `unsupported: ${g.reason}` : "unsupported";
    case "planner_changed":
      // A newer batch replaced the operation (the planner moved on), unlike a rebind to another chat.
      return g.reason === "block_advanced" ? "superseded by the chat's next batch" : "planner changed";
    default:
      return PHRASES[g.status] ?? g.status;
  }
}

/** The header of a session with blocks; null for a legacy session (no grilling view). */
export function grillingHeader(view: SessionView, plannerTitle: string | null): { text: string; recovery: string | null } | null {
  const g = view.grilling;
  if (g === undefined) return null;
  // The plugin continues a chat bound by Discuss itself: no "continue by hand" line while that
  // continuation waits or was sent (an unknown or failed one still needs the owner).
  const last = g.lastRetry;
  const automatic = g.automatic === "waiting" || (last?.origin === "automatic" && (last.state === "sending" || last.state === "sent"));
  const recovery = g.manualRecovery && !automatic ? MANUAL_RECOVERY_TEXT : null;
  if (g.status === "no_planner") return { text: "No planner bound", recovery };
  const name = plannerTitle !== null && plannerTitle !== "" ? plannerTitle : (g.plannerAgentId ?? view.session.planner?.agentId ?? "");
  return { text: `Planner: ${name} · ${grillingStatusText(g)}`, recovery };
}

/** The planner chat's status as the host's client state reports it; null when it is not known. */
export type PlannerStatus = "initializing" | "idle" | "running" | "error" | "closed" | null;

export const INTERRUPT_WARNING_RUNNING = "The chat is responding: Retry interrupts its current answer.";
export const INTERRUPT_WARNING_UNKNOWN = "The chat's state is unknown: if it is responding, Retry interrupts its current answer.";

export type RetryAction = {
  enabled: boolean;
  /** When the last retry was sent; Retry is then blocked. */
  sentAt?: string;
  /** The last retry's outcome is unknown since this time: the owner checks the chat and marks it. */
  unknownSince?: string;
  retryId?: string;
  /** The last message was the plugin's automatic continuation, not the owner's Retry. */
  automatic?: true;
  /** Shown before sending: the host interrupts an answer in progress (it has no queue mode). */
  interruptWarning?: string;
};

export type GrillingActions = { accept: boolean; bind: "bind" | "change" | null; reopen: boolean; retry: RetryAction | null; finish: boolean };

/**
 * Which grilling actions the screen offers: Accept, Bind/Change chat, Reopen (S3-TASKS §3.3), Retry of
 * a manual continuation (only under manual recovery with a bound planner) and the owner's Finish (in
 * any active session with blocks, never on a closed or legacy session).
 */
export function grillingActions(view: SessionView, opts: { plannerStatus?: PlannerStatus | string } = {}): GrillingActions {
  if (view.session.blocks === undefined) return { accept: false, bind: null, reopen: false, retry: null, finish: false };
  if (view.session.status === "closed") return { accept: false, bind: null, reopen: true, retry: null, finish: false };
  const open = view.session.blocks.some((b) => b.state === "open");
  const g = view.grilling;
  const manual = g?.manualRecovery === true;
  return {
    accept: open && g?.status !== "complete",
    bind: view.session.planner === undefined ? "bind" : "change",
    reopen: false,
    retry: manual && view.session.planner !== undefined ? retryAction(view, opts.plannerStatus) : null,
    finish: true,
  };
}

/** The Chat menu's Retry item: enabled state and the one hint that explains it. */
export function retryItem(retry: RetryAction | null): { enabled: boolean; hint: string } {
  const at = (iso: string) => iso.replace("T", " ").slice(0, 16);
  if (retry === null) return { enabled: false, hint: "Nothing to retry" };
  if (retry.sentAt !== undefined) return { enabled: false, hint: `Sent at ${at(retry.sentAt)}` };
  if (retry.unknownSince !== undefined) return { enabled: false, hint: `Delivery unknown since ${at(retry.unknownSince)}: check the chat` };
  if (!retry.enabled) return { enabled: false, hint: "Nothing to retry" };
  return { enabled: true, hint: retry.interruptWarning ?? "Resends the accepted summary to the chat" };
}

/** The discussion chat's roadmap tools: the short state for the visible line, the explanation for the menu. */
export const TOOLS_STATE = { attached: "attached", pending: "pending", not_attached: "not attached", unknown: "unknown" } as const;
export const TOOLS_EXPLANATION = {
  attached: "The chat holds a current grant for the roadmap tools.",
  pending: "Issued for this chat; they attach when its session starts.",
  not_attached: "The chat holds no current grant for them.",
  unknown: "The plugin cannot tell which tools, if any, belong to this chat.",
} as const;

type Closure = NonNullable<SessionView["session"]["closures"]>[number];
const closureTime = (iso: string) => iso.replace("T", " ").slice(0, 16);
const closureBasis = (c: Closure) => (c.basis === "proposal" ? `by accepting the chat's proposal of ${closureTime(c.proposalAt)}` : "manually");

/**
 * The line that says how the session was last closed, from the last closure only. A closed session
 * whose last closure was already reopened was closed some other way (an earlier version or the
 * chat's completion): its basis is not recorded, and the earlier closure is never named as current.
 * An active session last closed by the chat's grilling completion (later than any recorded reopen)
 * says so, without a reopen time. Null for an active session with no recorded or chat close, and for
 * a closed session with neither blocks nor closures (a legacy session); a legacy session with closures
 * gets a line.
 */
export function closureLine(view: SessionView): string | null {
  const s = view.session;
  const last = s.closures?.at(-1);
  if (s.status === "closed") {
    if (last === undefined || last.reopenedAt !== undefined) return s.blocks !== undefined || last !== undefined ? "Closed (basis not recorded)" : null;
    const marked = [s.finishProposal, ...(s.finishHistory ?? [])].find((p) => p !== undefined && p.finishedBy === "manual" && p.finishedAt === last.at);
    const notAccepted = last.basis === "manual" && marked !== undefined ? `; the chat's proposal of ${closureTime(marked.at)} was not accepted` : "";
    return `Closed ${closureTime(last.at)} · ${closureBasis(last)}${notAccepted}`;
  }
  // A chat's roadmap_grill_complete closes the session without a closure record; its completed
  // continuation (current, or archived by the chat's next batch) keeps the time. One later than the last
  // recorded reopen means the last closure is not the latest close: that was the chat's, and the reopen
  // that undid it is not recorded, so no reopen time is given.
  const chatClose = [s.continuation, ...(s.continuations ?? [])]
    .filter((c) => c !== undefined && c.state === "complete")
    .map((c) => c!.at)
    .sort()
    .at(-1);
  if (chatClose !== undefined && (last === undefined || (last.reopenedAt !== undefined && chatClose > last.reopenedAt))) {
    return `Reopened (time not recorded) · previously closed ${closureTime(chatClose)} by the chat completing grilling`;
  }
  if (last?.reopenedAt !== undefined) return `Reopened ${closureTime(last.reopenedAt)} · previously closed ${closureTime(last.at)} (${closureBasis(last)})`;
  return null;
}

function retryAction(view: SessionView, plannerStatus: string | null | undefined): RetryAction {
  const last = view.grilling?.lastRetry;
  const automatic = last?.origin === "automatic" ? { automatic: true as const } : {};
  if (last?.state === "sent") return { enabled: false, sentAt: last.at, ...automatic };
  if (last?.state === "sending" || last?.state === "unknown") return { enabled: false, unknownSince: last.at, retryId: last.id, ...automatic };
  // Only a known idle chat needs no warning; an unknown state is never assumed idle.
  if (plannerStatus === "idle") return { enabled: true };
  return { enabled: true, interruptWarning: plannerStatus === "running" ? INTERRUPT_WARNING_RUNNING : INTERRUPT_WARNING_UNKNOWN };
}

export const NO_TRANSLATION_WARNING =
  "English is recommended for the questions, because they are ultimately needed in English; no translation is performed in this version, so questions are shown as the agent wrote them.";

const isEnglish = (value: string) => ["en", "english"].includes(value.trim().toLowerCase());

/**
 * The session's effective language: the one chosen at Discuss when stored with the session, else (earlier
 * sessions) the question tagged "language", English until it is answered otherwise, chosen or typed
 * ("en" or "English" in any case; an empty free-text answer reads as English). Any other language carries the notice that recommends English and
 * says nothing is translated (`warning` and `notice` are that text); `acknowledged` is true once the
 * owner pressed Got it for exactly this label. `known` is false only for a session with no language
 * information at all (a legacy session without blocks or a tagged question), which shows no chip.
 */
export function sessionLanguage(view: SessionView): { label: string; warning: string | null; notice: string | null; acknowledged: boolean; known: boolean } {
  const tagged = view.questions.find((qv) => qv.question.tag === "language")?.question;
  const known = view.session.language !== undefined || tagged !== undefined || view.session.blocks !== undefined;
  const result = (label: string) => {
    // An empty free-text answer names no language: English, with nothing to acknowledge.
    const english = label.trim() === "" || isEnglish(label);
    const notice = english ? null : NO_TRANSLATION_WARNING;
    return { label: english ? "English" : label, warning: notice, notice, acknowledged: !english && view.session.languageNoticeAck?.language === label, known };
  };
  const stored = view.session.language;
  if (stored !== undefined) return result(stored);
  const answer = tagged !== undefined && (tagged.validity === "valid" || tagged.validity === "stale") ? tagged.answer : undefined;
  if (tagged === undefined || answer === undefined) return result("English");
  if (answer.optionId !== undefined && isEnglish(answer.optionId)) return result("English");
  return result(answer.text !== undefined ? answer.text.trim() : (tagged.options.find((o) => o.id === answer.optionId)?.label ?? answer.optionId ?? ""));
}

/**
 * What an empty open block says about the session, first match wins; each branch quotes the phrase
 * the header shows for that state, so the two never disagree. It never promises more questions.
 * `blockNumber` is the open block's number; the previous block's summary is the one in flight.
 */
export function emptyBlockLine(view: SessionView, blockNumber: number): string {
  const g = view.grilling;
  const at = (iso: string) => iso.replace("T", " ").slice(0, 16);
  if (view.session.status === "closed") return "The session is closed; nothing more is added here.";
  if (g === undefined) return "Nothing has been added here yet.";
  if (g.status === "complete") return "Grilling is complete; the chat asks nothing more in this session.";
  if (g.finishProposal !== undefined) return "The chat proposes to finish rather than ask more. Its proposal is in the navigator.";
  if (g.automatic === "waiting") return "Nothing was sent yet: the plugin gives the chat the accepted summary once the chat is idle with nothing pending.";
  const last = g.lastRetry;
  if (last?.state === "sending") return `The summary is being sent to the chat (since ${at(last.at)}); delivery is not confirmed yet.`;
  if (last?.state === "sent") {
    return last.origin === "automatic"
      ? `The chat was given Block ${blockNumber - 1}'s summary at ${at(last.at)}. Nothing has been added here since.`
      : `Retry sent at ${at(last.at)}. Nothing has been added here since.`;
  }
  if (last?.state === "unknown") return `Delivery of the summary is unknown since ${at(last.at)}: check the chat and mark the outcome above.`;
  if (last?.state === "failed") return `The summary was not delivered: ${grillingStatusText(g)}. Retry is in the Chat menu.`;
  if (g.status === "no_planner") return "No chat is bound. Bind a chat from the Chat menu, or add questions yourself.";
  if (g.manualRecovery) return `The chat did not continue: ${grillingStatusText(g)}. ${MANUAL_RECOVERY_TEXT}`;
  return `The chat is ${grillingStatusText(g)}. Nothing has been added here yet.`;
}
