// Run controls (Stage R4.2): which run actions the feature screen offers, and why one is disabled.
// Pure: approval truth comes from plan.get and run truth from the latest run.get. No control
// interrupts or cancels an agent; Defer and Cancel stay the existing feature actions.
import type { Feature } from "../shared/model";
import type { RunGetValue } from "./hooks";

export type RunControl = "start" | "openChat" | "pause" | "resume" | "stopAndRework" | "defer" | "cancel" | "replaceCoordinator" | "grantBudget" | "accept";
export type RunControlState = { control: RunControl; enabled: boolean; reason?: string; taskId?: string };

const ACTIVE = new Set(["planned", "executing"]);
const UNKNOWN = "the run state is not known yet";
const PLAN_UNKNOWN = "the plan is not known yet";
const SEVERAL_PLANS = "several plans are bound to this feature";
const awaitingAck = (run: RunGetValue) => (run.unresolved ?? []).some((line) => line.startsWith("awaiting ack:"));

export function runControls(x: {
  feature: Feature;
  /** The live run from run.get (never a list summary); null when there is none. */
  run: RunGetValue | null;
  /** plan.get: the latest revision's approval is current. */
  approvalCurrent: boolean;
  /** plan.get: the latest revision has a verified receipt (the rework precondition). */
  approvedLatest: boolean;
  /** False while the run reads have not answered: an unknown run is never treated as no run. */
  runKnown?: boolean;
  /** False while plan.get has not answered: an unknown approval is never treated as not current. */
  planKnown?: boolean;
  /** More than one plan is bound: no unique plan, so no approval verdict and no plan-dependent action. */
  severalPlans?: boolean;
}): RunControlState[] {
  const { feature, approvalCurrent, approvedLatest } = x;
  const runKnown = x.runKnown ?? true;
  const planKnown = x.planKnown ?? true;
  const severalPlans = x.severalPlans ?? false;
  const run = x.run && x.run.run.state !== "ended" ? x.run : null;
  const state = run?.run.state;
  const active = ACTIVE.has(feature.status);
  const out: RunControlState[] = [];
  const add = (control: RunControl, enabled: boolean, reason?: string, taskId?: string) =>
    out.push({ control, enabled, ...(enabled || reason === undefined ? {} : { reason }), ...(taskId !== undefined ? { taskId } : {}) });
  // The server refuses run.resume for any run-level blocker other than the pause itself.
  const resumeBlocker = run?.blocked.find((b) => b.taskId === undefined && b.code !== "run_not_running")?.code;

  add(
    "start",
    runKnown && !severalPlans && planKnown && active && approvalCurrent && !run,
    !runKnown
      ? UNKNOWN
      : run
        ? "a run is already live"
        : !active
          ? "the feature is not planned"
          : severalPlans
            ? SEVERAL_PLANS
            : !planKnown
              ? PLAN_UNKNOWN
              : !approvalCurrent
                ? "the approval is not current"
                : undefined,
  );
  add("openChat", feature.coordinator !== undefined, "no coordinator chat yet");
  add("pause", state === "running", "the run is not running");
  add("resume", state === "paused" && resumeBlocker === undefined, state !== "paused" ? "the run is not paused" : resumeBlocker?.replace(/_/g, " "));
  add(
    "stopAndRework",
    !severalPlans && planKnown && approvedLatest && active,
    severalPlans
      ? SEVERAL_PLANS
      : !planKnown
        ? PLAN_UNKNOWN
        : !approvedLatest
          ? "the latest revision is not approved"
          : "the feature is not planned or executing",
  );
  if (feature.coordinator === undefined) add("replaceCoordinator", false, "no coordinator to replace");
  else if (!runKnown) add("replaceCoordinator", false, UNKNOWN);
  else if (!run) add("replaceCoordinator", true);
  else if (state === "running") add("replaceCoordinator", false, "pause the run first");
  else if (awaitingAck(run)) add("replaceCoordinator", false, "waiting for acknowledgements");
  else add("replaceCoordinator", true);
  for (const task of run?.run.tasks ?? []) {
    add("grantBudget", task.state === "ceiling", "the task is not at its repair ceiling", task.taskId);
    add("accept", task.state === "awaiting_acceptance", "the task is not awaiting acceptance", task.taskId);
  }
  return out;
}

/** The enabled state of one control (per task when `taskId` is given). */
export function controlOf(controls: RunControlState[], control: RunControl, taskId?: string): RunControlState | undefined {
  return controls.find((c) => c.control === control && (taskId === undefined || c.taskId === taskId));
}
