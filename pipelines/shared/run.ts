import { z } from "zod";
import { JOB_KINDS, MAX_MATRIX_ITEMS, MAX_MATRIX_PARALLEL, REASONING_LEVELS, type ExpandedGraph } from "./workflow";

export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const RunId = z.string().regex(RUN_ID_PATTERN);

export const RUN_STATUSES = ["running", "paused", "finished", "cancelled"] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.output<typeof RunStatusSchema>;

export const JOB_STATUSES = [
  "waiting",
  "running",
  "checking",
  "reviewing",
  "awaiting_human",
  "needs_human",
  "succeeded",
  "failed",
  "stopped",
  "cancelled",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.output<typeof JobStatusSchema>;

export const PauseReasonSchema = z.enum(["human", "recovery", "binding_unknown", "quiesce_unconfirmed"]);
export type PauseReason = z.output<typeof PauseReasonSchema>;

export const AgentRoleSchema = z.enum(["worker", "reviewer"]);
export type AgentRole = z.output<typeof AgentRoleSchema>;

export const ProviderTargetSchema = z.enum(["primary", "fallback"]);
export type ProviderTarget = z.output<typeof ProviderTargetSchema>;

export const AttemptCauseSchema = z.enum(["first", "retry", "rework", "manual", "failover", "stale"]);
export type AttemptCause = z.output<typeof AttemptCauseSchema>;

export const AttemptOutcomeSchema = z.enum(["succeeded", "failed", "stopped", "superseded", "lost", "provider_failed"]);
export type AttemptOutcome = z.output<typeof AttemptOutcomeSchema>;

export const CheckModeSchema = z.enum(["isolated", "exclusive"]);
export type CheckMode = z.output<typeof CheckModeSchema>;

export const CriterionStatusSchema = z.enum(["pending", "met", "not_met", "stale"]);
export type CriterionStatus = z.output<typeof CriterionStatusSchema>;

const Text = z.string().max(65_536);
const Id = z.string().min(1).max(512);
const Timestamp = z.string().min(1).max(64);

export const ResolvedAgentSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoning: z.enum(REASONING_LEVELS).optional(),
    profile: z.string().min(1).optional(),
    /** Launch values of a Paseo profile, captured at Start. */
    modeId: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
    options: z.record(z.string(), z.json()).optional(),
  })
  .strict();
export type ResolvedAgent = z.output<typeof ResolvedAgentSchema>;

export const ResolvedSettingsSchema = z
  .object({ primary: ResolvedAgentSchema, fallback: ResolvedAgentSchema.optional(), retries: z.number().int().min(0).max(10) })
  .strict();
export type ResolvedSettings = z.output<typeof ResolvedSettingsSchema>;

export const WorktreeIdentitySchema = z.object({ headCommit: Id, indexTree: Id, contentTree: Id }).strict();
export type WorktreeIdentity = z.output<typeof WorktreeIdentitySchema>;

export const ProviderFailureSchema = z
  .object({
    target: ProviderTargetSchema,
    provider: z.string(),
    model: z.string(),
    class: z.enum(["auth", "quota", "unavailable"]),
    message: Text,
    at: Timestamp,
  })
  .strict();
export type ProviderFailure = z.output<typeof ProviderFailureSchema>;

export const FindingSchema = z.object({ title: Text, detail: Text, tasks: z.array(z.string()).max(64) }).strict();
export type Finding = z.output<typeof FindingSchema>;

export const CriterionResultSchema = z.object({ index: z.number().int().min(0), met: z.boolean(), note: Text.optional() }).strict();
export type CriterionResult = z.output<typeof CriterionResultSchema>;

export const EvidenceSchema = z
  .object({
    id: Id,
    attemptId: Id,
    cycleId: Id,
    kind: z.enum(["check", "criterion", "review", "acceptance", "approval"]),
    item: z.number().int().min(0).nullable(),
    result: z.enum(["pass", "fail", "late"]),
    mode: CheckModeSchema.nullable(),
    exitCode: z.number().int().nullable(),
    outputTail: Text.nullable(),
    identity: WorktreeIdentitySchema,
    at: Timestamp,
  })
  .strict();
export type Evidence = z.output<typeof EvidenceSchema>;

export const ProcessRecordSchema = z
  .object({ pid: z.number().int().positive(), pgid: z.number().int().positive(), startedAt: Timestamp })
  .strict();
export type ProcessRecord = z.output<typeof ProcessRecordSchema>;

const Reasoning = z.enum(REASONING_LEVELS);
const Command = z.union([z.string(), z.array(z.string())]);
const DoneItem = z.union([z.object({ run: Command }).strict(), z.object({ criterion: z.string() }).strict()]);
const OutputItemType = z.enum(["string", "number", "boolean", "object"]);
const OutputDecl = z.union([
  z.object({ type: OutputItemType }).strict(),
  z.object({ type: z.literal("list"), items: OutputItemType }).strict(),
]);
const AgentSettings = z
  .object({
    profile: z.string().optional(),
    model: z.string().optional(),
    reasoning: Reasoning.optional(),
    fallback: z.object({ model: z.string(), reasoning: Reasoning.optional() }).strict().optional(),
    retries: z.number().int(),
  })
  .strict();

const MatrixScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

const MatrixDeclSchema = z
  .object({
    key: z.string(),
    source: z.union([
      z.object({ fixed: z.array(MatrixScalarSchema) }).strict(),
      z.object({ ref: z.object({ jobId: z.string(), output: z.string() }).strict() }).strict(),
    ]),
    maxParallel: z.number().int().min(1).max(MAX_MATRIX_PARALLEL),
  })
  .strict();

const GraphJobSchema = z
  .object({
    id: z.string(),
    sourceJobId: z.string(),
    name: z.string(),
    kind: z.enum(JOB_KINDS),
    uses: z.enum(["agent", "run-task", "checks", "review", "approval"]),
    taskId: z.string().optional(),
    with: z.record(z.string(), z.unknown()),
    outputs: z.record(z.string(), OutputDecl),
    done: z.array(DoneItem),
    agent: AgentSettings.optional(),
    reviewer: AgentSettings.optional(),
    criteria: z.enum(["reviewer", "human"]),
    humanAcceptance: z.boolean(),
    isolated: z.boolean(),
    matrix: MatrixDeclSchema.optional(),
    matrixIndex: z.number().int().min(0).optional(),
  })
  .strict();

export const ExpandedGraphSchema = z
  .object({
    jobs: z.array(GraphJobSchema),
    edges: z.array(z.object({ from: z.string(), to: z.string() }).strict()),
    groups: z.array(z.object({ id: z.string(), kind: z.enum(["tasks", "matrix"]), jobIds: z.array(z.string()) }).strict()),
    reworks: z.array(z.object({ from: z.string(), to: z.string(), max: z.number().int() }).strict()),
    maxParallel: z.number().int().min(1),
  })
  .strict();

const RoleSettings = z.object({ worker: ResolvedSettingsSchema.optional(), reviewer: ResolvedSettingsSchema.optional() }).strict();

/** Everything a run needs from Start; written once with `snapshotHash` over the rest. */
export const RunSnapshotBodySchema = z
  .object({
    runId: RunId,
    projectId: z.string().min(1),
    startKey: z.string().min(1).max(256),
    createdAt: Timestamp,
    startedBy: z.literal("human"),
    workflow: z.object({ yaml: z.string(), sha256: z.string() }).strict(),
    inputs: z.record(z.string(), z.unknown()),
    graph: ExpandedGraphSchema,
    settings: z.record(z.string(), RoleSettings),
  })
  .strict();
export type RunSnapshotBody = z.output<typeof RunSnapshotBodySchema>;

export const RunSnapshotSchema = RunSnapshotBodySchema.extend({ snapshotHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type RunSnapshot = z.output<typeof RunSnapshotSchema>;

export const BarrierCauseSchema = z.enum(["stop_job", "stop_run", "cancel", "rework", "provider_failure", "recovery"]);
export type BarrierCause = z.output<typeof BarrierCauseSchema>;

export const OutputErrorSchema = z.object({ name: z.string().nullable(), code: z.string(), message: Text }).strict();
export type OutputError = z.output<typeof OutputErrorSchema>;

const AgentRef = z.object({ attemptId: Id, role: AgentRoleSchema, agentId: Id }).strict();

function event<K extends string, S extends z.ZodRawShape>(kind: K, shape: S) {
  return z.object({ seq: z.number().int().min(1), id: Id, at: Timestamp, kind: z.literal(kind), ...shape }).strict();
}

export const RunEventSchema = z.discriminatedUnion("kind", [
  event("workspace.intent", { branchName: z.string().min(1) }),
  event("workspace.bound", { workspaceId: Id, directory: z.string().min(1), baseCommit: Id }),
  event("attempt.started", {
    jobId: Id,
    attemptId: Id,
    n: z.number().int().min(1),
    cause: AttemptCauseSchema,
    target: ProviderTargetSchema,
    note: Text.optional(),
    findings: z.array(FindingSchema).optional(),
    taskIds: z.array(z.string()).optional(),
    matrixValue: MatrixScalarSchema.optional(),
  }),
  event("matrix.expanded", { jobId: Id, sourceAttemptId: Id, values: z.array(MatrixScalarSchema).min(1).max(MAX_MATRIX_ITEMS) }),
  event("matrix.failed", { jobId: Id, sourceAttemptId: Id, reason: z.enum(["matrix_empty", "matrix_too_large", "matrix_invalid"]) }),
  event("agent.intent", {
    attemptId: Id,
    role: AgentRoleSchema,
    creationKey: Id,
    settings: ResolvedAgentSchema,
    target: ProviderTargetSchema,
    cycleId: Id.optional(),
  }),
  event("attempt.agent_bound", { attemptId: Id, role: AgentRoleSchema, agentId: Id }),
  event("agent.turn_ended", {
    attemptId: Id,
    role: AgentRoleSchema,
    agentId: Id,
    result: z.enum(["completed", "no_completion", "cancelled", "failed"]),
    message: Text.optional(),
  }),
  event("agent.reminded", { attemptId: Id, role: AgentRoleSchema }),
  event("attempt.outputs_rejected", { attemptId: Id, role: z.literal("worker"), agentId: Id, errors: z.array(OutputErrorSchema) }),
  event("attempt.outputs_accepted", {
    attemptId: Id,
    role: z.literal("worker"),
    agentId: Id,
    outputs: z.record(z.string(), z.unknown()),
    summary: Text,
  }),
  event("cycle.opened", { cycleId: Id, attemptId: Id.nullable(), identity: WorktreeIdentitySchema }),
  event("checks.started", { attemptId: Id, cycleId: Id, mode: CheckModeSchema, count: z.number().int().min(0) }),
  event("check.launched", {
    attemptId: Id,
    cycleId: Id,
    index: z.number().int().min(0),
    pid: z.number().int().positive(),
    pgid: z.number().int().positive(),
    startedAt: Timestamp,
  }),
  event("evidence.recorded", { evidence: EvidenceSchema }),
  event("cycle.invalidated", {
    cycleId: Id,
    explained: z.boolean(),
    reason: z.string(),
    observed: WorktreeIdentitySchema.optional(),
  }),
  event("review.submitted", {
    attemptId: Id,
    cycleId: Id,
    role: AgentRoleSchema,
    agentId: Id,
    outcome: z.enum(["approved", "changes_requested"]),
    findings: z.array(FindingSchema),
    criteria: z.array(CriterionResultSchema),
    identity: WorktreeIdentitySchema,
  }),
  event("review.held", {
    attemptId: Id,
    agentId: Id,
    outcome: z.enum(["approved", "changes_requested"]),
    findings: z.array(FindingSchema),
    criteria: z.array(CriterionResultSchema),
  }),
  event("job.awaiting_human", { jobId: Id, attemptId: Id, cycleId: Id }),
  event("human.accepted", { jobId: Id, attemptId: Id, cycleId: Id, identity: WorktreeIdentitySchema, criteria: z.array(z.number().int().min(0)) }),
  event("human.approved", { jobId: Id, attemptId: Id, cycleId: Id, identity: WorktreeIdentitySchema }),
  event("human.changes_requested", { jobId: Id, attemptId: Id, note: Text, taskIds: z.array(z.string()).optional() }),
  event("quiesce.started", {
    barrierId: Id,
    attempts: z.array(Id),
    cause: BarrierCauseSchema,
    jobId: Id.optional(),
    failure: ProviderFailureSchema.extend({ role: AgentRoleSchema }).strict().optional(),
    agents: z.array(AgentRef).optional(),
  }),
  event("quiesce.confirmed", { barrierId: Id }),
  event("quiesce.unconfirmed", { barrierId: Id, message: Text }),
  event("attempt.ended", {
    attemptId: Id,
    outcome: AttemptOutcomeSchema,
    reason: z.string().optional(),
    failure: ProviderFailureSchema.extend({ role: AgentRoleSchema }).strict().optional(),
    findings: z.array(FindingSchema).optional(),
    note: Text.optional(),
  }),
  event("job.provider_switched", { jobId: Id, role: AgentRoleSchema, to: z.literal("fallback") }),
  event("job.needs_human", { jobId: Id, role: AgentRoleSchema, reason: z.literal("providers_unavailable"), failures: z.array(ProviderFailureSchema) }),
  event("job.retry_requested", { jobId: Id, target: ProviderTargetSchema.optional() }),
  event("rework.started", {
    jobId: Id,
    attemptId: Id,
    to: Id,
    taskIds: z.array(z.string()).optional(),
    affected: z.array(Id),
    superseded: z.array(Id),
    findings: z.array(FindingSchema),
    note: Text.optional(),
  }),
  event("rework.granted", { jobId: Id }),
  event("run.paused", { reason: z.enum(["human", "recovery", "binding_unknown"]) }),
  event("run.resumed", {}),
  event("run.cancelled", {}),
  event("run.finished", { cycleId: Id }),
]);
export type RunEvent = z.output<typeof RunEventSchema>;
export type RunEventKind = RunEvent["kind"];

type Body<E> = E extends unknown ? Omit<E, "seq" | "id" | "at"> : never;
/** An event before the journal stamps `seq`, `id` and `at`. */
export type RunEventBody = Body<RunEvent>;

export const AgentBindingSchema = z
  .object({
    role: AgentRoleSchema,
    creationKey: Id,
    agentId: Id.nullable(),
    settings: ResolvedAgentSchema,
    target: ProviderTargetSchema,
    intentAt: Timestamp,
    boundAt: Timestamp.nullable(),
  })
  .strict();
export type AgentBinding = z.output<typeof AgentBindingSchema>;

export const AttemptSchema = z
  .object({
    attemptId: Id,
    jobId: Id,
    n: z.number().int().min(1),
    cause: AttemptCauseSchema,
    startedAt: Timestamp,
    endedAt: Timestamp.nullable(),
    agents: z.array(AgentBindingSchema),
    target: ProviderTargetSchema,
    outcome: AttemptOutcomeSchema.nullable(),
    reason: z.string().nullable(),
    outputs: z.record(z.string(), z.unknown()).nullable(),
    matrixValue: MatrixScalarSchema.optional(),
  })
  .strict();
export type Attempt = z.output<typeof AttemptSchema>;

export const RunViewSchema = z
  .object({
    runId: RunId,
    projectId: z.string(),
    status: RunStatusSchema,
    pauseReason: PauseReasonSchema.nullable(),
    workspace: z.object({ branchName: z.string(), workspaceId: Id.nullable(), baseCommit: Id.nullable() }).strict().nullable(),
    jobs: z.array(
      z
        .object({
          id: Id,
          status: JobStatusSchema,
          reason: z.string().nullable(),
          attempts: z.array(AttemptSchema),
          criteria: z.array(z.object({ index: z.number().int(), status: CriterionStatusSchema }).strict()),
          providerFailures: z.array(ProviderFailureSchema),
          activeCycleId: Id.nullable(),
          /** A matrix instance beyond the latest expansion: kept as history, out of the live graph. */
          retired: z.literal(true).optional(),
        })
        .strict(),
    ),
    evidence: z.array(EvidenceSchema),
    /** Verification cycles whose evidence no longer counts because the worktree changed. */
    invalidatedCycles: z.array(Id),
    barrier: z.object({ barrierId: Id, cause: BarrierCauseSchema, attempts: z.array(Id), unconfirmed: z.boolean() }).strict().nullable(),
    unresolvedIntents: z.array(z.object({ kind: z.enum(["workspace", "agent"]), key: z.string() }).strict()),
  })
  .strict();
export type RunView = z.output<typeof RunViewSchema>;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
/** Compile-time proof that the stored graph schema matches the expanded graph type. */
export const graphSchemaInSync: Same<z.output<typeof ExpandedGraphSchema>, ExpandedGraph> = true;
