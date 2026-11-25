// Feature discussion contracts (part of `STAGE_D_CONTRACTS` in `./rpc`).
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { Id, IsoTime } from "./model";
import { Mutation, ProjectInput, Refs, result, Written } from "./rpc-base";

/** Marks one active question out of scope; distinct from skipping. The actor is set by the server. */
export const QuestionOutOfScope = defineRpc({
  name: "question.out_of_scope",
  input: Mutation.extend({ sessionId: Id, questionId: Id, reason: z.string().optional() }),
  output: result(Written.extend({ visibilityChanged: Refs })),
});

/**
 * The owner's Finish: closes the session and marks an open finish proposal finished. UI only. The
 * basis is required: accepting the open proposal made at `proposalAt`, or a manual finish.
 */
export const SessionFinishInput = z.discriminatedUnion("basis", [
  Mutation.extend({ sessionId: Id, basis: z.literal("proposal"), proposalAt: IsoTime }).strict(),
  Mutation.extend({ sessionId: Id, basis: z.literal("manual") }).strict(),
]);
export const SessionFinish = defineRpc({
  name: "session.finish",
  input: SessionFinishInput,
  output: result(Written),
});

/** Whether the discussion chat's roadmap MCP tools are attached, as far as the plugin can tell. */
export const DiscussionTools = z.enum(["attached", "pending", "not_attached", "unknown"]);
export type DiscussionTools = z.infer<typeof DiscussionTools>;

/**
 * One-click Discuss on a feature card (UI only): creates the feature's discussion chat in the panel's
 * workspace when absent and binds it as the session planner, or returns the existing one. An
 * unresolved creation is created again only with `retryUnresolved` together with `confirmedNoChat`,
 * the owner's explicit confirmation that they checked and no chat was created.
 */
export const FeatureDiscussionOpen = defineRpc({
  name: "feature.discussion.open",
  input: Mutation.extend({
    featureId: Id,
    workspaceId: Id,
    profileRef: z.string().min(1).optional(),
    retryUnresolved: z.literal(true).optional(),
    confirmedNoChat: z.literal(true).optional(),
    /** The discussion language: English when absent; otherwise one configured in the roadmap settings. */
    language: z.string().min(1).max(40).optional(),
  }),
  output: result(Written.extend({ sessionId: Id, agentId: Id, workspaceId: Id, created: z.boolean(), tools: DiscussionTools })),
});

/**
 * Retry of a manual continuation (UI only): one send of the accepted block's summary to the planner.
 * `sent`: the host accepted the message (not that the chat consumed it); `sending`: accepted, but the
 * outcome could not be written yet.
 */
export const DiscussionRetry = defineRpc({
  name: "discussion.retry",
  input: Mutation.extend({ sessionId: Id }),
  output: result(Written.extend({ retryId: Id, sentTo: Id, state: z.enum(["sent", "sending"]) })),
});

/** The owner's mark of an uncertain retry: delivered (sent) or not delivered (failed, Retry enabled). */
export const DiscussionRetryResolve = defineRpc({
  name: "discussion.retry.resolve",
  input: Mutation.extend({ sessionId: Id, retryId: Id, outcome: z.enum(["delivered", "not_delivered"]) }),
  output: result(Written),
});

/** Looks for the retry's token in the planner's timeline; marks it sent only when observed. Never resends. */
export const DiscussionRetryCheck = defineRpc({
  name: "discussion.retry.check",
  input: ProjectInput.extend({ sessionId: Id, retryId: Id }),
  output: result(z.object({ state: z.enum(["sending", "sent", "failed", "unknown"]) })),
});
