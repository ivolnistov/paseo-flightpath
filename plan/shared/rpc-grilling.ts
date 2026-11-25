// Automatic grilling contracts: the planner binding and reopening (`STAGE_G_CONTRACTS` in `./rpc`),
// whose binding workspace, time and epoch are set by the server, never taken from the input; and the
// language-notice acknowledgement (`STAGE_U_CONTRACTS`). All three are UI only.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { Id, NoticeLanguage } from "./model";
import { Mutation, result, Written } from "./rpc-base";

/** Binds (or rebinds) the session's planner chat; a rebind bumps the epoch and supersedes a live operation. */
export const SessionPlannerSet = defineRpc({
  name: "session.planner.set",
  input: Mutation.extend({ sessionId: Id, agentId: Id }),
  output: result(Written.extend({ epoch: z.number().int().min(1) })),
});

/** Reopens a completed (closed) session; the next batch the chat posts starts a new operation. */
export const SessionReopen = defineRpc({
  name: "session.reopen",
  input: Mutation.extend({ sessionId: Id }),
  output: result(Written),
});

/**
 * The owner's Got it on the no-translation notice for the language label shown (UI only, part of
 * `STAGE_U_CONTRACTS`): stores `languageNoticeAck`; the same label again writes nothing.
 */
export const SessionLanguageNoticeAck = defineRpc({
  name: "session.language_notice.ack",
  input: Mutation.extend({ sessionId: Id, language: NoticeLanguage }),
  output: result(Written),
});

/** What the session header shows for a session with blocks, derived from its planner and continuation. */
export const GRILLING_STATUSES = [
  "no_planner",
  "idle",
  "waiting_for_answers",
  "waiting_for_accept",
  "accepted_waiting_for_pause",
  "answering",
  "continued",
  "outcome_unknown",
  "chat_moved_on",
  "pause_lost",
  "card_mismatch",
  "unsupported",
  "planner_changed",
  "needs_manual",
  "complete",
] as const;
export const GrillingStatus = z.enum(GRILLING_STATUSES);
export type GrillingStatus = z.infer<typeof GrillingStatus>;

export const GrillingView = z
  .object({
    status: GrillingStatus,
    manualRecovery: z.boolean(),
    reason: z.string().optional(),
    operationId: Id.optional(),
    plannerAgentId: Id.optional(),
    epoch: z.number().int().min(1).optional(),
    /** The planner's open (not yet finished) proposal to finish. */
    finishProposal: z
      .object({ at: z.string(), summary: z.string(), skipped: z.array(z.number().int()), outOfScope: z.array(z.number().int()) })
      .strict()
      .optional(),
    /** Manual continuation retries recorded for the session; session.get always sets it, the bare view omits 0. */
    retryCount: z.number().int().min(0).optional(),
    lastRetry: z
      .object({ id: Id, at: z.string(), state: z.enum(["sending", "sent", "failed", "unknown"]), origin: z.enum(["automatic"]).optional() })
      .strict()
      .optional(),
    /**
     * `waiting`: the plugin will give the accepted block to this chat bound by Discuss by one message
     * as soon as the chat is idle with no pending permission or question; nothing was sent yet.
     */
    automatic: z.enum(["waiting"]).optional(),
    /** A discussion planner's roadmap tools, read from the grant state on each panel read. */
    tools: z.enum(["attached", "pending", "not_attached", "unknown"]).optional(),
  })
  .strict();
export type GrillingView = z.infer<typeof GrillingView>;
