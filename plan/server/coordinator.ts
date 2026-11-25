// The per-feature coordinator (Stage R3.4): a saved agent profile mapped to an agent config, created in
// its own branch-off worktree workspace with NO prompt. The run prompt is sent only after the binding
// and run are committed (server/runs.ts). The product stores only the profile reference.
import type { PaseoApi, PaseoAgentConfig } from "@getpaseo/client";
import type { Feature } from "../shared/model";

export type AgentProfile = {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
};

/** The saved profile with this id from the daemon config, or null. */
export async function findProfile(paseo: PaseoApi, profileRef: string): Promise<AgentProfile | null> {
  const { config } = await paseo.config.get();
  const profiles = (config.agentProfiles ?? []) as AgentProfile[];
  return profiles.find((p) => p.id === profileRef) ?? null;
}

/** A profile as the installed `PaseoAgentConfig` ("provider/model" when a model is set). */
export function agentConfig(profile: AgentProfile): PaseoAgentConfig {
  return {
    provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
    ...(profile.modeId !== undefined ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId !== undefined ? { thinkingOptionId: profile.thinkingOptionId } : {}),
    ...(profile.featureValues !== undefined ? { featureValues: profile.featureValues as PaseoAgentConfig["featureValues"] } : {}),
  };
}

/** Creates the isolated worktree workspace, then the coordinator agent in it, without a prompt. Throws on SDK failure. */
export async function createCoordinator(
  paseo: PaseoApi,
  x: { storeRoot: string; projectId: string; featureId: string; featureTitle: string; profile: AgentProfile; baseRef?: string },
): Promise<{ agentId: string; workspaceId: string }> {
  const workspace = await paseo.workspaces.create({
    source: {
      kind: "worktree",
      action: "branch-off",
      cwd: x.storeRoot,
      projectId: x.projectId,
      branchName: `roadmap/${x.featureId}`,
      ...(x.baseRef !== undefined ? { baseBranch: x.baseRef } : {}),
    },
  });
  const agent = await workspace.agents.create({
    config: agentConfig(x.profile),
    title: `Roadmap: ${x.featureTitle}`,
    labels: { "decision-roadmap.feature": x.featureId },
  });
  return { agentId: agent.id, workspaceId: workspace.id };
}

/** The run prompt (repository-authored English). */
export function runPrompt(x: { featureTitle: string; featureId: string; runId: string; runToken: string }): string {
  return [
    `You coordinate the roadmap feature "${x.featureTitle}" (${x.featureId}), run ${x.runId}.`,
    `Use run token ${x.runToken} with the decision-roadmap MCP tools: roadmap_run_next to see ready tasks,`,
    "roadmap_task_claim to take or dispatch one, roadmap_task_progress to report in_progress or done,",
    "and roadmap_run_ack when asked to pause. Respect task dependencies and parallel grants.",
    `When you dispatch a task to a worker, give that worker the run id ${x.runId} and the run token ${x.runToken} so it can report progress and acknowledge pauses itself.`,
    "Reporting done starts the checks and review; only the plugin server decides completion.",
  ].join(" ");
}

/** The handover prompt for a replacement coordinator (Stage R3.5): the same run and token continue. */
export function handoverPrompt(x: { featureTitle: string; featureId: string; runId: string; runToken: string; previousAgentId: string }): string {
  return [
    `You replace the previous coordinator (${x.previousAgentId}) of this paused run.`,
    runPrompt(x),
    "The run stays paused until the human resumes it in the Paseo UI.",
  ].join(" ");
}

/**
 * The replacement request (Stage R4.3): a cancelled feature in this feature's dependency chain (not
 * necessarily its direct prerequisite) left it without a valid plan.
 */
export function replacementPrompt(x: { featureTitle: string; featureId: string; becauseOfTitle: string }): string {
  return [
    `"${x.becauseOfTitle}", a feature in the dependency chain of the roadmap feature "${x.featureTitle}" (${x.featureId}), was cancelled.`,
    `Prepare a replacement plan draft for this feature with roadmap_plan_draft, passing featureId ${x.featureId} so the plan is bound to it.`,
    "If a plan is already bound to it, find that plan with roadmap_plan_status and also pass its planId to draft a new revision of it.",
    "Only the human approves it in the Paseo UI; do not start work on it before that approval.",
  ].join(" ");
}

/** The chat binding without a workspace (`roadmap_feature_bind`); it has no worktree and no crew. */
export const NO_WORKSPACE = "no-workspace";

/**
 * The bound coordinator's worktree directory, read fresh on every use; null for no binding, the
 * no-workspace sentinel (no SDK call), an unknown workspace or one without a directory.
 */
export async function coordinatorWorktree(paseo: PaseoApi, feature: Feature): Promise<string | null> {
  const c = feature.coordinator;
  if (!c || c.workspaceId === NO_WORKSPACE) return null;
  try {
    const handle = paseo.workspaces.ref(c.workspaceId);
    await handle.refresh();
    return handle.directory ?? null;
  } catch {
    return null;
  }
}

/** Best-effort archive of a surplus agent; false when it failed. */
export async function archiveAgent(paseo: PaseoApi, agentId: string): Promise<boolean> {
  try {
    await paseo.agents.ref(agentId).archive();
    return true;
  } catch {
    return false;
  }
}
