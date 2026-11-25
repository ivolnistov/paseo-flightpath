export type ErrorCode =
  | "invalid_input" | "not_found" | "unresolved_ref" | "relation_cycle"
  | "question_inactive" | "not_stale" | "revision_conflict"
  | "store_missing" | "store_exists" | "store_invalid"
  | "unknown_project" | "project_mismatch" | "unsafe_root"
  | "plan_revision_mismatch" | "plan_ineligible" | "plan_not_current" | "task_transition"
  | "tracker_not_current" | "tracker_token_mismatch" | "tracker_unavailable" | "tracker_intent_unresolved"
  | "block_frozen" | "feature_transition" | "decision_cancelled"
  | "run_stale" | "run_not_ready" | "delegation_unverified"
  | "planner_bound" | "stale_operation"
  | "internal";

// A constructor function rather than a class: the native (Hermes) client bundle cannot parse class
// syntax. Reflect.construct with this function as new.target gives a real Error with this prototype,
// so `instanceof DomainError`, `instanceof Error`, name, message and stack behave as with a class.
export interface DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
}
interface DomainErrorConstructor {
  new (code: ErrorCode, message: string, details?: unknown): DomainError;
  prototype: DomainError;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Hermes-safe ES5 Error subclass (Reflect.construct); no class extends Error by design
export const DomainError = function DomainError(code: ErrorCode, message: string, details?: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Hermes-safe ES5 Error subclass (Reflect.construct); no class extends Error by design
  const error = Reflect.construct(Error, [message], DomainError) as { -readonly [K in keyof DomainError]: DomainError[K] };
  error.name = "DomainError";
  error.code = code;
  error.details = details;
  return error;
} as unknown as DomainErrorConstructor;
Object.setPrototypeOf(DomainError, Error);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Hermes-safe ES5 Error subclass (Reflect.construct); no class extends Error by design
DomainError.prototype = Object.create(Error.prototype, {
  constructor: { value: DomainError, writable: true, configurable: true },
  name: { value: "DomainError", writable: true, configurable: true },
});

/**
 * The string `code` of a thrown value, such as a Node errno ("ENOENT"); undefined for anything else.
 * One property read, exactly like `e.code`: inherited codes are found, a getter runs once (and a
 * throwing getter propagates), and no `in` check is made. Never throws for primitives or null.
 */
export function errnoCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const code: unknown = Reflect.get(e, "code");
  return typeof code === "string" ? code : undefined;
}

export const isDomainError = (e: unknown, code?: ErrorCode): e is DomainError =>
  e instanceof DomainError && (code === undefined || e.code === code);
