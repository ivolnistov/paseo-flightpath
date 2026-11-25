import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { ExpandedGraphSchema, ProviderTargetSchema, ResolvedSettingsSchema, RunId, RunStatusSchema, PauseReasonSchema, RunViewSchema } from "./run";
import { JOB_KINDS, REASONING_LEVELS, type Diagnostic, type Workflow } from "./workflow";

export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PROPOSAL_ID_PATTERN = /^prp_[a-z0-9]{1,64}$/;
export const DIGEST_PATTERN = /^(?:[0-9a-f]{64}|absent)$/;
export const MAX_WORKFLOW_CHARS = 1_048_576;
export const MAX_SUMMARY_CHARS = 4_000;

export const ProjectId = z.string().regex(PROJECT_ID_PATTERN);
export const ProposalId = z.string().regex(PROPOSAL_ID_PATTERN);
/** SHA-256 hex of a file's exact bytes, or `absent`. */
export const Digest = z.string().regex(DIGEST_PATTERN);
export const WorkflowText = z.string().max(MAX_WORKFLOW_CHARS);

const Range = z.object({ start: z.number().int(), end: z.number().int() }).strict();

export const DiagnosticSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    line: z.number().int(),
    column: z.number().int(),
    range: Range.nullable(),
    jobId: z.string().optional(),
    input: z.string().optional(),
  })
  .strict();

const Reasoning = z.enum(REASONING_LEVELS);
const Fallback = z.object({ model: z.string(), reasoning: Reasoning.optional() }).strict();
const AgentSettingsDecl = z
  .object({
    profile: z.string().optional(),
    model: z.string().optional(),
    reasoning: Reasoning.optional(),
    fallback: Fallback.optional(),
    retries: z.number().int().optional(),
  })
  .strict();
const ScalarType = z.enum(["string", "number", "boolean", "object"]);
const OutputDecl = z.union([
  z.object({ type: ScalarType }).strict(),
  z.object({ type: z.literal("list"), items: ScalarType }).strict(),
]);
const Command = z.union([z.string(), z.array(z.string())]);
const DoneItem = z.union([z.object({ run: Command }).strict(), z.object({ criterion: z.string() }).strict()]);
/** `strategy` as the parser returns it; list items stay unchecked so invalid drafts still carry their diagnostics. */
const StrategyDecl = z
  .object({ matrix: z.record(z.string(), z.union([z.array(z.unknown()), z.string()])), maxParallel: z.number().int() })
  .strict();
const SourceLoc = z.object({ line: z.number(), column: z.number(), start: z.number(), end: z.number() }).strict();

export const WorkflowSchema = z
  .object({
    name: z.string().optional(),
    inputs: z.record(
      z.string(),
      z
        .object({
          type: z.enum(["string", "number", "boolean", "tasks"]),
          required: z.boolean(),
          default: z.unknown().optional(),
          description: z.string().optional(),
        })
        .strict(),
    ),
    defaults: z.object({ maxParallel: z.number().int(), agent: AgentSettingsDecl }).strict(),
    jobs: z.array(
      z
        .object({
          id: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          kind: z.enum(JOB_KINDS).optional(),
          needs: z.array(z.string()),
          uses: z.string(),
          with: z.record(z.string(), z.unknown()),
          outputs: z.record(z.string(), OutputDecl),
          done: z.array(DoneItem),
          acceptance: z.enum(["auto", "human"]).optional(),
          rework: z.object({ to: z.string(), max: z.number().int() }).strict().optional(),
          strategy: StrategyDecl.optional(),
        })
        .strict(),
    ),
    source: z.record(z.string(), z.object({ key: SourceLoc.optional(), value: SourceLoc }).strict()),
  })
  .strict();

export const ProposalStatus = z.enum(["pending", "applied", "discarded", "stale"]);
export const ProposalSchema = z
  .object({
    id: ProposalId,
    baseToken: Digest,
    yaml: WorkflowText,
    summary: z.string().max(MAX_SUMMARY_CHARS),
    agentId: z.string().min(1),
    createdAt: z.iso.datetime(),
    status: ProposalStatus,
    diagnostics: z.array(DiagnosticSchema),
    /** The proposed text's parsed model, for the job-level change preview; null when it does not parse. */
    model: WorkflowSchema.nullable(),
  })
  .strict();
export type Proposal = z.output<typeof ProposalSchema>;

const Text = z.object({ yaml: z.string(), digest: Digest }).strict();
/** A text that validates with zero diagnostics, with its planning graph (no Start inputs). */
export const WorkflowPlanSchema = z.object({ model: WorkflowSchema, graph: ExpandedGraphSchema }).strict();
export type WorkflowPlan = z.output<typeof WorkflowPlanSchema>;
export const WorkflowViewSchema = z
  .object({
    saved: Text.nullable(),
    draft: Text.nullable(),
    editableDigest: Digest,
    diagnostics: z.array(DiagnosticSchema),
    /** The editable text's parsed model; set even when validation reports diagnostics. */
    model: WorkflowSchema.nullable(),
    /** The editable text's planning graph; null unless it has zero diagnostics. */
    graph: ExpandedGraphSchema.nullable(),
    /** The saved text's plan while a draft exists; null without a draft or when the saved text does not validate. */
    savedPlan: WorkflowPlanSchema.nullable(),
    proposals: z.array(ProposalSchema),
  })
  .strict();
export type WorkflowView = z.output<typeof WorkflowViewSchema>;

export const EDIT_FIELD_KEYS = ["name", "description", "kind", "needs", "uses", "with", "outputs", "done", "acceptance", "rework"] as const;
const JobFields = z
  .object({
    name: z.unknown().optional(),
    description: z.unknown().optional(),
    kind: z.unknown().optional(),
    needs: z.unknown().optional(),
    uses: z.unknown().optional(),
    with: z.unknown().optional(),
    outputs: z.unknown().optional(),
    done: z.unknown().optional(),
    acceptance: z.unknown().optional(),
    rework: z.unknown().optional(),
  })
  .strict();
const JobRef = z.string().min(1).max(64);
const PatchPath = z.array(z.string().min(1).max(64)).min(1).max(4);
/** A leaf edit inside a job: set `value` at `path`, or remove the key. */
const PatchChange = z.union([z.object({ path: PatchPath, remove: z.literal(true) }).strict(), z.object({ path: PatchPath, value: z.unknown() }).strict()]);
export const EditOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("job.add"), id: JobRef, fields: JobFields }).strict(),
  z.object({ kind: z.literal("job.update"), id: JobRef, set: JobFields.optional(), unset: z.array(z.enum(EDIT_FIELD_KEYS)).optional() }).strict(),
  z.object({ kind: z.literal("job.remove"), id: JobRef }).strict(),
  z.object({ kind: z.literal("job.setNeeds"), id: JobRef, needs: z.array(JobRef) }).strict(),
  z.object({ kind: z.literal("job.patch"), id: JobRef, changes: z.array(PatchChange).min(1).max(32) }).strict(),
]);

/** The digests a refused mutation found under the lock. */
export const CurrentDigestsSchema = z.object({ savedDigest: Digest, draftDigest: Digest, editableDigest: Digest }).strict();
export type CurrentDigests = z.output<typeof CurrentDigestsSchema>;

export const STORE_ERROR_CODES = [
  "workflow_conflict",
  "workflow_invalid",
  "proposal_not_found",
  "proposal_stale",
  "proposal_not_pending",
  "proposal_invalid",
  "edit_invalid",
  "edit_unparseable",
  "job_not_found",
  "job_exists",
  "store_invalid",
  "unsafe_path",
  "internal",
] as const;
export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

export const RpcErrorSchema = z
  .object({
    code: z.enum(STORE_ERROR_CODES),
    message: z.string(),
    current: CurrentDigestsSchema.optional(),
    diagnostics: z.array(DiagnosticSchema).optional(),
  })
  .strict();
export type RpcError = z.output<typeof RpcErrorSchema>;

export const ViewResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: WorkflowViewSchema }).strict(),
  z.object({ ok: z.literal(false), error: RpcErrorSchema }).strict(),
]);
export type ViewResult = z.output<typeof ViewResultSchema>;

const ProjectInput = z.object({ projectId: ProjectId }).strict();
const EditableInput = ProjectInput.extend({ editableDigest: Digest }).strict();

export const workflowGet = defineRpc({ name: "workflow.get", input: ProjectInput, output: ViewResultSchema });
export const workflowDraftSetText = defineRpc({
  name: "workflow.draft.set-text",
  input: EditableInput.extend({ yaml: WorkflowText }).strict(),
  output: ViewResultSchema,
});
export const workflowDraftEdit = defineRpc({
  name: "workflow.draft.edit",
  input: EditableInput.extend({ op: EditOpSchema }).strict(),
  output: ViewResultSchema,
});
export const workflowDraftDiscard = defineRpc({ name: "workflow.draft.discard", input: EditableInput, output: ViewResultSchema });
export const workflowSave = defineRpc({
  name: "workflow.save",
  input: ProjectInput.extend({ savedDigest: Digest, draftDigest: Digest }).strict(),
  output: ViewResultSchema,
});
export const workflowProposalApply = defineRpc({
  name: "workflow.proposal.apply",
  input: EditableInput.extend({ proposalId: ProposalId }).strict(),
  output: ViewResultSchema,
});
export const workflowProposalDiscard = defineRpc({
  name: "workflow.proposal.discard",
  input: ProjectInput.extend({ proposalId: ProposalId }).strict(),
  output: ViewResultSchema,
});

// ---------------------------------------------------------------------------------------------
// runs

export const START_KEY_MAX = 256;
const JobId = z.string().min(1).max(512);
const RunInput = z.object({ runId: RunId }).strict();
const JobInput = RunInput.extend({ jobId: JobId }).strict();
const StartInputs = z.record(z.string(), z.unknown());

/** A refused run operation: a stable code, and diagnostics for Start. */
export const RunErrorSchema = z.object({ code: z.string(), message: z.string(), diagnostics: z.array(DiagnosticSchema).optional() }).strict();
export type RunError = z.output<typeof RunErrorSchema>;

function result<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), value }).strict(), z.object({ ok: z.literal(false), error: RunErrorSchema }).strict()]);
}

const RoleSettingsView = z.object({ worker: ResolvedSettingsSchema.optional(), reviewer: ResolvedSettingsSchema.optional() }).strict();

export const RunPreviewSchema = z
  .object({
    workflowDigest: Digest.nullable(),
    diagnostics: z.array(DiagnosticSchema),
    jobCount: z.number().int().min(0),
    settings: z.record(z.string(), RoleSettingsView),
    hasDraft: z.boolean(),
    /** The graph these inputs expand to; null when the workflow or the inputs do not expand. */
    graph: ExpandedGraphSchema.nullable(),
    blockers: z.array(z.enum(["workflow_missing", "workflow_invalid", "inputs_invalid", "settings_unresolved", "host_unavailable"])),
  })
  .strict();
export type RunPreview = z.output<typeof RunPreviewSchema>;

export const RunSummaryViewSchema = z
  .object({ runId: RunId, startKey: z.string(), createdAt: z.string(), status: RunStatusSchema.nullable(), pauseReason: PauseReasonSchema.nullable(), health: z.enum(["ok", "journal_corrupt", "faulted"]) })
  .strict();
export type RunSummaryView = z.output<typeof RunSummaryViewSchema>;

/** A run as the Execution view draws it: always from its snapshot and journal. */
export const RunDetailSchema = z
  .object({
    view: RunViewSchema,
    graph: ExpandedGraphSchema,
    settings: z.record(z.string(), RoleSettingsView),
    workflowName: z.string().nullable(),
    startKey: z.string(),
    createdAt: z.string(),
    health: z.enum(["ok", "journal_corrupt", "faulted"]),
    /** What an open barrier still waits for: unconfirmed agents and recorded check processes. */
    waits: z.object({ agents: z.array(z.string()), processes: z.number().int().min(0) }).strict().nullable(),
  })
  .strict();
export type RunDetail = z.output<typeof RunDetailSchema>;

export const JobChangesSchema = z
  .object({ diff: z.string(), truncated: z.boolean(), stat: z.string(), attempts: z.array(z.object({ attemptId: z.string(), files: z.array(z.string()).nullable() }).strict()) })
  .strict();

export const RunDetailResultSchema = result(RunDetailSchema);
export type RunDetailResult = z.output<typeof RunDetailResultSchema>;

export const runPreview = defineRpc({ name: "run.preview", input: ProjectInput.extend({ inputs: StartInputs }).strict(), output: result(RunPreviewSchema) });
export const runStart = defineRpc({
  name: "run.start",
  input: ProjectInput.extend({ inputs: StartInputs, workflowDigest: Digest, startKey: z.string().min(1).max(START_KEY_MAX) }).strict(),
  output: result(z.object({ runId: RunId }).strict()),
});
export const runList = defineRpc({ name: "run.list", input: ProjectInput, output: result(z.object({ runs: z.array(RunSummaryViewSchema) }).strict()) });
export const runGet = defineRpc({ name: "run.get", input: RunInput, output: RunDetailResultSchema });
export const runPause = defineRpc({ name: "run.pause", input: RunInput, output: RunDetailResultSchema });
export const runResume = defineRpc({ name: "run.resume", input: RunInput, output: RunDetailResultSchema });
export const runCancel = defineRpc({ name: "run.cancel", input: RunInput, output: RunDetailResultSchema });
export const runRetryStop = defineRpc({ name: "run.retry-stop", input: RunInput, output: RunDetailResultSchema });
export const jobStop = defineRpc({ name: "job.stop", input: JobInput, output: RunDetailResultSchema });
export const jobRetry = defineRpc({ name: "job.retry", input: JobInput.extend({ target: ProviderTargetSchema.optional() }).strict(), output: RunDetailResultSchema });
export const jobAccept = defineRpc({
  name: "job.accept",
  input: JobInput.extend({ cycleId: z.string().min(1).max(512), criteria: z.array(z.number().int().min(0)).max(256).optional() }).strict(),
  output: RunDetailResultSchema,
});
export const jobApprove = defineRpc({ name: "job.approve", input: JobInput.extend({ cycleId: z.string().min(1).max(512) }).strict(), output: RunDetailResultSchema });
export const jobRequestChanges = defineRpc({
  name: "job.request-changes",
  input: JobInput.extend({ note: z.string().max(65_536), taskIds: z.array(z.string().max(64)).max(64).optional() }).strict(),
  output: RunDetailResultSchema,
});
export const reworkGrant = defineRpc({ name: "rework.grant", input: JobInput, output: RunDetailResultSchema });
export const jobChanges = defineRpc({ name: "job.changes", input: JobInput, output: result(JobChangesSchema) });
export const workflowChatOpen = defineRpc({
  name: "workflow.chat.open",
  input: ProjectInput.extend({ workspaceId: z.string().min(1).max(128), model: z.string().min(3).max(256).optional() }).strict(),
  output: result(z.object({ agentId: z.string() }).strict()),
});
export const runWatch = defineSubscription({ name: "run.watch", input: RunInput, event: RunDetailSchema });

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
/** Compile-time proof that the wire schemas match the shared types. */
export const wireTypesInSync: [Same<z.output<typeof WorkflowSchema>, Workflow>, Same<z.output<typeof DiagnosticSchema>, Diagnostic>] = [true, true];
