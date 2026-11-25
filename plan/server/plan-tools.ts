// Plan MCP tools (Stage 3). No approve tool exists, and tasks can never be marked verified here.
import { z } from "zod";
import { Id } from "../shared/model";
import { TaskInput, type Result } from "../shared/rpc";
import type { DodTemplateValue } from "../shared/rpc-dod";
import type { McpTool, McpToolTable } from "./mcp-tools";
import type { PlanCommands } from "./plans";

export const STAGE3_TOOL_NAMES = ["roadmap_plan_draft", "roadmap_plan_status", "roadmap_task_update"] as const;

// Same sentence as the Stage 2 tool table (mcp-tools.ts, not exported there).
const NO_APPROVAL = "Approval of plans happens only in the Paseo UI; no tool can approve.";
const Revision = z.number().int().min(1);
const ContentHash = z.string().regex(/^[0-9a-f]{64}$/);

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous MCP tool list; each tool keeps its own input schema at definition
const tool = <S extends z.ZodType>(t: McpTool<S>): McpTool<z.ZodType> => t as unknown as McpTool<z.ZodType>;

/** Resolves a project's effective DoD template, as `dod.template.get` does. */
export type DodTemplateResolver = (projectId: string) => Promise<Result<DodTemplateValue>>;

/** Stage 3 plan tools; with a resolver also the read-only `roadmap_dod_template` (Stage R2.2). */
export function buildPlanTools(plan: PlanCommands, dodTemplate?: DodTemplateResolver): McpToolTable {
  const tools: McpTool<z.ZodType>[] = [
    tool({
      name: "roadmap_plan_draft",
      description:
        "Draft a new revision of a plan (or a new plan without planId) from decided questions of the given sessions. " +
        "Every active question there must be answered (or explicitly skipped) and not stale; an explicitly cancelled " +
        "decision stays active but is excluded from the basis and needs no answer (answering it fails: block_frozen " +
        "first for a question of an accepted block, otherwise decision_cancelled). With featureId the plan is " +
        "bound to that feature and the revision carries per-task dependsOn, parallel, completion, grill and dod (omitted " +
        "ones get defaults); dependsOn, parallel, completion, grill and dod need featureId (a task id is accepted and kept " +
        "without it), and a bound plan must always repeat " +
        "its featureId. When this chat's MCP grant is bound to it, each grilling session this draft creates gets this chat " +
        "as its planner. " +
        `Pass the latest revision as expectedRevision. ${NO_APPROVAL}`,
      input: z
        .object({
          expectedRevision: Revision,
          planId: Id.optional(),
          featureId: Id.optional(),
          title: z.string().min(1),
          sessionIds: z.array(Id).min(1),
          markdown: z.string().min(1).max(200_000),
          tasks: z.array(TaskInput).max(200),
        })
        .strict(),
      // A bound grant's agent becomes the planner of the grilling sessions this draft creates.
      run: (a, { open, projectId, origin, agentId, workspaceId }) =>
        plan.draft(open, { projectId, ...a }, origin, agentId !== undefined ? { agentId, workspaceId: workspaceId ?? null } : undefined),
    }),
    tool({
      name: "roadmap_plan_status",
      description:
        "Without planId: every plan with its latest revision and approval state. With planId: that plan's revisions, tasks, " +
        `approval state, reasons it is not current, and the planRev/contentHash to use for task updates. ${NO_APPROVAL}`,
      input: z.object({ planId: Id.optional() }).strict(),
      run: async (a, { open, projectId }) => {
        if (a.planId === undefined) return plan.list(open, { projectId });
        const out = await plan.get(open, { projectId, planId: a.planId });
        if (!out.ok) return out;
        const latest = out.value.plan.revisions.at(-1);
        return {
          ok: true,
          value: { ...out.value, planId: a.planId, planRev: latest?.rev ?? null, contentHash: latest?.contentHash ?? null },
        };
      },
    }),
    tool({
      name: "roadmap_task_update",
      description:
        "Move a task of the latest approved plan revision to in_progress or done, addressed by planId, planRev and " +
        "contentHash from roadmap_plan_status. Starting work needs a current approval; tasks are never verified by an agent. " +
        NO_APPROVAL,
      input: z
        .object({
          expectedRevision: Revision,
          planId: Id,
          planRev: z.number().int().min(1),
          contentHash: ContentHash,
          taskId: Id,
          status: z.enum(["in_progress", "done"]),
        })
        .strict(),
      run: (a, { open, projectId, origin }) => plan.taskUpdate(open, { projectId, ...a }, origin),
    }),
  ];
  if (dodTemplate !== undefined) {
    tools.push(
      tool({
        name: "roadmap_dod_template",
        description:
          "The project's effective Definition of Done template and its source (the file `dod template.md`, then project " +
          "settings, then global settings; the first found wins, none when absent). Use it as guidance to propose a " +
          "tailored DoD for each task you draft; it is never applied to any task by itself, and the human owns every DoD. " +
          NO_APPROVAL,
        input: z.object({}).strict(),
        run: (_a, { projectId }) => dodTemplate(projectId),
      }),
    );
  }
  return tools;
}
