// Whether a planner chat can pause on a blocking native question (TR1, TR5). Claude routes
// AskUserQuestion to the host in every mode Paseo exposes; Codex exposes synchronous
// request_user_input only in its Plan collaboration mode, which Paseo 0.12 reports as the
// `plan_mode` toggle feature (not a mode id). Every uncertain host read is `unknown`, never
// `unsupported`. The host read is bounded and never throws.
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";

export type PauseSupport = { kind: "supported" } | { kind: "unsupported"; reason: string } | { kind: "unknown" };

export const CODEX_PLAN_FEATURE_ID = "plan_mode";
export const SUPPORT_TIMEOUT_MS = 2000;

/** The snapshot fields the decision reads; any other field (a mode id included) is ignored. */
export type SupportSnapshot = { provider: string; features?: ReadonlyArray<{ type: string; id: string; value?: unknown }> | null };

export function pauseSupport(agent: SupportSnapshot | null): PauseSupport {
  if (agent === null) return { kind: "unknown" };
  if (agent.provider === "claude") return { kind: "supported" };
  if (agent.provider === "codex") {
    if (agent.features === undefined || agent.features === null) return { kind: "unknown" };
    const plan = agent.features.find((f) => f.type === "toggle" && f.id === CODEX_PLAN_FEATURE_ID);
    if (plan === undefined) return { kind: "unsupported", reason: "codex plan mode unavailable" };
    return plan.value === true ? { kind: "supported" } : { kind: "unsupported", reason: "codex default mode" };
  }
  return { kind: "unsupported", reason: `${agent.provider}: no blocking native question` };
}

export type AgentRead = { kind: "ok"; agent: PaseoAgent } | { kind: "missing" } | { kind: "failed" };

/**
 * One bounded `refresh()` of an agent: `missing` when the host does not know it, `failed` on a
 * rejection, a timeout or no host context. The timer is always cleared.
 */
export async function readAgent(paseo: PaseoApi | null, agentId: string, timeoutMs = SUPPORT_TIMEOUT_MS): Promise<AgentRead> {
  if (paseo === null) return { kind: "failed" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AgentRead>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "failed" }), timeoutMs);
  });
  const read = Promise.resolve()
    .then(() => paseo.agents.ref(agentId).refresh())
    .then(
      (found): AgentRead => (found === null ? { kind: "missing" } : { kind: "ok", agent: found.agent }),
      (): AgentRead => ({ kind: "failed" }),
    );
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The planner candidate's support, read once from the host within `timeoutMs` (2 s by default). */
export async function readPauseSupport(paseo: PaseoApi | null, agentId: string, timeoutMs = SUPPORT_TIMEOUT_MS): Promise<PauseSupport> {
  const read = await readAgent(paseo, agentId, timeoutMs);
  if (read.kind !== "ok") return { kind: "unknown" };
  const archivedAt = read.agent.archivedAt;
  if (typeof archivedAt === "string" && archivedAt !== "") return { kind: "unsupported", reason: "archived" };
  return pauseSupport(read.agent);
}
