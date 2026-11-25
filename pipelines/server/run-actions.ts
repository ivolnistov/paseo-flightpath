import type { AgentRole, CriterionResult, Finding, ProviderFailure, ProviderTarget, RunEventBody, WorktreeIdentity } from "../shared/run";
import { validateOutputs } from "./outputs";
import {
  currentAttempt,
  currentCycle,
  cycleCommands,
  graphJob,
  isWriter,
  nextBarrierId,
  openBarriers,
  pauseReason,
  sameIdentity,
  settingsFor,
  textCriteria,
  type AttemptState,
  type RunState,
} from "./run-engine";
import { isUnexpanded } from "./matrix";
import { taskIdsOf } from "./rework";

/** Refusals carry events the caller still appends, such as the invalidation behind `evidence_stale`. */
export type ActionResult = { ok: true; events: RunEventBody[] } | { ok: false; code: string; message: string; events: RunEventBody[] };

function ok(events: RunEventBody[]): ActionResult {
  return { ok: true, events };
}

function refuse(code: string, message: string, events: RunEventBody[] = []): ActionResult {
  return { ok: false, code, message, events };
}

const ROLES: readonly AgentRole[] = ["worker", "reviewer"];

function isCurrent(a: AttemptState): boolean {
  return a.endedAt === null && a.stopping === null && a.outcome === null;
}

type AgentCheck = { ok: true; a: AttemptState } | { ok: false; result: ActionResult };

/** The attempt, if `agentId` holds `role` on a current attempt: `stale_attempt` or `role_forbidden` otherwise. */
function agentOn(state: RunState, attemptIdValue: string, agentId: string, role: AgentRole): AgentCheck {
  const a = state.attempts[attemptIdValue];
  if (!a) return { ok: false, result: refuse("stale_attempt", "Unknown attempt.") };
  const own = ROLES.find((candidate) => a.roles[candidate]?.binding.agentId === agentId);
  if (own === undefined) return { ok: false, result: refuse("stale_attempt", "The agent does not belong to this attempt.") };
  if (own !== role) return { ok: false, result: refuse("role_forbidden", `Only the ${role} may do this.`) };
  if (!isCurrent(a)) return { ok: false, result: refuse("stale_attempt", "The attempt is no longer current.") };
  if (currentAttempt(state, a.jobId)?.attemptId !== a.attemptId) return { ok: false, result: refuse("stale_attempt", "The attempt is no longer current.") };
  return { ok: true, a };
}

export type OutputsActionResult = ActionResult & { accepted?: boolean; errors?: Array<{ name: string | null; code: string; message: string }> };

/** `pipeline_job_complete`: valid outputs are accepted; invalid ones are rejected back to the worker. */
export function submitOutputs(state: RunState, x: { attemptId: string; agentId: string; outputs: unknown; summary: string }): OutputsActionResult {
  const check = agentOn(state, x.attemptId, x.agentId, "worker");
  if (!check.ok) return check.result;
  const a = check.a;
  if (a.outputs !== null) return refuse("already_completed", "The job was already completed.");
  const result = validateOutputs(graphJob(state, a.jobId).outputs, x.outputs);
  if (!result.ok) {
    return { ok: true, accepted: false, errors: result.errors, events: [{ kind: "attempt.outputs_rejected", attemptId: a.attemptId, role: "worker", agentId: x.agentId, errors: result.errors }] };
  }
  return { ok: true, accepted: true, events: [{ kind: "attempt.outputs_accepted", attemptId: a.attemptId, role: "worker", agentId: x.agentId, outputs: result.outputs, summary: x.summary }] };
}

/** `pipeline_review_submit`, with the identity read after the reviewer turn. */
export function submitReview(
  state: RunState,
  x: { attemptId: string; agentId: string; outcome: "approved" | "changes_requested"; findings: Finding[]; criteria: CriterionResult[]; identity: WorktreeIdentity },
): ActionResult {
  const check = agentOn(state, x.attemptId, x.agentId, "reviewer");
  if (!check.ok) return check.result;
  const a = check.a;
  const gj = graphJob(state, a.jobId);
  const c = currentCycle(state, a);
  if (!c || c.status !== "open" || c.review !== null) return refuse("review_not_expected", "No review is expected now.");
  if (cycleCommands(gj).length > 0 && (c.checks === null || c.evidence.size < c.checks.count)) return refuse("review_not_expected", "Checks have not finished.");
  const assigned = gj.uses === "review" ? [] : textCriteria(gj);
  const indices = x.criteria.map((criterion) => criterion.index);
  if (indices.length !== assigned.length || new Set(indices).size !== indices.length || !indices.every((index) => assigned.includes(index))) {
    return refuse("criteria_invalid", "Submit exactly one result per assigned acceptance criterion.");
  }
  if (gj.uses === "review" && x.outcome === "changes_requested") {
    const error = reworkTaskError(state, gj.sourceJobId, [...new Set(x.findings.flatMap((finding) => finding.tasks))]);
    if (error) return error;
  }
  return ok([
    { kind: "review.submitted", attemptId: a.attemptId, cycleId: c.cycleId, role: "reviewer", agentId: x.agentId, outcome: x.outcome, findings: x.findings, criteria: x.criteria, identity: x.identity },
  ]);
}

function reworkTaskError(state: RunState, sourceJobId: string, taskIds: readonly string[]): ActionResult | null {
  const rework = state.graph.reworks.find((candidate) => candidate.from === sourceJobId);
  if (!rework) return null;
  const known = taskIdsOf(state.graph, rework.to);
  if (known === null) return null;
  if (taskIds.length === 0) return refuse("task_ids_required", `A return to ${rework.to} must name task ids.`);
  const unknown = taskIds.filter((id) => !known.includes(id));
  if (unknown.length > 0) return refuse("task_ids_unknown", `Unknown task ids: ${unknown.join(", ")}.`);
  return null;
}

/** A turn of a bound agent ended. Outcomes of ended or foreign attempts are dropped. */
export function turnEnded(state: RunState, x: { attemptId: string; agentId: string; result: "completed" | "no_completion" | "cancelled" | "failed"; message?: string }): RunEventBody[] {
  const a = state.attempts[x.attemptId];
  if (!a || a.endedAt !== null) return [];
  const role = ROLES.find((candidate) => a.roles[candidate]?.binding.agentId === x.agentId);
  if (role === undefined) return [];
  return [{ kind: "agent.turn_ended", attemptId: a.attemptId, role, agentId: x.agentId, result: x.result, ...(x.message === undefined ? {} : { message: x.message }) }];
}

/** A classified provider failure: the attempt is drained through the barrier before it ends. */
export function providerFailed(state: RunState, x: { attemptId: string; role: AgentRole; failure: Omit<ProviderFailure, "target"> }): ActionResult {
  const a = state.attempts[x.attemptId];
  if (!a || !isCurrent(a)) return refuse("stale_attempt", "The attempt is no longer current.");
  const binding = a.roles[x.role]?.binding;
  if (!binding) return refuse("stale_attempt", `The attempt has no ${x.role}.`);
  return ok([
    {
      kind: "quiesce.started",
      barrierId: nextBarrierId(state),
      attempts: [a.attemptId],
      cause: "provider_failure",
      jobId: a.jobId,
      failure: { ...x.failure, target: binding.target, role: x.role },
    },
  ]);
}

function parkedAttempt(state: RunState, jobId: string): AttemptState | null {
  const a = currentAttempt(state, jobId);
  return a && a.parked && isCurrent(a) ? a : null;
}

/** Accept one task or agent job on its active cycle, with the identity read now. */
export function acceptJob(state: RunState, x: { jobId: string; cycleId: string; identity: WorktreeIdentity; criteria?: number[] }): ActionResult {
  const gj = state.graph.jobs.find((candidate) => candidate.id === x.jobId);
  if (!gj || !isWriter(gj)) return refuse("not_acceptable", "Only an agent job or task can be accepted.");
  const a = parkedAttempt(state, x.jobId);
  const c = a ? currentCycle(state, a) : null;
  if (!a || !c || c.status !== "open") return refuse("not_awaiting", "The job is not waiting for acceptance.");
  if (c.cycleId !== x.cycleId) return refuse("evidence_stale", "The verification cycle has changed.");
  if (!sameIdentity(c.identity, x.identity)) {
    return refuse("evidence_stale", "The worktree changed since the evidence was recorded.", [{ kind: "cycle.invalidated", cycleId: c.cycleId, explained: true, reason: "accept_drift", observed: x.identity }]);
  }
  const marks = x.criteria ?? [];
  const required = gj.criteria === "human" ? textCriteria(gj) : [];
  if (marks.length !== required.length || new Set(marks).size !== marks.length || !marks.every((index) => required.includes(index))) {
    return refuse("criteria_invalid", "Mark every acceptance criterion exactly once.");
  }
  return ok([{ kind: "human.accepted", jobId: x.jobId, attemptId: a.attemptId, cycleId: c.cycleId, identity: x.identity, criteria: marks }]);
}

/** Approve the `approval` job on its active cycle, with the identity read now. */
export function approveJob(state: RunState, x: { jobId: string; cycleId: string; identity: WorktreeIdentity }): ActionResult {
  const gj = state.graph.jobs.find((candidate) => candidate.id === x.jobId);
  if (!gj || gj.uses !== "approval") return refuse("not_approvable", "Only the approval job can be approved.");
  const a = parkedAttempt(state, x.jobId);
  const c = a ? currentCycle(state, a) : null;
  if (!a || !c || c.status !== "open") return refuse("not_awaiting", "The job is not waiting for approval.");
  if (c.cycleId !== x.cycleId) return refuse("evidence_stale", "The verification cycle has changed.");
  if (!sameIdentity(c.identity, x.identity)) {
    return refuse("evidence_stale", "The worktree changed since the evidence was recorded.", [{ kind: "cycle.invalidated", cycleId: c.cycleId, explained: true, reason: "approve_drift", observed: x.identity }]);
  }
  return ok([{ kind: "human.approved", jobId: x.jobId, attemptId: a.attemptId, cycleId: c.cycleId, identity: x.identity }]);
}

/** Request changes on a job waiting for a human. */
export function requestChanges(state: RunState, x: { jobId: string; note: string; taskIds?: string[] }): ActionResult {
  const a = parkedAttempt(state, x.jobId);
  if (!a) return refuse("not_awaiting", "The job is not waiting for a human.");
  const gj = graphJob(state, x.jobId);
  if (gj.uses === "approval") {
    const error = reworkTaskError(state, gj.sourceJobId, x.taskIds ?? []);
    if (error) return error;
  }
  return ok([{ kind: "human.changes_requested", jobId: x.jobId, attemptId: a.attemptId, note: x.note, ...(x.taskIds === undefined ? {} : { taskIds: x.taskIds }) }]);
}

/** Human Retry: exactly one manual attempt, optionally on a named provider target. */
export function retryJob(state: RunState, x: { jobId: string; target?: ProviderTarget }): ActionResult {
  const js = state.jobs[x.jobId];
  if (!js) return refuse("unknown_job", "Unknown job.");
  const current = currentAttempt(state, x.jobId);
  if (current && current.endedAt === null) return refuse("job_running", "The job is still running.");
  if (!state.order.includes(x.jobId) || isUnexpanded(graphJob(state, x.jobId))) return refuse("not_retryable", "The matrix has no runnable instance to retry.");
  if (js.pending !== null || (js.needsHuman === null && js.terminal !== "failed" && js.terminal !== "stopped")) return refuse("not_retryable", "The job cannot be retried now.");
  if (x.target === "fallback") {
    const role = js.needsHuman ?? (isWriter(graphJob(state, x.jobId)) ? "worker" : "reviewer");
    if (settingsFor(state, x.jobId, role)?.fallback === undefined) return refuse("fallback_missing", "The job has no fallback.");
  }
  return ok([{ kind: "job.retry_requested", jobId: x.jobId, ...(x.target === undefined ? {} : { target: x.target }) }]);
}

/** Stop job: its current attempt is stopped through the barrier. */
export function stopJob(state: RunState, x: { jobId: string }): ActionResult {
  const a = currentAttempt(state, x.jobId);
  if (!a || !isCurrent(a)) return refuse("not_running", "The job has no attempt to stop.");
  return ok([{ kind: "quiesce.started", barrierId: nextBarrierId(state), attempts: [a.attemptId], cause: "stop_job", jobId: x.jobId }]);
}

/** Stop run: active attempts stop through the barrier and the run pauses. */
export function pauseRun(state: RunState): ActionResult {
  if (state.finished || state.cancelled) return refuse("run_ended", "The run has ended.");
  const active = Object.values(state.attempts).filter((a) => isCurrent(a) && !a.parked);
  const events: RunEventBody[] = [];
  if (active.length > 0) events.push({ kind: "quiesce.started", barrierId: nextBarrierId(state), attempts: active.map((a) => a.attemptId), cause: "stop_run" });
  if (state.pause !== "human") events.push({ kind: "run.paused", reason: "human" });
  return ok(events);
}

export function resumeRun(state: RunState): ActionResult {
  if (state.pause === "binding_unknown") return refuse("reconcile_required", "Resume repeats the reconciliation for this run.");
  if (state.pause === null) return refuse("not_paused", "The run is not paused.");
  if (openBarriers(state).length > 0) return refuse("quiesce_pending", "Earlier work has not been confirmed stopped.");
  return ok([{ kind: "run.resumed" }]);
}

/** Cancel run: every unended attempt is stopped through the barrier, then the run is cancelled. */
export function cancelRun(state: RunState): ActionResult {
  if (state.finished || state.cancelled) return refuse("run_ended", "The run has ended.");
  if (state.barriers.some((barrier) => barrier.cause === "cancel")) return refuse("cancel_pending", "Cancel is already in progress.");
  const attempts = Object.values(state.attempts).filter((a) => a.endedAt === null).map((a) => a.attemptId);
  return ok([{ kind: "quiesce.started", barrierId: nextBarrierId(state), attempts, cause: "cancel" }]);
}

/** Retry stop: repeats the interruption of each unconfirmed barrier. */
export function retryStop(state: RunState): ActionResult {
  const unconfirmed = state.barriers.filter((barrier) => barrier.status === "unconfirmed");
  if (unconfirmed.length === 0 || pauseReason(state) !== "quiesce_unconfirmed") return refuse("nothing_to_retry", "No stop is unconfirmed.");
  return ok(unconfirmed.map((barrier) => ({ kind: "quiesce.started", barrierId: barrier.barrierId, attempts: [...barrier.attempts], cause: barrier.cause })));
}

/** Grant return: one more rework for a reviewing job. */
export function grantReturn(state: RunState, x: { jobId: string }): ActionResult {
  const gj = state.graph.jobs.find((candidate) => candidate.id === x.jobId);
  if (!gj || !state.graph.reworks.some((rework) => rework.from === gj.sourceJobId)) return refuse("no_rework", "The job has no return.");
  return ok([{ kind: "rework.granted", jobId: x.jobId }]);
}
