// Execution run contracts (Stage R3.1), registered as STAGE_R3_CONTRACTS in R3.5. All writes
// are UI only; run-scoped writes carry the run token, and a stale token or an ended run is run_stale.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { Evidence, ExecutionRun, Id } from "./model";
import { Mutation, ProjectInput, result, Written } from "./rpc-base";

/** Why a run or task is not ready (readiness data, carried in run_not_ready details as `blocked`). */
export const NotReady = z
  .object({
    code: z.enum([
      "feature_not_executing",
      "run_not_running",
      "start_unauthorised",
      "approval_not_current",
      "prerequisite_not_done",
      "dependency_not_verified",
      "parallel_not_granted",
      "ceiling",
      "not_todo",
      "coordinator_unavailable",
      "task_claimed",
      "pause_unacknowledged",
    ]),
    taskId: Id.optional(),
  })
  .strict();

/**
 * `unresolved` is derived (absent when none): `prompt_failed` details after the latest `started`,
 * `resumed` or `prompt_delivered`, then `awaiting ack: <taskId> (<agentId>)` lines while paused.
 */
export const RunView = z.object({ run: ExecutionRun, ready: z.array(Id), blocked: z.array(NotReady), unresolved: z.array(z.string()).optional() });
export type RunView = z.infer<typeof RunView>;

const RunMutation = Mutation.extend({ runId: Id, runToken: Id });

export const RunStart = defineRpc({
  name: "run.start",
  input: Mutation.extend({ featureId: Id, profileRef: z.string().min(1).optional() }),
  output: result(Written.extend({ runId: Id, runToken: Id, existing: z.boolean() })),
});
export const RunPause = defineRpc({ name: "run.pause", input: RunMutation, output: result(Written) });
export const RunResume = defineRpc({ name: "run.resume", input: RunMutation, output: result(Written) });
export const RunBudgetGrant = defineRpc({
  name: "run.budget.grant",
  input: RunMutation.extend({ taskId: Id, cycles: z.number().int().min(1).max(1000) }),
  output: result(Written),
});
export const DelegationRevoke = defineRpc({
  name: "delegation.revoke",
  input: Mutation.extend({ delegationId: Id }),
  output: result(Written),
});
export const RunGet = defineRpc({
  name: "run.get",
  input: ProjectInput.extend({ runId: Id }),
  output: result(RunView.extend({ revision: z.number().int() })),
});
export const RunList = defineRpc({
  name: "run.list",
  input: ProjectInput.extend({ featureId: Id.optional() }),
  output: result(z.object({ revision: z.number().int(), runs: z.array(RunView) })),
});

/** UI acceptance of a task whose approved completion policy is human (Stage R3.3). */
export const TaskAccept = defineRpc({ name: "task.accept", input: RunMutation.extend({ taskId: Id }), output: result(Written) });
export const RunEvidenceList = defineRpc({
  name: "run.evidence.list",
  input: ProjectInput.extend({ runId: Id, taskId: Id.optional() }),
  output: result(z.object({ revision: z.number().int(), evidence: z.array(Evidence), lateEvidence: z.array(Evidence) })),
});
/** Defined in R3.3; registered with the run routes (R3.5). */
export const RUN_EVIDENCE_CONTRACTS = [TaskAccept, RunEvidenceList] as const;

/** UI-only coordinator replacement (Stage R3.5): staged in the existing workspace, run and token kept. */
export const CoordinatorReplace = defineRpc({
  name: "coordinator.replace",
  input: Mutation.extend({ featureId: Id, profileRef: z.string().min(1) }),
  output: result(Written.extend({ agentId: Id, workspaceId: Id })),
});

export const RUN_CONTRACTS = [RunStart, RunPause, RunResume, RunBudgetGrant, DelegationRevoke, RunGet, RunList, CoordinatorReplace] as const;
