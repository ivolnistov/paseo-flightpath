import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Relation } from "./graph";
import {
  Activation,
  Answer,
  ApprovalReceipt,
  Block,
  cancellationFields,
  checkCancellation,
  Id,
  Invalidation,
  IsoTime,
  Link,
  LinkEnd,
  Option,
  OutOfScopeMark,
  Continuation,
  ContinuationRetry,
  SessionLanguage,
  LanguageNoticeAck,
  FinishProposal,
  SessionClosure,
  Plan,
  PlannerBinding,
  Question,
  Ref,
  Session,
  SessionV1,
  Stale,
  TaskState,
  TrackerIntent,
} from "./model";
import { DefinitionFields, Mutation, OptionId, ProjectInput, Refs, result, Written } from "./rpc-base";
import { BlockAccept, QuestionCreateV2Input } from "./rpc-blocks";
import { DecisionCancel } from "./rpc-decisions";
import { DiscussionRetry, DiscussionRetryCheck, DiscussionRetryResolve, FeatureDiscussionOpen, QuestionOutOfScope, SessionFinish } from "./rpc-discussion";
import { DodTemplateGet } from "./rpc-dod";
import { GrillingView, SessionLanguageNoticeAck, SessionPlannerSet, SessionReopen } from "./rpc-grilling";
import { FEATURE_CONTRACTS, PlanRework } from "./rpc-features";
import { RUN_CONTRACTS, RUN_EVIDENCE_CONTRACTS } from "./rpc-runs";

export {
  OptionId,
  RPC_ERROR_CODES,
  RpcError,
  result,
  rpcCodesInSync,
  type Result,
  type ValueOf,
} from "./rpc-base";
export { GRILLING_STATUSES, GrillingStatus, GrillingView, SessionLanguageNoticeAck, SessionPlannerSet, SessionReopen } from "./rpc-grilling";
export {
  DiscussionRetry,
  DiscussionRetryCheck,
  DiscussionRetryResolve,
  DiscussionTools,
  FeatureDiscussionOpen,
  QuestionOutOfScope,
  SessionFinish,
} from "./rpc-discussion";

export const QuestionStatusSchema = z.enum(["open", "answered", "stale", "skipped", "inactive", "out_of_scope"]);
const RefFields = { sessionId: Id, questionId: Id };
export const RelationInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("activation"), target: Ref, activation: Activation }),
  z.object({ kind: z.literal("invalidation"), target: Ref, invalidation: Invalidation }),
]);
// Type-level check: every RelationInput is a Relation (no runtime value).
type RelationInputIsRelation = z.infer<typeof RelationInput> extends Relation ? true : never;
const _relationCompatible: RelationInputIsRelation = true;
void _relationCompatible;

// Composition, not `.extend`: core `Question` carries `.superRefine`, and Zod 4 refuses to extend refined objects.
export const QuestionView = z.object({
  question: Question,
  visibility: z.enum(["active", "inactive"]),
  status: QuestionStatusSchema,
  depth: z.number().int().min(0),
  /** Stable per-session number: stored, else order + 1 for a question written before numbering. */
  number: z.number().int().min(1),
  /** Canonical question link and current-answer link. */
  links: z.object({ question: z.string(), answer: z.string() }),
  /** The current answer: present only for an answered or stale question. */
  currentAnswer: Answer.optional(),
  /**
   * The answer a skipped or out-of-scope question kept from before; history, never current. The
   * stored `question.answer` stays the latest revision.
   */
  priorAnswer: Answer.optional(),
  /** Every out-of-scope mark of this question, oldest first; absent when never marked. */
  outOfScopeEvents: z.array(OutOfScopeMark).optional(),
  /**
   * A skipped or out-of-scope question kept its outcome while a question it depends on changed
   * since: the cause, as for staleness. Answering, skipping or marking it out of scope again clears it.
   */
  review: Stale.optional(),
  /** Out-of-scope questions this one depends on (activation or invalidation, transitively): review it. */
  outOfScopeUpstream: z.array(z.object({ ref: Ref, number: z.number().int().min(1) })).optional(),
});
export type QuestionView = z.infer<typeof QuestionView>;
/** A question of the session that is out of scope, and every question depending on it, for review. */
export const OutOfScopeEntry = z.object({
  ref: Ref,
  number: z.number().int().min(1),
  dependents: z.array(z.object({ ref: Ref, number: z.number().int().min(1), status: QuestionStatusSchema })),
});
export type OutOfScopeEntry = z.infer<typeof OutOfScopeEntry>;
export const CatalogEntry = z.object({
  ref: Ref,
  sessionTitle: z.string(),
  questionTitle: z.string(),
  options: z.array(Option),
  status: QuestionStatusSchema,
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;
/**
 * A session without its questions; `blocks` only for a session that uses grilling blocks, and the
 * automatic-grilling fields only where stored.
 */
export const SessionViewSession = SessionV1.omit({ questions: true }).extend({
  blocks: z.array(Block).optional(),
  planner: PlannerBinding.optional(),
  plannerHistory: z.array(PlannerBinding).optional(),
  continuation: Continuation.optional(),
  continuations: z.array(Continuation).optional(),
  finishProposal: FinishProposal.optional(),
  finishHistory: z.array(FinishProposal).optional(),
  closures: z.array(SessionClosure).optional(),
  retries: z.array(ContinuationRetry).optional(),
  language: SessionLanguage.optional(),
  languageNoticeAck: LanguageNoticeAck.optional(),
});
/** A dependent decision listed for review: its ref, stable number and current status. */
export const DependentView = z.object({ ref: Ref, number: z.number().int().min(1), status: QuestionStatusSchema });
export type DependentView = z.infer<typeof DependentView>;
/** A stored cancellation plus its dependents (activation and invalidation, transitively, across sessions). */
export const CancellationView = z.object({ ...cancellationFields, dependents: z.array(DependentView) }).strict().superRefine(checkCancellation);
export type CancellationView = z.infer<typeof CancellationView>;
/**
 * An accepted block's summary at acceptance (the text the chat was given) and now. Without a
 * recorded snapshot `acceptedSummary` is empty, `noSnapshot` is true and nothing is reported changed.
 */
export const BlockSummaryView = z.object({
  blockId: Id,
  acceptedSummary: z.string(),
  currentSummary: z.string(),
  changedSinceAcceptance: z.boolean(),
  /** Session numbers whose summary entry differs from the one given at acceptance. */
  changed: z.array(z.number().int().min(1)),
  noSnapshot: z.literal(true).optional(),
});
export type BlockSummaryView = z.infer<typeof BlockSummaryView>;
export const SessionView = z.object({
  revision: z.number().int(),
  session: SessionViewSession,
  /** Explicit cancellations of this session's decisions, append-only, each with its dependents to cancel or re-ask. */
  cancellations: z.array(CancellationView),
  questions: z.array(QuestionView),
  links: z.array(Link),
  catalog: z.array(CatalogEntry),
  /** Derived automatic-grilling status; present only for a session that uses grilling blocks. */
  grilling: GrillingView.optional(),
  /**
   * This session's out-of-scope questions, each with every question that depends on it (activation
   * children and invalidation dependents, transitively, across sessions) for review. The listing
   * cancels nothing; the mark itself hid the activation children and made answered invalidation
   * dependents stale, or gave a skipped or out-of-scope one a review marker.
   */
  outOfScope: z.array(OutOfScopeEntry).optional(),
  /** Accepted blocks' summaries, in block order; only for a session that uses blocks. */
  summaries: z.array(BlockSummaryView).optional(),
  /** The open block's summary as it would be sent if accepted now; only for a session that uses blocks. */
  openBlockPreview: z.string().optional(),
});
export type SessionView = z.infer<typeof SessionView>;
const Count = z.number().int().min(0);
export const Counts = z.object({ open: Count, answered: Count, stale: Count, skipped: Count, inactive: Count, out_of_scope: Count });
export type Counts = z.infer<typeof Counts>;
export const Overview = z.object({
  revision: z.number().int(),
  disabled: z.boolean(),
  sessions: z.array(z.object({ id: Id, title: z.string(), status: Session.shape.status, counts: Counts })),
  links: z.array(Link),
});
export type Overview = z.infer<typeof Overview>;

export const VersionValue = z.object({
  status: z.enum(["missing", "ok", "invalid"]),
  revision: z.number().int().nullable(),
  error: z.string().optional(),
});
export type VersionValue = z.infer<typeof VersionValue>;

export const RoadmapVersion = defineRpc({ name: "roadmap.version", input: ProjectInput, output: result(VersionValue) });
export const RoadmapInit = defineRpc({
  name: "roadmap.init",
  input: ProjectInput,
  output: result(z.object({ created: z.boolean(), revision: z.number().int().min(1) })),
});
export const RoadmapOverview = defineRpc({ name: "roadmap.overview", input: ProjectInput, output: result(Overview) });
export const SessionGet = defineRpc({
  name: "session.get",
  input: ProjectInput.extend({ sessionId: Id }),
  output: result(SessionView),
});
export const SessionCreate = defineRpc({
  name: "session.create",
  input: Mutation.extend({ title: z.string().min(1) }),
  output: result(Written.extend({ sessionId: Id })),
});
export const QuestionCreate = defineRpc({
  name: "question.create",
  input: QuestionCreateV2Input,
  /** `rev` is present when the owner's first text answer was written with the question. */
  output: result(Written.extend({ questionId: Id, visibilityChanged: Refs, rev: z.literal(1).optional() })),
});
export const QuestionUpdate = defineRpc({
  name: "question.update",
  input: Mutation.extend({
    ...RefFields,
    // `recommendedOptionId: null` clears the recommendation.
    patch: z
      .object({ ...DefinitionFields, recommendedOptionId: OptionId.nullable() })
      .partial()
      .refine((p) => Object.values(p).some((v) => v !== undefined), { message: "patch must change at least one field" }),
  }),
  output: result(Written.extend({ definitionRev: z.number().int().min(1), staleMarked: Refs })),
});
export const QuestionAnswer = defineRpc({
  name: "question.answer",
  input: Mutation.extend({
    ...RefFields,
    optionId: Id.optional(),
    text: z.string().optional(),
    note: z.string().optional(),
    /** The owner submitted the preselected recommendation unchanged; stored only when it is that option. */
    defaulted: z.boolean().optional(),
  }),
  output: result(
    Written.extend({ rev: z.number().int().min(1), valueChanged: z.boolean(), staleMarked: Refs, visibilityChanged: Refs }),
  ),
});
export const QuestionConfirm = defineRpc({
  name: "question.confirm",
  input: Mutation.extend(RefFields),
  output: result(Written.extend({ rev: z.number().int().min(1), visibilityChanged: Refs })),
});
export const QuestionSkip = defineRpc({
  name: "question.skip",
  input: Mutation.extend(RefFields),
  output: result(Written.extend({ visibilityChanged: Refs })),
});
export const QuestionDiscuss = defineRpc({
  name: "question.discuss",
  input: Mutation.extend({ ...RefFields, text: z.string().min(1) }),
  output: result(Written.extend({ noteId: Id })),
});
const RelationChange = result(Written.extend({ staleMarked: Refs, visibilityChanged: Refs }));
export const RelationAdd = defineRpc({
  name: "relation.add",
  input: Mutation.extend({ relation: RelationInput }),
  output: RelationChange,
});
export const RelationRemove = defineRpc({
  name: "relation.remove",
  input: Mutation.extend({ relation: RelationInput }),
  output: RelationChange,
});
export const LinkCreate = defineRpc({
  name: "link.create",
  input: Mutation.extend({ kind: z.enum(["informs", "supersedes"]), from: LinkEnd, to: LinkEnd, note: z.string().optional() }),
  output: result(Written.extend({ linkId: Id })),
});
export const LinkDelete = defineRpc({
  name: "link.delete",
  input: Mutation.extend({ linkId: Id }),
  output: result(Written),
});

export const STAGE1_CONTRACTS = [
  RoadmapVersion,
  RoadmapInit,
  RoadmapOverview,
  SessionGet,
  SessionCreate,
  QuestionCreate,
  QuestionUpdate,
  QuestionAnswer,
  QuestionConfirm,
  QuestionSkip,
  QuestionDiscuss,
  RelationAdd,
  RelationRemove,
  LinkCreate,
  LinkDelete,
] as const;

// Stage 3: plans, approval and tasks. Registered separately from STAGE1_CONTRACTS.
export const PlanRef = z.object({ projectId: Id, planId: Id });
const ContentHash = z.string().regex(/^[0-9a-f]{64}$/);
/**
 * A drafted task. The v2 fields are optional and have no defaults: a request that carries none of
 * them (and no featureId) is a legacy draft; the server builds v2 defaults explicitly.
 */
export const TaskInput = z
  .object({
    id: Id.optional(),
    title: z.string().min(1),
    description: z.string(),
    dependsOn: z.array(Id).optional(),
    parallel: z.boolean().optional(),
    completion: z.enum(["auto", "human"]).optional(),
    grill: z.boolean().optional(),
    dod: z.string().optional(),
  })
  .strict();
export const ApprovalStatus = z.enum(["current", "not_current", "unapproved", "unverified"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;
export const PlanSummary = z.object({
  id: Id,
  title: z.string(),
  latestRev: z.number().int().nullable(),
  approval: ApprovalStatus,
  /** The feature the plan is bound to; absent for a legacy plan. */
  featureId: Id.optional(),
});
export type PlanSummary = z.infer<typeof PlanSummary>;
/** Why the latest revision cannot be approved; computed by the server for both plan.get and plan.approve. */
export const ApprovalBlocker = z
  .object({
    code: z.enum(["gates_not_available", "dod_missing", "grilling_required", "legacy_revision"]),
    taskId: Id.optional(),
    sessionId: Id.optional(),
  })
  .strict();
export type ApprovalBlocker = z.infer<typeof ApprovalBlocker>;
export const PlanView = z.object({
  revision: z.number().int(),
  plan: Plan.omit({ approvals: true, intents: true, tickets: true }),
  approvals: z.array(z.object({ receipt: ApprovalReceipt, verified: z.boolean() })),
  approval: ApprovalStatus,
  notCurrentReasons: z.array(z.string()),
  exportWritten: z.boolean(),
  blockers: z.array(ApprovalBlocker),
  /** Verified tasks of revisions sent for rework, newest revision first; never applied automatically. Absent when empty. */
  reuseCandidates: z
    .array(z.object({ planRev: z.number().int().min(1), taskId: Id, title: z.string(), verifiedAt: IsoTime.optional() }).strict())
    .optional(),
  /**
   * Effects of the latest revision's durable approval not yet recorded (derived, never stored); absent
   * when none. `retryBlocked` names a server refusal that makes a same-revision retry pointless.
   */
  approvalEffectsPending: z
    .array(
      z
        .object({
          effect: z.enum(["project_copy", "feature_planned"]),
          reason: z.string(),
          retryBlocked: z.literal("feature_has_multiple_plans").optional(),
        })
        .strict(),
    )
    .optional(),
});
export type PlanView = z.infer<typeof PlanView>;
export const PlanList = defineRpc({
  name: "plan.list",
  input: ProjectInput,
  output: result(z.object({ revision: z.number().int(), plans: z.array(PlanSummary) })),
});
export const PlanGet = defineRpc({ name: "plan.get", input: PlanRef, output: result(PlanView) });
export const PlanDraft = defineRpc({
  name: "plan.draft",
  input: Mutation.extend({
    planId: Id.optional(),
    /** Binds the plan to a feature and makes the revision schema 2; a bound plan must repeat it. */
    featureId: Id.optional(),
    title: z.string().min(1),
    sessionIds: z.array(Id).min(1),
    markdown: z.string().min(1).max(200_000),
    tasks: z.array(TaskInput).max(200),
  }),
  output: result(Written.extend({ planId: Id, rev: z.number().int(), contentHash: z.string(), exportWritten: z.boolean() })),
});
export const PlanApprove = defineRpc({
  name: "plan.approve",
  input: PlanRef.extend({ rev: z.number().int().min(1), contentHash: ContentHash, note: z.string().max(2000).optional() }),
  output: result(
    z.object({
      receiptId: Id,
      approvedAt: IsoTime,
      /** A receipt for this revision already existed; it is returned unchanged. */
      alreadyApproved: z.boolean(),
      /** This call recorded the cosmetic copy in the project data. The plugin-data receipt is the authority. */
      copyRecorded: z.boolean(),
      /** The derived Markdown export now matches the latest revision. */
      exportWritten: z.boolean(),
      /** Store revision committed by this call's own copy write; null when this call committed nothing. */
      revision: z.number().int().nullable(),
    }),
  ),
});
export const TaskUpdate = defineRpc({
  name: "task.update",
  input: Mutation.extend({
    planId: Id,
    planRev: z.number().int().min(1),
    contentHash: ContentHash,
    taskId: Id,
    /** `cancelled` is set only by a rework; the UI still verifies with a note. */
    status: TaskState.shape.status.exclude(["cancelled"]),
    note: z.string().max(2000).optional(),
  }),
  output: result(Written),
});
export const STAGE3_CONTRACTS = [PlanList, PlanGet, PlanDraft, PlanApprove, TaskUpdate] as const;

// Stage 4: tracker preview/apply/reconcile. Registered separately from earlier stages.
const Destination = z.object({ provider: z.enum(["none", "snailorbit"]), projectKey: z.string().nullable() });
export const CreatePayload = z.object({ title: z.string().min(1).max(500), body: z.string().max(100_000) }).strict();
export type CreatePayload = z.infer<typeof CreatePayload>;
export const TrackerAction = z.object({
  actionId: z.string().nullable(), // null for skip; otherwise the encoded action id (ruling 5)
  intentId: Id.nullable(),
  taskId: Id,
  planRev: z.number().int(),
  kind: z.enum(["create", "close", "skip"]),
  payload: z.union([CreatePayload, z.record(z.string(), z.unknown()) /* adapter WirePayload */]).nullable(),
  idempotencyKey: z.string().nullable(),
  reason: z.string().nullable(),
  /** Actionable rows: where this action goes (non-secret). A close keeps its original destination. */
  destination: z.object({ provider: z.enum(["none", "snailorbit"]), projectKey: z.string() }).optional(),
});
export type TrackerAction = z.infer<typeof TrackerAction>;
export const TrackerPreview = defineRpc({
  name: "tracker.preview",
  input: PlanRef,
  output: result(
    z.object({
      actions: z.array(TrackerAction),
      destination: Destination,
      mode: z.enum(["dry-run", "live"]),
      receiptId: Id,
      storeRevision: z.number().int(),
      confirmToken: z.string(),
      interrupted: z.array(z.object({ intentId: Id, taskId: Id, kind: z.string(), state: z.string() })),
      /** Live mode found a supported local connection config and an adapter; nothing was contacted. */
      liveAvailable: z.boolean(),
      unavailableReason: z.enum(["connection_missing", "connection_invalid", "connection_unsupported"]).nullable(),
    }),
  ),
});
export const TrackerApply = defineRpc({
  name: "tracker.apply",
  input: PlanRef.extend({
    actionIds: z.array(z.string().max(1024)).min(1).max(200),
    confirmToken: z.string(),
    expectedRevision: z.number().int().min(1),
  }),
  output: result(
    z.object({
      revision: z.number().int(),
      results: z.array(
        z.object({
          actionId: Id,
          intentId: Id.nullable(),
          state: z.enum(["dry_run", "confirmed", "unknown", "failed", "not_attempted"]),
          remoteKey: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
  ),
});
export const TrackerReconcile = defineRpc({
  name: "tracker.reconcile",
  input: PlanRef.extend({ intentId: Id }),
  output: result(z.object({ state: TrackerIntent.shape.state, remoteKey: z.string().optional(), humanDecisionRequired: z.boolean() })),
});
// Read-only (P4.8): mapped tickets and intents that need attention, independent of approval and settings.
export const TrackerList = defineRpc({
  name: "tracker.list",
  input: PlanRef,
  output: result(
    z.object({
      revision: z.number().int(),
      latestRev: z.number().int().nullable(),
      tickets: z.array(
        z.object({
          intentId: Id,
          taskId: Id.nullable(),
          planRev: z.number().int().nullable(),
          provider: z.literal("snailorbit"),
          remoteKey: z.string(),
          url: z.string(),
          state: z.enum(["created", "closed"]),
          lastSyncAt: IsoTime,
        }),
      ),
      intents: z.array(
        z.object({
          intentId: Id,
          taskId: Id,
          planRev: z.number().int(),
          kind: z.enum(["create", "close", "comment"]),
          state: z.enum(["pending", "sent", "unknown", "failed"]),
          interrupted: z.boolean(),
          errorClass: z.string().nullable(),
          createdAt: IsoTime,
          lastAttemptAt: IsoTime,
        }),
      ),
    }),
  ),
});
// O2: resolve an unknown or interrupted intent by linking a found ticket or confirming nothing happened.
export const TrackerResolve = defineRpc({
  name: "tracker.resolve",
  input: PlanRef.extend({
    intentId: Id,
    planRev: z.number().int().min(1),
    expectedRevision: z.number().int().min(1),
    resolution: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("link"), remoteKey: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/) }).strict(),
      z.object({ kind: z.literal("not_created"), confirm: z.literal(true) }).strict(),
    ]),
  }),
  output: result(
    z.object({ revision: z.number().int(), state: TrackerIntent.shape.state, remoteKey: z.string().optional(), auditRecorded: z.boolean() }),
  ),
});
export const STAGE4_CONTRACTS = [TrackerPreview, TrackerApply, TrackerReconcile, TrackerList, TrackerResolve] as const; // 3 → 4 → 5 intentional (P4.8, P4.7)

// Redesign Stage R0: feature cards, grilling block acceptance and the effective DoD template.
export const STAGE_R0_CONTRACTS = [...FEATURE_CONTRACTS, BlockAccept, DodTemplateGet] as const;

// Redesign Stage R1: explicit decision cancellation.
export const STAGE_R1_CONTRACTS = [DecisionCancel] as const;

// Redesign Stage R2: sending an approved revision back for rework.
export const STAGE_R2_CONTRACTS = [PlanRework] as const;

// Redesign Stage R3: execution runs, evidence and coordinator replacement.
export const STAGE_R3_CONTRACTS = [...RUN_CONTRACTS, ...RUN_EVIDENCE_CONTRACTS] as const;

// Automatic grilling (stage S1): UI-only planner binding and reopening of a completed session.
export const STAGE_G_CONTRACTS = [SessionPlannerSet, SessionReopen] as const;

// Feature discussion UI: the owner's acknowledgement of the no-translation notice (UI only).
export const STAGE_U_CONTRACTS = [SessionLanguageNoticeAck] as const;

// Feature discussion: out-of-scope marks, the owner's Finish, one-click Discuss and Retry.
export const STAGE_D_CONTRACTS = [QuestionOutOfScope, SessionFinish, FeatureDiscussionOpen, DiscussionRetry, DiscussionRetryResolve, DiscussionRetryCheck] as const;
