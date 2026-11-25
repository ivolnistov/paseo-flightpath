import type { ResolvedSettings, RunEvent, RunEventBody, RunSnapshot, RunSnapshotBody, WorktreeIdentity } from "../shared/run";
import type { AgentSettings, OutputDecl } from "../shared/workflow";
import { parseTasks } from "./start-inputs";
import { expandWorkflow } from "./workflow-expand";
import { parseWorkflow } from "./workflow-parse";
import { validateWorkflow } from "./workflow-validate";
import { snapshotHashOf } from "./run-store";
import { decide, graphJob, initialState, isActive, isWriter, reduce, slotHolders, startedEvent, stampEvents, type Effect, type RunState } from "./run-engine";

function resolved(settings: AgentSettings): ResolvedSettings {
  const primaryModel = settings.model ?? settings.profile ?? "default";
  const out: ResolvedSettings = { primary: { provider: "provider-a", model: primaryModel, ...(settings.profile ? { profile: settings.profile } : {}) }, retries: settings.retries };
  if (settings.fallback) {
    const [provider = "provider-b", model = "model-b"] = settings.fallback.model.split("/");
    out.fallback = { provider, model, ...(settings.fallback.reasoning ? { reasoning: settings.fallback.reasoning } : {}) };
  }
  return out;
}

/** A snapshot body from workflow YAML and Start values; `tasks` is task-list YAML. */
export function snapshotBody(yaml: string, x: { runId?: string; projectId?: string; startKey?: string; inputs?: Record<string, unknown>; tasks?: string } = {}): RunSnapshotBody {
  const { workflow, diagnostics } = parseWorkflow(yaml);
  if (!workflow || diagnostics.length > 0) throw new Error(`workflow does not parse: ${JSON.stringify(diagnostics)}`);
  const issues = validateWorkflow(workflow);
  if (issues.length > 0) throw new Error(`workflow is invalid: ${JSON.stringify(issues)}`);
  const inputs: Record<string, unknown> = { ...(x.inputs ?? {}) };
  if (x.tasks !== undefined) {
    const parsed = parseTasks(x.tasks);
    if (!parsed.ok) throw new Error(`tasks are invalid: ${JSON.stringify(parsed.diagnostics)}`);
    inputs.tasks = parsed.tasks;
  }
  const graph = expandWorkflow(workflow, inputs);
  const settings: RunSnapshotBody["settings"] = {};
  for (const job of graph.jobs) {
    const entry: RunSnapshotBody["settings"][string] = {};
    if (job.agent && (job.uses === "agent" || job.uses === "run-task")) entry.worker = resolved(job.agent);
    if (job.agent && job.uses === "review") entry.reviewer = resolved(job.agent);
    if (job.reviewer) entry.reviewer = resolved(job.reviewer);
    settings[job.id] = entry;
  }
  return {
    runId: x.runId ?? "run1",
    projectId: x.projectId ?? "proj",
    startKey: x.startKey ?? "start-1",
    createdAt: "2026-11-21T00:00:00.000Z",
    startedBy: "human",
    workflow: { yaml, sha256: "0".repeat(64) },
    inputs,
    graph,
    settings,
  };
}

export function snapshotOf(yaml: string, x: Parameters<typeof snapshotBody>[1] = {}): RunSnapshot {
  const body = snapshotBody(yaml, x);
  return { ...body, snapshotHash: snapshotHashOf(body) };
}

export function identity(content: string): WorktreeIdentity {
  return { headCommit: "head0", indexTree: "index0", contentTree: content };
}

function sampleOutput(decl: OutputDecl): unknown {
  switch (decl.type) {
    case "string":
      return "value";
    case "number":
      return 1;
    case "boolean":
      return true;
    case "object":
      return {};
    case "list":
      return [];
  }
}

export type Policy = {
  /** What a worker does when its agent is bound. Default: valid outputs, a worktree write, turn completed. */
  worker?: (attemptId: string, sim: Sim) => "complete" | "hold" | RunEventBody[] | void;
  /** Default: approve and meet every assigned criterion. */
  reviewer?: (attemptId: string, cycleId: string, sim: Sim) => "approve" | "hold" | void;
  /** Exit code of a check command. Default 0. */
  check?: (jobId: string, index: number, cycleId: string, sim: Sim) => number | "hold";
  /** Default: accept or approve on the current identity. */
  human?: (jobId: string, sim: Sim) => "accept" | "hold";
  /** How a pending barrier ends once its interrupts ran. Default: confirmed. */
  quiesce?: (barrierId: string, sim: Sim) => "confirm" | "unconfirm" | "hold";
  /** Runs before each check command reads the identity after it. */
  duringCheck?: (jobId: string, index: number, sim: Sim) => void;
};

/** An in-memory host for the pure engine: applies effects, tracks invariants, never touches a real host. */
export class Sim {
  state: RunState;
  events: RunEvent[] = [];
  worktree: WorktreeIdentity = identity("t0");
  writes = 0;
  executed = new Set<string>();
  effectsSeen: Effect[] = [];
  maxHolders = 0;
  writerWithIsolated = false;
  agentCount = 0;
  private turns: Array<{ attemptId: string; role: "worker" | "reviewer"; agentId: string; cycleId?: string }> = [];
  private rng: () => number;

  constructor(
    readonly snapshot: RunSnapshot,
    readonly policy: Policy = {},
    seed?: number,
  ) {
    this.state = initialState(snapshot);
    let x = seed ?? 0;
    this.rng = seed === undefined ? () => 0 : () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  }

  at(): string {
    return `2026-11-21T00:00:${String(this.events.length).padStart(2, "0")}.000Z`;
  }

  apply(bodies: readonly RunEventBody[]): RunEvent[] {
    const stamped = stampEvents(this.state, bodies, this.at());
    for (const event of stamped) {
      this.state = reduce(this.state, event);
      this.events.push(event);
      this.checkInvariants();
    }
    return stamped;
  }

  private checkInvariants(): void {
    const holders = slotHolders(this.state);
    this.maxHolders = Math.max(this.maxHolders, holders.length);
    const active = Object.values(this.state.attempts).filter(isActive);
    const writer = active.some((a) => isWriter(graphJob(this.state, a.jobId)));
    const isolated = active.some((a) => {
      const gj = graphJob(this.state, a.jobId);
      return gj.uses === "checks" && gj.isolated && !this.state.jobs[gj.id]?.exclusive;
    });
    if (writer && isolated) this.writerWithIsolated = true;
  }

  /** Applies engine records until host effects remain; returns them. */
  settle(limit = 500): Effect[] {
    for (let i = 0; i < limit; i += 1) {
      const effects = decide(this.state);
      this.effectsSeen.push(...effects);
      const [first] = effects;
      if (first?.kind === "record") {
        this.apply(first.events);
        continue;
      }
      return effects;
    }
    throw new Error("settle did not converge");
  }

  /** Runs host effects and scripted agents until nothing changes. */
  run(limit = 2000): void {
    for (let i = 0; i < limit; i += 1) {
      const effects = this.settle().filter((effect) => !this.executed.has(effect.key));
      if (effects.length === 0 && this.settleBarriers()) continue;
      const choices = effects.length + this.turns.length;
      if (choices === 0) return;
      const pick = Math.floor(this.rng() * choices);
      if (pick < effects.length) {
        const effect = effects[pick];
        if (effect) this.execute(effect);
      } else {
        const turn = this.turns.splice(pick - effects.length, 1)[0];
        if (turn) this.playTurn(turn);
      }
    }
    throw new Error("run did not converge");
  }

  /** Ends pending barriers whose interrupts have run, as the policy says. */
  settleBarriers(): boolean {
    let changed = false;
    for (const barrier of this.state.barriers) {
      if (barrier.status !== "pending") continue;
      const decision = this.policy.quiesce?.(barrier.barrierId, this) ?? "confirm";
      if (decision === "hold") continue;
      this.apply([decision === "confirm" ? { kind: "quiesce.confirmed", barrierId: barrier.barrierId } : { kind: "quiesce.unconfirmed", barrierId: barrier.barrierId, message: "interrupt failed" }]);
      changed = true;
    }
    return changed;
  }

  execute(effect: Effect): void {
    this.executed.add(effect.key);
    switch (effect.kind) {
      case "record":
        this.apply(effect.events);
        return;
      case "create_workspace":
        this.apply([{ kind: "workspace.bound", workspaceId: "ws1", directory: "/tmp/ws1", baseCommit: "base0" }]);
        return;
      case "start_attempt":
        this.apply([startedEvent(effect)]);
        return;
      case "create_agent": {
        this.agentCount += 1;
        const agentId = `agent-${effect.creationKey}`;
        this.apply([{ kind: "attempt.agent_bound", attemptId: effect.attemptId, role: effect.role, agentId }]);
        const cycleId = this.state.attempts[effect.attemptId]?.roles[effect.role]?.binding.cycleId;
        this.turns.push({ attemptId: effect.attemptId, role: effect.role, agentId, ...(cycleId ? { cycleId } : {}) });
        return;
      }
      case "request_review": {
        this.turns.push({ attemptId: effect.attemptId, role: "reviewer", agentId: effect.agentId, cycleId: effect.cycleId });
        return;
      }
      case "open_cycle":
        this.apply([{ kind: "cycle.opened", cycleId: effect.cycleId, attemptId: effect.scope === "finish" ? null : effect.scope.attemptId, identity: { ...this.worktree } }]);
        return;
      case "run_checks":
        this.runChecks(effect);
        return;
      case "remind":
        this.apply([{ kind: "agent.reminded", attemptId: effect.attemptId, role: effect.role }]);
        return;
      case "interrupt_agent":
      case "cancel_checks":
        return;
      case "finish_run":
        this.apply([{ kind: "run.finished", cycleId: effect.cycleId }]);
        return;
    }
  }

  runChecks(effect: Extract<Effect, { kind: "run_checks" }>): void {
    this.apply([{ kind: "checks.started", attemptId: effect.attemptId, cycleId: effect.cycleId, mode: effect.mode, count: effect.commands.length }]);
    effect.commands.forEach((_command, index) => {
      const code = this.policy.check?.(effect.jobId, index, effect.cycleId, this) ?? 0;
      if (code === "hold") return;
      this.apply([{ kind: "check.launched", attemptId: effect.attemptId, cycleId: effect.cycleId, index, pid: 1000 + index, pgid: 1000 + index, startedAt: "boot" }]);
      this.policy.duringCheck?.(effect.jobId, index, this);
      this.apply([
        {
          kind: "evidence.recorded",
          evidence: {
            id: `${effect.cycleId}:${index}`,
            attemptId: effect.attemptId,
            cycleId: effect.cycleId,
            kind: "check",
            item: index,
            result: code === 0 ? "pass" : "fail",
            mode: effect.mode,
            exitCode: code,
            outputTail: code === 0 ? "ok" : "failed",
            identity: { ...this.worktree },
            at: this.at(),
          },
        },
      ]);
    });
  }

  /** A worker that changes the worktree. */
  write(): void {
    this.writes += 1;
    this.worktree = identity(`t${this.writes}`);
  }

  playTurn(turn: { attemptId: string; role: "worker" | "reviewer"; agentId: string; cycleId?: string }): void {
    const a = this.state.attempts[turn.attemptId];
    if (!a || a.endedAt !== null) return;
    if (turn.role === "worker") {
      const action = this.policy.worker?.(turn.attemptId, this) ?? "complete";
      if (action === "hold") return;
      if (Array.isArray(action)) {
        this.apply(action);
        return;
      }
      const gj = graphJob(this.state, a.jobId);
      this.write();
      const outputs = Object.fromEntries(Object.entries(gj.outputs).map(([name, decl]) => [name, sampleOutput(decl)]));
      this.apply([
        { kind: "attempt.outputs_accepted", attemptId: a.attemptId, role: "worker", agentId: turn.agentId, outputs, summary: "done" },
        { kind: "agent.turn_ended", attemptId: a.attemptId, role: "worker", agentId: turn.agentId, result: "completed" },
      ]);
      return;
    }
    const cycleId = this.state.cycles[a.cycles[a.cycles.length - 1] ?? ""]?.cycleId;
    if (!cycleId) return;
    const action = this.policy.reviewer?.(turn.attemptId, cycleId, this) ?? "approve";
    if (action === "hold") return;
    const gj = graphJob(this.state, a.jobId);
    const criteria = gj.uses === "review" ? [] : gj.done.flatMap((item, index) => ("criterion" in item ? [{ index, met: true }] : []));
    this.apply([
      { kind: "review.submitted", attemptId: a.attemptId, cycleId, role: "reviewer", agentId: turn.agentId, outcome: "approved", findings: [], criteria, identity: { ...this.worktree } },
      { kind: "agent.turn_ended", attemptId: a.attemptId, role: "reviewer", agentId: turn.agentId, result: "completed" },
    ]);
  }

  /** Accepts or approves every job waiting for a human, on the current identity. */
  humans(): boolean {
    let acted = false;
    for (const a of Object.values(this.state.attempts)) {
      if (!a.parked || a.endedAt !== null || a.outcome !== null) continue;
      const decision = this.policy.human?.(a.jobId, this) ?? "accept";
      if (decision === "hold") continue;
      const gj = graphJob(this.state, a.jobId);
      const cycleId = a.cycles[a.cycles.length - 1];
      if (!cycleId) continue;
      const criteria = gj.criteria === "human" ? gj.done.flatMap((item, index) => ("criterion" in item ? [index] : [])) : [];
      if (gj.uses === "approval") this.apply([{ kind: "human.approved", jobId: a.jobId, attemptId: a.attemptId, cycleId, identity: { ...this.worktree } }]);
      else this.apply([{ kind: "human.accepted", jobId: a.jobId, attemptId: a.attemptId, cycleId, identity: { ...this.worktree }, criteria }]);
      acted = true;
    }
    return acted;
  }

  /** Runs to quiescence, letting humans act whenever the engine waits for them. */
  runAll(limit = 50): void {
    for (let i = 0; i < limit; i += 1) {
      this.run();
      if (!this.humans()) return;
    }
  }

  jobStarts(jobId: string): number {
    return this.events.filter((event) => event.kind === "attempt.started" && event.jobId === jobId).length;
  }

  startSeq(jobId: string): number {
    return this.events.find((event) => event.kind === "attempt.started" && event.jobId === jobId)?.seq ?? -1;
  }

  successSeq(jobId: string): number {
    const ids = new Set(this.events.flatMap((event) => (event.kind === "attempt.started" && event.jobId === jobId ? [event.attemptId] : [])));
    return this.events.find((event) => event.kind === "attempt.ended" && ids.has(event.attemptId) && event.outcome === "succeeded")?.seq ?? -1;
  }
}
