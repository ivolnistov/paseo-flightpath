import { PipelineError } from "../shared/errors";
import type {
  AgentBinding,
  AgentRole,
  Attempt,
  AttemptCause,
  AttemptOutcome,
  BarrierCause,
  CheckMode,
  CriterionStatus,
  Evidence,
  Finding,
  JobStatus,
  PauseReason,
  ProcessRecord,
  ProviderFailure,
  ProviderTarget,
  ResolvedAgent,
  ResolvedSettings,
  RunEvent,
  RunEventBody,
  RunSnapshot,
  RunStatus,
  RunView,
  WorktreeIdentity,
} from "../shared/run";
import { matrixItemsProblem, type ExpandedGraph, type GraphJob, type MatrixScalar } from "../shared/workflow";
import { resolveCommand, type ResolvedCommand } from "./commands";
import { dynamicTemplates, instanceIds, isUnexpanded, liveGraph, liveMatrixValue, matrixPinned, matrixRef, type MatrixState } from "./matrix";

/** `<jobId>#<n>`, local to its run. */
export function attemptId(jobId: string, n: number): string {
  return `${jobId}#${n}`;
}

/** `<runId>:<attemptId>:<role>`: the host idempotency key, distinct across simultaneous runs. */
export function creationKey(runId: string, attempt: string, role: AgentRole): string {
  return `${runId}:${attempt}:${role}`;
}

/** The one branch a run's worktree uses. */
export function branchNameFor(runId: string): string {
  return `flightpath/run-${runId}`;
}

export const MAX_OUTPUT_REJECTIONS = 3;
export const MAX_UNEXPLAINED_INVALIDATIONS = 3;

/** Failure reasons that use the job's retry budget. */
export const RETRYABLE_REASONS: ReadonlySet<string> = new Set([
  "no_result",
  "outputs_invalid",
  "check_failed",
  "criterion_not_met",
  "worktree_unstable",
  "turn_failed",
  "lost",
]);

export type ProviderFailureForRole = ProviderFailure & { role: AgentRole };

type ReviewRecord = {
  seq: number;
  outcome: "approved" | "changes_requested";
  findings: Finding[];
  criteria: Array<{ index: number; met: boolean; note?: string | undefined }>;
  identity: WorktreeIdentity;
};

export type CycleState = {
  cycleId: string;
  attemptId: string | null;
  identity: WorktreeIdentity;
  status: "open" | "invalidated";
  openedSeq: number;
  checks: { mode: CheckMode; count: number } | null;
  launched: Map<number, ProcessRecord>;
  evidence: Map<number, Evidence>;
  review: ReviewRecord | null;
};

export type RoleState = {
  binding: AgentBinding & { cycleId?: string | undefined };
  noCompletion: number;
  reminded: boolean;
  failed: string | null;
  cancelled: boolean;
  turnEnded: boolean;
};

export type AttemptState = {
  attemptId: string;
  jobId: string;
  n: number;
  cause: AttemptCause;
  target: ProviderTarget;
  startedAt: string;
  endedAt: string | null;
  outcome: AttemptOutcome | null;
  reason: string | null;
  note: string | undefined;
  findings: Finding[];
  taskIds: string[] | undefined;
  roles: Partial<Record<AgentRole, RoleState>>;
  rejections: number;
  outputs: Record<string, unknown> | null;
  summary: string | null;
  workerSettled: boolean;
  cycles: string[];
  unexplained: number;
  parked: boolean;
  stopping: string | null;
  quiesced: boolean;
  accepted: boolean;
  approved: boolean;
  humanChanges: { note: string; taskIds: string[] | undefined } | null;
  matrixValue: MatrixScalar | undefined;
};

export type JobState = {
  id: string;
  attempts: string[];
  succeeded: string | null;
  retriesUsed: number;
  targets: Partial<Record<AgentRole, ProviderTarget>>;
  switched: AgentRole[];
  humanProviderChoice: AgentRole[];
  providerFailures: ProviderFailure[];
  pendingProvider: ProviderFailureForRole | null;
  needsHuman: AgentRole | null;
  pending: { cause: AttemptCause; target?: ProviderTarget; note?: string; findings?: Finding[]; taskIds?: string[] } | null;
  terminal: "failed" | "stopped" | "cancelled" | null;
  resumable: boolean;
  reason: string | null;
  exclusive: boolean;
  reworkUsed: number;
  reworkGranted: number;
  lastChanges: { findings: Finding[]; note?: string; taskIds?: string[] } | null;
};

export type BarrierState = {
  barrierId: string;
  attempts: string[];
  cause: BarrierCause;
  jobId: string | undefined;
  failure: ProviderFailureForRole | undefined;
  agents: Array<{ attemptId: string; role: AgentRole; agentId: string }>;
  status: "pending" | "unconfirmed" | "confirmed";
};

export type RunState = {
  snapshot: RunSnapshot;
  /** The snapshot graph with dynamic matrices expanded from the journal. */
  graph: ExpandedGraph;
  /** The latest expansion of each dynamic matrix, by job id. */
  matrices: Record<string, MatrixState>;
  /** Every dynamic matrix instance ever expanded, live or retired. */
  instances: Record<string, GraphJob>;
  seq: number;
  finished: boolean;
  cancelled: boolean;
  pause: "human" | "recovery" | "binding_unknown" | null;
  workspace: { branchName: string; workspaceId: string | null; directory: string | null; baseCommit: string | null } | null;
  jobs: Record<string, JobState>;
  attempts: Record<string, AttemptState>;
  cycles: Record<string, CycleState>;
  evidence: Evidence[];
  barriers: BarrierState[];
  latestIdentity: WorktreeIdentity | null;
  finishCycles: string[];
  lastJobChangeSeq: number;
  order: string[];
};

export type Effect =
  | { kind: "record"; key: string; events: RunEventBody[] }
  | { kind: "create_workspace"; key: string; branchName: string }
  | { kind: "start_attempt"; key: string; jobId: string; attemptId: string; n: number; cause: AttemptCause; target: ProviderTarget; note?: string; findings?: Finding[]; taskIds?: string[]; matrixValue?: MatrixScalar }
  | { kind: "create_agent"; key: string; jobId: string; attemptId: string; role: AgentRole; creationKey: string; target: ProviderTarget; settings: ResolvedAgent }
  | { kind: "open_cycle"; key: string; cycleId: string; scope: { attemptId: string } | "finish" }
  | { kind: "run_checks"; key: string; jobId: string; attemptId: string; cycleId: string; mode: CheckMode; commands: ResolvedCommand[] }
  | { kind: "request_review"; key: string; attemptId: string; cycleId: string; agentId: string }
  | { kind: "remind"; key: string; attemptId: string; role: AgentRole; agentId: string }
  | { kind: "interrupt_agent"; key: string; barrierId: string; attemptId: string; role: AgentRole; agentId: string }
  | { kind: "cancel_checks"; key: string; barrierId: string; attemptId: string; cycleId: string | null; processes: ProcessRecord[] }
  | { kind: "finish_run"; key: string; cycleId: string };

export class EngineError extends PipelineError {
  constructor(message: string) {
    super("event_invalid", message);
    this.name = "EngineError";
  }
}

function fail(message: string): never {
  throw new EngineError(message);
}

/** Graph order: topological by `needs`, ties broken by declaration order. */
export function graphOrder(graph: ExpandedGraph): string[] {
  const ids = graph.jobs.map((job) => job.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const edge of graph.edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const out: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    const id = ready.shift();
    if (id === undefined) break;
    out.push(id);
    for (const edge of graph.edges) {
      if (edge.from !== id) continue;
      const left = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, left);
      if (left === 0) ready.push(edge.to);
    }
  }
  return out;
}

function newJobState(id: string): JobState {
  return {
      id,
      attempts: [],
      succeeded: null,
      retriesUsed: 0,
      targets: {},
      switched: [],
      humanProviderChoice: [],
      providerFailures: [],
      pendingProvider: null,
      needsHuman: null,
      pending: null,
      terminal: null,
      resumable: false,
      reason: null,
      exclusive: false,
      reworkUsed: 0,
      reworkGranted: 0,
      lastChanges: null,
  };
}

export function initialState(snapshot: RunSnapshot): RunState {
  const jobs: Record<string, JobState> = {};
  for (const job of snapshot.graph.jobs) jobs[job.id] = newJobState(job.id);
  const graph = structuredClone(snapshot.graph);
  return {
    snapshot,
    graph,
    matrices: {},
    instances: {},
    seq: 0,
    finished: false,
    cancelled: false,
    pause: null,
    workspace: null,
    jobs,
    attempts: {},
    cycles: {},
    evidence: [],
    barriers: [],
    latestIdentity: null,
    finishCycles: [],
    lastJobChangeSeq: 0,
    order: graphOrder(graph),
  };
}

export function sameIdentity(a: WorktreeIdentity | null | undefined, b: WorktreeIdentity | null | undefined): boolean {
  return !!a && !!b && a.headCommit === b.headCommit && a.indexTree === b.indexTree && a.contentTree === b.contentTree;
}

/** A job of the live graph, or a retired matrix instance. */
export function graphJob(state: RunState, jobId: string): GraphJob {
  return state.graph.jobs.find((job) => job.id === jobId) ?? state.instances[jobId] ?? fail(`Unknown job ${jobId}.`);
}

/** Matrix instances that a later expansion dropped from the live graph; their history stays. */
export function retiredJobs(state: RunState): string[] {
  const live = new Set(state.order);
  return Object.keys(state.instances).filter((id) => !live.has(id));
}

export function isWriter(job: GraphJob): boolean {
  return job.uses === "agent" || job.uses === "run-task";
}

export function isVerifier(job: GraphJob): boolean {
  return !isWriter(job);
}

/** The role whose settings own the job's target and retry budget. */
export function mainRole(job: GraphJob): AgentRole | null {
  if (isWriter(job)) return "worker";
  if (job.uses === "review") return "reviewer";
  return null;
}

export function textCriteria(job: GraphJob): number[] {
  return job.done.flatMap((item, index) => ("criterion" in item ? [index] : []));
}

function needsReviewer(job: GraphJob): boolean {
  if (job.uses === "review") return true;
  return isWriter(job) && job.reviewer !== undefined && job.criteria === "reviewer" && textCriteria(job).length > 0;
}

function needsHuman(job: GraphJob): boolean {
  if (job.uses === "approval") return true;
  return isWriter(job) && (job.humanAcceptance || (job.criteria === "human" && textCriteria(job).length > 0));
}

/** Commands a cycle of this job runs: `with.run` for `checks`, the `run` acceptance criteria otherwise. */
export function cycleCommands(job: GraphJob): Array<string | string[]> {
  if (job.uses === "checks") {
    const run = job.with.run;
    if (!Array.isArray(run)) return [];
    const items: unknown[] = run;
    return items.filter((item): item is string | string[] => typeof item === "string" || (Array.isArray(item) && item.every((part) => typeof part === "string")));
  }
  if (!isWriter(job)) return [];
  return job.done.flatMap((item) => ("run" in item ? [item.run] : []));
}

export function checkMode(state: RunState, job: GraphJob): CheckMode {
  return job.uses === "checks" && job.isolated && !(state.jobs[job.id]?.exclusive ?? false) ? "isolated" : "exclusive";
}

function job(state: RunState, jobId: string): JobState {
  return state.jobs[jobId] ?? fail(`Unknown job ${jobId}.`);
}

function attempt(state: RunState, id: string): AttemptState {
  return state.attempts[id] ?? fail(`Unknown attempt ${id}.`);
}

function cycle(state: RunState, id: string): CycleState {
  return state.cycles[id] ?? fail(`Unknown cycle ${id}.`);
}

export function currentCycle(state: RunState, a: AttemptState): CycleState | null {
  const id = a.cycles[a.cycles.length - 1];
  return id === undefined ? null : (state.cycles[id] ?? null);
}

export function currentAttempt(state: RunState, jobId: string): AttemptState | null {
  const ids = job(state, jobId).attempts;
  const id = ids[ids.length - 1];
  return id === undefined ? null : (state.attempts[id] ?? null);
}

/** Resolved settings of a job and role; a dynamic matrix instance uses its matrix job's settings. */
export function settingsFor(state: RunState, jobId: string, role: AgentRole): ResolvedSettings | undefined {
  const own = state.snapshot.settings[jobId]?.[role];
  if (own !== undefined) return own;
  const source = state.instances[jobId]?.sourceJobId;
  return source === undefined ? undefined : state.snapshot.settings[source]?.[role];
}

function targetFor(state: RunState, jobId: string, role: AgentRole): ProviderTarget {
  return job(state, jobId).targets[role] ?? "primary";
}

function agentFor(state: RunState, jobId: string, role: AgentRole, target: ProviderTarget): ResolvedAgent {
  const settings = settingsFor(state, jobId, role) ?? fail(`Job ${jobId} has no ${role} settings.`);
  if (target === "fallback") return settings.fallback ?? fail(`Job ${jobId} has no ${role} fallback.`);
  return settings.primary;
}

function retriesFor(state: RunState, jobId: string): number {
  const role = mainRole(graphJob(state, jobId));
  return role === null ? 0 : (settingsFor(state, jobId, role)?.retries ?? 0);
}

/** Ended means the attempt's turns and checks are over and its outcome is final. */
function isEnded(a: AttemptState): boolean {
  return a.endedAt !== null;
}

/** Started, not ended and not parked waiting for a human. Stopping attempts stay active until they end. */
export function isActive(a: AttemptState): boolean {
  return !isEnded(a) && !a.parked;
}

function isHolder(state: RunState, a: AttemptState): boolean {
  if (!isActive(a)) return false;
  const gj = graphJob(state, a.jobId);
  if (gj.uses === "checks") return checkMode(state, gj) === "exclusive";
  return true;
}

function isIsolatedCheck(state: RunState, a: AttemptState): boolean {
  if (!isActive(a)) return false;
  const gj = graphJob(state, a.jobId);
  return gj.uses === "checks" && checkMode(state, gj) === "isolated";
}

/** The attempt holding the writer slot, if any. */
export function slotHolders(state: RunState): string[] {
  return Object.values(state.attempts)
    .filter((a) => isHolder(state, a))
    .map((a) => a.attemptId);
}

export function openBarriers(state: RunState): BarrierState[] {
  return state.barriers.filter((barrier) => barrier.status !== "confirmed");
}

export function runStatus(state: RunState): RunStatus {
  if (state.finished) return "finished";
  if (state.cancelled) return "cancelled";
  if (pauseReason(state) !== null) return "paused";
  return "running";
}

export function pauseReason(state: RunState): PauseReason | null {
  if (state.finished || state.cancelled) return null;
  if (state.barriers.some((barrier) => barrier.status === "unconfirmed")) return "quiesce_unconfirmed";
  return state.pause;
}

function resultIdentity(state: RunState, jobId: string): WorktreeIdentity | null {
  const id = job(state, jobId).succeeded;
  if (id === null) return null;
  const c = currentCycle(state, attempt(state, id));
  return c ? c.identity : null;
}

function needsOf(state: RunState, jobId: string): string[] {
  return state.graph.edges.filter((edge) => edge.to === jobId).map((edge) => edge.from);
}

function needsSatisfied(state: RunState, jobId: string): boolean {
  return needsOf(state, jobId).every((need) => job(state, need).succeeded !== null);
}

/** Verification-only ancestors reached through verification-only jobs. */
function verifierAncestors(state: RunState, jobId: string): string[] {
  const found = new Set<string>();
  const queue = needsOf(state, jobId);
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (found.has(id) || !isVerifier(graphJob(state, id))) continue;
    found.add(id);
    queue.push(...needsOf(state, id));
  }
  return state.order.filter((id) => found.has(id));
}

function isStale(state: RunState, jobId: string, identity: WorktreeIdentity | null): boolean {
  if (identity === null || !isVerifier(graphJob(state, jobId))) return false;
  const result = resultIdentity(state, jobId);
  return result !== null && !sameIdentity(result, identity);
}

/** Stale results among `candidates` that rely on no other stale result, in graph order. */
function minimalStale(state: RunState, candidates: readonly string[], identity: WorktreeIdentity | null): string[] {
  const stale = candidates.filter((id) => isStale(state, id, identity));
  return stale.filter((id) => !verifierAncestors(state, id).some((ancestor) => stale.includes(ancestor)));
}

function staleRelied(state: RunState, jobId: string, identity: WorktreeIdentity | null): string[] {
  return minimalStale(state, verifierAncestors(state, jobId), identity);
}

export function jobStatus(state: RunState, jobId: string): JobStatus {
  const js = job(state, jobId);
  if (js.terminal === "cancelled") return "cancelled";
  const current = currentAttempt(state, jobId);
  if (current && !isEnded(current)) {
    if (current.parked) return "awaiting_human";
    const c = currentCycle(state, current);
    if (c && c.status === "open") {
      if (c.review === null && needsReviewer(graphJob(state, jobId)) && (c.checks === null ? cycleCommands(graphJob(state, jobId)).length === 0 : c.evidence.size >= c.checks.count)) return "reviewing";
      if (c.checks !== null) return "checking";
    }
    return "running";
  }
  if (js.needsHuman !== null) return "needs_human";
  if (js.succeeded !== null) return "succeeded";
  if (js.terminal !== null) return js.terminal;
  return "waiting";
}

// ---------------------------------------------------------------------------------------------
// reduce

function roleOf(a: AttemptState, role: AgentRole): RoleState {
  return a.roles[role] ?? fail(`Attempt ${a.attemptId} has no ${role} intent.`);
}

function requireLive(a: AttemptState, what: string): void {
  if (isEnded(a) || a.stopping !== null || a.outcome !== null) fail(`${what}: attempt ${a.attemptId} is no longer current.`);
}

function requireAgent(a: AttemptState, role: AgentRole, agentId: string): RoleState {
  const rs = roleOf(a, role);
  if (rs.binding.agentId === null || rs.binding.agentId !== agentId) fail(`Agent ${agentId} is not the ${role} of ${a.attemptId}.`);
  return rs;
}

function addEvidence(state: RunState, evidence: Evidence): void {
  state.evidence.push(evidence);
  state.latestIdentity = evidence.identity;
}

function endAttempt(state: RunState, a: AttemptState, event: Extract<RunEvent, { kind: "attempt.ended" }>): void {
  if (isEnded(a)) fail(`Attempt ${a.attemptId} already ended.`);
  if (a.outcome === "superseded" && event.outcome !== "superseded") fail(`Attempt ${a.attemptId} is superseded.`);
  a.endedAt = event.at;
  a.outcome = event.outcome;
  a.reason = event.reason ?? a.reason;
  a.parked = false;
  state.lastJobChangeSeq = event.seq;
  const js = job(state, a.jobId);
  if (js.attempts[js.attempts.length - 1] !== a.attemptId) return;
  const findings = event.findings ?? [];
  switch (event.outcome) {
    case "succeeded":
      js.succeeded = a.attemptId;
      js.terminal = null;
      js.reason = null;
      return;
    case "failed": {
      const reason = event.reason ?? "failed";
      if (reason === "changes_requested" && isWriter(graphJob(state, a.jobId))) {
        js.pending = { cause: "manual", note: event.note ?? "", findings };
        return;
      }
      if (reason === "rework_exhausted") js.lastChanges = { findings, ...(event.note === undefined ? {} : { note: event.note }), ...(a.humanChanges?.taskIds ? { taskIds: a.humanChanges.taskIds } : {}) };
      if (RETRYABLE_REASONS.has(reason) && js.retriesUsed < retriesFor(state, a.jobId)) {
        js.retriesUsed += 1;
        js.pending = { cause: "retry", findings };
        return;
      }
      js.terminal = "failed";
      js.reason = reason;
      return;
    }
    case "lost":
      if (js.retriesUsed < retriesFor(state, a.jobId)) {
        js.retriesUsed += 1;
        js.pending = { cause: "retry" };
      } else {
        js.terminal = "failed";
        js.reason = "lost";
      }
      return;
    case "stopped": {
      const barrier = state.barriers.find((b) => b.barrierId === a.stopping);
      js.terminal = "stopped";
      js.reason = event.reason ?? "stopped";
      js.resumable = barrier?.cause === "stop_run";
      return;
    }
    case "provider_failed": {
      const failure = event.failure ?? fail(`Attempt ${a.attemptId} ended provider_failed without a failure.`);
      js.providerFailures.push(stripRole(failure));
      js.pendingProvider = failure;
      return;
    }
    case "superseded":
      if (event.reason === "evidence_stale") js.pending = { cause: "stale" };
      return;
  }
}

function stripRole(failure: ProviderFailureForRole): ProviderFailure {
  return { target: failure.target, provider: failure.provider, model: failure.model, class: failure.class, message: failure.message, at: failure.at };
}

/** Applies one journalled event. Throws `EngineError` for an event the state cannot accept. */
export function reduce(state: RunState, event: RunEvent): RunState {
  if (event.seq !== state.seq + 1) fail(`Event seq ${event.seq} does not follow ${state.seq}.`);
  if ((state.finished || state.cancelled) && event.kind !== "quiesce.confirmed") fail(`The run has ended; ${event.kind} is not accepted.`);
  const next = structuredClone(state);
  next.seq = event.seq;
  apply(next, event);
  return next;
}

/** Folds a journal into the state; equal journals give equal states. */
export function replay(snapshot: RunSnapshot, events: readonly RunEvent[]): RunState {
  let state = initialState(snapshot);
  for (const event of events) state = reduce(state, event);
  return state;
}

function apply(state: RunState, event: RunEvent): void {
  switch (event.kind) {
    case "workspace.intent":
      if (state.workspace !== null) fail("The workspace intent is already recorded.");
      if (event.branchName !== branchNameFor(state.snapshot.runId)) fail(`Unexpected branch ${event.branchName}.`);
      state.workspace = { branchName: event.branchName, workspaceId: null, directory: null, baseCommit: null };
      return;
    case "workspace.bound":
      if (state.workspace === null || state.workspace.workspaceId !== null) fail("No unbound workspace intent.");
      state.workspace = { ...state.workspace, workspaceId: event.workspaceId, directory: event.directory, baseCommit: event.baseCommit };
      return;
    case "attempt.started": {
      const js = job(state, event.jobId);
      if (event.attemptId !== attemptId(event.jobId, event.n) || event.n !== js.attempts.length + 1) fail(`Unexpected attempt ${event.attemptId}.`);
      const started = graphJob(state, event.jobId);
      if (!state.order.includes(event.jobId) || !matrixPinned(state, started)) fail(`Job ${event.jobId} is not runnable in the live graph.`);
      if (event.matrixValue !== liveMatrixValue(state, started)) fail(`Attempt ${event.attemptId} names the wrong matrix value.`);
      const previous = currentAttempt(state, event.jobId);
      if (previous && !isEnded(previous)) fail(`Job ${event.jobId} still has attempt ${previous.attemptId}.`);
      if (event.cause === "stale") {
        if (js.succeeded === null && js.pending?.cause !== "stale") fail(`Job ${event.jobId} has no result to refresh.`);
        if (js.succeeded !== null) {
          const old = attempt(state, js.succeeded);
          old.outcome = "superseded";
          old.reason = "evidence_stale";
        }
        js.succeeded = null;
      } else if (js.succeeded !== null) fail(`Job ${event.jobId} already succeeded.`);
      js.attempts.push(event.attemptId);
      js.pending = null;
      js.terminal = null;
      js.reason = null;
      js.resumable = false;
      state.attempts[event.attemptId] = {
        attemptId: event.attemptId,
        jobId: event.jobId,
        n: event.n,
        cause: event.cause,
        target: event.target,
        startedAt: event.at,
        endedAt: null,
        outcome: null,
        reason: null,
        note: event.note,
        findings: event.findings ?? [],
        taskIds: event.taskIds,
        roles: {},
        rejections: 0,
        outputs: null,
        summary: null,
        workerSettled: false,
        cycles: [],
        unexplained: 0,
        parked: false,
        stopping: null,
        quiesced: false,
        accepted: false,
        approved: false,
        humanChanges: null,
        matrixValue: event.matrixValue,
      };
      state.lastJobChangeSeq = event.seq;
      return;
    }
    case "matrix.expanded":
    case "matrix.failed":
      applyMatrix(state, event);
      return;
    case "agent.intent": {
      const a = attempt(state, event.attemptId);
      requireLive(a, "agent.intent");
      if (a.roles[event.role]) fail(`Attempt ${a.attemptId} already has a ${event.role} intent.`);
      if (event.creationKey !== creationKey(state.snapshot.runId, a.attemptId, event.role)) fail(`Unexpected creation key ${event.creationKey}.`);
      a.roles[event.role] = {
        binding: { role: event.role, creationKey: event.creationKey, agentId: null, settings: event.settings, target: event.target, intentAt: event.at, boundAt: null, cycleId: event.cycleId },
        noCompletion: 0,
        reminded: false,
        failed: null,
        cancelled: false,
        turnEnded: false,
      };
      return;
    }
    case "attempt.agent_bound": {
      const a = attempt(state, event.attemptId);
      const rs = roleOf(a, event.role);
      if (rs.binding.agentId !== null) fail(`The ${event.role} of ${a.attemptId} is already bound.`);
      rs.binding.agentId = event.agentId;
      rs.binding.boundAt = event.at;
      return;
    }
    case "agent.turn_ended": {
      const a = attempt(state, event.attemptId);
      const rs = requireAgent(a, event.role, event.agentId);
      rs.turnEnded = true;
      if (event.role === "worker" && a.outputs !== null) {
        a.workerSettled = true;
        return;
      }
      if (event.role === "reviewer") {
        const c = currentCycle(state, a);
        if (c?.review) return;
      }
      if (event.result === "no_completion" || event.result === "completed") rs.noCompletion += 1;
      else if (event.result === "failed") rs.failed = event.message ?? "turn failed";
      else if (event.result === "cancelled") rs.cancelled = true;
      return;
    }
    case "agent.reminded": {
      const rs = roleOf(attempt(state, event.attemptId), event.role);
      rs.reminded = true;
      return;
    }
    case "attempt.outputs_rejected": {
      const a = attempt(state, event.attemptId);
      requireLive(a, "outputs");
      requireAgent(a, "worker", event.agentId);
      if (a.outputs !== null) fail(`Attempt ${a.attemptId} already has outputs.`);
      a.rejections += 1;
      return;
    }
    case "attempt.outputs_accepted": {
      const a = attempt(state, event.attemptId);
      requireLive(a, "outputs");
      const rs = requireAgent(a, "worker", event.agentId);
      if (a.outputs !== null) fail(`Attempt ${a.attemptId} already has outputs.`);
      if (a.rejections >= MAX_OUTPUT_REJECTIONS) fail(`Attempt ${a.attemptId} exhausted its submissions.`);
      a.outputs = event.outputs;
      a.summary = event.summary;
      rs.turnEnded = false;
      return;
    }
    case "cycle.opened": {
      if (state.cycles[event.cycleId]) fail(`Cycle ${event.cycleId} already exists.`);
      state.cycles[event.cycleId] = {
        cycleId: event.cycleId,
        attemptId: event.attemptId,
        identity: event.identity,
        status: "open",
        openedSeq: event.seq,
        checks: null,
        launched: new Map(),
        evidence: new Map(),
        review: null,
      };
      state.latestIdentity = event.identity;
      if (event.attemptId === null) {
        if (event.cycleId !== `finish/c${state.finishCycles.length + 1}`) fail(`Unexpected finish cycle ${event.cycleId}.`);
        state.finishCycles.push(event.cycleId);
        return;
      }
      const a = attempt(state, event.attemptId);
      requireLive(a, "cycle.opened");
      if (event.cycleId !== `${a.attemptId}/c${a.cycles.length + 1}`) fail(`Unexpected cycle ${event.cycleId}.`);
      const previous = currentCycle(state, a);
      if (previous && previous.status === "open") fail(`Attempt ${a.attemptId} already has an open cycle.`);
      a.cycles.push(event.cycleId);
      a.parked = false;
      return;
    }
    case "checks.started": {
      const c = cycle(state, event.cycleId);
      if (c.attemptId !== event.attemptId || c.status !== "open" || c.checks !== null) fail(`Cycle ${c.cycleId} cannot start checks.`);
      requireLive(attempt(state, event.attemptId), "checks.started");
      c.checks = { mode: event.mode, count: event.count };
      return;
    }
    case "check.launched": {
      const c = cycle(state, event.cycleId);
      if (c.attemptId !== event.attemptId || c.checks === null || event.index >= c.checks.count) fail(`Unexpected check launch in ${c.cycleId}.`);
      c.launched.set(event.index, { pid: event.pid, pgid: event.pgid, startedAt: event.startedAt });
      return;
    }
    case "evidence.recorded": {
      const evidence = event.evidence;
      const c = cycle(state, evidence.cycleId);
      if (c.attemptId !== evidence.attemptId) fail(`Evidence ${evidence.id} names the wrong attempt.`);
      if (evidence.kind === "check") {
        if (c.checks === null || evidence.item === null || evidence.item >= c.checks.count) fail(`Unexpected check evidence ${evidence.id}.`);
        c.evidence.set(evidence.item, evidence);
      }
      addEvidence(state, evidence);
      return;
    }
    case "cycle.invalidated": {
      const c = cycle(state, event.cycleId);
      if (c.status !== "open") fail(`Cycle ${c.cycleId} is not open.`);
      c.status = "invalidated";
      if (event.observed) state.latestIdentity = event.observed;
      for (const evidence of state.evidence) {
        if (evidence.cycleId === c.cycleId && evidence.result !== "late") evidence.result = "late";
      }
      if (c.attemptId === null) return;
      const a = attempt(state, c.attemptId);
      if (!event.explained) a.unexplained += 1;
      const gj = graphJob(state, a.jobId);
      if (gj.uses === "checks" && c.checks?.mode === "isolated") job(state, a.jobId).exclusive = true;
      return;
    }
    case "review.submitted": {
      const a = attempt(state, event.attemptId);
      requireLive(a, "review");
      if (event.role !== "reviewer") fail("Only the reviewer submits a review.");
      requireAgent(a, "reviewer", event.agentId);
      const c = currentCycle(state, a);
      if (!c || c.cycleId !== event.cycleId || c.status !== "open" || c.review !== null) fail(`No review is expected on ${event.cycleId}.`);
      c.review = { seq: event.seq, outcome: event.outcome, findings: event.findings, criteria: event.criteria, identity: event.identity };
      const result = sameIdentity(event.identity, c.identity) ? undefined : "late";
      const base = { attemptId: a.attemptId, cycleId: c.cycleId, mode: null, exitCode: null, identity: event.identity, at: event.at };
      for (const criterion of event.criteria) {
        addEvidence(state, { ...base, id: `${event.id}:c${criterion.index}`, kind: "criterion", item: criterion.index, result: result ?? (criterion.met ? "pass" : "fail"), outputTail: criterion.note ?? null });
      }
      if (graphJob(state, a.jobId).uses === "review") {
        addEvidence(state, { ...base, id: `${event.id}:review`, kind: "review", item: null, result: result ?? (event.outcome === "approved" ? "pass" : "fail"), outputTail: null });
      }
      return;
    }
    case "review.held": {
      // Recorded so an acknowledged submission survives a restart; it takes effect as
      // `review.submitted` once the reviewer's turn has ended.
      const a = attempt(state, event.attemptId);
      requireLive(a, "review.held");
      requireAgent(a, "reviewer", event.agentId);
      return;
    }
    case "job.awaiting_human": {
      const a = attempt(state, event.attemptId);
      requireLive(a, "job.awaiting_human");
      const c = currentCycle(state, a);
      if (a.jobId !== event.jobId || !c || c.cycleId !== event.cycleId || c.status !== "open") fail(`Attempt ${a.attemptId} cannot wait on ${event.cycleId}.`);
      a.parked = true;
      a.unexplained = 0;
      return;
    }
    case "human.accepted":
    case "human.approved": {
      const a = attempt(state, event.attemptId);
      requireLive(a, event.kind);
      const c = currentCycle(state, a);
      if (!a.parked || a.jobId !== event.jobId || !c || c.cycleId !== event.cycleId || c.status !== "open") fail(`Attempt ${a.attemptId} is not waiting on ${event.cycleId}.`);
      if (!sameIdentity(event.identity, c.identity)) fail(`Evidence for ${event.cycleId} is stale.`);
      const base = { attemptId: a.attemptId, cycleId: c.cycleId, mode: null, exitCode: null, outputTail: null, identity: event.identity, at: event.at };
      if (event.kind === "human.accepted") {
        a.accepted = true;
        for (const index of event.criteria) addEvidence(state, { ...base, id: `${event.id}:c${index}`, kind: "criterion", item: index, result: "pass" });
        addEvidence(state, { ...base, id: `${event.id}:accept`, kind: "acceptance", item: null, result: "pass" });
      } else {
        a.approved = true;
        addEvidence(state, { ...base, id: `${event.id}:approve`, kind: "approval", item: null, result: "pass" });
      }
      return;
    }
    case "human.changes_requested": {
      const a = attempt(state, event.attemptId);
      requireLive(a, "human.changes_requested");
      if (!a.parked || a.jobId !== event.jobId) fail(`Attempt ${a.attemptId} is not waiting for a human.`);
      a.humanChanges = { note: event.note, taskIds: event.taskIds };
      return;
    }
    case "quiesce.started": {
      const existing = state.barriers.find((barrier) => barrier.barrierId === event.barrierId);
      if (existing) {
        if (existing.status !== "unconfirmed") fail(`Barrier ${event.barrierId} is not unconfirmed.`);
        existing.status = "pending";
        return;
      }
      if (event.barrierId !== `q${state.barriers.length + 1}`) fail(`Unexpected barrier ${event.barrierId}.`);
      for (const id of event.attempts) {
        const a = attempt(state, id);
        if (isEnded(a)) {
          if (event.cause === "recovery") continue;
          fail(`Attempt ${id} already ended.`);
        }
        if (a.stopping !== null && openBarriers(state).some((barrier) => barrier.barrierId === a.stopping)) fail(`Attempt ${id} is already stopping.`);
        a.stopping = event.barrierId;
        a.quiesced = false;
      }
      state.barriers.push({
        barrierId: event.barrierId,
        attempts: [...event.attempts],
        cause: event.cause,
        jobId: event.jobId,
        failure: event.failure,
        agents: event.agents ?? [],
        status: "pending",
      });
      return;
    }
    case "quiesce.confirmed": {
      const barrier = state.barriers.find((candidate) => candidate.barrierId === event.barrierId);
      if (!barrier || barrier.status === "confirmed") fail(`Barrier ${event.barrierId} is not open.`);
      barrier.status = "confirmed";
      for (const id of barrier.attempts) {
        const a = attempt(state, id);
        a.quiesced = true;
        if (barrier.cause === "recovery") a.stopping = null;
      }
      return;
    }
    case "quiesce.unconfirmed": {
      const barrier = state.barriers.find((candidate) => candidate.barrierId === event.barrierId);
      if (!barrier || barrier.status !== "pending") fail(`Barrier ${event.barrierId} is not pending.`);
      barrier.status = "unconfirmed";
      return;
    }
    case "attempt.ended": {
      const a = attempt(state, event.attemptId);
      if (a.stopping !== null) {
        const barrier = state.barriers.find((candidate) => candidate.barrierId === a.stopping);
        if (barrier && barrier.status !== "confirmed") fail(`Attempt ${a.attemptId} has not quiesced.`);
      }
      endAttempt(state, a, event);
      return;
    }
    case "job.provider_switched": {
      const js = job(state, event.jobId);
      if (js.pendingProvider === null || js.pendingProvider.role !== event.role || js.switched.includes(event.role)) fail(`Job ${event.jobId} cannot switch ${event.role}.`);
      js.targets[event.role] = "fallback";
      js.switched.push(event.role);
      js.pendingProvider = null;
      js.pending = { cause: "failover" };
      return;
    }
    case "job.needs_human": {
      const js = job(state, event.jobId);
      if (js.pendingProvider === null) fail(`Job ${event.jobId} has no provider failure to report.`);
      js.needsHuman = event.role;
      js.pendingProvider = null;
      js.reason = event.reason;
      return;
    }
    case "job.retry_requested": {
      const js = job(state, event.jobId);
      const current = currentAttempt(state, event.jobId);
      if (current && !isEnded(current)) fail(`Job ${event.jobId} is still running.`);
      if (js.needsHuman === null && js.terminal !== "failed" && js.terminal !== "stopped") fail(`Job ${event.jobId} cannot be retried.`);
      if (!state.order.includes(event.jobId) || isUnexpanded(graphJob(state, event.jobId))) fail(`Job ${event.jobId} cannot be retried.`);
      if (js.needsHuman !== null) {
        if (event.target !== undefined) js.targets[js.needsHuman] = event.target;
        if (!js.humanProviderChoice.includes(js.needsHuman)) js.humanProviderChoice.push(js.needsHuman);
      } else if (event.target !== undefined) {
        const role = mainRole(graphJob(state, event.jobId));
        if (role !== null) js.targets[role] = event.target;
      }
      js.needsHuman = null;
      js.terminal = null;
      js.reason = null;
      js.pending = { cause: "manual" };
      return;
    }
    case "rework.started": {
      const reviewing = job(state, event.jobId);
      reviewing.reworkUsed += 1;
      reviewing.lastChanges = null;
      const roots = new Set(event.taskIds && event.taskIds.length > 0 ? event.taskIds.map((taskId) => `${event.to}.${taskId}`) : membersOrSelf(state, event.to));
      for (const id of event.superseded) {
        const a = attempt(state, id);
        a.outcome = "superseded";
        a.reason = "rework";
      }
      for (const jobId of event.affected) {
        const js = job(state, jobId);
        js.succeeded = null;
        js.terminal = null;
        js.needsHuman = null;
        js.pendingProvider = null;
        js.reason = null;
        js.pending = roots.has(jobId)
          ? { cause: "rework", findings: event.findings, ...(event.note === undefined ? {} : { note: event.note }), ...(event.taskIds ? { taskIds: event.taskIds } : {}) }
          : { cause: "rework" };
      }
      state.lastJobChangeSeq = event.seq;
      return;
    }
    case "rework.granted":
      job(state, event.jobId).reworkGranted += 1;
      return;
    case "run.paused":
      state.pause = event.reason;
      return;
    case "run.resumed":
      if (state.pause === null || state.pause === "binding_unknown") fail("The run cannot resume.");
      state.pause = null;
      for (const js of Object.values(state.jobs)) {
        if (js.terminal === "stopped" && js.resumable) {
          js.terminal = null;
          js.resumable = false;
          js.reason = null;
          js.pending = { cause: "manual" };
        }
      }
      return;
    case "run.cancelled":
      if (state.barriers.some((barrier) => barrier.cause === "cancel" && barrier.status !== "confirmed")) fail("Cancel is not confirmed.");
      if (Object.values(state.attempts).some((a) => !isEnded(a))) fail("Attempts are still active.");
      state.cancelled = true;
      for (const js of Object.values(state.jobs)) if (js.succeeded === null) js.terminal = "cancelled";
      return;
    case "run.finished":
      state.finished = true;
      return;
  }
}

/**
 * Records a dynamic matrix expansion or failure pinned to the source's current successful attempt.
 * Instances of the previous expansion must have ended; those beyond the new list leave the live
 * graph and keep their history.
 */
function applyMatrix(state: RunState, event: Extract<RunEvent, { kind: "matrix.expanded" | "matrix.failed" }>): void {
  const template = state.snapshot.graph.jobs.find((gj) => gj.id === event.jobId);
  const ref = template ? matrixRef(template) : null;
  if (!template || ref === null || !isUnexpanded(template)) fail(`Job ${event.jobId} has no dynamic matrix.`);
  if (job(state, ref.jobId).succeeded !== event.sourceAttemptId) fail(`Attempt ${event.sourceAttemptId} is not the current result of ${ref.jobId}.`);
  if (state.matrices[event.jobId]?.sourceAttemptId === event.sourceAttemptId) fail(`Matrix ${event.jobId} already expanded from ${event.sourceAttemptId}.`);
  const previous = state.matrices[event.jobId]?.values?.length ?? 0;
  for (const id of instanceIds(event.jobId, previous)) {
    if (job(state, id).attempts.some((a) => !isEnded(attempt(state, a)))) fail(`Instance ${id} is still active.`);
  }
  if (event.kind === "matrix.failed") {
    state.matrices[event.jobId] = { sourceAttemptId: event.sourceAttemptId, values: null, reason: event.reason };
    const js = job(state, event.jobId);
    js.pending = null;
    js.terminal = "failed";
    js.reason = event.reason;
  } else {
    if (matrixItemsProblem(event.values) !== null) fail(`Matrix ${event.jobId} has invalid values.`);
    state.matrices[event.jobId] = { sourceAttemptId: event.sourceAttemptId, values: [...event.values], reason: null };
  }
  state.graph = liveGraph(state.snapshot.graph, state.matrices);
  state.order = graphOrder(state.graph);
  for (const gj of state.graph.jobs) {
    if (gj.sourceJobId !== event.jobId || gj.matrixIndex === undefined) continue;
    state.instances[gj.id] = gj;
    const js = state.jobs[gj.id];
    if (js === undefined) {
      state.jobs[gj.id] = newJobState(gj.id);
      continue;
    }
    if (js.succeeded !== null) fail(`Instance ${gj.id} still has a result from an earlier expansion.`);
    if (gj.matrixIndex >= previous) {
      const reinstated = newJobState(gj.id);
      reinstated.attempts = js.attempts;
      if (js.attempts.length > 0) reinstated.pending = { cause: "rework" };
      state.jobs[gj.id] = reinstated;
    }
  }
  state.lastJobChangeSeq = event.seq;
}

/** The `matrix.expanded` or `matrix.failed` event a dynamic matrix calls for, pinned to its source's current result. */
function matrixRecord(state: RunState): Effect | null {
  for (const template of dynamicTemplates(state.snapshot.graph)) {
    const ref = matrixRef(template);
    if (ref === null) continue;
    const source = job(state, ref.jobId).succeeded;
    if (source === null || state.matrices[template.id]?.sourceAttemptId === source) continue;
    const previous = state.matrices[template.id]?.values?.length ?? 0;
    if (instanceIds(template.id, previous).some((id) => job(state, id).attempts.some((a) => !isEnded(attempt(state, a))))) continue;
    const value = attempt(state, source).outputs?.[ref.output];
    const items: unknown[] | null = Array.isArray(value) ? value : null;
    const problem = items === null ? "matrix_invalid" : matrixItemsProblem(items);
    const key = `matrix:${template.id}:${source}`;
    if (problem !== null || items === null) return record(key, [{ kind: "matrix.failed", jobId: template.id, sourceAttemptId: source, reason: problem ?? "matrix_invalid" }]);
    const values = items.filter((item): item is MatrixScalar => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
    return record(key, [{ kind: "matrix.expanded", jobId: template.id, sourceAttemptId: source, values }]);
  }
  return null;
}

function membersOrSelf(state: RunState, id: string): string[] {
  const group = state.graph.groups.find((candidate) => candidate.id === id);
  return group ? group.jobIds : [id];
}

// ---------------------------------------------------------------------------------------------
// decide

type Step =
  | { kind: "wait" }
  | { kind: "record"; events: RunEventBody[] }
  | { kind: "create"; role: AgentRole; binding: RoleState["binding"] }
  | { kind: "remind"; role: AgentRole; agentId: string }
  | { kind: "open_cycle"; reopen: boolean }
  | { kind: "run_checks"; cycle: CycleState }
  | { kind: "request_review"; cycle: CycleState; agentId: string };

function end(a: AttemptState, outcome: AttemptOutcome, reason: string, extra: { findings?: Finding[]; note?: string } = {}): Step {
  return { kind: "record", events: [{ kind: "attempt.ended", attemptId: a.attemptId, outcome, reason, ...extra }] };
}

function intent(state: RunState, a: AttemptState, role: AgentRole, cycleId?: string): Step {
  const target = targetFor(state, a.jobId, role);
  return {
    kind: "record",
    events: [
      {
        kind: "agent.intent",
        attemptId: a.attemptId,
        role,
        creationKey: creationKey(state.snapshot.runId, a.attemptId, role),
        settings: agentFor(state, a.jobId, role, target),
        target,
        ...(cycleId === undefined ? {} : { cycleId }),
      },
    ],
  };
}

function turnSteps(a: AttemptState, rs: RoleState, role: AgentRole): Step | null {
  if (rs.cancelled) return end(a, "stopped", "turn_cancelled");
  if (rs.failed !== null) return end(a, "failed", "turn_failed");
  if (rs.noCompletion >= 2) return end(a, "failed", "no_result");
  if (rs.noCompletion === 1 && !rs.reminded && rs.binding.agentId !== null) return { kind: "remind", role, agentId: rs.binding.agentId };
  return null;
}

/** The next step of one attempt that is neither ended nor stopping. */
function progress(state: RunState, a: AttemptState): Step {
  const gj = graphJob(state, a.jobId);
  if (isWriter(gj)) {
    const worker = a.roles.worker;
    if (!worker) return intent(state, a, "worker");
    if (worker.binding.agentId === null) return { kind: "create", role: "worker", binding: worker.binding };
    if (a.rejections >= MAX_OUTPUT_REJECTIONS) return end(a, "failed", "outputs_invalid");
    if (a.outputs === null) return turnSteps(a, worker, "worker") ?? { kind: "wait" };
    if (!a.workerSettled) return { kind: "wait" };
  }
  return verification(state, a, gj);
}

function invalidate(c: CycleState, explained: boolean, reason: string): Step {
  return { kind: "record", events: [{ kind: "cycle.invalidated", cycleId: c.cycleId, explained, reason }] };
}

function verification(state: RunState, a: AttemptState, gj: GraphJob): Step {
  const c = currentCycle(state, a);
  if (!c || c.status === "invalidated") {
    if (a.unexplained >= MAX_UNEXPLAINED_INVALIDATIONS) return end(a, "failed", "worktree_unstable");
    if (gj.uses === "approval" && c) return end(a, "superseded", "evidence_stale");
    return { kind: "open_cycle", reopen: a.parked };
  }
  const commands = cycleCommands(gj);
  if (commands.length > 0) {
    if (c.checks === null) return { kind: "run_checks", cycle: c };
    const items = [...c.evidence.values()];
    if (items.some((evidence) => evidence.result === "late" || !sameIdentity(evidence.identity, c.identity))) return invalidate(c, false, "checks_drift");
    const failed = items.filter((evidence) => evidence.result === "fail");
    if (failed.length > 0 && c.evidence.size >= c.checks.count) {
      const findings = failed.map((evidence) => ({ title: `Check ${String(evidence.item)} failed`, detail: evidence.outputTail ?? "", tasks: [] }));
      return end(a, "failed", "check_failed", { findings });
    }
    if (c.evidence.size < c.checks.count) return { kind: "wait" };
  }
  if (needsReviewer(gj)) {
    const reviewer = a.roles.reviewer;
    if (!reviewer) return intent(state, a, "reviewer", c.cycleId);
    if (reviewer.binding.agentId === null) return { kind: "create", role: "reviewer", binding: reviewer.binding };
    const review = c.review;
    if (!review) {
      const turn = turnSteps(a, reviewer, "reviewer");
      if (turn) return turn;
      if (reviewer.binding.cycleId !== c.cycleId) return { kind: "request_review", cycle: c, agentId: reviewer.binding.agentId };
      return { kind: "wait" };
    }
    if (!sameIdentity(review.identity, c.identity)) return invalidate(c, false, "review_drift");
    if (gj.uses === "review") {
      if (review.outcome === "approved") return end(a, "succeeded", "approved");
      return reworkStep(state, a, gj, review.findings, undefined, reviewTaskIds(review.findings));
    }
    const unmet = review.criteria.filter((criterion) => !criterion.met);
    if (review.outcome !== "approved" || unmet.length > 0) {
      const findings = [...review.findings, ...unmet.map((criterion) => ({ title: `Criterion ${criterion.index} not met`, detail: criterion.note ?? "", tasks: [] }))];
      return end(a, "failed", "criterion_not_met", { findings });
    }
  }
  if (needsHuman(gj)) {
    if (!a.parked) return { kind: "record", events: [{ kind: "job.awaiting_human", jobId: a.jobId, attemptId: a.attemptId, cycleId: c.cycleId }] };
    if (a.humanChanges) {
      const { note, taskIds } = a.humanChanges;
      if (gj.uses === "approval") return reworkStep(state, a, gj, [], note, taskIds);
      return end(a, "failed", "changes_requested", { note });
    }
    if (a.accepted || a.approved) return end(a, "succeeded", a.approved ? "approved" : "accepted");
    if (state.latestIdentity && !sameIdentity(state.latestIdentity, c.identity)) return invalidate(c, true, "human_wait_drift");
    if (gj.uses === "approval" && staleRelied(state, gj.id, c.identity).length > 0) return end(a, "superseded", "evidence_stale");
    return { kind: "wait" };
  }
  return end(a, "succeeded", "verified");
}

function reviewTaskIds(findings: readonly Finding[]): string[] | undefined {
  const ids = [...new Set(findings.flatMap((finding) => finding.tasks))];
  return ids.length > 0 ? ids : undefined;
}

function reworkStep(state: RunState, a: AttemptState, gj: GraphJob, findings: Finding[], note: string | undefined, taskIds: string[] | undefined): Step {
  const rework = state.graph.reworks.find((candidate) => candidate.from === gj.sourceJobId);
  const extra = { findings, ...(note === undefined ? {} : { note }) };
  if (!rework) return end(a, "failed", "changes_requested", extra);
  const js = job(state, a.jobId);
  if (js.reworkUsed >= rework.max + js.reworkGranted) return end(a, "failed", "rework_exhausted", extra);
  return { kind: "record", events: reworkEvents(state, gj.id, a.attemptId, rework.to, findings, note, taskIds) };
}

function reworkEvents(state: RunState, jobId: string, reviewAttempt: string, to: string, findings: Finding[], note: string | undefined, taskIds: string[] | undefined): RunEventBody[] {
  const affected = affectedJobs(state, to, taskIds);
  const superseded: string[] = [];
  const stopping: string[] = [];
  for (const id of affected) {
    for (const attemptIdValue of job(state, id).attempts) {
      const a = attempt(state, attemptIdValue);
      if (!isEnded(a)) {
        superseded.push(a.attemptId);
        stopping.push(a.attemptId);
      } else if (a.outcome === "succeeded") superseded.push(a.attemptId);
    }
  }
  const events: RunEventBody[] = [
    {
      kind: "rework.started",
      jobId,
      attemptId: reviewAttempt,
      to,
      ...(taskIds ? { taskIds } : {}),
      affected,
      superseded,
      findings,
      ...(note === undefined ? {} : { note }),
    },
  ];
  if (stopping.length > 0) events.push({ kind: "quiesce.started", barrierId: nextBarrierId(state), attempts: stopping, cause: "rework", jobId });
  return events;
}

function affectedJobs(state: RunState, to: string, taskIds: readonly string[] | undefined): string[] {
  const roots = taskIds && taskIds.length > 0 ? taskIds.map((taskId) => `${to}.${taskId}`) : membersOrSelf(state, to);
  const reached = new Set(roots);
  const queue = [...roots];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const edge of state.graph.edges) {
      if (edge.from === id && !reached.has(edge.to)) {
        reached.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return state.graph.jobs.map((gj) => gj.id).filter((id) => reached.has(id));
}

export function nextBarrierId(state: RunState): string {
  return `q${state.barriers.length + 1}`;
}

function record(key: string, events: RunEventBody[]): Effect {
  return { kind: "record", key, events };
}

/** Facts the engine derives from the state; returned alone, before any host effect. */
function nextRecord(state: RunState): Effect | null {
  if (state.workspace === null) return record("workspace.intent", [{ kind: "workspace.intent", branchName: branchNameFor(state.snapshot.runId) }]);

  for (const barrier of state.barriers) {
    if (barrier.status !== "confirmed" || barrier.cause === "recovery") continue;
    for (const id of barrier.attempts) {
      const a = attempt(state, id);
      if (isEnded(a) || a.stopping !== barrier.barrierId) continue;
      if (a.outcome === "superseded") return record(`end:${id}`, [{ kind: "attempt.ended", attemptId: id, outcome: "superseded", reason: a.reason ?? "rework" }]);
      if (barrier.cause === "provider_failure" && barrier.failure) {
        return record(`end:${id}`, [{ kind: "attempt.ended", attemptId: id, outcome: "provider_failed", reason: "providers_unavailable", failure: barrier.failure }]);
      }
      return record(`end:${id}`, [{ kind: "attempt.ended", attemptId: id, outcome: "stopped", reason: barrier.cause }]);
    }
  }

  const cancel = state.barriers.find((barrier) => barrier.cause === "cancel");
  if (cancel && cancel.status === "confirmed" && !state.cancelled) {
    const leftover = Object.values(state.attempts).find((a) => !isEnded(a));
    if (leftover) return record(`end:${leftover.attemptId}`, [{ kind: "attempt.ended", attemptId: leftover.attemptId, outcome: "stopped", reason: "cancel" }]);
    return record("run.cancelled", [{ kind: "run.cancelled" }]);
  }
  if (cancel) return null;

  const matrix = matrixRecord(state);
  if (matrix) return matrix;

  for (const jobId of state.order) {
    const js = job(state, jobId);
    const failure = js.pendingProvider;
    if (failure === null) continue;
    const settings = settingsFor(state, jobId, failure.role);
    const fallbackFailed = js.providerFailures.some((item) => item.target === "fallback");
    const canSwitch = failure.target === "primary" && settings?.fallback !== undefined && !fallbackFailed && !js.switched.includes(failure.role) && !js.humanProviderChoice.includes(failure.role);
    if (canSwitch) return record(`switch:${jobId}:${failure.role}`, [{ kind: "job.provider_switched", jobId, role: failure.role, to: "fallback" }]);
    return record(`needs_human:${jobId}:${js.providerFailures.length}`, [
      { kind: "job.needs_human", jobId, role: failure.role, reason: "providers_unavailable", failures: js.providerFailures.map((item) => ({ ...item })) },
    ]);
  }

  const paused = pauseReason(state) !== null;
  const candidates = Object.values(state.attempts)
    .filter((a) => !isEnded(a) && a.stopping === null && a.outcome === null)
    .map((a) => ({ a, seq: currentCycle(state, a)?.review?.seq ?? Number.MAX_SAFE_INTEGER, order: state.order.indexOf(a.jobId) }))
    .sort((x, y) => x.seq - y.seq || x.order - y.order || x.a.n - y.a.n);
  for (const { a } of candidates) {
    const step = progress(state, a);
    if (step.kind !== "record") continue;
    if (paused && step.events.some((body) => body.kind === "agent.intent")) continue;
    return record(`${step.events[0]?.kind ?? "record"}:${a.attemptId}:${state.seq}`, step.events);
  }

  for (const jobId of state.order) {
    const js = job(state, jobId);
    if (js.terminal !== "failed" || js.reason !== "rework_exhausted" || js.lastChanges === null) continue;
    const rework = state.graph.reworks.find((candidate) => candidate.from === graphJob(state, jobId).sourceJobId);
    if (!rework || js.reworkUsed >= rework.max + js.reworkGranted) continue;
    const last = currentAttempt(state, jobId);
    if (!last) continue;
    const { findings, note, taskIds } = js.lastChanges;
    return record(`rework:${jobId}:${js.reworkUsed}`, reworkEvents(state, jobId, last.attemptId, rework.to, findings, note, taskIds));
  }
  return null;
}

/** A failed instance fails its matrix: siblings that have not started for this expansion stay waiting. */
function siblingFailed(state: RunState, gj: GraphJob, js: JobState): boolean {
  if (gj.matrixIndex === undefined || (js.pending !== null && js.pending.cause !== "rework")) return false;
  const group = state.graph.groups.find((candidate) => candidate.kind === "matrix" && candidate.id === gj.sourceJobId);
  return (group?.jobIds ?? []).some((id) => id !== gj.id && job(state, id).terminal === "failed");
}

function activeAttempts(state: RunState): AttemptState[] {
  return Object.values(state.attempts).filter(isActive);
}

function startEffect(state: RunState, jobId: string, causeOverride?: AttemptCause): Effect {
  const js = job(state, jobId);
  const gj = graphJob(state, jobId);
  const n = js.attempts.length + 1;
  const id = attemptId(jobId, n);
  const pending = js.pending;
  const role = mainRole(gj);
  const cause = causeOverride ?? pending?.cause ?? "first";
  const matrixValue = liveMatrixValue(state, gj);
  return {
    kind: "start_attempt",
    key: `start:${id}`,
    jobId,
    attemptId: id,
    n,
    cause,
    target: role === null ? "primary" : targetFor(state, jobId, role),
    ...(pending?.note === undefined ? {} : { note: pending.note }),
    ...(pending?.findings === undefined || pending.findings.length === 0 ? {} : { findings: pending.findings }),
    ...(pending?.taskIds === undefined ? {} : { taskIds: pending.taskIds }),
    ...(matrixValue === undefined ? {} : { matrixValue }),
  };
}

/** The `attempt.started` event for a `start_attempt` effect. */
export function startedEvent(effect: Extract<Effect, { kind: "start_attempt" }>): RunEventBody {
  return {
    kind: "attempt.started",
    jobId: effect.jobId,
    attemptId: effect.attemptId,
    n: effect.n,
    cause: effect.cause,
    target: effect.target,
    ...(effect.note === undefined ? {} : { note: effect.note }),
    ...(effect.findings === undefined ? {} : { findings: effect.findings }),
    ...(effect.taskIds === undefined ? {} : { taskIds: effect.taskIds }),
    ...(effect.matrixValue === undefined ? {} : { matrixValue: effect.matrixValue }),
  };
}

function barrierEffects(state: RunState): Effect[] {
  const effects: Effect[] = [];
  for (const barrier of state.barriers) {
    if (barrier.status !== "pending") continue;
    const agents = new Map<string, { attemptId: string; role: AgentRole; agentId: string }>();
    for (const id of barrier.attempts) {
      const a = attempt(state, id);
      for (const role of ["worker", "reviewer"] as const) {
        const agentId = a.roles[role]?.binding.agentId;
        if (agentId) agents.set(agentId, { attemptId: id, role, agentId });
      }
    }
    for (const ref of barrier.agents) agents.set(ref.agentId, ref);
    for (const ref of agents.values()) {
      effects.push({ kind: "interrupt_agent", key: `interrupt:${barrier.barrierId}:${ref.agentId}`, barrierId: barrier.barrierId, ...ref });
    }
    for (const id of barrier.attempts) {
      const processes = unfinishedChecks(state, id);
      if (processes.cycleId !== null) {
        effects.push({ kind: "cancel_checks", key: `cancel:${barrier.barrierId}:${id}`, barrierId: barrier.barrierId, attemptId: id, cycleId: processes.cycleId, processes: processes.records });
      }
    }
  }
  return effects;
}

/** Recorded check processes of the attempt's current cycle that have no evidence yet. */
export function unfinishedChecks(state: RunState, id: string): { cycleId: string | null; records: ProcessRecord[] } {
  const a = attempt(state, id);
  const c = currentCycle(state, a);
  if (!c || c.checks === null || c.evidence.size >= c.checks.count) return { cycleId: null, records: [] };
  const records = [...c.launched.entries()].filter(([index]) => !c.evidence.has(index)).map(([, process]) => process);
  return { cycleId: c.cycleId, records };
}

function continuation(state: RunState, a: AttemptState, step: Step): Effect | null {
  switch (step.kind) {
    case "create":
      if (step.binding.agentId !== null) return null;
      return {
        kind: "create_agent",
        key: step.binding.creationKey,
        jobId: a.jobId,
        attemptId: a.attemptId,
        role: step.role,
        creationKey: step.binding.creationKey,
        target: step.binding.target,
        settings: step.binding.settings,
      };
    case "remind":
      return { kind: "remind", key: `remind:${a.attemptId}:${step.role}`, attemptId: a.attemptId, role: step.role, agentId: step.agentId };
    case "open_cycle": {
      const cycleId = `${a.attemptId}/c${a.cycles.length + 1}`;
      return { kind: "open_cycle", key: `cycle:${cycleId}`, cycleId, scope: { attemptId: a.attemptId } };
    }
    case "run_checks": {
      const gj = graphJob(state, a.jobId);
      const commands: ResolvedCommand[] = [];
      for (const command of cycleCommands(gj)) {
        const resolved = gj.uses === "checks" ? resolveCommand(command, gj, state) : { ok: true as const, command: typeof command === "string" ? { shell: command } : { argv: [...command] } };
        if (!resolved.ok) return null;
        commands.push(resolved.command);
      }
      return { kind: "run_checks", key: `checks:${step.cycle.cycleId}`, jobId: a.jobId, attemptId: a.attemptId, cycleId: step.cycle.cycleId, mode: checkMode(state, gj), commands };
    }
    case "request_review":
      return { kind: "request_review", key: `review:${step.cycle.cycleId}`, attemptId: a.attemptId, cycleId: step.cycle.cycleId, agentId: step.agentId };
    case "wait":
    case "record":
      return null;
  }
}

/** A `checks` attempt whose commands cannot be resolved fails its job with `ref_value_invalid`. */
function unresolvableChecks(state: RunState): Effect | null {
  for (const a of activeAttempts(state)) {
    if (a.stopping !== null) continue;
    const gj = graphJob(state, a.jobId);
    if (gj.uses !== "checks") continue;
    const step = progress(state, a);
    if (step.kind !== "run_checks") continue;
    if (cycleCommands(gj).some((command) => !resolveCommand(command, gj, state).ok)) {
      return record(`end:${a.attemptId}`, [{ kind: "attempt.ended", attemptId: a.attemptId, outcome: "failed", reason: "ref_value_invalid" }]);
    }
  }
  return null;
}

/**
 * The effects the state calls for now, deterministic for equal states. Engine-derived facts come
 * alone as one `record` effect, which the caller appends before deciding again. Otherwise the
 * host effects follow; each carries a `key`, and the caller runs each key at most once.
 */
export function decide(state: RunState): Effect[] {
  if (state.finished || state.cancelled) return [];
  const pending = nextRecord(state) ?? unresolvableChecks(state);
  if (pending) return [pending];
  const effects = barrierEffects(state);
  if (pauseReason(state) !== null || openBarriers(state).length > 0) return effects;
  const workspace = state.workspace;
  if (workspace === null) return effects;
  if (workspace.workspaceId === null) {
    effects.push({ kind: "create_workspace", key: `workspace:${workspace.branchName}`, branchName: workspace.branchName });
    return effects;
  }

  const active = activeAttempts(state).sort((x, y) => state.order.indexOf(x.jobId) - state.order.indexOf(y.jobId));
  let holder = active.some((a) => isHolder(state, a));
  let isolated = active.some((a) => isIsolatedCheck(state, a));
  for (const a of active) {
    const step = progress(state, a);
    if (step.kind === "open_cycle" && isHolder(state, a) && active.some((other) => other !== a && isIsolatedCheck(state, other))) continue;
    const effect = continuation(state, a, step);
    if (effect) effects.push(effect);
  }
  let count = active.length;
  const cap = state.graph.maxParallel;
  const matrixActive = new Map<string, number>();
  for (const a of active) {
    const gj = graphJob(state, a.jobId);
    if (gj.matrixIndex !== undefined) matrixActive.set(gj.sourceJobId, (matrixActive.get(gj.sourceJobId) ?? 0) + 1);
  }
  /** Whether a matrix instance fits under its `strategy.max-parallel`; counts it when `take` is set. */
  const matrixRoom = (jobId: string, take: boolean): boolean => {
    const gj = graphJob(state, jobId);
    if (gj.matrix === undefined || gj.matrixIndex === undefined) return true;
    const used = matrixActive.get(gj.sourceJobId) ?? 0;
    if (used >= gj.matrix.maxParallel) return false;
    if (take) matrixActive.set(gj.sourceJobId, used + 1);
    return true;
  };

  type Candidate = { kind: "reopen"; a: AttemptState } | { kind: "start"; jobId: string; cause?: AttemptCause };
  const verifiers: Candidate[] = [];
  const writers: Candidate[] = [];
  const queued = new Set<string>();

  for (const a of Object.values(state.attempts)) {
    if (!a.parked || isEnded(a) || a.stopping !== null || a.outcome !== null) continue;
    const step = progress(state, a);
    if (step.kind === "open_cycle") verifiers.push({ kind: "reopen", a });
  }
  for (const jobId of state.order) {
    const js = job(state, jobId);
    if (js.terminal !== null || js.needsHuman !== null || js.pendingProvider !== null || js.succeeded !== null) continue;
    const current = currentAttempt(state, jobId);
    if (current && !isEnded(current)) continue;
    if (current && js.pending === null) continue;
    if (!needsSatisfied(state, jobId)) continue;
    const gj = graphJob(state, jobId);
    if (!matrixPinned(state, gj) || siblingFailed(state, gj, js)) continue;
    if (isWriter(gj)) {
      writers.push({ kind: "start", jobId });
      continue;
    }
    const stale = staleRelied(state, jobId, state.latestIdentity);
    if (stale.length === 0) verifiers.push({ kind: "start", jobId });
    for (const id of stale) {
      if (queued.has(id)) continue;
      queued.add(id);
      verifiers.push({ kind: "start", jobId: id, cause: "stale" });
    }
  }

  const idle = active.length === 0 && !Object.values(state.attempts).some((a) => a.parked && !isEnded(a));
  const allSucceeded = state.order.every((id) => job(state, id).succeeded !== null);
  if (idle && allSucceeded && verifiers.length === 0 && writers.length === 0) {
    const lastId = state.finishCycles[state.finishCycles.length - 1];
    const last = lastId === undefined ? null : cycle(state, lastId);
    if (!last || last.status !== "open" || last.openedSeq < state.lastJobChangeSeq) {
      const cycleId = `finish/c${state.finishCycles.length + 1}`;
      effects.push({ kind: "open_cycle", key: `cycle:${cycleId}`, cycleId, scope: "finish" });
      return effects;
    }
    const stale = minimalStale(state, state.order, last.identity);
    if (stale.length === 0) {
      effects.push({ kind: "finish_run", key: `finish:${last.cycleId}`, cycleId: last.cycleId });
      return effects;
    }
    for (const id of stale) verifiers.push({ kind: "start", jobId: id, cause: "stale" });
  }

  for (const candidate of verifiers) {
    if (count >= cap) break;
    if (candidate.kind === "reopen") {
      if (holder || isolated) continue;
      effects.push(continuation(state, candidate.a, { kind: "open_cycle", reopen: true }) ?? fail("unreachable"));
      holder = true;
      count += 1;
      continue;
    }
    const gj = graphJob(state, candidate.jobId);
    if (!matrixRoom(candidate.jobId, false)) continue;
    if (gj.uses === "checks" && checkMode(state, gj) === "isolated") {
      if (holder) continue;
      matrixRoom(candidate.jobId, true);
      effects.push(startEffect(state, candidate.jobId, candidate.cause));
      isolated = true;
      count += 1;
      continue;
    }
    if (holder || isolated) continue;
    matrixRoom(candidate.jobId, true);
    effects.push(startEffect(state, candidate.jobId, candidate.cause));
    holder = true;
    count += 1;
  }
  if (verifiers.length === 0) {
    for (const candidate of writers) {
      if (count >= cap || holder || isolated || candidate.kind !== "start") break;
      if (!matrixRoom(candidate.jobId, true)) continue;
      effects.push(startEffect(state, candidate.jobId));
      holder = true;
      count += 1;
    }
  }
  return effects;
}

// ---------------------------------------------------------------------------------------------
// journal helpers and views

/** Stamps bodies with consecutive `seq` after the state's last event. */
export function stampEvents(state: RunState, bodies: readonly RunEventBody[], at: string, idOf: (seq: number) => string = (seq) => `${state.snapshot.runId}:${seq}`): RunEvent[] {
  return bodies.map((body, index) => {
    const seq = state.seq + index + 1;
    const stamped: RunEvent = { ...body, seq, id: idOf(seq), at };
    return stamped;
  });
}

/** Applies bodies in order and returns the stamped events with the final state. */
export function applyBodies(state: RunState, bodies: readonly RunEventBody[], at: string): { state: RunState; events: RunEvent[] } {
  const events = stampEvents(state, bodies, at);
  let next = state;
  for (const event of events) next = reduce(next, event);
  return { state: next, events };
}

export function criterionStatuses(state: RunState, jobId: string): Array<{ index: number; status: CriterionStatus }> {
  const gj = graphJob(state, jobId);
  const a = currentAttempt(state, jobId);
  return textCriteria(gj).map((index) => {
    if (!a) return { index, status: "pending" as const };
    const latest = [...state.evidence].reverse().find((evidence) => evidence.attemptId === a.attemptId && evidence.kind === "criterion" && evidence.item === index);
    if (!latest) return { index, status: "pending" as const };
    const c = state.cycles[latest.cycleId];
    if (latest.result === "late" || !c || c.status === "invalidated") return { index, status: "stale" as const };
    return { index, status: latest.result === "pass" ? ("met" as const) : ("not_met" as const) };
  });
}

export function attemptView(a: AttemptState): Attempt {
  const agents: AgentBinding[] = [];
  for (const role of ["worker", "reviewer"] as const) {
    const binding = a.roles[role]?.binding;
    if (binding) agents.push({ role: binding.role, creationKey: binding.creationKey, agentId: binding.agentId, settings: binding.settings, target: binding.target, intentAt: binding.intentAt, boundAt: binding.boundAt });
  }
  return {
    attemptId: a.attemptId,
    jobId: a.jobId,
    n: a.n,
    cause: a.cause,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    agents,
    target: a.target,
    outcome: a.outcome,
    reason: a.reason,
    outputs: a.outputs,
    ...(a.matrixValue === undefined ? {} : { matrixValue: a.matrixValue }),
  };
}

export function toRunView(state: RunState): RunView {
  const barrier = openBarriers(state)[0];
  const retired = retiredJobs(state);
  const unresolved: RunView["unresolvedIntents"] = [];
  if (state.workspace && state.workspace.workspaceId === null) unresolved.push({ kind: "workspace", key: state.workspace.branchName });
  for (const a of Object.values(state.attempts)) {
    if (isEnded(a)) continue;
    for (const rs of Object.values(a.roles)) if (rs.binding.agentId === null) unresolved.push({ kind: "agent", key: rs.binding.creationKey });
  }
  return {
    runId: state.snapshot.runId,
    projectId: state.snapshot.projectId,
    status: runStatus(state),
    pauseReason: pauseReason(state),
    workspace: state.workspace ? { branchName: state.workspace.branchName, workspaceId: state.workspace.workspaceId, baseCommit: state.workspace.baseCommit } : null,
    jobs: [...state.order, ...retired].map((id) => {
      const js = job(state, id);
      const current = currentAttempt(state, id);
      const c = current && !isEnded(current) ? currentCycle(state, current) : null;
      return {
        id,
        status: jobStatus(state, id),
        reason: js.reason,
        attempts: js.attempts.map((attemptIdValue) => attemptView(attempt(state, attemptIdValue))),
        criteria: criterionStatuses(state, id),
        providerFailures: js.providerFailures.map((failure) => ({ ...failure })),
        activeCycleId: c && c.status === "open" ? c.cycleId : null,
        ...(retired.includes(id) ? { retired: true as const } : {}),
      };
    }),
    evidence: state.evidence.map((evidence) => ({ ...evidence })),
    invalidatedCycles: Object.values(state.cycles).flatMap((c) => (c.status === "invalidated" ? [c.cycleId] : [])),
    barrier: barrier ? { barrierId: barrier.barrierId, cause: barrier.cause, attempts: [...barrier.attempts], unconfirmed: barrier.status === "unconfirmed" } : null,
    unresolvedIntents: unresolved,
  };
}
