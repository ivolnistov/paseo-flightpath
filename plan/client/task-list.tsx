// The feature's task rows (Stage R4.2), pure: the bound plan's latest revision with each task's run
// state. Labels are truthful: failed verification cycles are TaskRun.failedCycles (never reset),
// the granted extra cycles are `extraBudget`, and readiness is exactly run.get's `ready`. The list
// itself renders in client/feature-screen.tsx.
import type { PlanRevisionV2, TaskRunState } from "../shared/model";
import type { RunGetValue } from "./hooks";

export type TaskRow = {
  taskId: string;
  title: string;
  state: TaskRunState | "todo";
  dependsOn: string[];
  parallel: boolean;
  /** Failed verification cycles (TaskRun.failedCycles; never reset). */
  failedCycles: number;
  /** Extra cycles granted at the repair ceiling. */
  extraBudget: number;
  /** Exactly `state === "ceiling"`: the only state that accepts a budget grant. */
  atCeiling: boolean;
  unresolvedCount: number;
  agentId?: string;
  /** Exactly run.get's `ready`. */
  ready: boolean;
};

export function taskRows(x: { revision: PlanRevisionV2; run: RunGetValue | null }): TaskRow[] {
  const byId = new Map((x.run?.run.tasks ?? []).map((t) => [t.taskId, t] as const));
  const ready = new Set(x.run?.ready ?? []);
  return x.revision.tasks.map((task) => {
    const run = byId.get(task.id);
    return {
      taskId: task.id,
      title: task.title,
      state: run?.state ?? "todo",
      dependsOn: [...task.dependsOn],
      parallel: task.parallel,
      failedCycles: run?.failedCycles ?? 0,
      extraBudget: run?.extraBudget ?? 0,
      atCeiling: run?.state === "ceiling",
      unresolvedCount: run?.unresolved.length ?? 0,
      ...(run?.agentId !== undefined ? { agentId: run.agentId } : {}),
      ready: ready.has(task.id),
    };
  });
}

export const STATE_LABEL: Record<TaskRow["state"], string> = {
  todo: "To do",
  claimed: "Claimed",
  in_progress: "In progress",
  checks_pending: "Checks running",
  review_pending: "Review pending",
  awaiting_acceptance: "Awaiting acceptance",
  verified: "Verified",
  ceiling: "At repair ceiling",
  cancelled: "Cancelled",
};

/** Whole cycles 1..1000, the server's `run.budget.grant` bound; anything else is not offered. */
export function parseCycles(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
}
