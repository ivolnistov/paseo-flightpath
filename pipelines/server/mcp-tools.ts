import { z } from "zod";
import { PipelineError } from "../shared/errors";
import { DIGEST_PATTERN, MAX_SUMMARY_CHARS, MAX_WORKFLOW_CHARS, type Proposal, type WorkflowView } from "../shared/rpc";
import { CriterionResultSchema, FindingSchema, type AgentRole, type Finding, type CriterionResult } from "../shared/run";
import type { Grant } from "./grants";
import { resolveWith, UnresolvedReferenceError } from "./outputs";
import { submitOutputs, submitReview, type ActionResult } from "./run-actions";
import { currentAttempt, currentCycle, cycleCommands, graphJob, isWriter, textCriteria, type AttemptState, type RunState } from "./run-engine";
import type { NewProposal } from "./workflow-store";

export const TOOL_NAMES = ["pipeline_job_context", "pipeline_job_complete", "pipeline_review_submit", "pipeline_workflow_get", "pipeline_workflow_propose"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const Summary = z.string().max(MAX_SUMMARY_CHARS);
/** Diagnostics returned to a proposing agent; `diagnosticCount` gives the full number. */
export const MAX_RETURNED_DIAGNOSTICS = 50;

export const TOOL_INPUTS = {
  pipeline_job_context: z.object({}).strict(),
  pipeline_job_complete: z.object({ outputs: z.record(z.string(), z.unknown()), summary: Summary }).strict(),
  pipeline_review_submit: z
    .object({
      outcome: z.enum(["approved", "changes_requested"]),
      findings: z.array(FindingSchema).max(64),
      criteria: z.array(CriterionResultSchema).max(256),
    })
    .strict(),
  pipeline_workflow_get: z.object({}).strict(),
  pipeline_workflow_propose: z.object({ baseToken: z.string().regex(DIGEST_PATTERN), yaml: z.string().max(MAX_WORKFLOW_CHARS), summary: Summary }).strict(),
} satisfies Record<ToolName, z.ZodType>;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  pipeline_job_context: "Returns the prompt, resolved inputs, task, acceptance criteria, declared outputs, attempt number and findings for your role.",
  pipeline_job_complete: "Worker only. Submits the declared outputs as JSON with a summary. Checks then run on the server.",
  pipeline_review_submit: "Reviewer only. Submits the outcome, findings and one result per assigned acceptance criterion. It is recorded when your turn ends.",
  pipeline_workflow_get: "Workflow chat only. Returns the editable workflow YAML, its token and diagnostics.",
  pipeline_workflow_propose: "Workflow chat only. Stores a proposal for the user to preview; it never changes the workflow.",
};

export type ToolResult = { ok: true; value: unknown } | { ok: false; code: string; message: string; details?: unknown };

export type ReviewSubmission = { attemptId: string; agentId: string; outcome: "approved" | "changes_requested"; findings: Finding[]; criteria: CriterionResult[] };

/** What the tools need from the run driver and the workflow store. */
export type ToolDeps = {
  runs: {
    read(runId: string): Promise<RunState>;
    /** Runs `action` on the latest state inside the run's serialisation and appends its events. */
    act(runId: string, action: (state: RunState) => ActionResult): Promise<ActionResult>;
    /** Binds an agent the injection admitted when the host's creation result has not arrived yet. */
    bindFromGrant(runId: string, attemptId: string, role: AgentRole, agentId: string): Promise<void>;
    /** Holds a validated review until the reviewer's turn ends and the identity is read. */
    holdReview(runId: string, submission: ReviewSubmission): Promise<ActionResult>;
  };
  workflows: {
    get(projectId: string): Promise<WorkflowView>;
    addProposal(projectId: string, input: NewProposal): Promise<Proposal>;
  };
};

function refuse(code: string, message: string, details?: unknown): ToolResult {
  return { ok: false, code, message, ...(details === undefined ? {} : { details }) };
}

function fromAction(result: ActionResult, value: unknown): ToolResult {
  return result.ok ? { ok: true, value } : refuse(result.code, result.message);
}

type AttemptGrant = Extract<Grant, { kind: "attempt" }>;

/** The attempt if the grant's agent holds the grant's role on a current attempt. */
function current(state: RunState, grant: AttemptGrant): { ok: true; a: AttemptState } | { ok: false; result: ToolResult } {
  const a = state.attempts[grant.attemptId];
  if (!a) return { ok: false, result: refuse("stale_attempt", "Unknown attempt.") };
  const binding = a.roles[grant.role]?.binding;
  if (!binding || binding.agentId !== grant.agentId) return { ok: false, result: refuse("stale_attempt", "The agent does not hold this role on the attempt.") };
  if (a.endedAt !== null || a.stopping !== null || a.outcome !== null || currentAttempt(state, a.jobId)?.attemptId !== a.attemptId) {
    return { ok: false, result: refuse("stale_attempt", "The attempt is no longer current.") };
  }
  return { ok: true, a };
}

function interruptedNotice(state: RunState, a: AttemptState): string | null {
  const ids = state.jobs[a.jobId]?.attempts ?? [];
  const previous = ids[ids.indexOf(a.attemptId) - 1];
  const before = previous === undefined ? undefined : state.attempts[previous];
  const interrupted = a.cause === "failover" || (before !== undefined && (before.outcome === "stopped" || before.outcome === "lost" || before.outcome === "provider_failed"));
  return interrupted ? "An earlier attempt of this job was interrupted and may have left partial changes in the worktree." : null;
}

/** `pipeline_job_context` for one role of one attempt. */
export function jobContext(state: RunState, a: AttemptState, role: AgentRole): Record<string, unknown> {
  const gj = graphJob(state, a.jobId);
  let resolved: Record<string, unknown> | null = null;
  let unresolved: string | null = null;
  try {
    resolved = resolveWith(gj, state);
  } catch (error) {
    if (!(error instanceof UnresolvedReferenceError)) throw error;
    unresolved = error.expression;
  }
  const criteria = textCriteria(gj).map((index) => {
    const item = gj.done[index];
    return { index, text: item && "criterion" in item ? item.criterion : "" };
  });
  const context: Record<string, unknown> = {
    role,
    jobId: gj.id,
    name: gj.name,
    kind: gj.kind,
    uses: gj.uses,
    attempt: a.n,
    cause: a.cause,
    prompt: typeof resolved?.prompt === "string" ? resolved.prompt : null,
    with: resolved,
    ...(unresolved === null ? {} : { unresolvedReference: unresolved }),
    matrix: gj.matrix !== undefined && gj.matrixIndex !== undefined ? { key: gj.matrix.key, index: gj.matrixIndex, value: a.matrixValue ?? null } : null,
    task: gj.uses === "run-task" ? { id: gj.taskId ?? "main", title: gj.with.title ?? gj.name, description: gj.with.description ?? null } : null,
    acceptanceCriteria: criteria,
    checks: cycleCommands(gj),
    outputs: gj.outputs,
    findings: a.findings,
    note: a.note ?? null,
    interrupted: interruptedNotice(state, a),
  };
  if (role === "worker") {
    context.instructions = "Do the work in the current worktree, then call pipeline_job_complete with every declared output and a short summary.";
  } else {
    const c = currentCycle(state, a);
    context.cycleId = c?.cycleId ?? null;
    context.worker = isWriter(gj) ? { summary: a.summary, outputs: a.outputs } : null;
    context.instructions =
      gj.uses === "review"
        ? "Review the run's changes in the worktree without editing files, then call pipeline_review_submit with approved or changes_requested and your findings."
        : "Judge each listed acceptance criterion against the worktree without editing files, then call pipeline_review_submit with one criterion result per index.";
  }
  return context;
}

/** Runs one tool call for a verified grant. Errors carry stable codes; nothing grants human authority. */
export async function callTool(deps: ToolDeps, grant: Grant, name: ToolName, rawInput: unknown): Promise<ToolResult> {
  const parsed = TOOL_INPUTS[name].safeParse(rawInput ?? {});
  if (!parsed.success) return refuse("input_invalid", "The tool input is invalid.", parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })));

  if (name === "pipeline_workflow_get" || name === "pipeline_workflow_propose") {
    if (grant.kind !== "workflow") return refuse("role_forbidden", "Only the workflow chat may use this tool.");
    if (name === "pipeline_workflow_get") {
      const view = await deps.workflows.get(grant.projectId);
      const editable = view.draft ?? view.saved;
      return { ok: true, value: { yaml: editable?.yaml ?? "", token: view.editableDigest, diagnostics: view.diagnostics } };
    }
    const input = TOOL_INPUTS.pipeline_workflow_propose.parse(parsed.data);
    let proposal: Proposal;
    try {
      proposal = await deps.workflows.addProposal(grant.projectId, { baseToken: input.baseToken, yaml: input.yaml, summary: input.summary, agentId: grant.agentId });
    } catch (error) {
      if (error instanceof PipelineError && error.code === "proposal_limit") return refuse(error.code, error.message);
      throw error;
    }
    const diagnostics = proposal.diagnostics.slice(0, MAX_RETURNED_DIAGNOSTICS);
    return { ok: true, value: { proposalId: proposal.id, status: proposal.status, diagnostics, diagnosticCount: proposal.diagnostics.length } };
  }

  if (grant.kind !== "attempt") return refuse("role_forbidden", "The workflow chat cannot use job tools.");
  if (name === "pipeline_job_complete" && grant.role !== "worker") return refuse("role_forbidden", "Only the worker may complete the job.");
  if (name === "pipeline_review_submit" && grant.role !== "reviewer") return refuse("role_forbidden", "Only the reviewer may submit a review.");

  let state = await deps.runs.read(grant.runId);
  const binding = state.attempts[grant.attemptId]?.roles[grant.role]?.binding;
  if (binding && binding.agentId === null) {
    await deps.runs.bindFromGrant(grant.runId, grant.attemptId, grant.role, grant.agentId);
    state = await deps.runs.read(grant.runId);
  }
  const check = current(state, grant);
  if (!check.ok) return check.result;

  switch (name) {
    case "pipeline_job_context":
      return { ok: true, value: jobContext(state, check.a, grant.role) };
    case "pipeline_job_complete": {
      const input = TOOL_INPUTS.pipeline_job_complete.parse(parsed.data);
      let accepted: boolean | undefined;
      let errors: unknown;
      const result = await deps.runs.act(grant.runId, (latest) => {
        const outcome = submitOutputs(latest, { attemptId: grant.attemptId, agentId: grant.agentId, outputs: input.outputs, summary: input.summary });
        accepted = outcome.accepted;
        errors = outcome.errors;
        return outcome;
      });
      if (!result.ok) return fromAction(result, null);
      if (accepted === false) return refuse("outputs_invalid", "The outputs do not match the declaration; fix them and call again.", errors);
      return { ok: true, value: { status: "accepted" } };
    }
    case "pipeline_review_submit": {
      const input = TOOL_INPUTS.pipeline_review_submit.parse(parsed.data);
      const c = currentCycle(state, check.a);
      const probe = submitReview(state, { attemptId: grant.attemptId, agentId: grant.agentId, outcome: input.outcome, findings: input.findings, criteria: input.criteria, identity: c?.identity ?? { headCommit: "-", indexTree: "-", contentTree: "-" } });
      if (!probe.ok) return refuse(probe.code, probe.message);
      const held = await deps.runs.holdReview(grant.runId, { attemptId: grant.attemptId, agentId: grant.agentId, outcome: input.outcome, findings: input.findings, criteria: input.criteria });
      return fromAction(held, { status: "held", message: "The review is recorded when this turn ends." });
    }
  }
}
