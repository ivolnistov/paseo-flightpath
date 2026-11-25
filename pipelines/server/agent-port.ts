import type { PaseoAgent, PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import { AgentRoleSchema, type AgentRole, type ResolvedAgent } from "../shared/run";

export const METADATA_KEY = "flightpath-pipeline";
export const LABELS = {
  run: "flightpath-pipeline.run",
  attempt: "flightpath-pipeline.attempt",
  role: "flightpath-pipeline.role",
  key: "flightpath-pipeline.key",
} as const;

/** What Pipeline stores on its agents. It identifies a record; it grants nothing by itself. */
export const AgentReservationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attempt"), reservationId: z.string(), runId: z.string(), attemptId: z.string(), role: AgentRoleSchema, creationKey: z.string() }).strict(),
  z.object({ kind: z.literal("workflow"), reservationId: z.string(), projectId: z.string() }).strict(),
]);
export type AgentReservation = z.output<typeof AgentReservationSchema>;

export function reservationOf(metadata: Readonly<Record<string, unknown>> | null | undefined): AgentReservation | null {
  const parsed = AgentReservationSchema.safeParse(metadata?.[METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

/** Observed agent status. `null` from a lookup means unknown, never stopped. */
export type AgentStatus = "running" | "idle" | "closed";

export type CreateAgentInput = {
  workspaceId: string;
  runId: string;
  attemptId: string;
  role: AgentRole;
  creationKey: string;
  title: string;
  agent: ResolvedAgent;
  reservationId: string;
  prompt: string;
};

export type FoundWorkspace = { workspaceId: string; branchName: string; directory: string };

export interface AgentPort {
  createWorkspace(x: { projectId: string; branchName: string; runId: string }): Promise<{ workspaceId: string; directory: string }>;
  findWorkspaces(x: { projectId: string; branchName: string; runId: string }): Promise<FoundWorkspace[] | "unavailable">;
  createAgent(x: CreateAgentInput): Promise<{ agentId: string }>;
  /** Agents labelled with the creation key, or `unavailable` when the lookup fails. */
  findAgents(x: { workspaceId: string; creationKey: string }): Promise<string[] | "unavailable">;
  status(agentId: string): Promise<AgentStatus | null>;
  /** Sends a prompt; it steers a running turn rather than interrupting it. */
  send(agentId: string, text: string): Promise<void>;
  /**
   * Ends a running turn without sending a prompt: reads the status and reloads the session only
   * when a turn runs. Returns the status observed afterwards.
   */
  interrupt(agentId: string): Promise<AgentStatus | null>;
}

export function statusOf(agent: PaseoAgent | null | undefined): AgentStatus | null {
  if (!agent) return null;
  if (agent.archivedAt !== undefined && agent.archivedAt !== null) return "closed";
  switch (agent.status) {
    case "closed":
      return "closed";
    case "idle":
    case "error":
      return "idle";
    case "running":
    case "initializing":
      return "running";
  }
}

function workspaceReservation(workspace: PaseoWorkspace): string | null {
  const value = workspace.metadata?.[METADATA_KEY];
  const parsed = z.object({ runId: z.string() }).safeParse(value);
  return parsed.success ? parsed.data.runId : null;
}

/** The create configuration of a resolved agent: an explicit workflow reasoning already overrides the profile's thinking option. */
export function launchConfig(agent: ResolvedAgent): { provider: string; thinkingOptionId?: string; modeId?: string; options?: Record<string, JsonValue> } {
  const thinkingOptionId = agent.thinkingOptionId ?? agent.reasoning;
  return {
    provider: `${agent.provider}/${agent.model}`,
    ...(thinkingOptionId === undefined ? {} : { thinkingOptionId }),
    ...(agent.modeId === undefined ? {} : { modeId: agent.modeId }),
    ...(agent.options === undefined ? {} : { options: agent.options }),
  };
}

const PAGE_LIMIT = 200;
const MAX_PAGES = 50;

/** The agent port over the host SDK. */
export function createPaseoAgentPort(paseo: () => PaseoApi): AgentPort {
  return {
    async createWorkspace(x) {
      const handle = await paseo().workspaces.create({
        source: { kind: "worktree", projectId: x.projectId, action: "branch-off", branchName: x.branchName },
        idempotencyKey: `${METADATA_KEY}:workspace:${x.runId}`,
        title: `Pipeline run ${x.runId}`,
        metadata: { [METADATA_KEY]: { runId: x.runId, branchName: x.branchName } },
      });
      const directory = handle.directory ?? (await handle.refresh())?.workspaceDirectory ?? null;
      if (directory === null) throw new Error("The created workspace has no directory.");
      return { workspaceId: handle.id, directory };
    },

    async findWorkspaces(x) {
      try {
        const found: FoundWorkspace[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await paseo().workspaces.list({ filter: { projectId: x.projectId, includeBackground: true }, includeBackground: true, page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } });
          for (const workspace of result.entries) {
            const branch = workspace.gitRuntime?.currentBranch ?? null;
            const directory = workspace.workspaceDirectory;
            if (directory === undefined) continue;
            if (branch === x.branchName || workspaceReservation(workspace) === x.runId) found.push({ workspaceId: workspace.id, branchName: branch ?? x.branchName, directory });
          }
          if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) return found;
          cursor = result.pageInfo.nextCursor;
        }
        return "unavailable";
      } catch {
        return "unavailable";
      }
    },

    async createAgent(x) {
      const handle = await paseo()
        .workspaces.ref(x.workspaceId)
        .agents.create({
          idempotencyKey: x.creationKey,
          title: x.title,
          config: launchConfig(x.agent),
          prompt: x.prompt,
          labels: { [LABELS.run]: x.runId, [LABELS.attempt]: x.attemptId, [LABELS.role]: x.role, [LABELS.key]: x.creationKey },
          metadata: {
            [METADATA_KEY]: { kind: "attempt", reservationId: x.reservationId, runId: x.runId, attemptId: x.attemptId, role: x.role, creationKey: x.creationKey } satisfies AgentReservation,
          },
        });
      return { agentId: handle.id };
    },

    async findAgents(x) {
      try {
        const ids: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await paseo().agents.list({
            filter: { labels: { [LABELS.key]: x.creationKey }, includeArchived: true, includeBackground: true },
            includeBackground: true,
            page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
          });
          for (const entry of result.entries) {
            if (entry.agent.labels[LABELS.key] === x.creationKey) ids.push(entry.agent.id);
          }
          if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) return ids;
          cursor = result.pageInfo.nextCursor;
        }
        return "unavailable";
      } catch {
        return "unavailable";
      }
    },

    async status(agentId) {
      try {
        return statusOf((await paseo().agents.ref(agentId).refresh())?.agent);
      } catch {
        return null;
      }
    },

    async send(agentId, text) {
      await paseo().agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },

    async interrupt(agentId) {
      const ref = paseo().agents.ref(agentId);
      const before = statusOf((await ref.refresh())?.agent);
      if (before !== "running") return before;
      return statusOf((await ref.reload())?.agent);
    },
  };
}
