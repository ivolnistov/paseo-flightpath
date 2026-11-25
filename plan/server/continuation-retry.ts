// The continuation message shared by the owner's Retry and the automatic continuation of a chat bound
// by Discuss: one durable record per send, committed `sending` before it, whose id is the message id
// and whose token [DR-RETRY-<id>] is in the text.
import { DomainError } from "../shared/errors";
import type { Block, Continuation, ContinuationRetry, RoadmapData, Session } from "../shared/model";

type AcceptedBlock = Extract<Block, { state: "accepted" }>;
import { buildBlockSummary } from "./summary";

export const RETRY_PREFIX = "Decision Roadmap (manual continuation)";
export const AUTO_PREFIX = "Decision Roadmap (continuation)";
export const retryToken = (id: string): string => `[DR-RETRY-${id}]`;

export function retryText(prefix: string, id: string, summary: string): string {
  return `${prefix} ${retryToken(id)}:\n${summary}\nContinue with the next batch through roadmap_ask, or propose finishing through roadmap_grill_propose_finish.`;
}

/**
 * `failed` only for rejections known to happen before the daemon dispatches anything: the
 * authentication refusal (recognised by its error name, as the class is not exported from the
 * public client entry) and the daemon's `Agent not found: <id>` answer to an unknown agent.
 * Everything else, connection loss and request timeouts included, is `unknown`.
 */
export function classifySendError(e: unknown): "failed" | "unknown" {
  if (!(e instanceof Error)) return "unknown";
  if (e.name === "DaemonAuthenticationError") return "failed";
  if (e.name === "DaemonConnectionError") return "unknown";
  return /^Agent not found: /.test(e.message) ? "failed" : "unknown";
}

/** What is recorded about a rejection: the reason of a pre-dispatch refusal, else only its kind. */
export function recordedError(e: unknown, state: "failed" | "unknown"): string {
  if (!(e instanceof Error)) return "non-error rejection";
  if (state === "failed") return e.message;
  const code = "code" in e && typeof e.code === "string" ? e.code : undefined;
  return code ?? e.name;
}

/** The text the chat is given for an accepted block: the summary frozen at Accept when present. */
export function acceptedSummary(data: RoadmapData, session: Session, accepted: AcceptedBlock): string {
  const carried = session.continuation?.acceptedBlockId === accepted.id ? session.continuation.summary : undefined;
  return accepted.summary ?? carried ?? buildBlockSummary(data, session.id, accepted.id);
}

/** The records of one accepted block, operation and planner binding. */
export const retriesOf = (s: Session, x: { blockId: string; operationId: string; agentId: string; epoch: number }): ContinuationRetry[] =>
  (s.retries ?? []).filter((r) => r.blockId === x.blockId && r.operationId === x.operationId && r.agentId === x.agentId && r.epoch === x.epoch);

/**
 * Terminal reasons after which the chat is known to wait without having been given the accepted
 * block: it cannot pause at all (`unsupported`, e.g. Codex in default mode), or its turn ended
 * without the pause card (before or after Accept). Every other reason (the owner answered the card
 * in the chat, a deviating card, an uncertain answer, a lost card, an unavailable chat, a newer
 * operation) is left to the owner.
 */
const AUTOMATIC_REASON = /^(unsupported(: .*)?|no_pause|pause_lost: no_pause)$/;

/**
 * The operation of a chat bound by Discuss whose accepted block the plugin continues by itself, when
 * no record exists for it yet; null otherwise. At most one record per accepted block, operation and
 * binding is ever written automatically, whatever happened to it later.
 */
export function automaticContinuation(s: Session): { c: Continuation; block: AcceptedBlock } | null {
  const planner = s.planner;
  const c = s.continuation;
  if (planner?.boundBy !== "discussion" || s.status !== "active" || c === undefined) return null;
  // The planner proposed finishing: another batch is not what it waits for.
  if (s.finishProposal !== undefined && s.finishProposal.finishedAt === undefined) return null;
  if (c.state !== "needs_manual" || c.reason === undefined || !AUTOMATIC_REASON.test(c.reason)) return null;
  if (c.target.agentId !== planner.agentId || c.target.epoch !== planner.epoch || c.acceptedBlockId === undefined) return null;
  const block = s.blocks?.find((b) => b.id === c.acceptedBlockId);
  if (block === undefined || block.state !== "accepted") return null;
  if (retriesOf(s, { blockId: block.id, operationId: c.operationId, agentId: planner.agentId, epoch: planner.epoch }).length > 0) return null;
  return { c, block };
}

/**
 * Whether the claimed record `id` may still be sent, on the state at the committed revision: it is
 * this engine's unsent automatic record, and the session is still active, bound to the same chat by
 * Discuss in the same epoch, on the same operation and accepted block, with no open finish proposal.
 */
export function admissibleAutomatic(data: RoadmapData, sessionId: string, id: string): boolean {
  const s = data.sessions.find((x) => x.id === sessionId);
  const r = s?.retries?.find((x) => x.id === id);
  if (s === undefined || r === undefined || r.state !== "sending" || r.origin !== "automatic" || r.resolvedBy !== undefined) return false;
  const planner = s.planner;
  const c = s.continuation;
  if (s.status !== "active" || planner?.boundBy !== "discussion" || planner.agentId !== r.agentId || planner.epoch !== r.epoch) return false;
  if (s.finishProposal !== undefined && s.finishProposal.finishedAt === undefined) return false;
  if (c === undefined || c.state !== "needs_manual" || c.operationId !== r.operationId || c.acceptedBlockId !== r.blockId) return false;
  if (c.target.agentId !== planner.agentId || c.target.epoch !== planner.epoch) return false;
  return s.blocks?.find((b) => b.id === r.blockId)?.state === "accepted";
}

/**
 * Inside a store transaction: writes the automatic record `sending` for the session's operation
 * `operationId` and returns the message to send, or throws when the operation no longer qualifies
 * (the guard runs on the state the record is written against).
 */
export function claimAutomatic(draft: RoadmapData, sessionId: string, operationId: string, id: string, at: string): { agentId: string; text: string } {
  const s = draft.sessions.find((x) => x.id === sessionId);
  const found = s !== undefined ? automaticContinuation(s) : null;
  if (s === undefined || found === null || found.c.operationId !== operationId) throw new DomainError("invalid_input", "the operation no longer needs an automatic continuation");
  const { agentId, epoch } = s.planner!;
  s.retries = [...(s.retries ?? []), { id, at, operationId, blockId: found.block.id, agentId, epoch, state: "sending", origin: "automatic" }];
  return { agentId, text: retryText(AUTO_PREFIX, id, acceptedSummary(draft, s, found.block)) };
}
