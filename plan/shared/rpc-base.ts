// RPC building blocks shared by every contract module. Contract modules import from here, never from
// `./rpc`, so `./rpc` can aggregate them without an initialisation cycle; `./rpc` re-exports these.
import { z } from "zod";
import type { ErrorCode } from "./errors";
import { Id, Option, Ref } from "./model";

export const RPC_ERROR_CODES = [
  "invalid_input", "not_found", "unresolved_ref", "relation_cycle",
  "question_inactive", "not_stale", "revision_conflict",
  "store_missing", "store_exists", "store_invalid",
  "unknown_project", "project_mismatch", "unsafe_root",
  "plan_revision_mismatch", "plan_ineligible", "plan_not_current", "task_transition",
  "tracker_not_current", "tracker_token_mismatch", "tracker_unavailable", "tracker_intent_unresolved",
  "block_frozen", "feature_transition", "decision_cancelled",
  "run_stale", "run_not_ready", "delegation_unverified",
  "planner_bound", "stale_operation",
  "internal",
] as const;
// compile-time sync with shared/errors.ts: both directions must hold
type _CoreCovered = Exclude<ErrorCode, (typeof RPC_ERROR_CODES)[number]> extends never ? true : never;
type _NoExtra = Exclude<(typeof RPC_ERROR_CODES)[number], ErrorCode | "internal"> extends never ? true : never;
export const rpcCodesInSync: [_CoreCovered, _NoExtra] = [true, true];

const ErrorCodeSchema = z.enum(RPC_ERROR_CODES);
export const RpcError = z.object({ code: ErrorCodeSchema, message: z.string(), details: z.unknown().optional() });
export type RpcError = z.infer<typeof RpcError>;
export const result = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), value }), z.object({ ok: z.literal(false), error: RpcError })]);
export type Result<T> = { ok: true; value: T } | { ok: false; error: RpcError };

/** The success value carried by a contract's `result(...)` output. */
export type ValueOf<C extends { output: z.ZodType }> = Extract<z.output<C["output"]>, { ok: true }> extends { value: infer V }
  ? V
  : never;

export const ProjectInput = z.object({ projectId: Id });
export const Mutation = ProjectInput.extend({ expectedRevision: z.number().int().min(1) });
export const Written = z.object({ revision: z.number().int().min(1) });
export const Refs = z.array(Ref);
export const OptionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const OptionInput = Option.extend({ id: OptionId });
export const DefinitionFields = {
  title: z.string().min(1),
  context: z.string(),
  options: z.array(OptionInput),
  recommendedOptionId: OptionId.optional(),
  allowFreeText: z.boolean(),
};
