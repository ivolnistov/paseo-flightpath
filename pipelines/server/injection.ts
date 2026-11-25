import type { PluginHookContext, PluginHookResult, PluginLifecycleRegistration, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { AgentRole } from "../shared/run";
import { LABELS, reservationOf, type AgentReservation } from "./agent-port";
import { sameReservation, type Grant } from "./grants";
import { MCP_SERVER_NAME } from "./mcp-endpoint";
import { creationKey, type RunState } from "./run-engine";

export const ROLE_INSTRUCTIONS: Record<AgentRole | "workflow", string> = {
  worker:
    "You work for Pipeline as the worker of one job attempt. Read your job with the pipeline_job_context tool, work only in this worktree, and report the declared outputs with pipeline_job_complete. Pipeline decides completion; you cannot accept, approve or retry anything.",
  reviewer:
    "You review for Pipeline. Read the job with the pipeline_job_context tool, inspect the worktree without editing files, and submit your outcome, findings and one result per acceptance criterion with pipeline_review_submit.",
  workflow:
    "You help edit this project's Pipeline workflow. Read it with pipeline_workflow_get and offer changes with pipeline_workflow_propose; the user previews and applies proposals. You cannot save the workflow or start a run.",
};

export type InjectionDeps = {
  /** The endpoint, or null while it is not running. */
  endpoint(): { urlFor(grant: Grant): string; reservation(subject: string): string } | null;
  /** The run's folded state, or null when the run is unknown. */
  readRun(runId: string): Promise<RunState | null>;
  /** Whether the agent is, or is being created as, the workflow chat of the project. */
  isWorkflowChat(projectId: string, agentId: string, reason: PluginSessionOpenRequest["reason"]): Promise<boolean>;
  log(message: string): void;
};

type OpenResult = PluginHookResult<"agent.open.before">;

async function grantFor(request: PluginSessionOpenRequest, reservation: AgentReservation, deps: InjectionDeps): Promise<{ grant: Grant; instructions: string } | null> {
  const endpoint = deps.endpoint();
  if (endpoint === null) return null;
  if (reservation.kind === "workflow") {
    if (!sameReservation(reservation.reservationId, endpoint.reservation(`workflow:${reservation.projectId}`))) return null;
    if (!(await deps.isWorkflowChat(reservation.projectId, request.agentId, request.reason))) return null;
    return { grant: { kind: "workflow", projectId: reservation.projectId, agentId: request.agentId }, instructions: ROLE_INSTRUCTIONS.workflow };
  }
  if (reservation.creationKey !== creationKey(reservation.runId, reservation.attemptId, reservation.role)) return null;
  if (!sameReservation(reservation.reservationId, endpoint.reservation(reservation.creationKey))) return null;
  const label = request.labels[LABELS.key];
  if (label !== undefined && label !== reservation.creationKey) return null;
  const state = await deps.readRun(reservation.runId);
  const a = state?.attempts[reservation.attemptId];
  const binding = a?.roles[reservation.role]?.binding;
  if (!a || !binding || a.endedAt !== null || binding.creationKey !== reservation.creationKey) return null;
  const own = binding.agentId === request.agentId || (binding.agentId === null && request.reason === "create");
  if (!own) return null;
  return {
    grant: { kind: "attempt", runId: reservation.runId, attemptId: reservation.attemptId, role: reservation.role, agentId: request.agentId },
    instructions: ROLE_INSTRUCTIONS[reservation.role],
  };
}

/**
 * Adds role instructions and the scoped MCP server to an interactive open of an agent whose
 * reservation matches Pipeline's own records. History opens and everything else pass unchanged.
 */
export async function injectFor(request: PluginSessionOpenRequest, deps: InjectionDeps): Promise<OpenResult> {
  if (request.purpose !== "interactive") return undefined;
  const reservation = reservationOf(request.metadata);
  if (reservation === null) return undefined;
  let admitted: Awaited<ReturnType<typeof grantFor>>;
  try {
    admitted = await grantFor(request, reservation, deps);
  } catch (error) {
    deps.log(`open of ${request.agentId} not admitted: ${error instanceof Error ? error.message : "unknown error"}`);
    return undefined;
  }
  const endpoint = deps.endpoint();
  if (admitted === null || endpoint === null) return undefined;
  return {
    ...request,
    appendSystemPrompt: [...(request.appendSystemPrompt ?? []), admitted.instructions],
    mcpServers: { ...request.mcpServers, [MCP_SERVER_NAME]: { type: "http", url: endpoint.urlFor(admitted.grant) } },
  };
}

export function registerInjection(server: Pick<PluginLifecycleRegistration, "addHook">, deps: InjectionDeps & { onContext?(context: PluginHookContext): Promise<void> }): () => void {
  return server.addHook("agent.open.before", async ({ request }, context) => {
    await deps.onContext?.(context);
    return injectFor(request, deps);
  });
}
