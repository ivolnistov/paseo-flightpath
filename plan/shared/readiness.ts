// Pure task readiness (Stage R3.1, design §3.3). A task is dispatchable only when every
// precondition holds; approval alone never makes a task ready. No IO.
import type { ExecutionRun, Feature, Plan, StartDelegation, TaskRun, TaskRunState } from "./model";
import { isV2Revision } from "./model";

export type NotReadyCode =
  | "feature_not_executing"
  | "run_not_running"
  | "start_unauthorised"
  | "approval_not_current"
  | "prerequisite_not_done"
  | "dependency_not_verified"
  | "parallel_not_granted"
  | "ceiling"
  | "not_todo"
  | "coordinator_unavailable"
  | "task_claimed"
  | "pause_unacknowledged";
export type NotReady = { code: NotReadyCode; taskId?: string };

export type ReadinessInput = {
  feature: Feature;
  features: Feature[];
  run: ExecutionRun;
  plan: Plan;
  /** The run's revision is the plan's latest, approved by a verified receipt, current and not reworked. */
  approvedCurrent: boolean;
  /**
   * The current delegation covering the run's feature (`coveringDelegation`), if any. A delegated
   * run is authorised by any unrevoked covering delegation, not only the one that started it
   * (Stage R4.4, Fable ruling 2026-10-30); `run.startAuth` stays the historical record.
   */
  delegation?: StartDelegation;
  ceiling: number;
};

const ACTIVE: ReadonlySet<TaskRunState> = new Set<TaskRunState>(["claimed", "in_progress", "checks_pending", "review_pending"]);

export const ceilingReached = (t: TaskRun, ceiling: number): boolean => t.failedCycles >= ceiling + t.extraBudget;

/** Every feature this one depends on is done (an unknown prerequisite is not done). */
export function prerequisitesDone(feature: Feature, features: Feature[]): boolean {
  return feature.dependsOn.every((id) => features.find((f) => f.id === id)?.status === "done");
}

/** Whether the run's start authorisation is present: the UI, or any unrevoked delegation covering the feature. */
function startAuthorised(run: ExecutionRun, featureId: string, delegation: StartDelegation | undefined): boolean {
  if (run.startAuth.kind === "ui") return true;
  if (!delegation || delegation.revokedAt !== undefined) return false;
  return delegation.scope === "roadmap" || delegation.featureId === featureId;
}

/** Run-level preconditions (no task data). Without a run only the feature-level checks apply. */
export function runBlockers(x: Omit<ReadinessInput, "run"> & { run?: ExecutionRun }): NotReady[] {
  const out: NotReady[] = [];
  if (x.feature.status !== "executing") out.push({ code: "feature_not_executing" });
  if (x.run !== undefined) {
    if (x.run.state !== "running") out.push({ code: "run_not_running" });
    if (!startAuthorised(x.run, x.feature.id, x.delegation)) out.push({ code: "start_unauthorised" });
  }
  if (!x.approvedCurrent) out.push({ code: "approval_not_current" });
  if (!prerequisitesDone(x.feature, x.features)) out.push({ code: "prerequisite_not_done" });
  return out;
}

/** Ready task ids and the reasons the others are not ready (run-level reasons block every task). */
export function readyTasks(x: ReadinessInput): { ready: string[]; blocked: NotReady[] } {
  const run = runBlockers(x);
  if (run.length > 0) return { ready: [], blocked: run };
  const revision = x.plan.revisions.find((r) => r.rev === x.run.planRev);
  const tasks = revision !== undefined && isV2Revision(revision) ? revision.tasks : [];
  const stateOf = new Map(x.run.tasks.map((t) => [t.taskId, t] as const));
  const anyActive = x.run.tasks.some((t) => ACTIVE.has(t.state));
  const ready: string[] = [];
  const blocked: NotReady[] = [];
  for (const task of tasks) {
    const tr = stateOf.get(task.id);
    if (!tr || tr.state !== "todo") {
      blocked.push({ code: "not_todo", taskId: task.id });
      continue;
    }
    if (ceilingReached(tr, x.ceiling)) {
      blocked.push({ code: "ceiling", taskId: task.id });
      continue;
    }
    if (task.dependsOn.some((dep) => stateOf.get(dep)?.state !== "verified")) {
      blocked.push({ code: "dependency_not_verified", taskId: task.id });
      continue;
    }
    if (anyActive && !task.parallel) {
      blocked.push({ code: "parallel_not_granted", taskId: task.id });
      continue;
    }
    ready.push(task.id);
  }
  return { ready, blocked };
}
