import { z } from "zod";
import { Id } from "./model";
import { ProjectInput } from "./rpc-base";

/**
 * What a revision event carries: the same existence, status, revision and schema facts the store
 * reports for `roadmap.version`, never roadmap content.
 */
export const RevisionFacts = z.object({
  exists: z.boolean(),
  status: z.enum(["missing", "ok", "invalid"]),
  revision: z.number().int().nullable(),
  schemaVersion: z.union([z.literal(1), z.literal(2)]).nullable(),
});
export type RevisionFacts = z.infer<typeof RevisionFacts>;

/** One event: the facts and the project they belong to, so a listener can refuse another project's. */
export const RevisionEvent = RevisionFacts.extend({ projectId: Id });
export type RevisionEvent = z.infer<typeof RevisionEvent>;

/** The subscription contract shape, declared here because older SDKs do not export it. */
export interface SubscriptionContract<Input extends z.ZodType, Event extends z.ZodType> {
  readonly name: string;
  readonly input: Input;
  readonly event: Event;
}

/**
 * Project-scoped revision notifications. A plain object rather than `defineSubscription`, which
 * older hosts lack: evaluating this module must not fail where subscriptions are unsupported.
 */
export const RoadmapRevisionWatch: SubscriptionContract<typeof ProjectInput, typeof RevisionEvent> = Object.freeze({
  name: "roadmap.revision.watch",
  input: ProjectInput,
  event: RevisionEvent,
});
