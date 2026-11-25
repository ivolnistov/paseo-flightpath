// MCP tool table over the shared roadmap commands. The project comes from the grant, never from
// arguments; every input object is strict, so a smuggled projectId or path is rejected.
import { z } from "zod";
import { Id, LinkEnd, Option, Ref } from "../shared/model";
import { parseLink } from "../shared/links";
import { OptionId, QuestionUpdate, RelationInput, type Result } from "../shared/rpc";
import type { PauseSupport } from "./pause-support";
import type { PlannerCaller, RoadmapCommands, StoreOpener, WriteOrigin } from "./sessions";
import { MAX_BATCH } from "./sessions";

export interface McpTool<S extends z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** `agentId` is the agent bound to the calling grant (Stage R3.2), absent while unbound. */
  run(args: z.output<S>, ctx: { open: StoreOpener; projectId: string; origin: WriteOrigin; agentId?: string; workspaceId?: string | null }): Promise<Result<unknown>>;
}
export type McpToolTable = readonly McpTool<z.ZodType>[];

export const TOOL_NAMES = [
  "roadmap_overview",
  "roadmap_get_session",
  "roadmap_create_session",
  "roadmap_ask",
  "roadmap_answer",
  "roadmap_confirm",
  "roadmap_discuss",
  "roadmap_relate",
  "roadmap_update_question",
  "roadmap_link",
  "roadmap_pause_instructions",
  "roadmap_grill_complete",
  "roadmap_resolve_link",
  "roadmap_out_of_scope",
  "roadmap_cancel_question",
  "roadmap_block_accept",
  "roadmap_grill_propose_finish",
] as const;

export const INSTRUCTIONS =
  "Decision roadmap for this project. Read with roadmap_overview/roadmap_get_session, pass the returned revision as expectedRevision on every write, quote the human for answers, never claim approval.";

const NO_APPROVAL = "Approval of plans happens only in the Paseo UI; no tool can approve.";
const QUOTE_RULE = "Record only what the human said; put their exact words in `quoted`.";
const BLOCKS =
  "A session that uses grilling blocks needs blockId: the id of its open block from roadmap_get_session; every question " +
  "of the call joins that block. A blockId on an empty session starts its first block; on a session that already has " +
  "questions without blocks it is rejected with invalid_input. A block is accepted in the Paseo UI, or with roadmap_block_accept " +
  "when the human explicitly consented in chat.";
const REVISION = "Pass the revision from the latest roadmap_overview or roadmap_get_session as expectedRevision.";
const PLANNER =
  "When this chat's MCP grant is bound to it, its first call into a session without a planner makes this chat the session's " +
  "planner (only the Paseo UI can change that). In a session with blocks the result's grilling field tells you whether and " +
  "how to pause after the batch.";

const Revision = z.number().int().min(1);
const BatchParent = z.union([Ref, z.object({ batchIndex: z.number().int().min(0) }).strict()]);
const BatchQuestion = z
  .object({
    title: z.string().min(1),
    context: z.string(),
    options: z.array(Option.extend({ id: OptionId })),
    recommendedOptionId: OptionId.optional(),
    tag: z.enum(["language"]).optional(),
    allowFreeText: z.boolean(),
    activatedBy: z.array(z.object({ parent: BatchParent, optionIds: z.array(Id).min(1) }).strict()),
    invalidatedBy: z.array(z.object({ upstream: BatchParent }).strict()),
  })
  .strict();

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous MCP tool list; each tool keeps its own input schema at definition
const tool = <S extends z.ZodType>(t: McpTool<S>): McpTool<z.ZodType> => t as unknown as McpTool<z.ZodType>;

/** Automatic grilling dependencies of the tool table; both are optional (absent: support unknown). */
export interface GrillingToolDeps {
  /** The calling agent's native-pause support, read from the host before a batch (bounded). */
  support?: (agentId: string) => Promise<PauseSupport>;
  /** Tells the pause engine which project a bound agent writes batches into. */
  remember?: (agentId: string, projectId: string) => void;
}

/** The planner candidate of a bound grant; an unbound grant (no agent) is none (TR6). */
const callerOf = (agentId: string | undefined, workspaceId: string | null | undefined): PlannerCaller | undefined =>
  agentId !== undefined ? { agentId, workspaceId: workspaceId ?? null } : undefined;

export function buildTools(commands: RoadmapCommands, extra: McpToolTable = [], grilling: GrillingToolDeps = {}): McpToolTable {
  const chat = (origin: WriteOrigin, quoted?: string): WriteOrigin =>
    origin.source === "chat" ? { ...origin, ...(quoted !== undefined ? { quoted } : {}) } : origin;
  return [
    tool({
      name: "roadmap_overview",
      description: "Sessions with question counts by status, descriptive links and the current revision.",
      input: z.object({}).strict(),
      run: (_a, { open, projectId, origin }) => commands.overview(open, { projectId }, origin),
    }),
    tool({
      name: "roadmap_get_session",
      description:
        "One session with every question, its options, answer history, status, relations and the current revision. " +
        "Each question's currentAnswer is its current answer; a skipped or out-of-scope question has none and shows an earlier " +
        "answer only as priorAnswer. outOfScope lists the session's out-of-scope questions with their activation children and " +
        "invalidation dependents (any session) to review; a question depending on an out-of-scope one names it in outOfScopeUpstream. " +
        "A skipped or out-of-scope question whose upstream changed keeps its outcome and carries review (the cause, like stale): " +
        "ask the human whether it still holds, then record their answer, or skip or mark it out of scope again. " +
        "A session that uses grilling blocks also lists its blocks and each question's blockId; the open block is the one roadmap_ask needs.",
      input: z.object({ sessionId: Id }).strict(),
      run: (a, { open, projectId, origin }) => commands.sessionGet(open, { projectId, sessionId: a.sessionId }, origin),
    }),
    tool({
      name: "roadmap_create_session",
      description: `Create a decision session. ${REVISION} ${NO_APPROVAL}`,
      input: z.object({ expectedRevision: Revision, title: z.string().min(1) }).strict(),
      run: (a, { open, projectId, origin }) => commands.sessionCreate(open, { projectId, ...a }, origin),
    }),
    tool({
      name: "roadmap_ask",
      description:
        `Add 1 to ${MAX_BATCH} questions to a session in one step. Each has options (ids made of letters, digits, _ or -), ` +
        "an optional recommendation, whether free text is allowed, activation conditions (shown only while a parent has one of " +
        "the listed answers) and invalidation dependencies (marked stale when the parent's answer changes or it goes out of scope). A parent is an existing " +
        `{sessionId, questionId} or {batchIndex} of an earlier question in this call. ${BLOCKS} ${PLANNER} ${REVISION} ${NO_APPROVAL}`,
      input: z
        .object({ expectedRevision: Revision, sessionId: Id, blockId: Id.optional(), questions: z.array(BatchQuestion).min(1).max(MAX_BATCH) })
        .strict(),
      // A bound grant's agent is the planner candidate; an unbound grant binds nothing (TR6). Its pause
      // support is read before the command, so the store transaction never waits on the host (TR5).
      run: async (a, { open, projectId, origin, agentId, workspaceId }) => {
        const base = callerOf(agentId, workspaceId);
        const support = base !== undefined && grilling.support !== undefined ? await grilling.support(base.agentId) : undefined;
        const caller = base !== undefined && support !== undefined ? { ...base, support } : base;
        const out = await commands.questionCreateBatch(open, { projectId, ...a }, origin, caller);
        if (out.ok && caller !== undefined) grilling.remember?.(caller.agentId, projectId);
        return out;
      },
    }),
    tool({
      name: "roadmap_answer",
      description: `Record the human's answer: exactly one of optionId or text (text only where free text is allowed). ${QUOTE_RULE} Never answer on your own judgement. ${REVISION} ${NO_APPROVAL}`,
      input: z
        .object({
          expectedRevision: Revision,
          sessionId: Id,
          questionId: Id,
          optionId: Id.optional(),
          text: z.string().optional(),
          quoted: z.string().min(1),
          note: z.string().optional(),
        })
        .strict(),
      run: ({ quoted, ...a }, { open, projectId, origin }) => commands.questionAnswer(open, { projectId, ...a }, chat(origin, quoted)),
    }),
    tool({
      name: "roadmap_confirm",
      description: `Confirm a stale answer unchanged after the human re-confirmed it. ${QUOTE_RULE} ${REVISION} ${NO_APPROVAL}`,
      input: z.object({ expectedRevision: Revision, sessionId: Id, questionId: Id, quoted: z.string().min(1) }).strict(),
      run: ({ quoted, ...a }, { open, projectId, origin }) => commands.questionConfirm(open, { projectId, ...a }, chat(origin, quoted)),
    }),
    tool({
      name: "roadmap_discuss",
      description: `Add a discussion note to a question; it changes no answer or status. ${REVISION} ${NO_APPROVAL}`,
      input: z.object({ expectedRevision: Revision, sessionId: Id, questionId: Id, text: z.string().min(1) }).strict(),
      run: (a, { open, projectId, origin }) => commands.questionDiscuss(open, { projectId, ...a }, origin),
    }),
    tool({
      name: "roadmap_relate",
      description: `Add or remove an activation or invalidation relation between questions; cycles are rejected. ${REVISION} ${NO_APPROVAL}`,
      input: z.object({ expectedRevision: Revision, action: z.enum(["add", "remove"]), relation: RelationInput }).strict(),
      run: ({ action, ...a }, { open, projectId, origin }) =>
        action === "add"
          ? commands.relationAdd(open, { projectId, ...a }, origin)
          : commands.relationRemove(open, { projectId, ...a }, origin),
    }),
    tool({
      name: "roadmap_update_question",
      description: `Edit a question's title, context, options, recommendation or free-text flag. Removing the chosen option marks the question stale. ${REVISION} ${NO_APPROVAL}`,
      input: z
        .object({ expectedRevision: Revision, sessionId: Id, questionId: Id, patch: QuestionUpdate.input.shape.patch })
        .strict(),
      run: (a, { open, projectId, origin }) => commands.questionUpdate(open, { projectId, ...a }, origin),
    }),
    tool({
      name: "roadmap_link",
      description: `Create a descriptive informs/supersedes link between sessions or questions; it changes no status. ${REVISION} ${NO_APPROVAL}`,
      input: z
        .object({ expectedRevision: Revision, kind: z.enum(["informs", "supersedes"]), from: LinkEnd, to: LinkEnd, note: z.string().optional() })
        .strict(),
      run: (a, { open, projectId, origin }) => commands.linkCreate(open, { projectId, ...a }, origin),
    }),
    tool({
      name: "roadmap_pause_instructions",
      description:
        "Read-only (it mints nothing): for a session with grilling blocks, the advice for your chat in the current " +
        "operation's state. For the session's planner it is the exact pause instructions only while the card is awaited " +
        "(awaiting_pause, accepted_awaiting_pause); in other states it is that state's notice. Any other chat gets a " +
        "do-not-pause notice. It need not equal what a new roadmap_ask would return, since a new batch may start a new " +
        "operation. For a session without blocks (where roadmap_ask returns no grilling value) it returns a do-not-pause notice.",
      input: z.object({ sessionId: Id }).strict(),
      run: (a, { open, projectId, agentId, workspaceId }) => commands.pauseInstructions(open, { projectId, sessionId: a.sessionId }, callerOf(agentId, workspaceId)),
    }),
    tool({
      name: "roadmap_grill_complete",
      description:
        "End grilling of a session when nothing remains to ask, instead of pausing. Only the session's planner chat may call it, " +
        "with operationId set to the raw operationId of the grilling value roadmap_ask returned (not the DR-OP- token). It is " +
        "accepted for the current operation only while its pause card is not shown yet (states awaiting_pause, " +
        "accepted_awaiting_pause) or after the accepted summary was delivered (resumed); otherwise it returns stale_operation. " +
        `It closes the session. ${REVISION} ${NO_APPROVAL}`,
      input: z.object({ expectedRevision: Revision, sessionId: Id, operationId: Id }).strict(),
      run: (a, { open, projectId, origin, agentId, workspaceId }) => commands.grillComplete(open, { projectId, ...a }, origin, callerOf(agentId, workspaceId)),
    }),
    tool({
      name: "roadmap_resolve_link",
      description:
        "Read-only: resolve a roadmap:// question or answer link of this project (roadmap://<project>/s/<session>/q/<n>, " +
        "with /answer or /answer/r<k>). An answer link returns the CURRENT outcome (current: true): `answer` and `currentRev` " +
        "only when the question is answered or stale. For a skipped or out-of-scope question the status is the outcome, there is " +
        "no current answer, and an answer kept from before is returned as `priorAnswer` (history). The /answer/r<k> form " +
        "returns revision k as history, with current: false unless k is the current answer revision. Numbers are stable per session.",
      input: z.object({ link: z.string().min(1) }).strict(),
      run: async (a, { open, projectId, origin }) => {
        const parsed = parseLink(a.link);
        if (parsed === null) return { ok: false, error: { code: "invalid_input", message: "not a roadmap:// question or answer link" } };
        if (parsed.projectId !== projectId) return { ok: false, error: { code: "project_mismatch", message: "the link belongs to another project" } };
        const view = await commands.sessionGet(open, { projectId, sessionId: parsed.sessionId }, origin);
        if (!view.ok) return view;
        const found = view.value.questions.find((x) => x.number === parsed.number);
        if (found === undefined) {
          return { ok: false, error: { code: "not_found", message: `Q${parsed.number} not found in session ${parsed.sessionId}` } };
        }
        const q = found.question;
        const currentRev = found.currentAnswer?.rev;
        const pinned = parsed.kind === "answer" && parsed.rev !== undefined;
        const answer = parsed.kind !== "answer" ? undefined : pinned ? q.revisions.find((r) => r.rev === parsed.rev) : found.currentAnswer;
        if (pinned && answer === undefined) {
          return { ok: false, error: { code: "not_found", message: `Q${parsed.number} has no answer revision ${parsed.rev}` } };
        }
        return {
          ok: true,
          value: {
            kind: parsed.kind,
            sessionId: parsed.sessionId,
            questionId: q.id,
            number: found.number,
            title: q.title,
            status: found.status,
            ...(answer !== undefined ? { answer } : {}),
            ...(parsed.kind === "answer" && found.priorAnswer !== undefined ? { priorAnswer: found.priorAnswer } : {}),
            ...(currentRev !== undefined ? { currentRev } : {}),
            ...(pinned ? { pinnedRev: parsed.rev } : {}),
            current: !pinned || parsed.rev === currentRev,
            revision: view.value.revision,
          },
        };
      },
    }),
    tool({
      name: "roadmap_out_of_scope",
      description:
        "Mark a question out of scope on the human's behalf; distinct from skipping. Out of scope becomes the question's current " +
        "outcome: an earlier answer is kept only as history (priorAnswer), and the mark stays in the question's outOfScopeEvents " +
        "after later answers. Questions it activates (activation children) are hidden, not changed. Answered questions whose " +
        "answer depends on it (invalidation dependents, transitively, across sessions) become stale as after a changed answer, " +
        "keeping their answers; a skipped or out-of-scope one keeps its outcome and gets a review marker. roadmap_get_session of " +
        "this session lists every dependent under outOfScope; each dependent's own row, in roadmap_get_session of its own " +
        "session, names this question under outOfScopeUpstream. Review them with the human: roadmap_confirm or roadmap_answer " +
        `for a stale one, roadmap_answer or roadmap_out_of_scope for one with a review marker; never decide on your own judgement. ${QUOTE_RULE} ${REVISION} ${NO_APPROVAL}`,
      input: z.object({ expectedRevision: Revision, sessionId: Id, questionId: Id, quoted: z.string().min(1) }).strict(),
      run: ({ quoted, ...a }, { open, projectId, origin }) => commands.questionOutOfScope(open, { projectId, ...a }, chat(origin, quoted)),
    }),
    tool({
      name: "roadmap_cancel_question",
      description:
        "Cancel a decision with a reason; the record is attributed to your chat and is append-only. On your own you may cancel a " +
        "question that has no answer, or any dependent of a cancelled decision (roadmap_get_session lists them under " +
        "cancellations[].dependents; the block summary names them in a Cancelled: line). Any other answered decision needs the " +
        "human's consent: put their exact words in quoted, which is kept on the record. Re-asking is an ordinary roadmap_ask. " +
        `${REVISION} ${NO_APPROVAL}`,
      input: z.object({ expectedRevision: Revision, sessionId: Id, questionId: Id, reason: z.string().min(1), quoted: z.string().min(1).optional() }).strict(),
      run: ({ quoted, ...a }, { open, projectId, origin }) => commands.questionCancelByAgent(open, { projectId, ...a }, chat(origin, quoted)),
    }),
    tool({
      name: "roadmap_block_accept",
      description:
        "Accept the open block of a session after the human explicitly consented in chat; the same effect as Accept in the " +
        "panel (the block freezes with its summary, the next block opens, a waiting grilling operation continues). Only a chat " +
        "bound to an agent may call it; the block records your agent and the human's words, which are your report of their " +
        `consent, not a signature. Never accept on your own judgement. ${QUOTE_RULE} ${REVISION} ${NO_APPROVAL}`,
      input: z.object({ expectedRevision: Revision, sessionId: Id, blockId: Id, quoted: z.string().min(1) }).strict(),
      run: ({ quoted, ...a }, { open, projectId, origin }) => commands.blockAccept(open, { projectId, ...a }, chat(origin, quoted)),
    }),
    tool({
      name: "roadmap_grill_propose_finish",
      description:
        "Propose to finish when nothing remains to ask: records your summary and the numbers of the active skipped and " +
        "out-of-scope questions for the owner, who confirms with Finish in the Paseo panel. Only the session's planner chat " +
        `may call it; it closes nothing, and no tool can finish a session. ${REVISION} ${NO_APPROVAL}`,
      input: z.object({ expectedRevision: Revision, sessionId: Id, summary: z.string().min(1) }).strict(),
      run: (a, { open, projectId, origin, agentId, workspaceId }) => commands.grillProposeFinish(open, { projectId, ...a }, origin, callerOf(agentId, workspaceId)),
    }),
    ...extra,
  ];
}
