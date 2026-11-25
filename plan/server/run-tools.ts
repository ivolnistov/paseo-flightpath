// MCP run tools for the bound coordinator chat (Stage R3.4). Authority comes only from the caller's
// bound grant (ctx.agentId, ctx.workspaceId), never from tool arguments; run-scoped tools carry the
// runToken. No tool approves, verifies, accepts, pauses, resumes, reworks, cancels or grants budget.
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { Id } from "../shared/model";
import type { McpTool, McpToolTable } from "./mcp-tools";
import type { Caller, RunCommands } from "./runs";

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous MCP tool list; each tool keeps its own input schema at definition
const tool = <S extends z.ZodType>(t: McpTool<S>): McpTool<z.ZodType> => t as unknown as McpTool<z.ZodType>;
const caller = (ctx: { agentId?: string; workspaceId?: string | null }): Caller => ({
  ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
  ...(ctx.workspaceId !== undefined ? { workspaceId: ctx.workspaceId } : {}),
});

const RunRef = { runId: Id, runToken: Id };
const SERVER_DECIDES = "Only the plugin server decides completion: checks and review run on the server, and the human accepts in the Paseo UI.";

export function buildRunTools(runs: RunCommands, opts: { paseo: () => PaseoApi | null }): McpToolTable {
  return [
    tool({
      name: "roadmap_run_next",
      description: "Coordinator only: the run's ready tasks and the blockers of the others. Pass the runId and runToken from the run prompt.",
      input: z.object(RunRef).strict(),
      run: (a, ctx) => runs.next(ctx.open, { projectId: ctx.projectId, ...a }, caller(ctx)),
    }),
    tool({
      name: "roadmap_task_claim",
      description:
        "Claim a ready task. The coordinator claims for itself or dispatches to a worker by agentId; a crew member claims only for itself. " +
        "Refused unless the run is running and the task is ready.",
      input: z.object({ ...RunRef, taskId: Id, agentId: Id.optional() }).strict(),
      run: (a, ctx) => runs.claim(ctx.open, { projectId: ctx.projectId, ...a }, caller(ctx)),
    }),
    tool({
      name: "roadmap_task_progress",
      description: `The task's assigned agent (or the coordinator) reports in_progress, or done to start the server checks. ${SERVER_DECIDES}`,
      input: z.object({ ...RunRef, taskId: Id, state: z.enum(["in_progress", "done"]) }).strict(),
      run: (a, ctx) => runs.progress(ctx.open, { projectId: ctx.projectId, ...a }, caller(ctx)),
    }),
    tool({
      name: "roadmap_run_ack",
      description: "The task's assigned agent acknowledges a pause after suspending its work on the task.",
      input: z.object({ ...RunRef, taskId: Id }).strict(),
      run: (a, ctx) => runs.ack(ctx.open, { projectId: ctx.projectId, ...a }, caller(ctx)),
    }),
    tool({
      name: "roadmap_start",
      description:
        "Record the user's start delegation for a feature or the whole roadmap, then start the ready features it covers. " +
        "Put the exact words in `quoted`; they must appear in a user message of this chat (this shows the words are in a user " +
        "message, not who wrote them). featureId is required for scope feature and refused for scope roadmap. " +
        "Scope roadmap starts every ready feature in roadmap order; a feature approved later starts at the next sweep. " +
        "Unapproved or non-current features never start. The user may revoke a delegation in the UI: that stops new " +
        "starts under it, and stops new task dispatch (claims, resume) for a feature only while no unrevoked delegation " +
        "still covers that feature; in-flight tasks finish, and a new delegation covering the feature restores them.",
      input: z
        .object({ scope: z.enum(["feature", "roadmap"]), featureId: Id.optional(), quoted: z.string().min(1) })
        .strict()
        .refine((v) => (v.scope === "feature") === (v.featureId !== undefined), {
          message: "featureId is required for scope feature and not allowed for scope roadmap",
        }),
      run: (a, ctx) =>
        runs.startDelegated(
          ctx.open,
          { projectId: ctx.projectId, scope: a.scope, quoted: a.quoted, ...(a.featureId !== undefined ? { featureId: a.featureId } : {}) },
          caller(ctx),
          opts.paseo(),
        ),
    }),
    tool({
      name: "roadmap_feature_bind",
      description: "Bind this chat as the feature's coordinator. Refused when another coordinator is bound.",
      input: z.object({ featureId: Id }).strict(),
      run: (a, ctx) => runs.bindChat(ctx.open, { projectId: ctx.projectId, featureId: a.featureId }, caller(ctx)),
    }),
  ];
}
