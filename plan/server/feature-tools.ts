// Feature MCP tools (Stage R0.5, design §6): agents list feature cards, and create and edit cards
// and their dependencies as work the human asked for. These tools delete, reorder, set a status
// or start nothing; inputs are strict and the project comes from the grant.
import { z } from "zod";
import { Id } from "../shared/model";
import { FeaturePatch } from "../shared/rpc-features";
import type { FeatureCommands } from "./features";
import type { McpTool, McpToolTable } from "./mcp-tools";

export const FEATURE_TOOL_NAMES = ["roadmap_feature_create", "roadmap_feature_list", "roadmap_feature_update"] as const;

const SCOPE = "These feature tools cannot delete, reorder, defer, cancel or start features, and they do not run any work.";
const Revision = z.number().int().min(1);

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous MCP tool list; each tool keeps its own input schema at definition
const tool = <S extends z.ZodType>(t: McpTool<S>): McpTool<z.ZodType> => t as unknown as McpTool<z.ZodType>;

export function buildFeatureTools(features: FeatureCommands): McpToolTable {
  return [
    tool({
      name: "roadmap_feature_create",
      description:
        "Append a feature card to the roadmap (kind feature or bug), optionally depending on existing features, " +
        "only as work the human asked for. " +
        `Creating a card never starts work. Pass the latest revision as expectedRevision. ${SCOPE}`,
      input: z
        .object({
          expectedRevision: Revision,
          title: z.string().min(1),
          description: z.string(),
          kind: z.enum(["feature", "bug"]),
          dependsOn: z.array(Id).optional(),
        })
        .strict(),
      run: (a, { open, projectId, origin }) => features.create(open, { projectId, ...a }, origin),
    }),
    tool({
      name: "roadmap_feature_list",
      description:
        "Read the roadmap: every feature card in roadmap order with its id, status, dependencies and history, the start " +
        `delegations (revoked ones included), and the current revision to pass as expectedRevision. Read only. ${SCOPE}`,
      input: z.object({}).strict(),
      run: (_a, { open, projectId, origin }) => features.list(open, { projectId }, origin),
    }),
    tool({
      name: "roadmap_feature_update",
      description:
        "Edit a feature card's title or description, replace its dependencies, or both in one write, " +
        "only as work the human asked for. " +
        `Pass the latest revision as expectedRevision. ${SCOPE}`,
      input: z
        .object({ expectedRevision: Revision, featureId: Id, patch: FeaturePatch.optional(), dependsOn: z.array(Id).optional() })
        .strict()
        .refine((a) => a.patch !== undefined || a.dependsOn !== undefined, { message: "give a patch, dependsOn or both" }),
      run: (a, { open, projectId, origin }) => features.update(open, { projectId, ...a }, origin),
    }),
  ];
}
