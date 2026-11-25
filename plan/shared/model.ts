import { z } from "zod";

export const GEN_RE = /^g-\d{10}-[0-9A-HJKMNP-TV-Z]{26}$/;

export const Id = z.string().min(1);
export const IsoTime = z.string().datetime();

export const Ref = z.object({ sessionId: Id, questionId: Id }).strict();
export type Ref = z.infer<typeof Ref>;

export const Actor = z.object({ kind: z.enum(["human", "agent"]), agentId: z.string().optional() }).strict();
export type Actor = z.infer<typeof Actor>;

export const Option = z.object({ id: Id, label: z.string().min(1), description: z.string().optional() }).strict();
export type Option = z.infer<typeof Option>;

export const Answer = z
  .object({
    rev: z.number().int().min(1),
    optionId: Id.optional(),
    text: z.string().optional(),
    source: z.enum(["ui", "chat"]),
    actor: Actor,
    at: IsoTime,
    note: z.string().optional(),
    quoted: z.string().optional(),
    /** The owner submitted the preselected recommended option unchanged; absent otherwise. */
    defaulted: z.literal(true).optional(),
  })
  .strict()
  .refine((a) => (a.optionId === undefined) !== (a.text === undefined), {
    message: "exactly one of optionId or text is required",
  });
export type Answer = z.infer<typeof Answer>;

export const Activation = z.object({ parent: Ref, optionIds: z.array(Id).min(1) }).strict();
export type Activation = z.infer<typeof Activation>;

export const Invalidation = z.object({ upstream: Ref }).strict();
export type Invalidation = z.infer<typeof Invalidation>;

export const Note = z.object({ id: Id, at: IsoTime, actor: Actor, text: z.string().min(1) }).strict();
export type Note = z.infer<typeof Note>;

/**
 * Stale marker. Caused either by a new answer revision of the upstream question (`causeRev`) or
 * by the upstream question going out of scope (`causeKind: "out_of_scope"`, with the id of its
 * out-of-scope mark when known), which records no answer revision. Exactly one of the two; legacy
 * and v1 markers always carry `causeRev`.
 */
export const Stale = z
  .object({
    causeSessionId: Id,
    causeQuestionId: Id,
    causeRev: z.number().int().min(1).optional(),
    causeKind: z.literal("out_of_scope").optional(),
    causeMarkId: Id.optional(),
    at: IsoTime,
  })
  .strict()
  .superRefine((s, ctx) => {
    if ((s.causeRev !== undefined) === (s.causeKind !== undefined)) {
      ctx.addIssue({ code: "custom", message: "a stale marker has exactly one of causeRev and causeKind", path: ["causeRev"] });
    }
    if (s.causeMarkId !== undefined && s.causeKind === undefined) {
      ctx.addIssue({ code: "custom", message: "causeMarkId requires causeKind", path: ["causeMarkId"] });
    }
  });
export type Stale = z.infer<typeof Stale>;

/** `out_of_scope`: the owner marked the question out of scope; distinct from `skipped`, answer history kept. */
export const Validity = z.enum(["unanswered", "valid", "stale", "skipped", "out_of_scope"]);
export type Validity = z.infer<typeof Validity>;

const sameAnswer = (a: Answer, b: Answer) =>
  JSON.stringify(Object.entries(a).filter(([, v]) => v !== undefined).sort()) ===
  JSON.stringify(Object.entries(b).filter(([, v]) => v !== undefined).sort());

const questionFields = {
  id: Id,
  order: z.number().int(),
  title: z.string().min(1),
  context: z.string(),
  options: z.array(Option),
  recommendedOptionId: Id.optional(),
  allowFreeText: z.boolean(),
  definitionRev: z.number().int().min(1),
  activatedBy: z.array(Activation),
  invalidatedBy: z.array(Invalidation),
  answer: Answer.optional(),
  revisions: z.array(Answer),
  discussion: z.array(Note),
  validity: Validity,
  stale: Stale.optional(),
};

function checkQuestion(q: z.infer<z.ZodObject<typeof questionFields>>, ctx: z.RefinementCtx): void {
  const last = q.revisions.at(-1);
  if (q.answer !== undefined && (last === undefined || !sameAnswer(q.answer, last))) {
    ctx.addIssue({ code: "custom", message: "answer must equal the latest revision", path: ["answer"] });
  }
  if (q.answer === undefined && last !== undefined) {
    ctx.addIssue({ code: "custom", message: "answer missing while revisions exist", path: ["answer"] });
  }
  q.revisions.forEach((a, i) => {
    if (a.rev !== i + 1) ctx.addIssue({ code: "custom", message: "revisions must be numbered 1..n", path: ["revisions", i] });
  });
  if ((q.stale !== undefined) !== (q.validity === "stale")) {
    ctx.addIssue({ code: "custom", message: "stale present iff validity is stale", path: ["stale"] });
  }
  const ids = q.options.map((o) => o.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "option ids must be unique", path: ["options"] });
  }
  if (q.recommendedOptionId !== undefined && !ids.includes(q.recommendedOptionId)) {
    ctx.addIssue({ code: "custom", message: "recommendedOptionId must be an option", path: ["recommendedOptionId"] });
  }
}

/** Legacy (schema v1) question, exactly the shape shipped at feb6905. */
export const QuestionV1 = z.object(questionFields).strict().superRefine(checkQuestion);
export type QuestionV1 = z.infer<typeof QuestionV1>;

/**
 * v2 question: the v1 fields plus the grilling block it belongs to and its stable display number.
 * `number` is absent on questions written before numbering; their effective number is order + 1.
 * `review` marks an answered question whose explicit outcome (skipped or out of scope) is kept while
 * a question it depends on changed since; it has the cause shape of `stale`.
 */
export const Question = z
  .object({
    ...questionFields,
    blockId: Id.optional(),
    number: z.number().int().min(1).optional(),
    review: Stale.optional(),
    /** `language`: the session-language question; no translation is performed. */
    tag: z.enum(["language"]).optional(),
  })
  .strict()
  .superRefine(checkQuestion)
  .superRefine((q, ctx) => {
    if (q.review !== undefined && q.validity !== "skipped" && q.validity !== "out_of_scope") {
      ctx.addIssue({ code: "custom", message: "review is kept only on a skipped or out-of-scope question", path: ["review"] });
    }
  });
export type Question = z.infer<typeof Question>;

const sessionFields = { id: Id, title: z.string(), createdAt: IsoTime, status: z.enum(["active", "closed"]) };

/** Legacy (schema v1) session, exactly the shape shipped at feb6905. */
export const SessionV1 = z.object({ ...sessionFields, questions: z.array(QuestionV1) }).strict();
export type SessionV1 = z.infer<typeof SessionV1>;

/** Who accepted a block: the human in the panel, or a bound agent reporting the human's quoted consent. */
const BlockAcceptor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), hostClientId: z.string().optional() }).strict(),
  z.object({ kind: z.literal("agent"), agentId: z.string().min(1), quoted: z.string().min(1) }).strict(),
]);

/** A grilling block. Accepted blocks are frozen; acceptance data is present iff accepted. */
export const Block = z.discriminatedUnion("state", [
  z.object({ id: Id, order: z.number().int(), state: z.literal("open"), openedAt: IsoTime }).strict(),
  z
    .object({
      id: Id,
      order: z.number().int(),
      state: z.literal("accepted"),
      openedAt: IsoTime,
      acceptedAt: IsoTime,
      acceptedBy: BlockAcceptor,
      /** The block summary built at acceptance; absent for blocks accepted before it was recorded. */
      summary: z.string().optional(),
    })
    .strict(),
]);
export type Block = z.infer<typeof Block>;

/**
 * The chat bound as a session's planner (automatic grilling). Set once by the first bound
 * `roadmap_ask` or by the drafting chat, and changed only by the UI rebind, which bumps `epoch`.
 */
export const PlannerBinding = z
  .object({
    agentId: Id,
    workspaceId: z.string().nullable(),
    boundAt: IsoTime,
    boundBy: z.enum(["ask", "draft", "ui", "discussion"]),
    epoch: z.number().int().min(1),
  })
  .strict();
export type PlannerBinding = z.infer<typeof PlannerBinding>;

export const CONTINUATION_STATES = [
  "awaiting_pause",
  "paused",
  "accepted_awaiting_pause",
  "resolving",
  "resumed",
  "unknown",
  "pause_answered_externally",
  "pause_lost",
  "pause_mismatch",
  "unsupported",
  "superseded",
  "needs_manual",
  "complete",
] as const;
export const ContinuationState = z.enum(CONTINUATION_STATES);
export type ContinuationState = z.infer<typeof ContinuationState>;

/** States in which the plugin may still observe or answer the operation's pause card. */
export const LIVE_CONTINUATION_STATES: readonly ContinuationState[] = ["awaiting_pause", "paused", "accepted_awaiting_pause", "resolving"];
export const TERMINAL_CONTINUATION_STATES: readonly ContinuationState[] = CONTINUATION_STATES.filter(
  (s) => !LIVE_CONTINUATION_STATES.includes(s),
);
export const isTerminalContinuation = (state: ContinuationState): boolean => TERMINAL_CONTINUATION_STATES.includes(state);

/** The planner's native pause request as seen by the plugin (what it answers, never more). */
export const PauseSnapshot = z
  .object({
    requestId: z.string().min(1),
    provider: z.string().min(1),
    name: z.string().min(1),
    seenAt: IsoTime,
    questionText: z.string().min(1),
    header: z.string().min(1),
    optionLabels: z.array(z.string()),
  })
  .strict();
export type PauseSnapshot = z.infer<typeof PauseSnapshot>;

export const ContinuationResolution = z
  .object({ behavior: z.enum(["allow", "deny"]), at: IsoTime, source: z.enum(["plugin", "external", "host"]) })
  .strict();
export type ContinuationResolution = z.infer<typeof ContinuationResolution>;

const ACCEPTED_REQUIRED: readonly ContinuationState[] = ["accepted_awaiting_pause", "resolving", "resumed", "unknown", "needs_manual"];
const ACCEPTED_FORBIDDEN: readonly ContinuationState[] = ["awaiting_pause", "paused", "unsupported", "pause_mismatch"];
const PAUSE_REQUIRED: readonly ContinuationState[] = ["paused", "resolving", "resumed", "unknown", "pause_answered_externally"];
const ZERO_ATTEMPTS: readonly ContinuationState[] = ["awaiting_pause", "paused", "accepted_awaiting_pause"];
const SOME_ATTEMPTS: readonly ContinuationState[] = ["resolving", "resumed", "unknown"];

/**
 * One grilling operation: a batch posted into `openBlockId`, the planner's pause for it and, after
 * Accept, the answer carrying the block summary. Field presence follows the state (rules C1–C8).
 */
export const Continuation = z
  .object({
    operationId: Id,
    openBlockId: Id,
    target: z.object({ agentId: Id, epoch: z.number().int().min(1) }).strict(),
    state: ContinuationState,
    acceptedBlockId: Id.optional(),
    nextBlockId: Id.optional(),
    summary: z.string().optional(),
    pause: PauseSnapshot.optional(),
    attempts: z.number().int().min(0),
    resolution: ContinuationResolution.optional(),
    at: IsoTime,
    reason: z.string().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
    const accepted = c.acceptedBlockId !== undefined;
    if (accepted !== (c.nextBlockId !== undefined)) issue("acceptedBlockId and nextBlockId are present together", "nextBlockId");
    if (ACCEPTED_REQUIRED.includes(c.state) && !accepted) issue(`${c.state} requires the accepted block refs`, "acceptedBlockId");
    if (ACCEPTED_FORBIDDEN.includes(c.state) && (accepted || c.nextBlockId !== undefined)) {
      issue(`${c.state} forbids the accepted block refs`, "acceptedBlockId");
    }
    if (PAUSE_REQUIRED.includes(c.state) && c.pause === undefined) issue(`${c.state} requires the pause snapshot`, "pause");
    if ((c.summary !== undefined) !== accepted) issue("summary is present iff acceptedBlockId is", "summary");
    if (accepted && c.acceptedBlockId !== c.openBlockId) issue("acceptedBlockId must be the operation's openBlockId", "acceptedBlockId");
    if (c.nextBlockId !== undefined && c.nextBlockId === c.acceptedBlockId) issue("nextBlockId must differ from acceptedBlockId", "nextBlockId");
    if (c.resolution !== undefined && c.pause === undefined) issue("a resolution requires the pause snapshot", "resolution");
    if (ZERO_ATTEMPTS.includes(c.state) && c.attempts !== 0) issue(`${c.state} has made no answer attempt`, "attempts");
    if (SOME_ATTEMPTS.includes(c.state) && c.attempts < 1) issue(`${c.state} requires at least one answer attempt`, "attempts");
  });
export type Continuation = z.infer<typeof Continuation>;

/**
 * The planner's proposal to finish a session; `finishedAt` is set by the owner's Finish. `finishedBy`
 * records, with `finishedAt`, whether the owner accepted this proposal or closed the session
 * manually while it stood; proposals finished before it existed carry no `finishedBy`.
 */
export const FinishProposal = z
  .object({
    at: IsoTime,
    agentId: Id,
    summary: z.string(),
    skipped: z.array(z.number().int().min(1)),
    outOfScope: z.array(z.number().int().min(1)),
    finishedAt: IsoTime.optional(),
    finishedBy: z.enum(["proposal", "manual"]).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.finishedBy !== undefined && p.finishedAt === undefined) {
      ctx.addIssue({ code: "custom", message: "finishedBy requires finishedAt", path: ["finishedBy"] });
    }
  });
export type FinishProposal = z.infer<typeof FinishProposal>;

/** A close is the owner's Finish in the Paseo UI, so its actor is the human (as every close writes it). */
const ClosureActor = z.object({ kind: z.literal("human") }).strict();
const closureFields = { at: IsoTime, source: z.literal("ui"), actor: ClosureActor, reopenedAt: IsoTime.optional() };
/**
 * One close of a session by the owner's Finish, oldest first: on accepting the chat's proposal made
 * at `proposalAt`, or manually. `reopenedAt` is set once, by the reopen that follows it.
 */
export const SessionClosure = z.discriminatedUnion("basis", [
  z.object({ ...closureFields, basis: z.literal("proposal"), proposalAt: IsoTime }).strict(),
  z.object({ ...closureFields, basis: z.literal("manual") }).strict(),
]);
export type SessionClosure = z.infer<typeof SessionClosure>;

/** A discussion language label as configured in the roadmap settings. */
export const SessionLanguage = z.string().min(1).max(40);

/**
 * A session's effective language label: for an earlier session the answer of its language question
 * (the free-text answer or the chosen option's label), so any non-empty text.
 */
export const NoticeLanguage = z.string().min(1);
/** The owner's acknowledgement of the no-translation notice for one effective language label (Got it). */
export const LanguageNoticeAck = z.object({ language: NoticeLanguage, at: IsoTime }).strict();
export type LanguageNoticeAck = z.infer<typeof LanguageNoticeAck>;

/**
 * One retry of a continuation (the owner's, or the plugin's automatic one), recorded `sending` before its single send. `sent`: the host
 * accepted the message; `failed`: refused before dispatch; `unknown`: the outcome cannot be told.
 * An uncertain record is settled only by the token in the planner's timeline, the start-up sweep
 * (to `unknown`) or the owner's mark, recorded in `resolvedAt` and `resolvedBy`.
 */
export const ContinuationRetry = z
  .object({
    id: Id,
    at: IsoTime,
    operationId: Id.optional(),
    blockId: Id,
    agentId: Id,
    epoch: z.number().int().min(1),
    state: z.enum(["sending", "sent", "failed", "unknown"]),
    error: z.string().optional(),
    resolvedAt: IsoTime.optional(),
    resolvedBy: z.enum(["user", "sweep", "timeline"]).optional(),
    /**
     * `automatic`: sent by the plugin itself after Accept in a chat bound by Discuss, under the same
     * rules (one record, one send). Absent: the owner's Retry.
     */
    origin: z.enum(["automatic"]).optional(),
  })
  .strict();
export type ContinuationRetry = z.infer<typeof ContinuationRetry>;

/** Session rules S1–S7 for the optional grilling fields; absent fields add nothing. */
function checkGrilling(
  s: { blocks?: Block[]; planner?: PlannerBinding; plannerHistory?: PlannerBinding[]; continuation?: Continuation; continuations?: Continuation[] },
  ctx: z.RefinementCtx,
): void {
  const issue = (message: string, path: Array<string | number>) => ctx.addIssue({ code: "custom", message, path });
  const history = s.continuations ?? [];
  const hasContinuation = s.continuation !== undefined || history.length > 0;
  if (hasContinuation && s.blocks === undefined) issue("a continuation requires session blocks", ["continuation"]);
  if ((hasContinuation || s.continuations !== undefined) && s.planner === undefined) issue("a continuation requires a planner", ["continuation"]);
  if (s.plannerHistory !== undefined) {
    if (s.planner === undefined) issue("plannerHistory requires a planner", ["plannerHistory"]);
    s.plannerHistory.forEach((b, i) => {
      const previous = i > 0 ? s.plannerHistory![i - 1].epoch : 0;
      if (b.epoch <= previous || (s.planner !== undefined && b.epoch >= s.planner.epoch)) {
        issue("plannerHistory epochs must increase and stay below the planner's epoch", ["plannerHistory", i, "epoch"]);
      }
    });
  }
  const c = s.continuation;
  if (c !== undefined && s.blocks !== undefined) {
    const block = (id: string) => s.blocks!.find((b) => b.id === id);
    if (block(c.openBlockId) === undefined) issue("openBlockId must name a block of the session", ["continuation", "openBlockId"]);
    if (c.nextBlockId !== undefined && block(c.nextBlockId) === undefined) issue("nextBlockId must name a block of the session", ["continuation", "nextBlockId"]);
    if (c.acceptedBlockId !== undefined && block(c.acceptedBlockId)?.state !== "accepted") {
      issue("acceptedBlockId must name an accepted block", ["continuation", "acceptedBlockId"]);
    }
  }
  if (c !== undefined && s.planner !== undefined) {
    if (!isTerminalContinuation(c.state)) {
      if (c.target.agentId !== s.planner.agentId || c.target.epoch !== s.planner.epoch) {
        issue("a live continuation must target the current planner and epoch", ["continuation", "target"]);
      }
    } else if (c.target.epoch > s.planner.epoch) {
      issue("a continuation cannot target a future planner epoch", ["continuation", "target"]);
    }
  }
  history.forEach((h, i) => {
    if (!isTerminalContinuation(h.state)) issue("continuation history holds terminal operations only", ["continuations", i, "state"]);
  });
  const ids = [...history.map((h) => h.operationId), ...(c !== undefined ? [c.operationId] : [])];
  if (new Set(ids).size !== ids.length) issue("operation ids must be unique", ["continuations"]);
}

/**
 * v2 session. Without `blocks` it is a legacy session and no question may name a block; with
 * `blocks` every question names one block of this session. The automatic-grilling fields
 * (`planner`, `plannerHistory`, `continuation`, `continuations`) are optional and absent by default.
 */
export const Session = z
  .object({
    ...sessionFields,
    questions: z.array(Question),
    blocks: z.array(Block).optional(),
    planner: PlannerBinding.optional(),
    plannerHistory: z.array(PlannerBinding).optional(),
    continuation: Continuation.optional(),
    continuations: z.array(Continuation).optional(),
    /**
     * The planner's proposal to finish, with the active skipped and out-of-scope question numbers at
     * that time; `finishedAt` is set when the owner confirms with Finish and kept after a reopen.
     */
    finishProposal: FinishProposal.optional(),
    /**
     * Earlier proposals, oldest first and append-only: a new proposal moves the current one here,
     * finished (with `finishedAt`) or never finished. Absent until the first such move.
     */
    finishHistory: z.array(FinishProposal).optional(),
    /**
     * The owner's closes by Finish, oldest first and append-only, except that a reopen stamps the
     * last one's `reopenedAt` once. Absent for sessions never closed by Finish since it was added.
     */
    closures: z.array(SessionClosure).optional(),
    /** Manual continuation retries, oldest first. */
    retries: z.array(ContinuationRetry).optional(),
    /**
     * The discussion language chosen at Discuss when it is not English. Absent means English, or, for
     * an earlier session, the answer of its question tagged "language".
     */
    language: SessionLanguage.optional(),
    /**
     * The owner's Got it on the no-translation notice, for the language label it was shown for; written
     * only by `session.language_notice.ack`. A different effective label shows the notice again.
     */
    languageNoticeAck: LanguageNoticeAck.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    checkGrilling(s, ctx);
    // Stored numbers only: older stores without numbers stay readable whatever their orders.
    const numbers = s.questions.flatMap((q) => (q.number !== undefined ? [q.number] : []));
    if (new Set(numbers).size !== numbers.length) ctx.addIssue({ code: "custom", message: "question numbers must be unique", path: ["questions"] });
    if (s.blocks === undefined) {
      s.questions.forEach((q, i) => {
        if (q.blockId !== undefined) {
          ctx.addIssue({ code: "custom", message: "blockId requires session blocks", path: ["questions", i, "blockId"] });
        }
      });
      return;
    }
    const ids = s.blocks.map((b) => b.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "block ids must be unique", path: ["blocks"] });
    // Exactly one open block, and no accepted block above it: the open block is the current one.
    const open = s.blocks.filter((b) => b.state === "open");
    if (open.length !== 1) {
      ctx.addIssue({ code: "custom", message: `a session with blocks needs exactly one open block, found ${open.length}`, path: ["blocks"] });
    } else if (s.blocks.some((b) => b.state === "accepted" && b.order > open[0].order)) {
      ctx.addIssue({ code: "custom", message: "the open block must not be ordered below an accepted block", path: ["blocks"] });
    }
    const known = new Set(ids);
    s.questions.forEach((q, i) => {
      if (q.blockId === undefined || !known.has(q.blockId)) {
        ctx.addIssue({ code: "custom", message: "every question must name a block of its session", path: ["questions", i, "blockId"] });
      }
    });
  });
export type Session = z.infer<typeof Session>;

export const LinkEnd = z.union([Ref, z.object({ sessionId: Id }).strict()]);
export type LinkEnd = z.infer<typeof LinkEnd>;

export const Link = z
  .object({ id: Id, kind: z.enum(["informs", "supersedes"]), from: LinkEnd, to: LinkEnd, note: z.string().optional() })
  .strict();
export type Link = z.infer<typeof Link>;

export const TaskDefinition = z.object({ id: Id, title: z.string(), description: z.string() }).strict();
export type TaskDefinition = z.infer<typeof TaskDefinition>;

/** Task of a schema 2 revision. Every field is required except grillSessionId; `dod` may be empty in a draft. */
export const TaskDefinitionV2 = z
  .object({
    id: Id,
    title: z.string(),
    description: z.string(),
    dependsOn: z.array(Id),
    parallel: z.boolean(),
    completion: z.enum(["auto", "human"]),
    grill: z.boolean(),
    grillSessionId: Id.optional(),
    dod: z.string(),
  })
  .strict();
export type TaskDefinitionV2 = z.infer<typeof TaskDefinitionV2>;

export type TaskGraphIssue = {
  code: "duplicate_task_id" | "unknown_dependency" | "self_dependency" | "duplicate_dependency" | "dependency_cycle";
  taskId: string;
  dependsOn?: string;
  cycle?: string[];
};

/**
 * Structural problems of a v2 task list, in task order and then dependency order. Each group of
 * mutually dependent tasks (a strongly connected component of two or more tasks) is reported
 * once, as `dependency_cycle` at its first task in task order; a self loop is `self_dependency`.
 */
export function taskGraphIssues(tasks: ReadonlyArray<Pick<TaskDefinitionV2, "id" | "dependsOn">>): TaskGraphIssue[] {
  const ids = new Set(tasks.map((t) => t.id));
  const perTask: TaskGraphIssue[][] = tasks.map(() => []);
  const seenIds = new Set<string>();
  tasks.forEach((t, i) => {
    if (seenIds.has(t.id)) perTask[i].push({ code: "duplicate_task_id", taskId: t.id });
    seenIds.add(t.id);
    const seenDeps = new Set<string>();
    for (const dep of t.dependsOn) {
      if (seenDeps.has(dep)) perTask[i].push({ code: "duplicate_dependency", taskId: t.id, dependsOn: dep });
      else if (dep === t.id) perTask[i].push({ code: "self_dependency", taskId: t.id, dependsOn: dep });
      else if (!ids.has(dep)) perTask[i].push({ code: "unknown_dependency", taskId: t.id, dependsOn: dep });
      seenDeps.add(dep);
    }
  });

  // Tarjan's strongly connected components over known, non-self edges (duplicate ids merged).
  const edges = new Map<string, string[]>();
  for (const t of tasks) {
    const out = edges.get(t.id) ?? [];
    for (const dep of t.dependsOn) if (dep !== t.id && ids.has(dep) && !out.includes(dep)) out.push(dep);
    edges.set(t.id, out);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let next = 0;
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) components.push(component);
    }
  };
  for (const t of tasks) if (!index.has(t.id)) visit(t.id);

  const firstIndex = new Map<string, number>();
  tasks.forEach((t, i) => {
    if (!firstIndex.has(t.id)) firstIndex.set(t.id, i);
  });
  for (const component of components) {
    const members = [...component].sort((a, b) => firstIndex.get(a)! - firstIndex.get(b)!);
    const at = firstIndex.get(members[0])!;
    perTask[at].push({ code: "dependency_cycle", taskId: members[0], cycle: members });
  }
  return perTask.flat();
}

const basedOnEntry = z
  .object({
    sessionId: Id,
    questionId: Id,
    answerRev: z.number().int(),
    definitionRev: z.number().int(),
    validity: Validity,
  })
  .strict();

const revisionFields = {
  rev: z.number().int().min(1),
  createdAt: IsoTime,
  contentHash: z.string(),
  markdown: z.string(),
  basedOn: z.array(basedOnEntry),
  decisionSnapshotHash: z.string(),
};

/** Legacy revision: no `schema` field, strict three-field tasks, hashed with the v1 function. */
export const PlanRevisionV1 = z.object({ ...revisionFields, tasks: z.array(TaskDefinition) }).strict();
export type PlanRevisionV1 = z.infer<typeof PlanRevisionV1>;

/** Schema 2 revision: v2 tasks whose dependencies form a valid graph. */
export const PlanRevisionV2 = z
  .object({ ...revisionFields, schema: z.literal(2), tasks: z.array(TaskDefinitionV2) })
  .strict()
  .superRefine((rev, ctx) => {
    for (const issue of taskGraphIssues(rev.tasks)) {
      ctx.addIssue({ code: "custom", message: `task graph: ${issue.code} at ${issue.taskId}`, path: ["tasks"] });
    }
  });
export type PlanRevisionV2 = z.infer<typeof PlanRevisionV2>;

export const PlanRevision = z.union([PlanRevisionV1, PlanRevisionV2]);
export type PlanRevision = z.infer<typeof PlanRevision>;

/** A revision is legacy iff it has no `schema` field (derived, never stored). */
export const isV2Revision = (rev: PlanRevision): rev is PlanRevisionV2 => "schema" in rev && rev.schema === 2;

const taskStateFields = {
  taskId: Id,
  planRev: z.number().int().min(1),
  verification: z.object({ at: IsoTime, note: z.string() }).strict().optional(),
};

/** Legacy (schema v1) task state, exactly the shape shipped at feb6905. */
export const TaskStateV1 = z.object({ ...taskStateFields, status: z.enum(["todo", "in_progress", "done", "verified"]) }).strict();
export type TaskStateV1 = z.infer<typeof TaskStateV1>;

/** Task state; `cancelled` is set only by a rework (Stage R2.3), and no task update sets or leaves it. */
export const TaskState = z
  .object({ ...taskStateFields, status: z.enum(["todo", "in_progress", "done", "verified", "cancelled"]) })
  .strict();
export type TaskState = z.infer<typeof TaskState>;

export const ApprovalReceipt = z
  .object({
    receiptId: Id,
    projectId: Id,
    planId: Id,
    planRev: z.number().int().min(1),
    contentHash: z.string(),
    decisionSnapshotHash: z.string(),
    at: IsoTime,
    actor: z.object({ kind: z.literal("human"), hostClientId: z.string().optional() }).strict(),
    note: z.string().optional(),
  })
  .strict();
export type ApprovalReceipt = z.infer<typeof ApprovalReceipt>;

export const TrackerIntent = z
  .object({
    intentId: Id,
    planId: Id,
    taskId: Id,
    planRev: z.number().int().min(1),
    receiptId: Id,
    kind: z.enum(["create", "close", "comment"]),
    payload: z.unknown(),
    destination: z.string(),
    mode: z.string(),
    state: z.enum(["pending", "sent", "confirmed", "unknown", "failed"]),
    createdAt: IsoTime,
    lastAttemptAt: IsoTime,
    error: z.string().optional(),
  })
  .strict();
export type TrackerIntent = z.infer<typeof TrackerIntent>;

export const TicketMapping = z
  .object({
    provider: z.literal("snailorbit"),
    remoteId: z.string(),
    remoteKey: z.string(),
    url: z.string(),
    idempotencyKey: z.string(),
    intentId: Id,
    state: z.enum(["created", "closed"]),
    lastSyncAt: IsoTime,
  })
  .strict();
export type TicketMapping = z.infer<typeof TicketMapping>;

const planFields = {
  id: Id,
  title: z.string(),
  sessionIds: z.array(Id),
  approvals: z.array(ApprovalReceipt),
  intents: z.array(TrackerIntent),
  tickets: z.array(TicketMapping),
};

/** Legacy (schema v1) plan, exactly the shape shipped at feb6905. */
export const PlanV1 = z.object({ ...planFields, taskStates: z.array(TaskStateV1), revisions: z.array(PlanRevisionV1) }).strict();
export type PlanV1 = z.infer<typeof PlanV1>;

/** A revision sent for rework (Stage R2.3); the revision itself is never edited. */
export const PlanReworkRecord = z
  .object({
    planRev: z.number().int().min(1),
    at: IsoTime,
    reason: z.string().min(1),
    actor: z.object({ kind: z.literal("human"), hostClientId: z.string().optional() }).strict(),
  })
  .strict();
export type PlanReworkRecord = z.infer<typeof PlanReworkRecord>;

/**
 * v2 plan: legacy and schema 2 revisions, optionally bound to a feature. `grillSessionId` is the
 * plan's server-created grilling session (Stage R2); a revision listed in `reworks` is superseded.
 */
export const Plan = z
  .object({
    ...planFields,
    taskStates: z.array(TaskState),
    revisions: z.array(PlanRevision),
    featureId: Id.optional(),
    grillSessionId: Id.optional(),
    reworks: z.array(PlanReworkRecord).optional(),
  })
  .strict();
export type Plan = z.infer<typeof Plan>;

/** A plan is legacy iff it is not bound to a feature (derived, never stored). */
export const isLegacyPlan = (plan: Plan): boolean => plan.featureId === undefined;

export const FeatureStatus = z.enum(["created", "planned", "executing", "done", "deferred", "cancelled"]);
export type FeatureStatus = z.infer<typeof FeatureStatus>;

/** Who created a card or event. `agentId: "unknown"` when the calling grant has no bound agent yet. */
export const FeatureCreator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), hostClientId: z.string().optional() }).strict(),
  z.object({ kind: z.literal("agent"), agentId: Id }).strict(),
]);
export type FeatureCreator = z.infer<typeof FeatureCreator>;

export const CoordinatorBinding = z
  .object({ agentId: Id, workspaceId: Id, boundAt: IsoTime, profileRef: z.string() })
  .strict();
export type CoordinatorBinding = z.infer<typeof CoordinatorBinding>;

export const FeatureEvent = z
  .object({
    at: IsoTime,
    actor: FeatureCreator,
    kind: z.enum(["created", "updated", "status", "dependencies", "reordered", "coordinator", "note"]),
    from: z.string().optional(),
    to: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type FeatureEvent = z.infer<typeof FeatureEvent>;

const DiscussionBound = z
  .object({ state: z.literal("bound"), reservationId: Id, agentId: Id, workspaceId: Id, boundAt: IsoTime, profileRef: z.string().min(1) })
  .strict();
/**
 * A feature's discussion chat. `creating`: the reservation, written before the host creates the agent,
 * whose id is the agent's reservation label. `failed`: the host refused the creation (authentication).
 * `unresolved`: the creation outcome is unknown and no agent with the reservation label was found;
 * absence in the listing does not prove none was created, so only the owner's explicit retry, under
 * the same reservation, may create again. `bound`: the chat and its agent.
 */
export const DiscussionBinding = z.discriminatedUnion("state", [
  z.object({ state: z.literal("creating"), reservationId: Id, profileRef: z.string().min(1), workspaceId: Id, at: IsoTime }).strict(),
  z.object({ state: z.literal("failed"), reservationId: Id, profileRef: z.string().min(1), workspaceId: Id, at: IsoTime, error: z.string() }).strict(),
  z
    .object({ state: z.literal("unresolved"), reservationId: Id, profileRef: z.string().min(1), workspaceId: Id, at: IsoTime, checkedAt: IsoTime })
    .strict(),
  DiscussionBound,
]);
export type DiscussionBinding = z.infer<typeof DiscussionBinding>;

export const Feature = z
  .object({
    id: Id,
    title: z.string(),
    description: z.string(),
    kind: z.enum(["feature", "bug"]),
    status: FeatureStatus,
    statusReason: z.string().optional(),
    statusBeforeDefer: z.enum(["created", "planned", "executing"]).optional(),
    dependsOn: z.array(Id),
    relatedTo: z.array(Id),
    everStarted: z.boolean(),
    createdAt: IsoTime,
    createdBy: FeatureCreator,
    coordinator: CoordinatorBinding.optional(),
    /** Stage R4.3: a replacement plan is wanted because a prerequisite (`becauseOf`, the root) was cancelled. */
    replacementRequested: z
      .object({
        at: IsoTime,
        becauseOf: Id,
        state: z.enum(["queued", "requested"]),
        /** The bound plan revision reworked for it; a cancellation that reworks nothing keeps an earlier value and sets none. */
        reworkedRev: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    /** The feature's server-created grilling session (Stage R2); a bug gets none automatically. */
    grillSessionId: Id.optional(),
    /** The feature's discussion chat: a reservation while creating, then the binding. */
    discussion: DiscussionBinding.optional(),
    /** Earlier bindings, oldest first. */
    discussionHistory: z.array(DiscussionBound).optional(),
    coordinatorHistory: z.array(CoordinatorBinding),
    events: z.array(FeatureEvent),
  })
  .strict()
  .superRefine((f, ctx) => {
    if ((f.statusBeforeDefer !== undefined) !== (f.status === "deferred")) {
      ctx.addIssue({ code: "custom", message: "statusBeforeDefer present iff status is deferred", path: ["statusBeforeDefer"] });
    }
    if (f.dependsOn.includes(f.id)) ctx.addIssue({ code: "custom", message: "a feature cannot depend on itself", path: ["dependsOn"] });
    if (new Set(f.dependsOn).size !== f.dependsOn.length) {
      ctx.addIssue({ code: "custom", message: "dependency ids must be unique", path: ["dependsOn"] });
    }
  });
export type Feature = z.infer<typeof Feature>;

// Run, evidence and delegation records are provisional until Stage R3 first writes them.

export const WorktreeIdentity = z
  .object({ headCommit: z.string(), indexTreeHash: z.string(), worktreeTreeHash: z.string(), untrackedHash: z.string() })
  .strict();
export type WorktreeIdentity = z.infer<typeof WorktreeIdentity>;

export const ResultBinding = z
  .object({
    taskId: Id,
    planId: Id,
    planRev: z.number().int().min(1),
    contentHash: z.string(),
    runToken: Id,
    worktree: WorktreeIdentity,
  })
  .strict();
export type ResultBinding = z.infer<typeof ResultBinding>;

export const Evidence = z
  .object({
    id: Id,
    kind: z.enum(["check", "review", "acceptance"]),
    taskId: Id,
    binding: ResultBinding,
    at: IsoTime,
    result: z.enum(["pass", "fail"]),
    itemIndex: z.number().int().min(0).optional(),
    exitCode: z.number().int().optional(),
    reason: z.string().optional(),
    lateReason: z.string().optional(),
  })
  .strict();
export type Evidence = z.infer<typeof Evidence>;

export const TaskRunState = z.enum([
  "todo",
  "claimed",
  "in_progress",
  "checks_pending",
  "review_pending",
  "awaiting_acceptance",
  "verified",
  "cancelled",
  "ceiling",
]);
export type TaskRunState = z.infer<typeof TaskRunState>;

export const TaskRun = z
  .object({
    taskId: Id,
    state: TaskRunState,
    agentId: Id.optional(),
    failedCycles: z.number().int().min(0),
    extraBudget: z.number().int().min(0),
    binding: ResultBinding.optional(),
    unresolved: z.array(z.string()),
  })
  .strict();
export type TaskRun = z.infer<typeof TaskRun>;

export const RunState = z.enum(["running", "paused", "ended"]);
export type RunState = z.infer<typeof RunState>;
export const PauseReason = z.enum(["owner", "deferred", "prerequisite_not_done", "prerequisite_cancelled"]);
export type PauseReason = z.infer<typeof PauseReason>;
export const EndReason = z.enum(["finished", "cancelled_for_rework", "cancelled_with_feature"]);
export type EndReason = z.infer<typeof EndReason>;

export const RunEvent = z
  .object({ at: IsoTime, kind: z.string().min(1), taskId: Id.optional(), detail: z.string().optional() })
  .strict();
export type RunEvent = z.infer<typeof RunEvent>;

export const ExecutionRun = z
  .object({
    id: Id,
    featureId: Id,
    planId: Id,
    planRev: z.number().int().min(1),
    runToken: Id,
    state: RunState,
    pauseReason: PauseReason.optional(),
    endReason: EndReason.optional(),
    pausedAt: IsoTime.optional(),
    endedAt: IsoTime.optional(),
    startAuth: z
      .object({
        kind: z.enum(["ui", "delegation"]),
        delegationId: Id.optional(),
        at: IsoTime,
        hostClientId: z.string().optional(),
      })
      .strict(),
    tasks: z.array(TaskRun),
    acks: z.array(z.object({ taskId: Id, agentId: Id, at: IsoTime }).strict()),
    events: z.array(RunEvent),
    /** Current-binding results recorded by the runners and acceptances (Stage R3.3); absent until the first. */
    evidence: z.array(Evidence).optional(),
    lateEvidence: z.array(Evidence),
  })
  .strict();
export type ExecutionRun = z.infer<typeof ExecutionRun>;

export const DelegationProvenance = z
  .object({
    agentId: Id,
    messageId: z.string().optional(),
    seqStart: z.number().int(),
    turnId: z.string().optional(),
    timestamp: IsoTime,
    quoted: z.string().min(1),
  })
  .strict();
export type DelegationProvenance = z.infer<typeof DelegationProvenance>;

export const StartDelegation = z
  .object({
    id: Id,
    scope: z.enum(["feature", "roadmap"]),
    featureId: Id.optional(),
    provenance: DelegationProvenance,
    grantedAt: IsoTime,
    revokedAt: IsoTime.optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if ((d.featureId !== undefined) !== (d.scope === "feature")) {
      ctx.addIssue({ code: "custom", message: "featureId present iff scope is feature", path: ["featureId"] });
    }
  });
export type StartDelegation = z.infer<typeof StartDelegation>;

export const ProjectSettings = z.object({ dodTemplate: z.string().optional() }).strict();
export type ProjectSettings = z.infer<typeof ProjectSettings>;

const metaFields = { projectId: Id, createdAt: IsoTime, links: z.array(Link), sessionIds: z.array(Id), planIds: z.array(Id) };

/** Legacy (schema v1) roadmap.json, exactly the shape shipped at feb6905. */
export const RoadmapMetaV1 = z.object({ version: z.literal(1), ...metaFields }).strict();
export type RoadmapMetaV1 = z.infer<typeof RoadmapMetaV1>;

const CancellationActor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), hostClientId: z.string().optional() }).strict(),
  z.object({ kind: z.literal("agent"), agentId: z.string().min(1) }).strict(),
]);

/** Fields of a cancellation record; `Cancellation` adds its rules. */
export const cancellationFields = {
  id: Id,
  ref: Ref,
  reason: z.string(),
  at: IsoTime,
  actor: CancellationActor,
  /** For an agent cancellation that needed consent: the human's words the agent reported. */
  quoted: z.string().min(1).optional(),
};

/**
 * An explicit, append-only cancellation of a decision. The reason is required and stored trimmed.
 * A human cancels in the UI; an agent cancels through MCP, quoting the human where consent is
 * required. The decision's own record is never changed by it.
 */
export const Cancellation = z.object(cancellationFields).strict().superRefine(checkCancellation);

/** Rules of a cancellation record, shared by every schema that carries one. */
export function checkCancellation(c: { reason: string; quoted?: string; actor: { kind: "human" | "agent" } }, ctx: z.RefinementCtx): void {
  if (c.reason.length === 0 || c.reason.trim() !== c.reason) ctx.addIssue({ code: "custom", message: "reason must be non-empty and trimmed", path: ["reason"] });
  if (c.quoted !== undefined && c.actor.kind !== "agent") ctx.addIssue({ code: "custom", message: "quoted is recorded for agent cancellations only", path: ["quoted"] });
}
export type Cancellation = z.infer<typeof Cancellation>;

const Cancellations = z.array(Cancellation).superRefine((list, ctx) => {
  if (new Set(list.map((c) => c.id)).size !== list.length) ctx.addIssue({ code: "custom", message: "cancellation ids must be unique" });
  if (new Set(list.map((c) => refKey(c.ref))).size !== list.length) {
    ctx.addIssue({ code: "custom", message: "a decision is cancelled at most once" });
  }
});

/**
 * An explicit, append-only out-of-scope mark of a question: who marked it, how, and after which answer
 * revision (absent for an unanswered question). The question's own `validity` holds the current
 * outcome; these marks keep every mark in its history after later answers.
 */
export const OutOfScopeMark = z
  .object({
    id: Id,
    ref: Ref,
    at: IsoTime,
    source: z.enum(["ui", "chat"]),
    actor: Actor,
    quoted: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    afterRev: z.number().int().min(1).optional(),
  })
  .strict();
export type OutOfScopeMark = z.infer<typeof OutOfScopeMark>;

const OutOfScopeMarks = z.array(OutOfScopeMark).superRefine((list, ctx) => {
  if (new Set(list.map((m) => m.id)).size !== list.length) ctx.addIssue({ code: "custom", message: "out-of-scope mark ids must be unique" });
});

export const RoadmapMetaV2 = z
  .object({
    version: z.literal(2),
    ...metaFields,
    featureIds: z.array(Id),
    runIds: z.array(Id),
    settings: ProjectSettings,
    // Absent until the first cancellation; never defaulted, so existing v2 bytes stay unchanged.
    cancellations: Cancellations.optional(),
    // Absent until the first out-of-scope mark, like cancellations.
    outOfScopeMarks: OutOfScopeMarks.optional(),
  })
  .strict();
export type RoadmapMetaV2 = z.infer<typeof RoadmapMetaV2>;

export const RoadmapMeta = z.discriminatedUnion("version", [RoadmapMetaV1, RoadmapMetaV2]);
export type RoadmapMeta = z.infer<typeof RoadmapMeta>;

export const Manifest = z
  .object({
    version: z.literal(1),
    projectId: Id,
    revision: z.number().int().min(1),
    generation: z.string().regex(GEN_RE),
    changeToken: z.string().min(1),
    disabled: z.boolean().optional(),
  })
  .strict();
export type Manifest = z.infer<typeof Manifest>;

/** A legacy generation: no v2-only field anywhere. */
export const RoadmapDataV1 = z.object({ meta: RoadmapMetaV1, sessions: z.array(SessionV1), plans: z.array(PlanV1) }).strict();
export type RoadmapDataV1 = z.infer<typeof RoadmapDataV1>;

/** Cancellation refs that name no existing question. */
export function cancellationRefIssues(data: { meta: { cancellations?: Cancellation[] }; sessions: Session[] }): Ref[] {
  const known = new Set(data.sessions.flatMap((s) => s.questions.map((q) => refKey({ sessionId: s.id, questionId: q.id }))));
  return (data.meta.cancellations ?? []).filter((c) => !known.has(refKey(c.ref))).map((c) => c.ref);
}

/** Out-of-scope mark refs that name no existing question. */
export function outOfScopeRefIssues(data: { meta: { outOfScopeMarks?: OutOfScopeMark[] }; sessions: Session[] }): Ref[] {
  const known = new Set(data.sessions.flatMap((s) => s.questions.map((q) => refKey({ sessionId: s.id, questionId: q.id }))));
  return (data.meta.outOfScopeMarks ?? []).filter((m) => !known.has(refKey(m.ref))).map((m) => m.ref);
}

/** A v2 generation. Roadmap order is the order of `features`. */
export const RoadmapDataV2 = z
  .object({
    meta: RoadmapMetaV2,
    sessions: z.array(Session),
    plans: z.array(Plan),
    features: z.array(Feature),
    runs: z.array(ExecutionRun),
    delegations: z.array(StartDelegation),
  })
  .strict()
  .superRefine((data, ctx) => {
    for (const ref of cancellationRefIssues(data)) {
      ctx.addIssue({ code: "custom", message: `cancellation of an unknown decision ${refKey(ref)}`, path: ["meta", "cancellations"] });
    }
    for (const ref of outOfScopeRefIssues(data)) {
      ctx.addIssue({ code: "custom", message: `out-of-scope mark of an unknown question ${refKey(ref)}`, path: ["meta", "outOfScopeMarks"] });
    }
  });
export type RoadmapDataV2 = z.infer<typeof RoadmapDataV2>;

/** The in-memory roadmap: always the v2 view (legacy generations are projected on read). */
export const RoadmapData = RoadmapDataV2;
export type RoadmapData = RoadmapDataV2;

export type Visibility = "active" | "inactive";
export type RefKey = `${string}/${string}`;
export const refKey = (r: Ref): RefKey => `${r.sessionId}/${r.questionId}`;
