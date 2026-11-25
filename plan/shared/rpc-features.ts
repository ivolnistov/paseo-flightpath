// Feature card contracts (part of `STAGE_R0_CONTRACTS` in `./rpc`); `PlanRework` is also defined here
// but registered in `STAGE_R2_CONTRACTS`. Status is not part of the
// create or update inputs; the manual changes a person may make go through the dedicated UI
// contract `feature.status.set`. Start state, history and creator are server-controlled and never
// part of an input. Over RPC, dependencies are
// set at `feature.create` and replaced only through `feature.dependencies.set`; `feature.update`
// edits card text. The separate MCP tool `roadmap_feature_update` may replace them together with
// a card edit in one write.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { Feature, FeatureStatus, Id, StartDelegation } from "./model";
import { Mutation, ProjectInput, result, Written } from "./rpc-base";

/** Card fields a person or an agent may edit after creation. */
export const FeaturePatch = z
  .object({ title: z.string().min(1).optional(), description: z.string().optional() })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), { message: "patch must change at least one field" });
export type FeaturePatch = z.output<typeof FeaturePatch>;

export const FeatureList = defineRpc({
  name: "feature.list",
  input: ProjectInput,
  // Stage R4.4: the stored delegations (revoked ones with `revokedAt`) for the roadmap screen strip.
  output: result(z.object({ revision: z.number().int(), features: z.array(Feature), delegations: z.array(StartDelegation) })),
});
export const FeatureCreate = defineRpc({
  name: "feature.create",
  input: Mutation.extend({
    title: z.string().min(1),
    description: z.string(),
    kind: z.enum(["feature", "bug"]),
    dependsOn: z.array(Id).optional(),
    /** Features this card relates to, such as the done feature a removal feature removes; set at creation only. */
    relatedTo: z.array(Id).optional(),
  }),
  output: result(Written.extend({ featureId: Id })),
});
export const FeatureUpdate = defineRpc({
  name: "feature.update",
  input: Mutation.extend({ featureId: Id, patch: FeaturePatch }),
  output: result(Written),
});
export const FeatureReorder = defineRpc({
  name: "feature.reorder",
  input: Mutation.extend({ order: z.array(Id) }),
  output: result(Written),
});
export const FeatureDependenciesSet = defineRpc({
  name: "feature.dependencies.set",
  input: Mutation.extend({ featureId: Id, dependsOn: z.array(Id) }),
  output: result(Written),
});
export const FeatureDelete = defineRpc({
  name: "feature.delete",
  input: Mutation.extend({ featureId: Id }),
  output: result(Written),
});
export const FeatureStatusSet = defineRpc({
  name: "feature.status.set",
  input: Mutation.extend({ featureId: Id, status: FeatureStatus }),
  output: result(Written),
});

/** Sends an approved latest bound revision back for rework (Stage R2.3). UI only; registered in R2.4. */
export const PlanRework = defineRpc({
  name: "plan.rework",
  input: Mutation.extend({ planId: Id, planRev: z.number().int().min(1), reason: z.string().trim().min(1).max(2000) }),
  output: result(Written),
});

export const FEATURE_CONTRACTS = [
  FeatureList,
  FeatureCreate,
  FeatureUpdate,
  FeatureReorder,
  FeatureDependenciesSet,
  FeatureDelete,
  FeatureStatusSet,
] as const;
