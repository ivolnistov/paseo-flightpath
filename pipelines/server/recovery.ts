import type { AgentRole, RunEvent, RunEventBody } from "../shared/run";
import { currentCycle, cycleCommands, graphJob, isWriter, stampEvents, unfinishedChecks, type AttemptState, type RunState } from "./run-engine";

export type AgentFact = "running" | "idle" | "closed" | "gone";

/** What the host reports at recovery; gathered by the caller before `reconcile`. */
export type HostFacts = {
  /**
   * Observed status of bound agents. Only `idle`, `closed` and `gone` prove that no turn runs; a
   * missing id is unknown and proves nothing, so the caller must report every agent it can.
   */
  agents: ReadonlyMap<string, AgentFact>;
  /** The project's workspaces, or `unavailable` when they cannot be listed. `baseCommit` is the commit the branch started from. */
  workspaces: Array<{ workspaceId: string; branchName: string; directory: string; baseCommit: string }> | "unavailable";
  /** Agent ids carrying each creation key in their labels, or `unavailable` when the lookup failed. */
  agentsByKey: ReadonlyMap<string, string[]> | "unavailable";
  /** `<pid>:<startedAt>` of recorded check processes that are still alive. */
  liveCheckGroups: ReadonlySet<string>;
  /**
   * Whether the host is proven to return the same agent for a repeated creation key. When false,
   * an agent intent without a match is never created again: the run pauses with
   * `binding_unknown` and the intent stays unresolved for a later lookup.
   */
  idempotentCreate: boolean;
};

const ROLES: readonly AgentRole[] = ["worker", "reviewer"];

/** The role whose turn the attempt waits for, if its agent must still be working. */
function expectedTurn(state: RunState, a: AttemptState): AgentRole | null {
  const gj = graphJob(state, a.jobId);
  if (isWriter(gj) && a.outputs === null) return "worker";
  const reviewer = a.roles.reviewer;
  const c = currentCycle(state, a);
  if (reviewer && c && c.status === "open" && c.review === null) {
    const checksDone = cycleCommands(gj).length === 0 || (c.checks !== null && c.evidence.size >= c.checks.count);
    if (checksDone) return "reviewer";
  }
  return null;
}

/**
 * Rebuilds the host side of a run after a restart, before anything is scheduled. Unbound intents
 * bind on exactly one match; none leaves the intent for a repeat with the same key or branch when
 * the repeat is proven safe; several, an unavailable lookup, an unsafe repeat or an agent without
 * an observed status pause with `binding_unknown` and leave the intent unresolved. Lost turns end as `lost`,
 * interrupted check batches are discarded and live recorded processes are stopped through the
 * barrier. It never emits a new creation key.
 */
export function reconcile(state: RunState, host: HostFacts, at: string): RunEvent[] {
  if (state.finished || state.cancelled) return [];
  const bodies: RunEventBody[] = [];
  let bindingUnknown = false;
  let reconciled = false;
  let barriers = state.barriers.length;
  const barrierId = (): string => {
    barriers += 1;
    return `q${barriers}`;
  };

  if (state.workspace === null) {
    bodies.push({ kind: "workspace.intent", branchName: `flightpath/run-${state.snapshot.runId}` });
  }
  const branchName = state.workspace?.branchName ?? `flightpath/run-${state.snapshot.runId}`;
  if (state.workspace === null || state.workspace.workspaceId === null) {
    if (host.workspaces === "unavailable") bindingUnknown = true;
    else {
      const matches = host.workspaces.filter((workspace) => workspace.branchName === branchName);
      const [only] = matches;
      if (matches.length > 1) bindingUnknown = true;
      else if (only) {
        bodies.push({ kind: "workspace.bound", workspaceId: only.workspaceId, directory: only.directory, baseCommit: only.baseCommit });
        reconciled = true;
      }
    }
  }

  /** True only for an observed status that proves the agent runs no turn. */
  const stopped = (agentId: string): boolean => {
    const fact = host.agents.get(agentId);
    return fact === "idle" || fact === "closed" || fact === "gone";
  };

  for (const barrier of state.barriers) {
    if (barrier.status === "confirmed") continue;
    const agentsStopped = barrier.attempts.every((id) => {
      const a = state.attempts[id];
      return !a || ROLES.every((role) => {
        const rs = a.roles[role];
        if (!rs) return true;
        return rs.binding.agentId !== null && stopped(rs.binding.agentId);
      });
    }) && barrier.agents.every((ref) => stopped(ref.agentId));
    const unresolved = barrier.attempts.some((id) => ROLES.some((role) => state.attempts[id]?.roles[role]?.binding.agentId === null));
    if (unresolved) bindingUnknown = true;
    const processesGone = barrier.attempts.every((id) => unfinishedChecks(state, id).records.every((record) => !host.liveCheckGroups.has(`${record.pid}:${record.startedAt}`)));
    if (agentsStopped && processesGone) {
      bodies.push({ kind: "quiesce.confirmed", barrierId: barrier.barrierId });
      reconciled = true;
    }
  }
  const inOpenBarrier = new Set(state.barriers.filter((barrier) => barrier.status !== "confirmed").flatMap((barrier) => barrier.attempts));

  for (const a of Object.values(state.attempts)) {
    if (a.endedAt !== null || inOpenBarrier.has(a.attemptId)) continue;

    let lost = false;
    let ambiguous = false;
    const extraAgents: Array<{ attemptId: string; role: AgentRole; agentId: string }> = [];
    const binds: RunEventBody[] = [];
    const bound = new Map<AgentRole, string>();
    for (const role of ROLES) {
      const rs = a.roles[role];
      if (!rs) continue;
      if (rs.binding.agentId !== null) {
        bound.set(role, rs.binding.agentId);
        continue;
      }
      if (host.agentsByKey === "unavailable") {
        bindingUnknown = true;
        ambiguous = true;
        continue;
      }
      const ids = host.agentsByKey.get(rs.binding.creationKey) ?? [];
      const [only] = ids;
      if (ids.length > 1) {
        bindingUnknown = true;
        ambiguous = true;
        extraAgents.push(...ids.map((agentId) => ({ attemptId: a.attemptId, role, agentId })));
      } else if (only) {
        binds.push({ kind: "attempt.agent_bound", attemptId: a.attemptId, role, agentId: only });
        bound.set(role, only);
      } else if (!host.idempotentCreate) {
        bindingUnknown = true;
        ambiguous = true;
      }
    }
    bodies.push(...binds);
    if (binds.length > 0) reconciled = true;

    const expected = expectedTurn(state, a);
    const expectedAgent = expected ? bound.get(expected) : undefined;
    if (expectedAgent !== undefined && !stopped(expectedAgent) && host.agents.get(expectedAgent) !== "running") {
      bindingUnknown = true;
      ambiguous = true;
    } else if (expectedAgent !== undefined && stopped(expectedAgent)) lost = true;
    if (ambiguous) lost = false;
    const worker = bound.get("worker");
    const settling = !lost && a.outputs !== null && !a.workerSettled && worker !== undefined;
    if (settling && host.agents.get(worker) === undefined) bindingUnknown = true;
    if (settling && stopped(worker)) {
      bodies.push({ kind: "agent.turn_ended", attemptId: a.attemptId, role: "worker", agentId: worker, result: "completed" });
      reconciled = true;
    }

    const batch = unfinishedChecks(state, a.attemptId);
    const c = currentCycle(state, a);
    const interrupted = c !== null && c.status === "open" && c.checks !== null && c.evidence.size < c.checks.count;
    const live = batch.records.some((record) => host.liveCheckGroups.has(`${record.pid}:${record.startedAt}`));
    if (lost) {
      bodies.push({ kind: "attempt.ended", attemptId: a.attemptId, outcome: "lost", reason: "lost" });
      reconciled = true;
    }
    if (live || extraAgents.length > 0) {
      bodies.push({ kind: "quiesce.started", barrierId: barrierId(), attempts: [a.attemptId], cause: "recovery", ...(extraAgents.length > 0 ? { agents: extraAgents } : {}) });
      reconciled = true;
    }
    if (!lost && interrupted && c !== null) {
      bodies.push({ kind: "cycle.invalidated", cycleId: c.cycleId, explained: true, reason: "recovery" });
      reconciled = true;
    }
  }

  if (bindingUnknown) {
    if (state.pause !== "binding_unknown") bodies.push({ kind: "run.paused", reason: "binding_unknown" });
  } else if (reconciled && state.pause !== "recovery") {
    bodies.push({ kind: "run.paused", reason: "recovery" });
  }
  return stampEvents(state, bodies, at);
}
