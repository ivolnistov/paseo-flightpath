// Execution runs (Stage R3.1): start authorisation, pause/resume, repair budget and reads. The plugin
// server owns every rule; run events are append-only. Stage R3.4 adds the staged coordinator start,
// the agent-facing run commands behind the MCP run tools and record-time cycle retirement.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract, RpcInput } from "@getpaseo/plugin";
import { DomainError, isDomainError } from "../shared/errors";
import { parseDod } from "../shared/dod";
import {
  isV2Revision,
  type Evidence,
  type ExecutionRun,
  type Feature,
  type FeatureCreator,
  type Plan,
  type ResultBinding,
  type RoadmapData,
  type StartDelegation,
  type TaskRun,
  type TaskRunState,
  type WorktreeIdentity,
} from "../shared/model";
import { ceilingReached, prerequisitesDone, readyTasks, runBlockers, type NotReady } from "../shared/readiness";
import type { Result, ValueOf } from "../shared/rpc";
import type {
  CoordinatorReplace,
  DelegationRevoke,
  RunBudgetGrant,
  RunEvidenceList,
  RunGet,
  RunList,
  RunPause,
  RunResume,
  RunStart,
  RunView,
  TaskAccept,
} from "../shared/rpc-runs";
import type { RoadmapSettings } from "../shared/settings";
import type { ApprovalStore } from "./approvals";
import { verifyUserMessage } from "./binding";
import { runChecks, type CheckOutcome } from "./check-runner";
import { agentConfig, archiveAgent, coordinatorWorktree, createCoordinator, findProfile, handoverPrompt, NO_WORKSPACE, replacementPrompt, runPrompt } from "./coordinator";
import { coveringDelegation, delegatedStarts, recordDelegation } from "./delegations";
import { predicate, sameBinding, sameIdentity } from "./evidence";
import type { ProcessPort } from "./process-port";
import { runReview, type ReviewOutcome } from "./review-runner";
import { ulid } from "./ids";
import { cancelledRefs } from "./plan-hash";
import { currency } from "./plan-rules";
import { receiptKey, reworkInDraft, verifiedReceiptFor, type ReceiptMap } from "./plans";
import { UI_ORIGIN, type RoadmapServiceDeps, type StoreOpener, type WriteOrigin } from "./sessions";
import type { Store } from "./store";
import { openProjectStore } from "./store-root";

/** Reads the current identity of a run's feature worktree (server-owned; null when it cannot be read). */
export type IdentityReader = (x: { projectId: string; run: ExecutionRun; feature: Feature }) => Promise<WorktreeIdentity | { notReady: "unmerged" } | null>;

export type RunDeps = RoadmapServiceDeps & {
  approvals: ApprovalStore;
  settings: () => Promise<RoadmapSettings>;
  identity?: IdentityReader;
  /** The host PaseoApi (Stage R3.4: coordinator creation and prompts); null while none is captured. */
  paseo?: () => PaseoApi | null;
  /** Starts the R3.3 runners for an opened cycle (`roadmap_task_progress` done); absent → the cycle waits. */
  runners?: Pick<Runners, "start" | "cancel">;
};

/** The calling chat, from its bound grant (never from tool input). */
export type Caller = { agentId?: string; workspaceId?: string | null };

type VerificationRef = { projectId: string; runId: string; runToken: string; taskId: string };

type Write<C extends PluginRpcContract> = (open: StoreOpener, input: RpcInput<C>, origin: WriteOrigin) => Promise<Result<ValueOf<C>>>;
type Read<C extends PluginRpcContract> = (open: StoreOpener, input: RpcInput<C>) => Promise<Result<ValueOf<C>>>;

export interface RunCommands {
  start: Write<typeof RunStart>;
  pause: Write<typeof RunPause>;
  resume: Write<typeof RunResume>;
  budgetGrant: Write<typeof RunBudgetGrant>;
  revokeDelegation: Write<typeof DelegationRevoke>;
  get: Read<typeof RunGet>;
  list: Read<typeof RunList>;
  accept: Write<typeof TaskAccept>;
  evidenceList: Read<typeof RunEvidenceList>;
  /** Internal (no RPC, no MCP tool): opens a server-owned verification cycle at the current identity. */
  beginVerification(open: StoreOpener, x: VerificationRef & { binding: ResultBinding }): Promise<Result<{ revision: number; cycleId: string }>>;
  /** Agent-facing (MCP run tools, Stage R3.4); authority from the caller's bound grant. */
  next(open: StoreOpener, x: { projectId: string; runId: string; runToken: string }, caller: Caller): Promise<Result<{ revision: number; ready: string[]; blocked: NotReady[] }>>;
  claim(open: StoreOpener, x: { projectId: string; runId: string; runToken: string; taskId: string; agentId?: string }, caller: Caller): Promise<Result<{ revision: number }>>;
  progress(open: StoreOpener, x: { projectId: string; runId: string; runToken: string; taskId: string; state: "in_progress" | "done" }, caller: Caller): Promise<Result<{ revision: number; state: TaskRunState }>>;
  ack(open: StoreOpener, x: { projectId: string; runId: string; runToken: string; taskId: string }, caller: Caller): Promise<Result<{ revision: number }>>;
  bindChat(open: StoreOpener, x: { projectId: string; featureId: string }, caller: Caller): Promise<Result<{ revision: number }>>;
  startDelegated(
    open: StoreOpener,
    x: { projectId: string; scope: "feature" | "roadmap"; featureId?: string; quoted: string },
    caller: Caller,
    paseo: PaseoApi | null,
  ): Promise<Result<{ revision: number; delegationId: string; started: string[]; skipped: string[] }>>;
  /** Internal: records one cycle's runner outcomes in one revalidating transaction. */
  recordVerification(
    open: StoreOpener,
    x: VerificationRef & { cycleId: string; binding: ResultBinding; checks: CheckOutcome; review?: ReviewOutcome; failure?: string },
  ): Promise<Result<{ revision: number; state: TaskRunState }>>;
  /** Internal (card §6.2a): resumes dependents whose prerequisites are done, then starts delegated candidates. */
  sweep(open: StoreOpener, x: { projectId: string }): Promise<Result<{ revision: number; resumed: string[]; started: string[] }>>;
  replaceCoordinator: Write<typeof CoordinatorReplace>;
}

type Fn<C extends PluginRpcContract> = (paseo: PaseoApi, input: RpcInput<C>) => Promise<Result<ValueOf<C>>>;
export interface RunService {
  start: Fn<typeof RunStart>;
  pause: Fn<typeof RunPause>;
  resume: Fn<typeof RunResume>;
  budgetGrant: Fn<typeof RunBudgetGrant>;
  revokeDelegation: Fn<typeof DelegationRevoke>;
  get: Fn<typeof RunGet>;
  list: Fn<typeof RunList>;
  accept: Fn<typeof TaskAccept>;
  evidenceList: Fn<typeof RunEvidenceList>;
  replaceCoordinator: Fn<typeof CoordinatorReplace>;
}

const LIVE = (r: ExecutionRun) => r.state === "running" || r.state === "paused";
const notReady = (blocked: NotReady[]) =>
  new DomainError("run_not_ready", `the run is not ready: ${blocked.map((b) => b.code).join(", ")}`, { blocked });

function uiOnly(origin: WriteOrigin, what: string): void {
  if (origin.source !== "ui") throw new DomainError("invalid_input", `${what} happens only in the Paseo UI`);
}

function findFeature(data: RoadmapData, featureId: string): Feature {
  const feature = data.features.find((f) => f.id === featureId);
  if (!feature) throw new DomainError("not_found", `feature ${featureId} not found`, { featureId });
  return feature;
}

function findRun(data: RoadmapData, runId: string): ExecutionRun {
  const run = data.runs.find((r) => r.id === runId);
  if (!run) throw new DomainError("not_found", `run ${runId} not found`, { runId });
  return run;
}

/** A run-scoped write needs the run's current token, and an ended run accepts no write. */
function liveRun(data: RoadmapData, runId: string, runToken: string): ExecutionRun {
  const run = findRun(data, runId);
  if (run.state === "ended" || run.runToken !== runToken) {
    throw new DomainError("run_stale", run.state === "ended" ? "the run has ended" : "the run token is stale", { runId });
  }
  return run;
}

/** The feature's single bound plan (one plan per feature, owner Q1); duplicates fail closed. */
function boundPlan(data: RoadmapData, featureId: string): Plan {
  const plans = data.plans.filter((p) => p.featureId === featureId);
  if (plans.length === 0) throw new DomainError("invalid_input", "the feature has no plan", { featureId });
  if (plans.length > 1) {
    throw new DomainError("invalid_input", "the feature has more than one plan", {
      reason: "feature_has_multiple_plans",
      featureId,
      planIds: plans.map((p) => p.id).sort(),
    });
  }
  return plans[0];
}

const NO_REVIEW = "no review command configured";
const PAUSE_TEXT =
  "The decision roadmap paused this run. Ask every active worker to stop at a safe point and call roadmap_run_ack " +
  "for its task. Do not claim or report progress until the run is resumed.";
const hasEvent = (run: ExecutionRun, kind: string, taskId: string, detail: string) =>
  run.events.some((e) => e.kind === kind && e.taskId === taskId && e.detail === detail);

/** Marks the plan's task state of the run's exact revision verified (the only writer for run-managed revisions). */
function mirrorVerified(data: RoadmapData, run: ExecutionRun, taskId: string, at: string, note: string): void {
  const plan = data.plans.find((p) => p.id === run.planId);
  if (!plan) return;
  const state = { taskId, planRev: run.planRev, status: "verified" as const, verification: { at, note } };
  const index = plan.taskStates.findIndex((s) => s.planRev === run.planRev && s.taskId === taskId);
  if (index >= 0) plan.taskStates[index] = state;
  else plan.taskStates.push(state);
}

/** Undelivered run prompts since the latest `started`, `resumed` or `prompt_delivered` event (derived; never stored). */
function promptFailures(run: ExecutionRun): string[] {
  let from = 0;
  run.events.forEach((e, i) => {
    if (e.kind === "started" || e.kind === "resumed" || e.kind === "prompt_delivered") from = i + 1;
  });
  return run.events.slice(from).flatMap((e) => (e.kind === "prompt_failed" && e.detail !== undefined ? [e.detail] : []));
}

const ACTIVE_TASK: ReadonlySet<TaskRunState> = new Set(["claimed", "in_progress", "checks_pending", "review_pending"]);
/** Active tasks of a paused run whose assigned agent has not acked since `pausedAt` (a task without an agent never has). */
function awaitingAcks(run: ExecutionRun): TaskRun[] {
  if (run.state !== "paused") return [];
  return run.tasks.filter(
    (t) =>
      ACTIVE_TASK.has(t.state) &&
      !(t.agentId !== undefined && run.acks.some((a) => a.taskId === t.taskId && a.agentId === t.agentId && (run.pausedAt === undefined || a.at >= run.pausedAt))),
  );
}

/** The paused run a prompt re-send was sent for: same token, same pause, nothing resumed or delivered since. */
type ObservedPause = { runToken: string; pauseReason: ExecutionRun["pauseReason"]; eventCount: number };
const observedPause = (run: ExecutionRun): ObservedPause => ({ runToken: run.runToken, pauseReason: run.pauseReason, eventCount: run.events.length });
function stillObserved(run: ExecutionRun, o: ObservedPause): boolean {
  return (
    run.runToken === o.runToken &&
    run.state === "paused" &&
    run.pauseReason === o.pauseReason &&
    !run.events.slice(o.eventCount).some((e) => e.kind === "resumed" || e.kind === "prompt_delivered")
  );
}

/** Derived unresolved lines: undelivered prompts, then pause acknowledgements still awaited (Stage R3.5). */
export function unresolvedOf(run: ExecutionRun): string[] {
  return [...promptFailures(run), ...awaitingAcks(run).map((t) => `awaiting ack: ${t.taskId} (${t.agentId ?? "no agent"})`)];
}

/** The task's open cycle: its latest `cycle_started`, not yet recorded or retired. */
function openCycle(run: ExecutionRun, task: TaskRun): string | undefined {
  if (task.state !== "checks_pending" && task.state !== "review_pending") return undefined;
  const started = [...run.events].reverse().find((e) => e.kind === "cycle_started" && e.taskId === task.taskId)?.detail;
  if (started === undefined) return undefined;
  return hasEvent(run, "cycle_recorded", task.taskId, started) || retiredCycle(run, task.taskId, started) ? undefined : started;
}
const retiredCycle = (run: ExecutionRun, taskId: string, cycleId: string) =>
  run.events.some((e) => e.kind === "cycle_retired" && e.taskId === taskId && e.detail?.split("|")[0] === cycleId);
const RETIRED = "verification cycle retired: ";
const RETIREMENT: Record<string, string> = {
  worktree_drift: `${RETIRED}worktree changed during checks`,
  binding_changed: `${RETIRED}worktree changed during checks`,
  identity_unavailable: `${RETIRED}identity unavailable`,
  run_paused: `${RETIRED}run paused during checks`,
};

/** Retires one open cycle (card §5.2 shape): late only elsewhere; the task returns to in_progress, same worker. */
function retire(run: ExecutionRun, task: TaskRun, cycleId: string, reason: string, note: string, at: string): void {
  run.events.push({ at, kind: "cycle_retired", taskId: task.taskId, detail: `${cycleId}|${reason}` });
  task.state = "in_progress";
  delete task.binding;
  task.unresolved = [...task.unresolved.filter((u) => u !== NO_REVIEW && !u.startsWith(RETIRED)), note];
}

/**
 * The delegation that currently authorises a delegated run: any unrevoked delegation covering its
 * feature (Stage R4.4). A UI-started run needs none; `run.startAuth` is never rewritten.
 */
function authorisingDelegation(data: RoadmapData, run: ExecutionRun): StartDelegation | undefined {
  return run.startAuth.kind === "delegation" ? coveringDelegation(data, run.featureId) : undefined;
}

/** Retires every open cycle of the run with `run_paused` (pause, resume sweep, status effects). */
export function retireOpenCycles(run: ExecutionRun, at: string): void {
  for (const task of run.tasks) {
    const open = openCycle(run, task);
    if (open !== undefined) retire(run, task, open, "run_paused", RETIREMENT.run_paused, at);
  }
}

/**
 * A feature status or plan rework effect on the feature's live run, applied inside the caller's
 * transaction (card §6.2a). Returns the run whose runners are cancelled after the commit.
 */
export function applyRunEffect(
  draft: RoadmapData,
  featureId: string,
  effect: "deferred" | "undeferred" | "cancelled" | "rework",
  at: string,
): { runId: string } | undefined {
  const run = draft.runs.find((r) => r.featureId === featureId && LIVE(r));
  if (!run) return undefined;
  if (effect === "undeferred") {
    // Undefer keeps the run paused; a human resume is required.
    if (run.state === "paused" && run.pauseReason === "deferred") run.pauseReason = "owner";
    return undefined;
  }
  retireOpenCycles(run, at);
  if (effect === "deferred") {
    if (run.state === "running") {
      run.state = "paused";
      run.pausedAt = at;
    }
    run.pauseReason = "deferred";
    run.events.push({ at, kind: "paused", detail: "deferred" });
  } else {
    run.state = "ended";
    run.endReason = effect === "rework" ? "cancelled_for_rework" : "cancelled_with_feature";
    run.endedAt = at;
    delete run.pauseReason;
    run.events.push({ at, kind: "ended", detail: run.endReason });
  }
  return { runId: run.id };
}

/** Auto-done (card §6.2a): every task verified ends the run (finished) and the feature executing → done. */
function autoDone(draft: RoadmapData, run: ExecutionRun, at: string, actor: FeatureCreator): boolean {
  if (run.state === "ended" || run.tasks.length === 0 || !run.tasks.every((t) => t.state === "verified")) return false;
  run.state = "ended";
  run.endReason = "finished";
  run.endedAt = at;
  delete run.pauseReason;
  run.events.push({ at, kind: "finished" });
  const feature = draft.features.find((f) => f.id === run.featureId);
  if (feature && feature.status === "executing") {
    feature.status = "done";
    delete feature.statusReason;
    feature.events.push({ at, actor, kind: "status", from: "executing", to: "done", reason: "all tasks verified" });
  }
  return true;
}


type Role = "coordinator" | "crew" | "foreign";
function roleOf(feature: Feature, caller: Caller): Role {
  const c = feature.coordinator;
  if (!c || caller.agentId === undefined) return "foreign";
  if (caller.agentId === c.agentId) return "coordinator";
  const ws = caller.workspaceId;
  return typeof ws === "string" && ws !== "" && c.workspaceId !== NO_WORKSPACE && ws === c.workspaceId ? "crew" : "foreign";
}
function requireBound(caller: Caller): string {
  if (caller.agentId === undefined) throw new DomainError("invalid_input", "this chat is not bound yet; send any message and retry");
  return caller.agentId;
}
const notTaskAgent = (taskId: string) => new DomainError("invalid_input", "only the task's assigned agent (or the coordinator) may do this", { reason: "not_task_agent", taskId });

export function createRunCommands(deps: RunDeps): RunCommands {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => ulid());
  const log = deps.storeOptions?.log ?? ((m: string, e?: unknown) => console.error(m, e));
  const { approvals } = deps;

  async function toResult<T>(body: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, value: await body() };
    } catch (e) {
      if (isDomainError(e)) {
        return { ok: false, error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
      }
      log("decision-roadmap: unexpected run error", e);
      return { ok: false, error: { code: "internal", message: "Unexpected error; see plugin logs." } };
    }
  }

  async function readOk(store: Store) {
    const read = await store.read();
    if (read.status === "missing") throw new DomainError("store_missing", "No decision roadmap in this project.");
    if (read.status === "invalid") throw new DomainError("store_invalid", read.error.message, read.error);
    return read;
  }

  /** Whether `planRev` is the plan's latest revision with a verified, current, not reworked approval. */
  async function approvedCurrent(projectId: string, data: RoadmapData, plan: Plan, planRev: number): Promise<boolean> {
    const latest = plan.revisions.at(-1);
    if (!latest || latest.rev !== planRev || !isV2Revision(latest)) return false;
    const receipt = await verifiedReceiptFor(approvals, projectId, plan, latest);
    const copyOnly = !receipt && plan.approvals.some((c) => c.planRev === latest.rev);
    return currency(data.sessions, plan, receipt, copyOnly, cancelledRefs(data)).status === "current";
  }

  async function viewOf(projectId: string, data: RoadmapData, run: ExecutionRun, ceiling: number): Promise<RunView> {
    const feature = findFeature(data, run.featureId);
    const plan = data.plans.find((p) => p.id === run.planId);
    if (!plan || run.state === "ended") return { run, ready: [], blocked: [] };
    const delegation = authorisingDelegation(data, run);
    const current = await approvedCurrent(projectId, data, plan, run.planRev);
    const { ready, blocked } = readyTasks({ feature, features: data.features, run, plan, approvedCurrent: current, ceiling, ...(delegation ? { delegation } : {}) });
    const unresolved = unresolvedOf(run);
    return { run, ready, blocked, ...(unresolved.length > 0 ? { unresolved } : {}) };
  }

  type Actor = { kind: "human" } | { kind: "agent"; agentId: string };

  /** Appends a feature note in its own transaction (retried on conflicts); best effort. */
  async function appendNote(store: Store, featureId: string, reason: string, actor: Actor, dedupe = false): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const v = await store.version();
      if (v.revision === null) return;
      try {
        await store.transact(v.revision, (draft) => {
          const f = findFeature(draft, featureId);
          const lastNote = [...f.events].reverse().find((e) => e.kind === "note");
          if (dedupe && lastNote?.reason === reason) return;
          f.events.push({ at: now().toISOString(), actor, kind: "note", reason });
        });
        return;
      } catch (e) {
        if (!isDomainError(e, "revision_conflict")) throw e;
      }
    }
  }

  /** A post-commit send failure: the bound run is paused (owner) with prompt_failed and a feature note; no retry. */
  async function recordPromptFailure(
    store: Store,
    runId: string,
    featureId: string,
    error: string,
    actor: Actor,
    what = "initial prompt not delivered",
    ownerPause = false,
    observed?: ObservedPause,
  ): Promise<void> {
    const detail = `${what}: ${error}`;
    // A late failure of a re-send must not touch a run that changed since it was read (c0066): the
    // guard aborts the transaction, so nothing is written (no event, no note, no revision).
    const stale = new Error("stale prompt failure");
    for (let attempt = 0; attempt < 3; attempt++) {
      const v = await store.version();
      if (v.revision === null) return;
      try {
        await store.transact(v.revision, (draft) => {
          const at = now().toISOString();
          const run = findRun(draft, runId);
          if (observed && !stillObserved(run, observed)) throw stale;
          if (run.state === "running") {
            run.state = "paused";
            run.pauseReason = "owner";
            run.pausedAt = at;
          } else if (ownerPause && run.state === "paused") {
            // A failed sweep re-send hands the run to the owner: no later automatic retry.
            run.pauseReason = "owner";
          }
          run.events.push({ at, kind: "prompt_failed", detail });
          findFeature(draft, featureId).events.push({ at, actor, kind: "note", reason: `coordinator ${what}: ${error}` });
        });
        return;
      } catch (e) {
        if (e === stale) {
          log("decision-roadmap: a stale prompt failure was not recorded; the run changed while the prompt was being sent");
          return;
        }
        if (!isDomainError(e, "revision_conflict")) throw e;
      }
    }
  }

  /** A re-sent run prompt whose resume did not commit: recorded so it is not re-sent; best effort. */
  async function recordPromptDelivered(store: Store, runId: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const v = await store.version();
      if (v.revision === null) return;
      try {
        await store.transact(v.revision, (draft) => {
          draft.runs.find((r) => r.id === runId)?.events.push({ at: now().toISOString(), kind: "prompt_delivered" });
        });
        return;
      } catch (e) {
        if (!isDomainError(e, "revision_conflict")) throw e;
      }
    }
  }

  /**
   * Staged start (card §5.2): read-only precheck; with no binding, create the coordinator (workspace,
   * then agent, no prompt); one revalidating transaction writes binding + run + planned → executing;
   * only then the run prompt is sent.
   */
  async function startRun(
    open: StoreOpener,
    i: { projectId: string; expectedRevision: number; featureId: string; profileRef?: string; delegationId?: string; actor: Actor; paseo?: PaseoApi | null },
  ): Promise<{ revision: number; runId: string; runToken: string; existing: boolean }> {
    const store = await open(i.projectId);
    const read = await readOk(store);
    const feature = findFeature(read.data, i.featureId);
    const live = read.data.runs.find((r) => r.featureId === feature.id && LIVE(r));
    if (live) return { revision: read.revision, runId: live.id, runToken: live.runToken, existing: true };
    // Preflight before any SDK call (R3 corrective c0017): a stale expectation creates nothing.
    if (read.revision !== i.expectedRevision) {
      throw new DomainError("revision_conflict", "store revision changed", { expected: i.expectedRevision, actual: read.revision });
    }
    if (feature.coordinator === undefined && i.profileRef === undefined) {
      throw new DomainError("invalid_input", "choose a coordinator profile or bind an existing chat");
    }
    const plan = boundPlan(read.data, feature.id);
    const latest = plan.revisions.at(-1);
    // A revision without tasks can never finish (c0001): refused before any SDK or config read.
    if (latest && isV2Revision(latest) && latest.tasks.length === 0) {
      throw new DomainError("invalid_input", "the approved revision has no tasks to execute", { planId: plan.id, planRev: latest.rev });
    }
    if (!latest || !(await approvedCurrent(i.projectId, read.data, plan, latest.rev))) throw notReady([{ code: "approval_not_current" }]);
    if (feature.status !== "planned" && feature.status !== "executing") throw notReady([{ code: "feature_not_executing" }]);

    const paseo = i.paseo !== undefined ? i.paseo : (deps.paseo?.() ?? null);
    let created: { agentId: string; workspaceId: string; profileRef: string } | undefined;
    if (feature.coordinator === undefined) {
      if (!paseo) throw notReady([{ code: "coordinator_unavailable" }]);
      const profile = await findProfile(paseo, i.profileRef!).catch(() => {
        throw notReady([{ code: "coordinator_unavailable" }]);
      });
      if (!profile) throw new DomainError("invalid_input", `unknown coordinator profile ${i.profileRef}`, { profileRef: i.profileRef });
      const baseRef = (await deps.settings()).baseRef;
      try {
        const c = await createCoordinator(paseo, { storeRoot: store.storeRoot, projectId: i.projectId, featureId: feature.id, featureTitle: feature.title, profile, ...(baseRef ? { baseRef } : {}) });
        created = { ...c, profileRef: profile.id };
      } catch (e) {
        throw new DomainError("run_not_ready", `the coordinator could not be created: ${e instanceof Error ? e.message : "error"}`, { blocked: [{ code: "coordinator_unavailable" }] });
      }
    }

    const at = now().toISOString();
    let replacementTo: string | undefined;
    let out: { revision: number; result: { runId: string; runToken: string } };
    try {
      out = await store.transact(i.expectedRevision, (draft) => {
        // Revalidate against the data this transaction commits on.
        const f = findFeature(draft, feature.id);
        const p = boundPlan(draft, f.id);
        const bindingOk = created ? f.coordinator === undefined : f.coordinator !== undefined;
        if (p.revisions.at(-1)?.rev !== latest.rev || !bindingOk || draft.runs.some((r) => r.featureId === f.id && LIVE(r))) {
          throw new DomainError("revision_conflict", "the feature changed; reload and start again");
        }
        if (f.status !== "planned" && f.status !== "executing") throw notReady([{ code: "feature_not_executing" }]);
        if (!isV2Revision(latest)) throw notReady([{ code: "approval_not_current" }]);
        if (created) {
          f.coordinator = { agentId: created.agentId, workspaceId: created.workspaceId, boundAt: at, profileRef: created.profileRef };
          f.events.push({ at, actor: i.actor, kind: "coordinator", to: created.agentId });
        }
        // Stage R4.3: a queued replacement request is delivered now that a coordinator is bound.
        if (f.replacementRequested?.state === "queued" && f.coordinator) {
          f.replacementRequested = { ...f.replacementRequested, state: "requested" };
          f.events.push({ at, actor: i.actor, kind: "note", reason: "replacement requested on the start of a coordinator run" });
          replacementTo = f.coordinator.agentId;
        }
        const waiting = runBlockers({ feature: { ...f, status: "executing" }, features: draft.features, plan: p, approvedCurrent: true, ceiling: 0 }).some(
          (b) => b.code === "prerequisite_not_done",
        );
        const run: ExecutionRun = {
          id: newId(),
          featureId: f.id,
          planId: p.id,
          planRev: latest.rev,
          runToken: newId(),
          state: waiting ? "paused" : "running",
          ...(waiting ? { pauseReason: "prerequisite_not_done" as const, pausedAt: at } : {}),
          startAuth: i.delegationId !== undefined ? { kind: "delegation", delegationId: i.delegationId, at } : { kind: "ui", at },
          tasks: latest.tasks.map((t) => ({ taskId: t.id, state: "todo" as const, failedCycles: 0, extraBudget: 0, unresolved: [] })),
          acks: [],
          events: [{ at, kind: "started" }],
          lateEvidence: [],
        };
        draft.runs.push(run);
        if (f.status === "planned") {
          f.status = "executing";
          delete f.statusReason;
          f.events.push({ at, actor: i.actor, kind: "status", from: "planned", to: "executing" });
        }
        f.everStarted = true;
        return { runId: run.id, runToken: run.runToken };
      });
    } catch (e) {
      // The surplus agent never gets a prompt; an archive failure is left visible for the human.
      if (created && paseo && !(await archiveAgent(paseo, created.agentId))) {
        await appendNote(store, feature.id, `orphan coordinator agent ${created.agentId} could not be archived; archive it manually`, i.actor);
      }
      // A start that lost to a concurrent winner returns the winning run (Q19), without a second send.
      const after = await store.read();
      const winner = after.status === "ok" ? after.data.runs.find((r) => r.featureId === feature.id && LIVE(r)) : undefined;
      if (after.status === "ok" && winner) return { revision: after.revision, runId: winner.id, runToken: winner.runToken, existing: true };
      throw e;
    }
    // The run prompt goes once to the new or the already bound coordinator, only after the commit (C).
    const target = created?.agentId ?? feature.coordinator?.agentId;
    const sender = paseo ?? (i.paseo !== undefined ? i.paseo : (deps.paseo?.() ?? null));
    if (target !== undefined && sender) {
      try {
        await sender.agents.ref(target).send(runPrompt({ featureTitle: feature.title, featureId: feature.id, runId: out.result.runId, runToken: out.result.runToken }));
      } catch (e) {
        await recordPromptFailure(store, out.result.runId, feature.id, e instanceof Error ? e.message : "send failed", i.actor);
      }
    }
    if (replacementTo !== undefined) {
      await afterReplacementRequest({ paseo: () => sender, open, log }, { projectId: i.projectId, featureId: feature.id, agentId: replacementTo, actor: i.actor });
    }
    const v = await store.version();
    return { revision: v.revision ?? out.revision, ...out.result, existing: false };
  }

  /** in_progress or review_pending → checks_pending: records the binding and opens a new server-owned cycle. */
  async function begin(open: StoreOpener, x: VerificationRef & { binding: ResultBinding }): Promise<{ revision: number; cycleId: string }> {
    const store = await open(x.projectId);
    const read = await readOk(store);
    const target = liveRun(read.data, x.runId, x.runToken);
    await requireCurrentIdentity(x.projectId, read.data, target, x.binding.worktree);
    const at = now().toISOString();
    const cycleId = newId();
    const out = await store.transact(read.revision, (draft) => {
      const run = liveRun(draft, x.runId, x.runToken);
      if (run.state !== "running") throw new DomainError("invalid_input", "the run is not running", { state: run.state });
      const task = run.tasks.find((t) => t.taskId === x.taskId);
      if (!task) throw new DomainError("not_found", `task ${x.taskId} not found in the run`, { taskId: x.taskId });
      if (task.state !== "in_progress" && task.state !== "review_pending") {
        throw new DomainError("invalid_input", "verification starts from in_progress or review_pending", { state: task.state });
      }
      const b = x.binding;
      const revision = draft.plans.find((p) => p.id === run.planId)?.revisions.find((r) => r.rev === run.planRev);
      if (
        b.taskId !== task.taskId ||
        b.planId !== run.planId ||
        b.planRev !== run.planRev ||
        b.runToken !== run.runToken ||
        revision === undefined ||
        b.contentHash !== revision.contentHash
      ) {
        throw new DomainError("invalid_input", "the binding does not name this run, task and revision");
      }
      task.state = "checks_pending";
      task.binding = b;
      task.unresolved = task.unresolved.filter((u) => u !== NO_REVIEW && !u.startsWith(RETIRED));
      run.events.push({ at, kind: "cycle_started", taskId: task.taskId, detail: cycleId });
    });
    return { revision: out.revision, cycleId };
  }

  /** Starts delegated candidates (card §5.2/§6.2a): bound coordinator or configured profile, else one skipped note. */
  async function startCandidates(
    open: StoreOpener,
    store: Store,
    projectId: string,
    candidates: string[],
    actor: Actor,
    paseo: PaseoApi | null,
    fallbackDelegationId?: string,
  ): Promise<{ started: string[]; skipped: string[] }> {
    const profileRef = (await deps.settings()).coordinatorProfile;
    const started: string[] = [];
    const skipped: string[] = [];
    for (const featureId of candidates) {
      const v = await store.version();
      const data = await readOk(store);
      const f = findFeature(data.data, featureId);
      if (f.coordinator === undefined && profileRef === undefined) {
        // Never launched unbound; one note per unchanged cause.
        await appendNote(store, featureId, "delegated start skipped: no coordinator profile configured", actor, true);
        skipped.push(featureId);
        continue;
      }
      const covering = coveringDelegation(data.data, featureId);
      const delegationId = covering?.id ?? fallbackDelegationId;
      if (delegationId === undefined) continue;
      try {
        await startRun(open, {
          projectId,
          expectedRevision: v.revision ?? data.revision,
          featureId,
          ...(f.coordinator === undefined && profileRef !== undefined ? { profileRef } : {}),
          delegationId,
          actor,
          paseo,
        });
        started.push(featureId);
      } catch (e) {
        if (!isDomainError(e)) throw e;
        await appendNote(store, featureId, `delegated start skipped: ${e.message}`, actor, true);
        skipped.push(featureId);
      }
    }
    return { started, skipped };
  }

  /**
   * Resumes one run paused for a prerequisite (card §6.2a sweep; R3 corrective c0003). Every
   * receipt, readiness and revision check runs before any send. An undelivered run prompt is
   * re-sent once as a steer while the run is still paused, then the resume commits. A failed
   * re-send pauses the run for the owner (no later automatic retry); a commit that loses after the
   * delivery records `prompt_delivered`, so a later sweep resumes without a second send.
   */
  async function sweepResume(store: Store, projectId: string, runId: string): Promise<boolean> {
    const read = await readOk(store);
    const pre = findRun(read.data, runId);
    const plan = read.data.plans.find((p) => p.id === pre.planId);
    const current = plan !== undefined && (await approvedCurrent(projectId, read.data, plan, pre.planRev));
    const check = (data: RoadmapData, run: ExecutionRun) => {
      if (run.state !== "paused" || run.pauseReason !== "prerequisite_not_done") throw new DomainError("invalid_input", "not waiting for a prerequisite");
      const p = data.plans.find((y) => y.id === run.planId);
      if (!p) throw new DomainError("not_found", `plan ${run.planId} not found`, { planId: run.planId });
      const delegation = authorisingDelegation(data, run);
      const blocked = runBlockers({
        feature: findFeature(data, run.featureId),
        features: data.features,
        run: { ...run, state: "running" },
        plan: p,
        approvedCurrent: current,
        ceiling: 0,
        ...(delegation ? { delegation } : {}),
      });
      if (blocked.length > 0) throw notReady(blocked);
    };
    try {
      check(read.data, pre);
    } catch (e) {
      if (isDomainError(e)) return false;
      throw e;
    }
    let delivered = false;
    if (promptFailures(pre).length > 0) {
      const feature = findFeature(read.data, pre.featureId);
      const paseo = deps.paseo?.() ?? null;
      let failure: string | undefined;
      if (!paseo || feature.coordinator === undefined) failure = "no coordinator chat is reachable";
      else {
        try {
          await paseo.agents
            .ref(feature.coordinator.agentId)
            .send(runPrompt({ featureTitle: feature.title, featureId: feature.id, runId: pre.id, runToken: pre.runToken }), { activeTurnBehavior: "steer" });
          delivered = true;
        } catch (e) {
          failure = e instanceof Error ? e.message : "send failed";
        }
      }
      if (failure !== undefined) {
        await recordPromptFailure(store, pre.id, pre.featureId, failure, { kind: "human" }, "run prompt re-send not delivered", true, observedPause(pre));
        return false;
      }
    }
    const at = now().toISOString();
    try {
      await store.transact(read.revision, (draft) => {
        const run = findRun(draft, runId);
        check(draft, run);
        retireOpenCycles(run, at);
        run.state = "running";
        delete run.pauseReason;
        delete run.pausedAt;
        run.events.push({ at, kind: "resumed" });
      });
      return true;
    } catch (e) {
      if (delivered) await recordPromptDelivered(store, runId);
      if (isDomainError(e)) return false;
      throw e;
    }
  }

  /**
   * Coordinator replacement (card §6.2a, UI only): read-only preconditions with no SDK call on a
   * refusal; the new agent is staged in the existing workspace (branch-off only for the sentinel);
   * one revalidating transaction keeps the run and token; the handover prompt goes after the commit.
   */
  async function replaceCoordinator(
    open: StoreOpener,
    i: { projectId: string; expectedRevision: number; featureId: string; profileRef: string },
  ): Promise<{ revision: number; agentId: string; workspaceId: string }> {
    const store = await open(i.projectId);
    const read = await readOk(store);
    const feature = findFeature(read.data, i.featureId);
    const old = feature.coordinator;
    if (!old) throw new DomainError("invalid_input", "the feature has no coordinator to replace", { featureId: feature.id });
    const live = read.data.runs.find((r) => r.featureId === feature.id && LIVE(r));
    if (live && live.state === "running") throw new DomainError("invalid_input", "pause the run first", { runId: live.id });
    if (live) {
      const waiting = awaitingAcks(live);
      if (waiting.length > 0) throw notReady(waiting.map((t) => ({ code: "pause_unacknowledged" as const, taskId: t.taskId })));
    }
    const paseo = deps.paseo?.() ?? null;
    if (!paseo) throw notReady([{ code: "coordinator_unavailable" }]);
    const profile = await findProfile(paseo, i.profileRef).catch(() => {
      throw notReady([{ code: "coordinator_unavailable" }]);
    });
    if (!profile) throw new DomainError("invalid_input", `unknown coordinator profile ${i.profileRef}`, { profileRef: i.profileRef });
    let next: { agentId: string; workspaceId: string };
    try {
      if (old.workspaceId === NO_WORKSPACE) {
        const baseRef = (await deps.settings()).baseRef;
        next = await createCoordinator(paseo, { storeRoot: store.storeRoot, projectId: i.projectId, featureId: feature.id, featureTitle: feature.title, profile, ...(baseRef ? { baseRef } : {}) });
      } else {
        const agent = await paseo.workspaces.ref(old.workspaceId).agents.create({
          config: agentConfig(profile),
          title: `Roadmap: ${feature.title}`,
          labels: { "decision-roadmap.feature": feature.id },
        });
        next = { agentId: agent.id, workspaceId: old.workspaceId };
      }
    } catch (e) {
      throw new DomainError("run_not_ready", `the coordinator could not be created: ${e instanceof Error ? e.message : "error"}`, { blocked: [{ code: "coordinator_unavailable" }] });
    }
    const at = now().toISOString();
    let out: { revision: number };
    try {
      out = await store.transact(i.expectedRevision, (draft) => {
        const f = findFeature(draft, feature.id);
        const run = live ? findRun(draft, live.id) : undefined;
        if (f.coordinator?.agentId !== old.agentId || (run && (run.state !== "paused" || run.runToken !== live!.runToken))) {
          throw new DomainError("revision_conflict", "the feature changed; reload and replace again");
        }
        f.coordinatorHistory.push(f.coordinator);
        f.coordinator = { agentId: next.agentId, workspaceId: next.workspaceId, boundAt: at, profileRef: profile.id };
        f.events.push({ at, actor: { kind: "human" }, kind: "coordinator", from: old.agentId, to: next.agentId });
      });
    } catch (e) {
      if (!(await archiveAgent(paseo, next.agentId))) {
        await appendNote(store, feature.id, `orphan coordinator agent ${next.agentId} could not be archived; archive it manually`, { kind: "human" });
      }
      throw e;
    }
    if (live) {
      try {
        await paseo.agents.ref(next.agentId).send(
          handoverPrompt({ featureTitle: feature.title, featureId: feature.id, runId: live.id, runToken: live.runToken, previousAgentId: old.agentId }),
        );
      } catch (e) {
        await recordPromptFailure(store, live.id, feature.id, e instanceof Error ? e.message : "send failed", { kind: "human" }, "handover prompt not delivered");
      }
    }
    const v = await store.version();
    return { revision: v.revision ?? out.revision, ...next };
  }

  const commands: RunCommands = {
    start: (open, i, origin) =>
      toResult(async () => {
        uiOnly(origin, "Starting execution");
        return startRun(open, { projectId: i.projectId, expectedRevision: i.expectedRevision, featureId: i.featureId, ...(i.profileRef !== undefined ? { profileRef: i.profileRef } : {}), actor: { kind: "human" } });
      }),

    pause: (open, i, origin) =>
      toResult(async () => {
        uiOnly(origin, "Pausing a run");
        const at = now().toISOString();
        const store = await open(i.projectId);
        const out = await store.transact(i.expectedRevision, (draft) => {
          const run = liveRun(draft, i.runId, i.runToken);
          if (run.state !== "running") throw new DomainError("invalid_input", "the run is not running", { state: run.state });
          run.state = "paused";
          run.pauseReason = "owner";
          run.pausedAt = at;
          // Pause terminates runner processes, so every open cycle is retired in this transaction.
          retireOpenCycles(run, at);
          run.events.push({ at, kind: "paused", detail: "owner" });
          return run.featureId;
        });
        // After commit: cancel the runners, then steer the coordinator (no forced interrupt).
        deps.runners?.cancel(i.runId);
        const read = await readOk(store);
        const feature = findFeature(read.data, out.result);
        const paseo = deps.paseo?.() ?? null;
        if (paseo && feature.coordinator) {
          try {
            await paseo.agents.ref(feature.coordinator.agentId).send(PAUSE_TEXT, { activeTurnBehavior: "steer" });
          } catch (e) {
            await appendNote(store, feature.id, `pause request not delivered to the coordinator: ${e instanceof Error ? e.message : "send failed"}`, { kind: "human" });
          }
        }
        const v = await store.version();
        return { revision: v.revision ?? out.revision };
      }),

    resume: (open, i, origin) =>
      toResult(async () => {
        uiOnly(origin, "Resuming a run");
        const store = await open(i.projectId);
        const read = await readOk(store);
        const target = liveRun(read.data, i.runId, i.runToken);
        const plan = read.data.plans.find((p) => p.id === target.planId);
        const current = plan !== undefined && (await approvedCurrent(i.projectId, read.data, plan, target.planRev));
        /** Token, state and every readiness condition; the same checks run again inside the transaction. */
        const check = (data: RoadmapData, run: ExecutionRun) => {
          if (run.state !== "paused") throw new DomainError("invalid_input", "the run is not paused", { state: run.state });
          const p = data.plans.find((x) => x.id === run.planId);
          if (!p) throw new DomainError("not_found", `plan ${run.planId} not found`, { planId: run.planId });
          const delegation = authorisingDelegation(data, run);
          const blocked = runBlockers({
            feature: findFeature(data, run.featureId),
            features: data.features,
            run: { ...run, state: "running" },
            plan: p,
            approvedCurrent: current,
            ceiling: 0,
            ...(delegation ? { delegation } : {}),
          });
          if (blocked.length > 0) throw notReady(blocked);
        };
        // Preflight before any send: a stale expectation or a refused resume sends nothing.
        if (read.revision !== i.expectedRevision) {
          throw new DomainError("revision_conflict", "the roadmap changed; reload and resume again", { expected: i.expectedRevision, actual: read.revision });
        }
        check(read.data, target);
        // An undelivered run prompt is re-sent once as a steer before the run resumes (Stage R3.4).
        let delivered = false;
        if (promptFailures(target).length > 0) {
          const feature = findFeature(read.data, target.featureId);
          const paseo = deps.paseo?.() ?? null;
          const prompt = runPrompt({ featureTitle: feature.title, featureId: feature.id, runId: target.id, runToken: target.runToken });
          let failure: string | undefined;
          if (!paseo || feature.coordinator === undefined) failure = "no coordinator chat is reachable";
          else {
            try {
              await paseo.agents.ref(feature.coordinator.agentId).send(prompt, { activeTurnBehavior: "steer" });
              delivered = true;
            } catch (e) {
              failure = e instanceof Error ? e.message : "send failed";
            }
          }
          if (failure !== undefined) {
            await recordPromptFailure(store, target.id, target.featureId, failure, { kind: "human" }, "initial prompt not delivered", false, observedPause(target));
            throw notReady([{ code: "coordinator_unavailable" }]);
          }
        }
        const at = now().toISOString();
        try {
          const out = await store.transact(i.expectedRevision, (draft) => {
            const run = liveRun(draft, i.runId, i.runToken);
            check(draft, run);
            // Defensive sweep: a cycle left open while paused is retired before the run resumes.
            retireOpenCycles(run, at);
            run.state = "running";
            delete run.pauseReason;
            delete run.pausedAt;
            run.events.push({ at, kind: "resumed" });
          });
          return { revision: out.revision };
        } catch (e) {
          // The prompt went out but the resume did not commit: the run stays paused and records the
          // delivery, so a later resume does not send it again. The refusal is returned as is.
          if (delivered) await recordPromptDelivered(store, target.id);
          throw e;
        }
      }),

    budgetGrant: (open, i, origin) =>
      toResult(async () => {
        uiOnly(origin, "Granting a repair budget");
        if (!Number.isInteger(i.cycles) || i.cycles < 1 || i.cycles > 1000) throw new DomainError("invalid_input", "cycles must be 1 to 1000");
        const ceiling = (await deps.settings()).repairCeiling;
        const at = now().toISOString();
        const out = await (await open(i.projectId)).transact(i.expectedRevision, (draft) => {
          const run = liveRun(draft, i.runId, i.runToken);
          const task = run.tasks.find((t) => t.taskId === i.taskId);
          if (!task) throw new DomainError("not_found", `task ${i.taskId} not found in the run`, { taskId: i.taskId });
          if (task.state !== "ceiling") throw new DomainError("invalid_input", "a budget can be granted only to a task at its repair ceiling", { state: task.state });
          // Additive and recorded; failedCycles is never reset.
          task.extraBudget += i.cycles;
          if (task.failedCycles < ceiling + task.extraBudget) task.state = "todo";
          run.events.push({ at, kind: "budget_granted", taskId: i.taskId, detail: `+${i.cycles}` });
        });
        return { revision: out.revision };
      }),

    revokeDelegation: (open, i, origin) =>
      toResult(async () => {
        uiOnly(origin, "Revoking a delegation");
        const at = now().toISOString();
        const out = await (await open(i.projectId)).transact(i.expectedRevision, (draft) => {
          const d = draft.delegations.find((x) => x.id === i.delegationId);
          if (!d) throw new DomainError("not_found", `delegation ${i.delegationId} not found`, { delegationId: i.delegationId });
          if (d.revokedAt === undefined) d.revokedAt = at;
        });
        return { revision: out.revision };
      }),

    get: (open, i) =>
      toResult(async () => {
        const read = await readOk(await open(i.projectId));
        const ceiling = (await deps.settings()).repairCeiling;
        return { revision: read.revision, ...(await viewOf(i.projectId, read.data, findRun(read.data, i.runId), ceiling)) };
      }),

    list: (open, i) =>
      toResult(async () => {
        const read = await readOk(await open(i.projectId));
        const ceiling = (await deps.settings()).repairCeiling;
        const runs: RunView[] = [];
        for (const run of read.data.runs) {
          if (i.featureId !== undefined && run.featureId !== i.featureId) continue;
          runs.push(await viewOf(i.projectId, read.data, run, ceiling));
        }
        return { revision: read.revision, runs };
      }),

    beginVerification: (open, x) => toResult(() => begin(open, x)),

    recordVerification: (open, x) =>
      toResult(async () => {
        const store = await open(x.projectId);
        const read = await readOk(store);
        const pre = findRun(read.data, x.runId);
        const preTask = pre.tasks.find((t) => t.taskId === x.taskId);
        if (!preTask) throw new DomainError("not_found", `task ${x.taskId} not found in the run`, { taskId: x.taskId });
        // A cycle is recorded once; repeating it changes nothing.
        if (hasEvent(pre, "cycle_recorded", x.taskId, x.cycleId)) return { revision: read.revision, state: preTask.state };
        const produced = [...x.checks.evidence, ...(x.review?.evidence ?? [])];
        const producedLate = [...x.checks.late, ...(x.review?.late ?? [])];
        // The current identity at the commit boundary (design §3.5).
        let lateReason: string | undefined;
        if (x.failure !== undefined) lateReason = "runner_error";
        else if (!deps.identity) lateReason = "identity_unavailable";
        else {
          const current = await deps.identity({ projectId: x.projectId, run: pre, feature: findFeature(read.data, pre.featureId) });
          if (current === null || "notReady" in current) lateReason = "identity_unavailable";
          else if (!sameIdentity(current, x.binding.worktree)) lateReason = "worktree_drift";
        }
        const ceiling = (await deps.settings()).repairCeiling;
        const at = now().toISOString();
        const out = await store.transact(read.revision, (draft) => {
          const run = findRun(draft, x.runId);
          const task = run.tasks.find((t) => t.taskId === x.taskId)!;
          let reason = lateReason;
          if (reason === undefined) {
            if (run.state === "ended" || run.runToken !== x.runToken) reason = "run_stale";
            else if (run.state !== "running") reason = "run_paused";
            else if (
              (task.state !== "checks_pending" && task.state !== "review_pending") ||
              task.binding === undefined ||
              !sameBinding(task.binding, x.binding) ||
              openCycle(run, task) !== x.cycleId
            ) {
              reason = "binding_changed";
            }
          }
          if (reason !== undefined) {
            // Never promotes the task: every result is kept as late evidence only.
            run.lateEvidence.push(...[...produced, ...producedLate].map((e): Evidence => ({ ...e, lateReason: reason })));
            // Retire only the task's positively open cycle under the run's token (card §5.2); an old,
            // retired, unstarted or foreign record never touches a newer cycle.
            const note = reason === "runner_error" ? `${RETIRED}runner error: ${x.failure}` : RETIREMENT[reason];
            if (note !== undefined && run.state !== "ended" && run.runToken === x.runToken && openCycle(run, task) === x.cycleId) {
              retire(run, task, x.cycleId, reason, note, at);
            }
            return { state: task.state, done: false };
          }
          run.evidence = [...(run.evidence ?? []), ...produced];
          run.lateEvidence.push(...producedLate);
          let finished = false;
          run.events.push({ at, kind: "cycle_recorded", taskId: task.taskId, detail: x.cycleId });
          // The evidence of this cycle, so an acceptance can be judged against exactly this cycle.
          run.events.push({ at, kind: "cycle_evidence", taskId: task.taskId, detail: `${x.cycleId}|${produced.map((e) => e.id).join(",")}` });
          const plan = draft.plans.find((p) => p.id === run.planId);
          const revision = plan?.revisions.find((r) => r.rev === run.planRev);
          const def = revision !== undefined && isV2Revision(revision) ? revision.tasks.find((t) => t.id === task.taskId) : undefined;
          if (!def) throw new DomainError("not_found", `task ${task.taskId} not found in revision ${run.planRev}`);
          task.unresolved = task.unresolved.filter((u) => u !== NO_REVIEW);
          const fail = () => {
            task.failedCycles += 1;
            run.events.push({ at, kind: "cycle_failed", taskId: task.taskId, detail: x.cycleId });
            if (ceilingReached(task, ceiling)) {
              task.state = "ceiling";
              run.events.push({ at, kind: "ceiling_reached", taskId: task.taskId });
            } else {
              // The claiming worker keeps the task to repair it.
              task.state = "in_progress";
            }
          };
          // Only this cycle decides; evidence of earlier cycles at the same binding never does.
          if (x.checks.result === "fail" || x.checks.late.length > 0) {
            fail();
          } else if (x.review === undefined || x.review.status === "pending") {
            task.state = "review_pending";
            task.unresolved = [...task.unresolved, NO_REVIEW];
          } else if (x.review.status === "fail" || x.review.late.length > 0) {
            fail();
          } else {
            const verdict = predicate({ task: def, items: parseDod(def.dod).items, binding: x.binding, evidence: produced });
            if (verdict === "verified") {
              task.state = "verified";
              mirrorVerified(draft, run, task.taskId, at, "verified by checks and review");
              // The verifying record is the task agent's work (else the coordinator's), never a human's.
              const coordinator = draft.features.find((f) => f.id === run.featureId)?.coordinator?.agentId;
              const agentId = task.agentId ?? coordinator;
              finished = autoDone(draft, run, at, agentId !== undefined ? { kind: "agent", agentId } : { kind: "human" });
            } else if (verdict === "pending" && def.completion === "human" && predicate({ task: { ...def, completion: "auto" }, items: parseDod(def.dod).items, binding: x.binding, evidence: produced }) === "verified") {
              task.state = "awaiting_acceptance";
            } else {
              // The runners passed but did not cover every key at this binding: not a pass.
              fail();
            }
          }
          return { state: task.state, done: finished };
        });
        // After auto-done, dependents and delegated candidates are swept (best effort).
        if (out.result.done) await commands.sweep(open, { projectId: x.projectId });
        return { revision: out.revision, state: out.result.state };
      }),

    accept: (open, i, origin) =>
      toResult(async () => {
        uiOnly(origin, "Accepting a task");
        const store = await open(i.projectId);
        const read = await readOk(store);
        const pre = liveRun(read.data, i.runId, i.runToken);
        const preTask = pre.tasks.find((t) => t.taskId === i.taskId);
        if (!preTask) throw new DomainError("not_found", `task ${i.taskId} not found in the run`, { taskId: i.taskId });
        if (preTask.state !== "awaiting_acceptance" || preTask.binding === undefined) {
          throw new DomainError("invalid_input", "only a task awaiting acceptance can be accepted", { state: preTask.state });
        }
        await requireCurrentIdentity(i.projectId, read.data, pre, preTask.binding.worktree);
        const at = now().toISOString();
        const out = await store.transact(i.expectedRevision, (draft) => {
          const run = liveRun(draft, i.runId, i.runToken);
          const task = run.tasks.find((t) => t.taskId === i.taskId)!;
          if (task.state !== "awaiting_acceptance" || task.binding === undefined || !sameBinding(task.binding, preTask.binding!)) {
            throw new DomainError("invalid_input", "only a task awaiting acceptance can be accepted", { state: task.state });
          }
          const acceptance: Evidence = { id: newId(), kind: "acceptance", taskId: task.taskId, binding: task.binding, at, result: "pass" };
          run.evidence = [...(run.evidence ?? []), acceptance];
          run.events.push({ at, kind: "accepted", taskId: task.taskId });
          const plan = draft.plans.find((p) => p.id === run.planId);
          const revision = plan?.revisions.find((r) => r.rev === run.planRev);
          const def = revision !== undefined && isV2Revision(revision) ? revision.tasks.find((t) => t.id === task.taskId) : undefined;
          // Judge exactly the cycle that led to awaiting_acceptance, plus this acceptance.
          const cycle = [...run.events].reverse().find((e) => e.kind === "cycle_evidence" && e.taskId === task.taskId);
          const ids = new Set((cycle?.detail ?? "").split("|")[1]?.split(",").filter((id) => id !== "") ?? []);
          const current = [...run.evidence.filter((e) => ids.has(e.id)), acceptance];
          if (def && ids.size > 0 && predicate({ task: def, items: parseDod(def.dod).items, binding: task.binding, evidence: current }) === "verified") {
            task.state = "verified";
            mirrorVerified(draft, run, task.taskId, at, "verified by checks, review and acceptance");
            return autoDone(draft, run, at, { kind: "human" });
          }
          return false;
        });
        if (out.result) await commands.sweep(open, { projectId: i.projectId });
        return { revision: out.revision };
      }),

    evidenceList: (open, i) =>
      toResult(async () => {
        const read = await readOk(await open(i.projectId));
        const run = findRun(read.data, i.runId);
        const keep = (e: Evidence) => i.taskId === undefined || e.taskId === i.taskId;
        return { revision: read.revision, evidence: (run.evidence ?? []).filter(keep), lateEvidence: run.lateEvidence.filter(keep) };
      }),

    // Agent-facing commands (Stage R3.4). Order: unbound, then runToken (run_stale), then the role
    // (card §5.2 "Run tool authority matrix"), then readiness.
    next: (open, x, caller) =>
      toResult(async () => {
        requireBound(caller);
        const read = await readOk(await open(x.projectId));
        const run = liveRun(read.data, x.runId, x.runToken);
        const feature = findFeature(read.data, run.featureId);
        if (roleOf(feature, caller) !== "coordinator") {
          throw new DomainError("invalid_input", "only the feature's coordinator asks for the next tasks", { reason: "not_coordinator", featureId: feature.id });
        }
        const view = await viewOf(x.projectId, read.data, run, (await deps.settings()).repairCeiling);
        return { revision: read.revision, ready: view.ready, blocked: view.blocked };
      }),

    claim: (open, x, caller) =>
      toResult(async () => {
        const me = requireBound(caller);
        const store = await open(x.projectId);
        const read = await readOk(store);
        const pre = liveRun(read.data, x.runId, x.runToken);
        const feature = findFeature(read.data, pre.featureId);
        const role = roleOf(feature, caller);
        if (role === "foreign") throw new DomainError("invalid_input", "only the feature's coordinator or its crew claims tasks", { reason: "not_crew", featureId: feature.id });
        if (role === "crew" && x.agentId !== undefined && x.agentId !== me) {
          throw new DomainError("invalid_input", "a crew member claims only for itself", { reason: "crew_self_claim_only", featureId: feature.id });
        }
        const assignee = x.agentId ?? me;
        const plan = read.data.plans.find((p) => p.id === pre.planId);
        const current = plan !== undefined && (await approvedCurrent(x.projectId, read.data, plan, pre.planRev));
        const ceiling = (await deps.settings()).repairCeiling;
        const at = now().toISOString();
        const out = await store.transact(read.revision, (draft) => {
          const run = liveRun(draft, x.runId, x.runToken);
          const task = run.tasks.find((t) => t.taskId === x.taskId);
          if (!task) throw new DomainError("not_found", `task ${x.taskId} not found in the run`, { taskId: x.taskId });
          if (task.state !== "todo" && task.agentId !== undefined) throw notReady([{ code: "task_claimed", taskId: task.taskId }]);
          const p = draft.plans.find((y) => y.id === run.planId);
          if (!p) throw new DomainError("not_found", `plan ${run.planId} not found`, { planId: run.planId });
          const delegation = authorisingDelegation(draft, run);
          const { ready, blocked } = readyTasks({
            feature: findFeature(draft, run.featureId),
            features: draft.features,
            run,
            plan: p,
            approvedCurrent: current,
            ceiling,
            ...(delegation ? { delegation } : {}),
          });
          if (!ready.includes(task.taskId)) throw notReady(blocked.filter((b) => b.taskId === undefined || b.taskId === task.taskId));
          task.state = "claimed";
          task.agentId = assignee;
          run.events.push({ at, kind: "claimed", taskId: task.taskId, detail: assignee });
        });
        return { revision: out.revision };
      }),

    progress: (open, x, caller) =>
      toResult(async () => {
        const me = requireBound(caller);
        const store = await open(x.projectId);
        const read = await readOk(store);
        const pre = liveRun(read.data, x.runId, x.runToken);
        const feature = findFeature(read.data, pre.featureId);
        const preTask = pre.tasks.find((t) => t.taskId === x.taskId);
        if (!preTask) throw new DomainError("not_found", `task ${x.taskId} not found in the run`, { taskId: x.taskId });
        if (preTask.agentId !== me && roleOf(feature, caller) !== "coordinator") throw notTaskAgent(preTask.taskId);
        if (pre.state !== "running") throw notReady([{ code: "run_not_running" }]);
        // "done" needs the server-read worktree identity to bind a cycle; it never verifies.
        let worktree: WorktreeIdentity | undefined;
        if (x.state === "done") {
          const identity = deps.identity ? await deps.identity({ projectId: x.projectId, run: pre, feature }) : null;
          if (identity === null || "notReady" in identity) {
            throw new DomainError("invalid_input", "the worktree identity cannot be read; resolve it and report done again");
          }
          worktree = identity;
        }
        const at = now().toISOString();
        const out = await store.transact(read.revision, (draft) => {
          const run = liveRun(draft, x.runId, x.runToken);
          const task = run.tasks.find((t) => t.taskId === x.taskId)!;
          if (task.state === "claimed") {
            task.state = "in_progress";
            run.events.push({ at, kind: "progress", taskId: task.taskId, detail: "in_progress" });
          } else if (task.state !== "in_progress" && !(x.state === "done" && task.state === "review_pending")) {
            throw new DomainError("invalid_input", `progress is reported only for a claimed or in-progress task`, { state: task.state });
          }
          return task.state;
        });
        if (x.state === "in_progress" || worktree === undefined) return { revision: out.revision, state: out.result };
        const revision = read.data.plans.find((p) => p.id === pre.planId)?.revisions.find((r) => r.rev === pre.planRev);
        if (!revision) throw new DomainError("not_found", `revision ${pre.planRev} not found`);
        const binding: ResultBinding = { taskId: x.taskId, planId: pre.planId, planRev: pre.planRev, contentHash: revision.contentHash, runToken: pre.runToken, worktree };
        const ref = { projectId: x.projectId, runId: x.runId, runToken: x.runToken, taskId: x.taskId };
        const begun = await begin(open, { ...ref, binding });
        deps.runners?.start({ ...ref, cycleId: begun.cycleId, binding });
        return { revision: begun.revision, state: "checks_pending" as const };
      }),

    ack: (open, x, caller) =>
      toResult(async () => {
        const me = requireBound(caller);
        const store = await open(x.projectId);
        const read = await readOk(store);
        const pre = liveRun(read.data, x.runId, x.runToken);
        const preTask = pre.tasks.find((t) => t.taskId === x.taskId);
        if (!preTask) throw new DomainError("not_found", `task ${x.taskId} not found in the run`, { taskId: x.taskId });
        // Self only: the coordinator never acks on a worker's behalf.
        if (preTask.agentId !== me) throw notTaskAgent(preTask.taskId);
        const acked = (run: ExecutionRun) => run.acks.some((a) => a.taskId === x.taskId && a.agentId === me && (run.pausedAt === undefined || a.at >= run.pausedAt));
        if (acked(pre)) return { revision: read.revision };
        const at = now().toISOString();
        const out = await store.transact(read.revision, (draft) => {
          const run = liveRun(draft, x.runId, x.runToken);
          if (!acked(run)) run.acks.push({ taskId: x.taskId, agentId: me, at });
        });
        return { revision: out.revision };
      }),

    bindChat: (open, x, caller) =>
      toResult(async () => {
        const me = requireBound(caller);
        const store = await open(x.projectId);
        const read = await readOk(store);
        const bound = findFeature(read.data, x.featureId).coordinator;
        if (bound?.agentId === me) return { revision: read.revision };
        if (bound !== undefined) throw new DomainError("invalid_input", "another coordinator is bound to this feature", { featureId: x.featureId });
        const at = now().toISOString();
        const out = await store.transact(read.revision, (draft) => {
          const f = findFeature(draft, x.featureId);
          if (f.coordinator !== undefined) throw new DomainError("invalid_input", "another coordinator is bound to this feature", { featureId: f.id });
          const workspaceId = typeof caller.workspaceId === "string" && caller.workspaceId !== "" ? caller.workspaceId : NO_WORKSPACE;
          f.coordinator = { agentId: me, workspaceId, boundAt: at, profileRef: "bound-chat" };
          f.events.push({ at, actor: { kind: "agent", agentId: me }, kind: "coordinator", to: me });
          // Stage R4.3: a queued replacement request is delivered to the newly bound chat.
          if (f.replacementRequested?.state !== "queued") return false;
          f.replacementRequested = { ...f.replacementRequested, state: "requested" };
          f.events.push({ at, actor: { kind: "agent", agentId: me }, kind: "note", reason: "replacement requested on bind of this chat as coordinator" });
          return true;
        });
        if (out.result) await afterReplacementRequest({ paseo: () => deps.paseo?.() ?? null, open, log }, { projectId: x.projectId, featureId: x.featureId, agentId: me, actor: { kind: "agent", agentId: me } });
        return { revision: out.revision };
      }),

    startDelegated: (open, x, caller, paseo) =>
      toResult(async () => {
        const me = requireBound(caller);
        if (x.scope === "feature" && x.featureId === undefined) throw new DomainError("invalid_input", "a feature-scoped delegation names its featureId");
        if (x.scope === "roadmap" && x.featureId !== undefined) throw new DomainError("invalid_input", "a roadmap-scoped delegation names no featureId");
        const provenance = paseo ? await verifyUserMessage(paseo, me, x.quoted) : null;
        if (!provenance) throw new DomainError("delegation_unverified", "the quoted exact words were not found in a user message of this chat");
        const store = await open(x.projectId);
        const read = await readOk(store);
        if (x.featureId !== undefined) findFeature(read.data, x.featureId);
        const delegationId = newId();
        const at = now().toISOString();
        const recorded = await store.transact(read.revision, (draft) => {
          recordDelegation(draft, { id: delegationId, scope: x.scope, ...(x.featureId !== undefined ? { featureId: x.featureId } : {}), provenance, at });
          return delegatedStarts(draft).filter((id) => x.scope === "roadmap" || id === x.featureId);
        });
        const { started, skipped } = await startCandidates(open, store, x.projectId, recorded.result, { kind: "agent", agentId: me }, paseo, delegationId);
        const v = await store.version();
        return { revision: v.revision ?? recorded.revision, delegationId, started, skipped };
      }),

    sweep: (open, x) =>
      toResult(async () => {
        const store = await open(x.projectId);
        const read = await readOk(store);
        const resumed: string[] = [];
        // (a) Dependents waiting for a prerequisite resume once every prerequisite is done.
        for (const run of read.data.runs) {
          if (run.state !== "paused" || run.pauseReason !== "prerequisite_not_done") continue;
          const feature = findFeature(read.data, run.featureId);
          if (!prerequisitesDone(feature, read.data.features)) continue;
          if (await sweepResume(store, x.projectId, run.id)) resumed.push(run.id);
        }
        // (b) Delegated candidates.
        const fresh = await readOk(store);
        const candidates = delegatedStarts(fresh.data);
        const started: string[] = [];
        for (const featureId of candidates) {
          const d = coveringDelegation(fresh.data, featureId);
          if (!d) continue;
          const out = await startCandidates(open, store, x.projectId, [featureId], { kind: "agent", agentId: d.provenance.agentId }, deps.paseo?.() ?? null);
          started.push(...out.started);
        }
        const v = await store.version();
        return { revision: v.revision ?? read.revision, resumed, started };
      }),

    replaceCoordinator: (open, i, origin) =>
      toResult(async () => {
        uiOnly(origin, "Replacing a coordinator");
        return replaceCoordinator(open, i);
      }),
  };
  return commands;

  /** Refuses (invalid_input, no write) unless the reader confirms `expected` is the worktree's current identity. */
  async function requireCurrentIdentity(projectId: string, data: RoadmapData, run: ExecutionRun, expected: WorktreeIdentity): Promise<void> {
    const current = deps.identity ? await deps.identity({ projectId, run, feature: findFeature(data, run.featureId) }) : null;
    if (current === null || "notReady" in current || !sameIdentity(current, expected)) {
      throw new DomainError("invalid_input", "the worktree changed or cannot be read; run the checks again");
    }
  }
}

/** Paths left out of every worktree identity (card §4.2a; no evidence directory setting exists). */
export const EXCLUDED = [".decisions"];

export type Runners = {
  /** Fire and forget: resolve the worktree, run checks, then review, then record (card §6.2a). */
  start(x: VerificationRef & { cycleId: string; binding: ResultBinding }): void;
  /** Aborts every active cycle of the run; no forced agent interrupt. */
  cancel(runId: string): void;
  /** Aborts everything and resolves once every in-flight cycle has settled. */
  dispose(): Promise<void>;
};

/**
 * Server-owned runner orchestration (Stage R3.5). One AbortController per active cycle. Errors are
 * visible and never counted as failed cycles: an unresolvable worktree, a thrown runner or an abort
 * records `failure` (retired as `runner_error`). A record that itself fails is logged, not retried.
 */
export function createRunners(deps: {
  port: ProcessPort;
  paseo: () => PaseoApi | null;
  settings: () => Promise<RoadmapSettings>;
  open: StoreOpener;
  record: RunCommands["recordVerification"];
  log: (m: string, e?: unknown) => void;
  now?: () => Date;
  newId?: () => string;
}): Runners {
  const active = new Map<string, Map<string, AbortController>>();
  const inflight = new Set<Promise<void>>();
  const clock = { ...(deps.now ? { now: deps.now } : {}), ...(deps.newId ? { newId: deps.newId } : {}) };
  const message = (e: unknown) => (e instanceof Error ? e.message : "runner failed");

  async function cycle(x: VerificationRef & { cycleId: string; binding: ResultBinding }, signal: AbortSignal): Promise<void> {
    let checks: CheckOutcome = { result: "fail", evidence: [], late: [] };
    let review: ReviewOutcome | undefined;
    let failure: string | undefined;
    try {
      const read = await (await deps.open(x.projectId)).read();
      if (read.status !== "ok") throw new Error("the roadmap store cannot be read");
      const run = read.data.runs.find((r) => r.id === x.runId);
      const feature = run ? read.data.features.find((f) => f.id === run.featureId) : undefined;
      const revision = run ? read.data.plans.find((p) => p.id === run.planId)?.revisions.find((r) => r.rev === run.planRev) : undefined;
      const def = revision !== undefined && isV2Revision(revision) ? revision.tasks.find((t) => t.id === x.taskId) : undefined;
      if (!run || !feature || !def) throw new Error("the run, feature or task is gone");
      const paseo = feature.coordinator?.workspaceId === NO_WORKSPACE ? null : deps.paseo();
      const worktree = paseo ? await coordinatorWorktree(paseo, feature) : null;
      if (worktree === null) throw new Error("the coordinator worktree cannot be resolved");
      const s = await deps.settings();
      const items = parseDod(def.dod).items;
      const checkItems = items.flatMap((i) => (i.kind === "check" && i.command !== undefined ? [{ index: i.index, command: i.command }] : []));
      checks = await runChecks(deps.port, { ...clock, worktree, binding: x.binding, items: checkItems, excluded: EXCLUDED, timeoutMs: s.checkTimeoutMs, maxBuffer: s.maxBuffer, signal });
      if (signal.aborted) throw new Error("cancelled");
      // The review runs only after passing checks with nothing late.
      if (checks.result === "pass" && checks.late.length === 0) {
        review = await runReview(deps.port, {
          ...clock,
          command: s.reviewCommand,
          worktree,
          request: { binding: x.binding, dod: { items }, taskTitle: def.title, taskDescription: def.description },
          excluded: EXCLUDED,
          timeoutMs: s.reviewTimeoutMs,
          maxBuffer: s.maxBuffer,
          signal,
        });
        if (signal.aborted) throw new Error("cancelled");
      }
    } catch (e) {
      failure = message(e);
    }
    try {
      const out = await deps.record(deps.open, {
        ...x,
        checks: failure !== undefined ? { result: "fail", evidence: [], late: [] } : checks,
        ...(failure === undefined && review ? { review } : {}),
        ...(failure !== undefined ? { failure } : {}),
      });
      if (!out.ok) deps.log(`verification record refused: ${out.error.code}`);
    } catch (e) {
      deps.log(`verification record failed: ${message(e)}`);
    }
  }

  return {
    start(x) {
      const perRun = active.get(x.runId) ?? new Map<string, AbortController>();
      active.set(x.runId, perRun);
      perRun.get(x.taskId)?.abort();
      const controller = new AbortController();
      perRun.set(x.taskId, controller);
      const p = cycle(x, controller.signal).finally(() => {
        if (perRun.get(x.taskId) === controller) perRun.delete(x.taskId);
        if (perRun.size === 0 && active.get(x.runId) === perRun) active.delete(x.runId);
        inflight.delete(p);
      });
      inflight.add(p);
    },
    cancel(runId) {
      for (const controller of active.get(runId)?.values() ?? []) controller.abort();
    },
    async dispose() {
      for (const perRun of active.values()) for (const controller of perRun.values()) controller.abort();
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}

const STOP_TEXT =
  "The decision roadmap ended this run because the feature was cancelled or its plan was sent for rework. " +
  "Stop all work on its tasks and do not claim or report progress for it.";

/**
 * After a committed status or rework effect (card §6.2a): cancel the run's runners first, then one
 * steer to the coordinator: the pause request for a paused run, an accurate stop text (no ack, no
 * resume, no token) for an ended one. A failed steer, including a missing host context, leaves one
 * durable feature note with the cause; the run is never changed and nothing is retried.
 */
export async function afterRunEffect(
  deps: { paseo: () => PaseoApi | null; open: StoreOpener; runners: Pick<Runners, "cancel">; log: (m: string) => void; now?: () => Date },
  x: { projectId: string; runId: string },
): Promise<void> {
  deps.runners.cancel(x.runId);
  let store: Store;
  try {
    store = await deps.open(x.projectId);
  } catch (e) {
    deps.log(`run effect steer failed: store unavailable (${e instanceof Error ? e.name : "error"}); delivery unknown`);
    return;
  }
  const read = await store.read().catch(() => null);
  if (!read || read.status !== "ok") {
    deps.log("run effect steer failed: store unreadable; delivery unknown");
    return;
  }
  const run = read.data.runs.find((r) => r.id === x.runId);
  const feature = run ? read.data.features.find((f) => f.id === run.featureId) : undefined;
  const coordinator = feature?.coordinator;
  if (!run || !feature || !coordinator) return;
  const ended = run.state === "ended";
  let cause: string | undefined;
  const paseo = deps.paseo();
  if (!paseo) cause = "the Paseo host context is not available";
  else {
    try {
      await paseo.agents.ref(coordinator.agentId).send(ended ? STOP_TEXT : PAUSE_TEXT, { activeTurnBehavior: "steer" });
    } catch (e) {
      cause = e instanceof Error ? e.message : "send failed";
    }
  }
  if (cause === undefined) return;
  deps.log(`run effect steer failed: ${cause}`);
  const reason = `${ended ? "stop" : "pause"} request not delivered to the coordinator: ${cause}`;
  // A durable note only (bounded conflict retry); the run itself is never touched.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const v = await store.version();
      if (v.revision === null) break;
      await store.transact(v.revision, (draft) => {
        draft.features.find((f) => f.id === feature.id)?.events.push({ at: (deps.now?.() ?? new Date()).toISOString(), actor: { kind: "human" }, kind: "note", reason });
      });
      return;
    } catch (e) {
      if (isDomainError(e, "revision_conflict")) continue;
      deps.log(`run effect note failed: ${e instanceof Error ? e.name : "error"}`);
      return;
    }
  }
  deps.log("run effect note failed: revision conflicts");
}

// ---- Stage R4.3: a cancelled prerequisite (card §4) ----

/** Effects of a cancelled prerequisite, delivered once each after the commit (never from the transaction). */
export type DependencyEffect = { kind: "run"; runId: string } | { kind: "replacement"; featureId: string; agentId: string };

/**
 * Applies a cancelled prerequisite inside the causing human cancel transaction. A direct dependent
 * (not done or cancelled) always has its live run ended `cancelled_for_rework`; `reworkInDraft` is
 * attempted with its pre-read receipt and reworks the plan only when it accepts (it refuses, for
 * example, a missing or mismatched receipt or an already reworked revision); otherwise the plan is
 * not reworked and an active feature returns to created. It gets a replacement request (requested
 * when bound, queued otherwise). Transitive dependents are only paused, with
 * their tasks kept; one without a live run gets an "execution waits" note.
 */
export function applyPrerequisiteCancelled(
  draft: RoadmapData,
  x: { projectId: string; cancelledId: string; at: string; actor: FeatureCreator; receipts: ReceiptMap },
): DependencyEffect[] {
  const effects: DependencyEffect[] = [];
  const cancelled = findFeature(draft, x.cancelledId);
  const open = (f: Feature) => f.status !== "done" && f.status !== "cancelled";
  const liveOf = (featureId: string) => draft.runs.find((r) => r.featureId === featureId && LIVE(r));
  /** Pauses a running run (or relabels a prerequisite wait) for the cancelled prerequisite; owner and deferred pauses are kept. */
  const holdRun = (run: ExecutionRun): boolean => {
    if (run.state === "running") {
      retireOpenCycles(run, x.at);
      run.state = "paused";
      run.pauseReason = "prerequisite_cancelled";
      run.pausedAt = x.at;
      run.events.push({ at: x.at, kind: "paused", detail: "prerequisite_cancelled" });
      return true;
    }
    if (run.pauseReason === "prerequisite_not_done") {
      run.pauseReason = "prerequisite_cancelled";
      run.events.push({ at: x.at, kind: "paused", detail: "prerequisite_cancelled" });
    }
    return false;
  };

  const direct = draft.features.filter((f) => f.dependsOn.includes(cancelled.id) && open(f));
  const seen = new Set<string>([cancelled.id, ...direct.map((f) => f.id)]);
  for (const b of direct) {
    const bound = draft.plans.filter((p) => p.featureId === b.id);
    const latest = bound.length === 1 ? bound[0].revisions.at(-1) : undefined;
    const planId = bound.length === 1 ? bound[0].id : undefined;
    const rework =
      planId !== undefined && latest !== undefined
        ? reworkInDraft(draft, {
            projectId: x.projectId,
            planId,
            planRev: latest.rev,
            receipt: x.receipts.get(receiptKey(planId, latest.rev)) ?? null,
            reason: "prerequisite cancelled",
            at: x.at,
            actor: x.actor,
            allowDeferred: true,
          })
        : undefined;
    const reworked = rework?.reworked === true;
    // A refused rework records the cause reworkInDraft computed; the receipt wording is for the
    // receipt refusal only.
    const receiptRefused = rework?.reworked === false && rework.why === "no matching approval receipt";
    const why = receiptRefused
      ? "approval receipt missing or mismatched"
      : rework === undefined
        ? bound.length === 0
          ? "no plan is bound to the feature"
          : bound.length === 1
            ? "the bound plan has no revisions"
            : "the feature has more than one plan"
        : rework.reworked ? undefined : rework.why;
    // Design §3.4/§3.6 (Fable ruling): the direct dependent's live run always ends, whatever its pause.
    const run = liveOf(b.id);
    if (run) {
      if (run.state === "running") {
        retireOpenCycles(run, x.at);
        run.state = "paused";
        run.pauseReason = "prerequisite_cancelled";
        run.pausedAt = x.at;
        run.events.push({ at: x.at, kind: "paused", detail: "prerequisite_cancelled" });
      }
      retireOpenCycles(run, x.at);
      run.state = "ended";
      run.endReason = "cancelled_for_rework";
      run.endedAt = x.at;
      delete run.pauseReason;
      run.events.push({ at: x.at, kind: "ended", detail: why === undefined ? "cancelled_for_rework" : `cancelled_for_rework: ${why}` });
      effects.push({ kind: "run", runId: run.id });
    }
    if (!reworked) {
      // No rework record (refused, or no single bound plan), but the feature no longer has an executable plan.
      const active = (s: string | undefined) => s === "planned" || s === "executing";
      if (active(b.status)) {
        const from = b.status;
        b.status = "created";
        b.statusReason = "prerequisite cancelled";
        b.events.push({ at: x.at, actor: x.actor, kind: "status", from, to: "created", reason: "prerequisite cancelled" });
      } else if (b.status === "deferred" && active(b.statusBeforeDefer)) {
        b.statusBeforeDefer = "created";
      }
      if (planId !== undefined) {
        const reason = receiptRefused
          ? `prerequisite ${cancelled.title} cancelled; approval receipt missing or mismatched, so the plan was not reworked`
          : `prerequisite ${cancelled.title} cancelled; the plan was not reworked: ${why}`;
        b.events.push({ at: x.at, actor: x.actor, kind: "note", reason });
      }
    }
    b.replacementRequested = {
      at: x.at,
      becauseOf: cancelled.id,
      state: b.coordinator ? "requested" : "queued",
      // A cancellation that reworked nothing keeps the revision an earlier cancellation reworked, so the
      // approval of its replacement still clears this request.
      ...(reworked && latest
        ? { reworkedRev: latest.rev }
        : b.replacementRequested?.reworkedRev !== undefined
          ? { reworkedRev: b.replacementRequested.reworkedRev }
          : {}),
    };
    if (b.coordinator) effects.push({ kind: "replacement", featureId: b.id, agentId: b.coordinator.agentId });
  }

  // Transitive dependents: paused only; their replacement is requested after the direct one is approved.
  const queue = [...direct];
  while (queue.length > 0) {
    const n = queue.shift()!;
    for (const c of draft.features) {
      if (seen.has(c.id) || !c.dependsOn.includes(n.id) || !open(c)) continue;
      seen.add(c.id);
      queue.push(c);
      const run = liveOf(c.id);
      if (run) {
        if (holdRun(run)) effects.push({ kind: "run", runId: run.id });
      } else {
        c.events.push({ at: x.at, actor: x.actor, kind: "note", reason: `prerequisite ${cancelled.title} cancelled; execution waits` });
      }
    }
  }
  return effects;
}

/**
 * After a committed replacement request: one steer asking the bound coordinator for a replacement
 * plan draft. A failure (or no host context) leaves one feature note, attributed to the actor that
 * raised the request; nothing is retried.
 */
export async function afterReplacementRequest(
  deps: { paseo: () => PaseoApi | null; open: StoreOpener; log: (m: string) => void; now?: () => Date },
  x: { projectId: string; featureId: string; agentId: string; actor: FeatureCreator },
): Promise<void> {
  let store: Store;
  try {
    store = await deps.open(x.projectId);
  } catch (e) {
    deps.log(`replacement request steer failed: store unavailable (${e instanceof Error ? e.name : "error"})`);
    return;
  }
  const read = await store.read().catch(() => null);
  if (!read || read.status !== "ok") return deps.log("replacement request steer failed: store unreadable");
  const feature = read.data.features.find((f) => f.id === x.featureId);
  if (!feature) return;
  const cause = feature.replacementRequested ? read.data.features.find((f) => f.id === feature.replacementRequested!.becauseOf) : undefined;
  let error: string | undefined;
  const paseo = deps.paseo();
  if (!paseo) error = "the Paseo host context is not available";
  else {
    try {
      await paseo.agents
        .ref(x.agentId)
        .send(replacementPrompt({ featureTitle: feature.title, featureId: feature.id, becauseOfTitle: cause?.title ?? feature.replacementRequested?.becauseOf ?? "a prerequisite" }), {
          activeTurnBehavior: "steer",
        });
    } catch (e) {
      error = e instanceof Error ? e.message : "send failed";
    }
  }
  if (error === undefined) return;
  deps.log(`replacement request steer failed: ${error}`);
  const reason = `replacement request not delivered to the coordinator: ${error}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const v = await store.version();
      if (v.revision === null) return;
      await store.transact(v.revision, (draft) => {
        draft.features.find((f) => f.id === x.featureId)?.events.push({ at: (deps.now?.() ?? new Date()).toISOString(), actor: x.actor, kind: "note", reason });
      });
      return;
    } catch (e) {
      if (isDomainError(e, "revision_conflict")) continue;
      deps.log(`replacement request note failed: ${e instanceof Error ? e.name : "error"}`);
      return;
    }
  }
}

/** UI wrapper: a live opener per call and the UI origin, as the plan service does. */
export function createRunService(deps: RunDeps): RunService {
  const commands = createRunCommands(deps);
  const opener =
    (paseo: PaseoApi): StoreOpener =>
    (projectId) =>
      openProjectStore(deps.directory(paseo), projectId, deps.storeOptions);
  return {
    start: (paseo, i) => commands.start(opener(paseo), i, UI_ORIGIN),
    pause: (paseo, i) => commands.pause(opener(paseo), i, UI_ORIGIN),
    resume: (paseo, i) => commands.resume(opener(paseo), i, UI_ORIGIN),
    budgetGrant: (paseo, i) => commands.budgetGrant(opener(paseo), i, UI_ORIGIN),
    revokeDelegation: (paseo, i) => commands.revokeDelegation(opener(paseo), i, UI_ORIGIN),
    get: (paseo, i) => commands.get(opener(paseo), i),
    list: (paseo, i) => commands.list(opener(paseo), i),
    accept: (paseo, i) => commands.accept(opener(paseo), i, UI_ORIGIN),
    replaceCoordinator: (paseo, i) => commands.replaceCoordinator(opener(paseo), i, UI_ORIGIN),
    evidenceList: (paseo, i) => commands.evidenceList(opener(paseo), i),
  };
}
