// The pause card a grilling planner shows between batches (PLAN §3.3) and the notices for every
// caller that must not pause (TR11). Pure text; the matcher in ./pause compares against these.

export const PAUSE_HEADER = "Roadmap";
export const PAUSE_OPTIONS = ["Continue", "Stop"] as const;

/** The token that ties a pause card to one grilling operation. */
export const operationToken = (operationId: string): string => `DR-OP-${operationId}`;

/** The exact question text of the pause card for an operation. */
export const pauseQuestionText = (operationId: string): string =>
  `Decision Roadmap: waiting for block acceptance (${operationToken(operationId)})`;

/**
 * A block id in plugin-authored text, encoded as a JSON string: the id is data (another granted chat can
 * choose the first block's id), so it can add no line or quote boundary to the instructions (c83).
 */
const blockRef = (blockId: string): string => JSON.stringify(blockId);

/** The first line of every accepted-block summary (./summary); the only answer that continues grilling. */
export const SUMMARY_PREFIX = "Decision Roadmap: block";

/**
 * PLAN §3.3: what the bound planner is told after posting a batch. Only the accepted block summary
 * continues the grilling; any other answer to the card (a native Continue or Stop included) does
 * not confirm an accepted summary, so the planner stops and waits for the owner.
 */
export function pauseContractText(x: { openBlockId: string; operationId: string }): string {
  const token = operationToken(x.operationId);
  return (
    `Batch posted to block ${blockRef(x.openBlockId)} (operation \`${token}\`). Now pause with your native question tool ` +
    `(Claude: AskUserQuestion; Codex: request_user_input) using exactly ONE question: text ` +
    `"${pauseQuestionText(x.operationId)}", header "${PAUSE_HEADER}", options "${PAUSE_OPTIONS[0]}" and "${PAUSE_OPTIONS[1]}", ` +
    `in that order, single-select. Do not answer it yourself and do not add other questions to it. If that native ` +
    `question tool is not available in this chat, show no card: the owner continues manually. If the answer is the owner's ` +
    `accepted block summary (its first line starts with "${SUMMARY_PREFIX}"), read the session with roadmap_get_session ` +
    `for the accepted block and its canonical answers, then write the next batch into the new open block; the summary ` +
    `approves no plan. Any other answer, a plain "${PAUSE_OPTIONS[0]}" or "${PAUSE_OPTIONS[1]}" included, does not ` +
    `confirm an accepted summary: stop and wait for the owner. When nothing remains to ask, call ` +
    `roadmap_grill_complete with operationId "${x.operationId}" instead of pausing.`
  );
}

export const NOT_PLANNER_TEXT = "This session's planner is another chat; do not pause.";
export const NO_PLANNER_TEXT = "No planner chat is bound; the owner can bind one in the panel.";
export const UNSUPPORTED_TEXT = (reason: string): string => `This chat cannot pause natively (${reason}); do not pause; the owner continues manually.`;
/**
 * A chat bound by Discuss that cannot pause: the plugin itself sends it the accepted block's summary
 * after the owner's Accept, so it ends its turn after a batch instead of waiting on a card.
 */
export const DISCUSSION_UNSUPPORTED_TEXT = (reason: string): string =>
  `This chat cannot pause natively (${reason}); do not pause. After posting a batch, end your turn: when the owner accepts ` +
  `the block, the plugin sends you its summary as a message; then post the next batch with roadmap_ask.`;
/** The owner accepted the block of a chat bound by Discuss; the plugin's message with the summary is due. */
export const AUTO_WAIT_TEXT = (openBlockId: string): string =>
  `The owner accepted block ${blockRef(openBlockId)}. The plugin sends you its summary as a message once this chat is idle; ` +
  `do not pause and do not complete grilling: end your turn and wait for that message, then post the next batch with roadmap_ask.`;
/** The plugin sent (or is sending) the accepted block's summary to a chat bound by Discuss. */
export const AUTO_SENT_TEXT = (openBlockId: string): string =>
  `The owner accepted block ${blockRef(openBlockId)} and the plugin sent you its summary as a message (a user message ` +
  `starting with "Decision Roadmap (continuation)"). Read the session with roadmap_get_session and post the next batch ` +
  `with roadmap_ask, or propose finishing with roadmap_grill_propose_finish; do not pause.`;
/** A completed (closed) session: nothing to pause for until the owner reopens it. */
export const CLOSED_TEXT = "This grilling session is complete; do not pause. The owner can reopen it in the panel.";
/** The bound planner has no operation yet: nothing to pause or complete for. */
export const NO_OPERATION_TEXT = "No grilling batch is waiting; post the next batch with roadmap_ask.";

/**
 * The owner accepted the block and the plugin is answering the planner's pending card (`resolving`):
 * no second card, and no idle wait once the summary has already arrived.
 */
export const ANSWERING_TEXT = (openBlockId: string): string =>
  `The owner accepted block ${blockRef(openBlockId)} and the plugin is answering the card you already showed for it; do not ` +
  `show another one. If that card already returned the accepted block summary, read the session with ` +
  `roadmap_get_session and post the next batch into the new open block; otherwise wait for that answer.`;

/**
 * The planner's card for this operation is shown and matched (`paused`): wait for the owner's Accept on
 * that card. No second card (it would never be claimed) and no completion (it rejects `paused`).
 */
export const PAUSED_TEXT = (openBlockId: string): string =>
  `Your card for block ${blockRef(openBlockId)} is shown; wait for its answer and do not show another one. If the answer ` +
  `is the owner's accepted block summary (its first line starts with "${SUMMARY_PREFIX}"), read the session with ` +
  `roadmap_get_session and post the next batch into the new open block; any other answer does not confirm an accepted ` +
  `summary: stop and wait for the owner.`;

/** The last batch's summary was delivered (`resumed`): the only terminal state completion accepts. */
export const RESUMED_TEXT = (operationId: string): string =>
  `The accepted block summary was delivered. Read the session with roadmap_get_session and post the next batch with ` +
  `roadmap_ask, or call roadmap_grill_complete with operationId "${operationId}" when nothing remains to ask.`;

/**
 * The current operation belongs to a previous planner binding (a rebind left its terminal record in
 * place): nothing of it applies to this planner, whose next batch starts a new operation.
 */
export const PRIOR_PLANNER_TEXT = "This chat was bound as the planner after the last batch; post the next batch with roadmap_ask.";

/** A terminal state other than `resumed`: the owner decides how grilling continues (completion would be rejected). */
export const MANUAL_TEXT = (state: string): string =>
  `This session has no resumable pause in its current state (${state}); do not pause and do not complete ` +
  `grilling. Continue only as the owner tells you.`;
/** A session without grilling blocks never pauses. */
export const NO_BLOCKS_TEXT = "This session does not use grilling blocks; do not pause.";
