export type ProviderFailureClass = "auth" | "quota" | "unavailable";

type Rule = { class: ProviderFailureClass; codes: readonly string[]; statuses: readonly number[]; message: RegExp };

/**
 * Host error fields that identify provider unavailability. Everything else is a task failure and
 * never causes failover.
 */
const RULES: readonly Rule[] = [
  {
    class: "auth",
    codes: ["auth", "auth_failed", "authentication_failed", "authentication_error", "unauthorized", "unauthenticated", "invalid_api_key", "not_logged_in", "login_required", "credentials_missing"],
    statuses: [401],
    message: /\b(unauthori[sz]ed|authentication (failed|error|required)|invalid (api|x-api) key|not logged in|log ?in required|missing credentials)\b/i,
  },
  {
    class: "quota",
    codes: ["rate_limit", "rate_limited", "rate_limit_exceeded", "rate_limit_error", "quota_exceeded", "insufficient_quota", "usage_limit", "usage_limit_reached", "too_many_requests"],
    statuses: [429],
    message: /\b(rate[- ]limit(ed)?|quota (exceeded|exhausted)|insufficient quota|usage limit|too many requests|credit balance is too low)\b/i,
  },
  {
    class: "unavailable",
    codes: ["provider_unavailable", "model_unavailable", "model_not_found", "overloaded", "overloaded_error", "service_unavailable", "provider_not_found", "provider_disabled"],
    statuses: [502, 503, 529],
    message: /\b(overloaded|service unavailable|provider (is )?(unavailable|disabled|not available)|model .{0,80}\b(not found|unavailable|not available|does not exist))\b/i,
  },
];

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const found: unknown = Reflect.get(value, key);
  return found;
}

function fieldsOf(error: unknown): { codes: string[]; statuses: number[]; messages: string[] } {
  const codes: string[] = [];
  const statuses: number[] = [];
  const messages: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === "string") {
      messages.push(value);
      return;
    }
    for (const key of ["code", "type", "errorCode"]) {
      const code = field(value, key);
      if (typeof code === "string") codes.push(code.toLowerCase());
    }
    for (const key of ["status", "statusCode", "httpStatus"]) {
      const status = field(value, key);
      if (typeof status === "number") statuses.push(status);
    }
    const message = field(value, "message");
    if (typeof message === "string") messages.push(message);
    if (field(value, "providerUnavailable") === true) codes.push("provider_unavailable");
    visit(field(value, "error"), depth + 1);
    visit(field(value, "cause"), depth + 1);
  };
  visit(error, 0);
  return { codes, statuses, messages };
}

/** Classifies a creation or turn failure; `null` means an ordinary task failure. */
export function classifyProviderFailure(error: unknown): ProviderFailureClass | null {
  const { codes, statuses, messages } = fieldsOf(error);
  for (const rule of RULES) if (codes.some((code) => rule.codes.includes(code))) return rule.class;
  for (const rule of RULES) if (statuses.some((status) => rule.statuses.includes(status))) return rule.class;
  for (const rule of RULES) if (messages.some((message) => rule.message.test(message))) return rule.class;
  return null;
}

export function failureMessage(error: unknown): string {
  const message = field(error, "message");
  if (typeof message === "string") return message.slice(0, 2_000);
  const nested = field(field(error, "error"), "message");
  if (typeof nested === "string") return nested.slice(0, 2_000);
  return typeof error === "string" ? error.slice(0, 2_000) : "Unknown failure.";
}
