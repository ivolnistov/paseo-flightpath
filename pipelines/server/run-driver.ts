import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import { PipelineError } from "../shared/errors";
import type { AgentRole, Evidence, ProcessRecord, RunEvent, RunEventBody, RunSnapshot, WorktreeIdentity } from "../shared/run";
import { reservationOf, type AgentPort, type AgentStatus } from "./agent-port";
import { ChecksUnconfirmedError, settleIsolatedGroup, type CheckBatch, type RunChecksInput } from "./check-runner";
import { createKeyedLock } from "./keyed-lock";
import type { ReviewSubmission } from "./mcp-tools";
import type { ProcessPort } from "./process-port";
import { classifyProviderFailure, failureMessage } from "./provider-failure";
import { reconcile, type AgentFact, type HostFacts } from "./recovery";
import { providerFailed, resumeRun, retryStop as retryStopAction, submitReview, turnEnded, type ActionResult } from "./run-actions";
import { checkMode, currentCycle, decide, graphJob, nextBarrierId, reduce, replay, stampEvents, startedEvent, unfinishedChecks, type Effect, type RunState } from "./run-engine";
import type { JournalHealth, RunStore } from "./run-store";
import type { ScratchCopyResult } from "./scratch-copy";

export type DriverSettings = { checkTimeoutMs: number; maxOutputBytes: number; quiesceTimeoutMs: number };

export type RunDriverDeps = {
  store: RunStore;
  processes: Pick<ProcessPort, "processState" | "terminateRecorded">;
  identity(dir: string): Promise<WorktreeIdentity>;
  headCommit(dir: string): Promise<string>;
  checks(input: RunChecksInput): CheckBatch;
  copies: { create(x: { repoDir: string; contentTree: string; targetDir: string }): Promise<ScratchCopyResult>; remove(dir: string): Promise<void>; removeAll(dir: string): Promise<void> };
  /** `runs/<projectId>/<runId>/copies`. */
  copiesDir(projectId: string, runId: string): string;
  reservation(creationKey: string): string;
  settings(): DriverSettings;
  now(): Date;
  log(message: string): void;
  /** Proven host behaviour for a repeated creation key; false until a sandbox proves it. */
  idempotentCreate?: boolean;
  createTimeoutMs?: number;
  pollMs?: number;
  retryDelayMs?: number;
};

export type TurnEndedEvent = { agent: { id: string; metadata: Readonly<Record<string, unknown>> }; turnId: string | null; outcome: PluginTurnOutcome };
export type AgentGoneEvent = { agent: { id: string; metadata: Readonly<Record<string, unknown>> } };

/** Gives Accept and Approve the identity read inside the run's serialisation. */
export type ActionContext = { identity(): Promise<WorktreeIdentity> };
export type RunAction = (state: RunState, context: ActionContext) => ActionResult | Promise<ActionResult>;

export interface RunDriver {
  /** Supplies the host port from the first SDK context; recovers every live run before scheduling. */
  attach(agents: AgentPort): Promise<void>;
  /** Disk-only recovery that needs no SDK: recorded check processes are stopped where proved. */
  prepare(): Promise<void>;
  /** Registers a run whose snapshot was just written; it needs no reconciliation. */
  register(snapshot: RunSnapshot): Promise<void>;
  tick(runId: string): Promise<void>;
  read(runId: string): Promise<RunState>;
  health(runId: string): Promise<JournalHealth | "faulted">;
  /** State and health for listing; a run not already loaded is replayed from disk without being kept. */
  peek(runId: string): Promise<{ state: RunState; health: JournalHealth | "faulted" }>;
  act(runId: string, action: RunAction): Promise<ActionResult>;
  retryStop(runId: string): Promise<ActionResult>;
  /** Resume; a run paused with `binding_unknown` repeats its reconciliation instead. */
  resume(runId: string): Promise<ActionResult>;
  bindFromGrant(runId: string, attemptId: string, role: AgentRole, agentId: string): Promise<void>;
  holdReview(runId: string, submission: ReviewSubmission): Promise<ActionResult>;
  onTurnEnded(event: TurnEndedEvent): Promise<void>;
  onAgentGone(event: AgentGoneEvent): Promise<void>;
  recoverAll(): Promise<void>;
  subscribe(runId: string, listener: () => void): () => void;
  /** Resolves once no host work of the run is in flight, or the run stops progressing while it waits on the host. */
  idle(runId: string): Promise<void>;
}

type BarrierResult = { ok: boolean; message?: string };

/**
 * Overlapping isolated batches share one captured identity. Their results are held until every
 * member has drained; one canonical reading then decides them all.
 */
type IsolatedGroup = {
  identity: WorktreeIdentity;
  members: Map<string, { attemptId: string; status: "running" | "done" | "dropped" | "unconfirmed"; evidence: Evidence[] }>;
};

type Runtime = {
  runId: string;
  state: RunState;
  health: JournalHealth;
  faulted: string | null;
  recovered: boolean;
  executed: Set<string>;
  creating: Set<string>;
  createRejected: Set<string>;
  batches: Map<string, { batch: CheckBatch; cancelled: boolean }>;
  barrierResults: Map<string, BarrierResult>;
  heldReviews: Map<string, ReviewSubmission>;
  turns: Map<string, number>;
  gone: Set<string>;
  inflight: Set<Promise<unknown>>;
  stopping: Set<Promise<unknown>>;
  group: IsolatedGroup | null;
};

const ROLES: readonly AgentRole[] = ["worker", "reviewer"];

class TimeoutError extends Error {
  constructor() {
    super("The host call timed out.");
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function copyName(cycleId: string): string {
  return `${cycleId.replace(/[^A-Za-z0-9._-]/g, "_")}-${createHash("sha256").update(cycleId).digest("hex").slice(0, 8)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function workerPrompt(state: RunState, attemptId: string): string {
  const a = state.attempts[attemptId];
  const gj = a ? graphJob(state, a.jobId) : null;
  return `You are the worker of the Pipeline job "${gj?.name ?? "?"}" (${a?.jobId ?? "?"}, attempt ${a?.n ?? 0}). Call the pipeline_job_context tool first, do the work in this worktree, then call pipeline_job_complete.`;
}

export function reviewerPrompt(state: RunState, attemptId: string): string {
  const a = state.attempts[attemptId];
  const gj = a ? graphJob(state, a.jobId) : null;
  return `You are the reviewer of the Pipeline job "${gj?.name ?? "?"}" (${a?.jobId ?? "?"}). Call the pipeline_job_context tool first, do not edit files, then call pipeline_review_submit.`;
}

export const REMINDER_PROMPT = "Your turn ended without a Pipeline result. Finish the work, then call pipeline_job_complete (worker) or pipeline_review_submit (reviewer).";

/** Reviews acknowledged through MCP whose reviewer turn had not ended when the journal was written. */
function heldReviewsOf(events: readonly RunEvent[]): Map<string, ReviewSubmission> {
  const held = new Map<string, ReviewSubmission>();
  for (const event of events) {
    if (event.kind === "review.held") held.set(event.attemptId, { attemptId: event.attemptId, agentId: event.agentId, outcome: event.outcome, findings: event.findings, criteria: event.criteria });
    else if ((event.kind === "review.submitted" || event.kind === "attempt.ended") && held.has(event.attemptId)) held.delete(event.attemptId);
  }
  return held;
}

export function createRunDriver(deps: RunDriverDeps): RunDriver {
  const lock = createKeyedLock();
  const runtimes = new Map<string, Runtime>();
  const listeners = new Map<string, Set<() => void>>();
  const pollMs = deps.pollMs ?? 250;
  const createTimeoutMs = deps.createTimeoutMs ?? 120_000;
  const retryDelayMs = deps.retryDelayMs ?? 2_000;
  let agents: AgentPort | null = null;
  let attaching: Promise<void> | null = null;

  const notify = (runId: string): void => {
    for (const listener of listeners.get(runId) ?? []) {
      try {
        listener();
      } catch (error) {
        deps.log(`run listener failed: ${message(error)}`);
      }
    }
  };

  async function load(runId: string): Promise<Runtime> {
    const known = runtimes.get(runId);
    if (known) return known;
    const loaded = await deps.store.load(runId);
    const rt: Runtime = {
      runId,
      state: replay(loaded.snapshot, loaded.events),
      health: loaded.health,
      faulted: loaded.health === "journal_corrupt" ? "journal_corrupt" : null,
      recovered: false,
      executed: new Set(),
      creating: new Set(),
      createRejected: new Set(),
      batches: new Map(),
      barrierResults: new Map(),
      heldReviews: heldReviewsOf(loaded.events),
      turns: new Map(),
      gone: new Set(),
      inflight: new Set(),
      stopping: new Set(),
      group: null,
    };
    runtimes.set(runId, rt);
    return rt;
  }

  const healthOf = (rt: Runtime): JournalHealth | "faulted" => (rt.faulted !== null && rt.health === "ok" ? "faulted" : rt.health);

  const locked = <T>(runId: string, work: (rt: Runtime) => Promise<T>): Promise<T> => lock.run(runId, async () => work(await load(runId)));

  /** Validates, appends and folds bodies in order. A failed append faults the run. */
  async function append(rt: Runtime, bodies: readonly RunEventBody[]): Promise<RunEvent[]> {
    if (rt.faulted !== null) throw new PipelineError("run_faulted", `Run ${rt.runId} is not writable: ${rt.faulted}.`);
    if (bodies.length === 0) return [];
    const events = stampEvents(rt.state, bodies, deps.now().toISOString());
    let next = rt.state;
    for (const event of events) next = reduce(next, event);
    let state = rt.state;
    for (const event of events) {
      try {
        await deps.store.append(rt.runId, event);
      } catch (error) {
        rt.faulted = message(error);
        rt.state = state;
        throw error;
      }
      state = reduce(state, event);
    }
    rt.state = state;
    notify(rt.runId);
    return events;
  }

  /** Runs async host work outside the lock; its completion re-enters through `complete`. */
  function spawn(rt: Runtime, work: () => Promise<void>, bounded = false): void {
    const promise = work().catch((error: unknown) => deps.log(`run ${rt.runId}: ${message(error)}`));
    rt.inflight.add(promise);
    if (bounded) rt.stopping.add(promise);
    void promise.finally(() => {
      rt.inflight.delete(promise);
      rt.stopping.delete(promise);
    });
  }

  async function complete(runId: string, work: (rt: Runtime) => Promise<void>): Promise<void> {
    await locked(runId, work);
    await tick(runId);
  }

  function retryLater(rt: Runtime, key: string): void {
    setTimeout(() => {
      rt.executed.delete(key);
      void tick(rt.runId);
    }, retryDelayMs);
  }

  const settled = (status: AgentStatus | null): boolean => status === "idle" || status === "closed";

  async function bindAgent(rt: Runtime, attemptId: string, role: AgentRole, agentId: string): Promise<void> {
    const a = rt.state.attempts[attemptId];
    const binding = a?.roles[role]?.binding;
    if (!a || !binding) return;
    if (binding.agentId === agentId) return;
    if (binding.agentId === null) {
      await append(rt, [{ kind: "attempt.agent_bound", attemptId, role, agentId }]);
      return;
    }
    deps.log(`run ${rt.runId}: a second agent ${agentId} carries the key ${binding.creationKey}`);
    const bodies: RunEventBody[] = [];
    const stopping = a.stopping !== null && rt.state.barriers.some((barrier) => barrier.barrierId === a.stopping && barrier.status !== "confirmed");
    if (a.endedAt === null && !stopping) bodies.push({ kind: "quiesce.started", barrierId: nextBarrierId(rt.state), attempts: [attemptId], cause: "recovery", agents: [{ attemptId, role, agentId }] });
    if (rt.state.pause !== "binding_unknown") bodies.push({ kind: "run.paused", reason: "binding_unknown" });
    await append(rt, bodies);
  }

  async function pauseUnknown(rt: Runtime): Promise<void> {
    if (rt.state.pause !== "binding_unknown" && !rt.state.finished && !rt.state.cancelled) await append(rt, [{ kind: "run.paused", reason: "binding_unknown" }]);
  }

  // -------------------------------------------------------------------------------------------
  // host effects

  function dispatch(rt: Runtime, effect: Effect): void {
    const port = agents;
    if (port === null) return;
    rt.executed.add(effect.key);
    switch (effect.kind) {
      case "create_workspace": {
        const projectId = rt.state.snapshot.projectId;
        spawn(rt, async () => {
          const created = port.createWorkspace({ projectId, branchName: effect.branchName, runId: rt.runId });
          try {
            const { workspaceId, directory } = await withTimeout(created, createTimeoutMs);
            const baseCommit = await deps.headCommit(directory);
            await complete(rt.runId, (latest) => append(latest, [{ kind: "workspace.bound", workspaceId, directory, baseCommit }]).then(() => undefined));
          } catch (error) {
            deps.log(`run ${rt.runId}: workspace creation unresolved: ${message(error)}`);
            await complete(rt.runId, pauseUnknown);
            if (error instanceof TimeoutError) {
              const late = await created.catch(() => null);
              if (late) {
                const baseCommit = await deps.headCommit(late.directory);
                await complete(rt.runId, async (latest) => {
                  if (latest.state.workspace?.workspaceId === null) await append(latest, [{ kind: "workspace.bound", workspaceId: late.workspaceId, directory: late.directory, baseCommit }]);
                });
              }
            }
          }
        });
        return;
      }
      case "create_agent": {
        const workspaceId = rt.state.workspace?.workspaceId;
        if (!workspaceId) return;
        const prompt = effect.role === "worker" ? workerPrompt(rt.state, effect.attemptId) : reviewerPrompt(rt.state, effect.attemptId);
        const gj = graphJob(rt.state, effect.jobId);
        rt.creating.add(effect.creationKey);
        spawn(rt, async () => {
          const created = port.createAgent({
            workspaceId,
            runId: rt.runId,
            attemptId: effect.attemptId,
            role: effect.role,
            creationKey: effect.creationKey,
            title: `Pipeline: ${gj.name} (${effect.role})`,
            agent: effect.settings,
            reservationId: deps.reservation(effect.creationKey),
            prompt,
          });
          try {
            const { agentId } = await withTimeout(created, createTimeoutMs);
            await complete(rt.runId, (latest) => bindAgent(latest, effect.attemptId, effect.role, agentId));
          } catch (error) {
            const kind = error instanceof TimeoutError ? null : classifyProviderFailure(error);
            if (kind !== null) {
              rt.createRejected.add(effect.creationKey);
              await complete(rt.runId, async (latest) => {
                const result = providerFailed(latest.state, {
                  attemptId: effect.attemptId,
                  role: effect.role,
                  failure: { provider: effect.settings.provider, model: effect.settings.model, class: kind, message: failureMessage(error), at: deps.now().toISOString() },
                });
                if (result.ok) await append(latest, result.events);
              });
              return;
            }
            deps.log(`run ${rt.runId}: agent creation ${effect.creationKey} unresolved: ${message(error)}`);
            await complete(rt.runId, pauseUnknown);
            if (error instanceof TimeoutError) {
              const late = await created.catch(() => null);
              if (late) await complete(rt.runId, (latest) => bindAgent(latest, effect.attemptId, effect.role, late.agentId));
            }
          } finally {
            rt.creating.delete(effect.creationKey);
          }
        });
        return;
      }
      case "run_checks":
        spawn(rt, () => runCheckBatch(rt, effect));
        return;
      case "remind":
        spawn(rt, async () => {
          try {
            await port.send(effect.agentId, REMINDER_PROMPT);
            await complete(rt.runId, (latest) => append(latest, [{ kind: "agent.reminded", attemptId: effect.attemptId, role: effect.role }]).then(() => undefined));
          } catch (error) {
            deps.log(`run ${rt.runId}: reminder failed: ${message(error)}`);
            retryLater(rt, effect.key);
          }
        });
        return;
      case "request_review":
        spawn(rt, async () => {
          try {
            await port.send(effect.agentId, `A new verification cycle (${effect.cycleId}) is ready. ${reviewerPrompt(rt.state, effect.attemptId)}`);
          } catch (error) {
            deps.log(`run ${rt.runId}: review request failed: ${message(error)}`);
            retryLater(rt, effect.key);
          }
        });
        return;
      case "interrupt_agent":
        spawn(rt, async () => {
          const result = await stopAgent(rt, port, effect.agentId);
          rt.barrierResults.set(effect.key, result);
          await tick(rt.runId);
        }, true);
        return;
      case "cancel_checks":
        spawn(rt, async () => {
          const result = await cancelChecks(rt, effect.cycleId, effect.processes);
          rt.barrierResults.set(effect.key, result);
          await tick(rt.runId);
        }, true);
        return;
      case "record":
      case "start_attempt":
      case "open_cycle":
      case "finish_run":
        return;
    }
  }

  /** Confirms a turn ended: an observed non-running status, a turn end after the stop began, or a closed agent. */
  async function stopAgent(rt: Runtime, port: AgentPort, agentId: string): Promise<BarrierResult> {
    const mark = rt.turns.get(agentId) ?? 0;
    const deadline = Date.now() + deps.settings().quiesceTimeoutMs;
    const ended = (): boolean => rt.gone.has(agentId) || (rt.turns.get(agentId) ?? 0) > mark;
    try {
      if (ended()) return { ok: true };
      if (settled(await withTimeout(port.interrupt(agentId), deps.settings().quiesceTimeoutMs))) return { ok: true };
      while (Date.now() < deadline) {
        await sleep(pollMs);
        if (ended()) return { ok: true };
        if (settled(await port.status(agentId))) return { ok: true };
      }
      return { ok: false, message: `Agent ${agentId} did not stop within the quiescence timeout.` };
    } catch (error) {
      return { ok: false, message: `Stopping agent ${agentId} failed: ${message(error)}` };
    }
  }

  /** An in-process batch is cancelled first; every recorded process must then be proved gone or stopped. */
  async function cancelChecks(rt: Runtime, cycleId: string | null, processes: readonly ProcessRecord[]): Promise<BarrierResult> {
    try {
      const running = cycleId === null ? undefined : rt.batches.get(cycleId);
      if (running) {
        running.cancelled = true;
        const result = await running.batch.cancel();
        if (!result.exited) return { ok: false, message: "A check process group did not exit." };
      }
      for (const record of processes) {
        const result = await deps.processes.terminateRecorded(record);
        if (!result.exited) return { ok: false, message: `Check process ${record.pid} could not be confirmed stopped.` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `Cancelling checks failed: ${message(error)}` };
    }
  }

  async function runCheckBatch(rt: Runtime, effect: Extract<Effect, { kind: "run_checks" }>): Promise<void> {
    const directory = rt.state.workspace?.directory;
    const cycle = rt.state.cycles[effect.cycleId];
    if (!directory || !cycle) return;
    const settings = deps.settings();
    let copyDir: string | undefined;
    if (effect.mode === "isolated") {
      const target = join(deps.copiesDir(rt.state.snapshot.projectId, rt.runId), copyName(effect.cycleId));
      const copy = await deps.copies.create({ repoDir: directory, contentTree: cycle.identity.contentTree, targetDir: target });
      if (!copy.ok) {
        deps.log(`run ${rt.runId}: scratch copy failed, checks fall back to exclusive mode: ${copy.reason}`);
        await complete(rt.runId, async (latest) => {
          await append(latest, [
            { kind: "checks.started", attemptId: effect.attemptId, cycleId: effect.cycleId, mode: "isolated", count: effect.commands.length },
            { kind: "cycle.invalidated", cycleId: effect.cycleId, explained: true, reason: "copy_failed" },
          ]);
        });
        return;
      }
      copyDir = copy.dir;
    }
    const holder: { entry: { batch: CheckBatch; cancelled: boolean } | null } = { entry: null };
    await locked(rt.runId, async (latest) => {
      try {
        await append(latest, [{ kind: "checks.started", attemptId: effect.attemptId, cycleId: effect.cycleId, mode: effect.mode, count: effect.commands.length }]);
      } catch (error) {
        deps.log(`run ${rt.runId}: checks of ${effect.cycleId} not started: ${message(error)}`);
        return;
      }
      const batch = deps.checks({
        canonicalDir: directory,
        attemptId: effect.attemptId,
        cycleId: effect.cycleId,
        identity: cycle.identity,
        mode: effect.mode,
        ...(copyDir === undefined ? {} : { copyDir }),
        commands: effect.commands,
        timeoutMs: settings.checkTimeoutMs,
        maxBytes: settings.maxOutputBytes,
        record: (launch) =>
          locked(rt.runId, async (current) => {
            await append(current, [{ kind: "check.launched", attemptId: effect.attemptId, cycleId: effect.cycleId, index: launch.index, pid: launch.process.pid, pgid: launch.process.pgid, startedAt: launch.process.startedAt }]);
          }),
      });
      holder.entry = { batch, cancelled: false };
      latest.batches.set(effect.cycleId, holder.entry);
      if (effect.mode === "isolated") {
        latest.group ??= { identity: cycle.identity, members: new Map() };
        latest.group.members.set(effect.cycleId, { attemptId: effect.attemptId, status: "running", evidence: [] });
      }
    });
    const started = holder.entry;
    if (started === null) {
      if (copyDir !== undefined) await deps.copies.remove(copyDir).catch(() => undefined);
      await tick(rt.runId);
      return;
    }
    let keepCopy = false;
    try {
      const evidence = await started.batch.done;
      await complete(rt.runId, async (latest) => {
        const member = effect.mode === "isolated" ? latest.group?.members.get(effect.cycleId) : undefined;
        if (member) {
          member.status = started.cancelled ? "dropped" : "done";
          member.evidence = evidence;
          await settleGroup(latest);
          return;
        }
        const c = latest.state.cycles[effect.cycleId];
        if (started.cancelled || !c || c.status !== "open") return;
        await append(latest, evidence.map((item) => ({ kind: "evidence.recorded" as const, evidence: item })));
      });
    } catch (error) {
      if (error instanceof ChecksUnconfirmedError) {
        keepCopy = true;
        await complete(rt.runId, async (latest) => {
          const bodies: RunEventBody[] = [];
          const c = latest.state.cycles[effect.cycleId];
          if (c && c.status === "open") bodies.push({ kind: "cycle.invalidated", cycleId: effect.cycleId, explained: true, reason: "check_exit_unconfirmed" });
          const a = latest.state.attempts[effect.attemptId];
          const stopping = a?.stopping != null && latest.state.barriers.some((barrier) => barrier.barrierId === a.stopping && barrier.status !== "confirmed");
          if (a && a.endedAt === null && !stopping) bodies.push({ kind: "quiesce.started", barrierId: nextBarrierId(latest.state), attempts: [effect.attemptId], cause: "recovery" });
          await append(latest, bodies);
          const member = latest.group?.members.get(effect.cycleId);
          if (member) {
            member.status = "unconfirmed";
            await settleGroup(latest);
          }
        });
      } else {
        deps.log(`run ${rt.runId}: checks of ${effect.cycleId} failed to run: ${message(error)}`);
        await complete(rt.runId, async (latest) => {
          const c = latest.state.cycles[effect.cycleId];
          if (c && c.status === "open" && !started.cancelled) await append(latest, [{ kind: "cycle.invalidated", cycleId: effect.cycleId, explained: true, reason: "checks_not_run" }]);
          const member = latest.group?.members.get(effect.cycleId);
          if (member) {
            member.status = "dropped";
            await settleGroup(latest);
          }
        });
      }
    } finally {
      rt.batches.delete(effect.cycleId);
      if (copyDir !== undefined && !keepCopy) await deps.copies.remove(copyDir).catch((error: unknown) => deps.log(`copy removal failed: ${message(error)}`));
    }
  }

  /**
   * Decides a drained isolated group with one canonical reading: drift marks every held result
   * `late`. A member whose process exit was not observed makes the whole group unprovable, so the
   * other members' cycles are invalidated instead and rerun exclusive.
   */
  async function settleGroup(rt: Runtime): Promise<void> {
    const group = rt.group;
    if (group === null || [...group.members.values()].some((member) => member.status === "running")) return;
    rt.group = null;
    const held = [...group.members.entries()].filter(([cycleId, member]) => {
      const c = rt.state.cycles[cycleId];
      const a = rt.state.attempts[member.attemptId];
      return member.status === "done" && c?.status === "open" && a !== undefined && a.endedAt === null && a.stopping === null;
    });
    if (held.length === 0) return;
    const invalidate = (reason: string): Promise<RunEvent[]> => append(rt, held.map(([cycleId]) => ({ kind: "cycle.invalidated" as const, cycleId, explained: true, reason })));
    if ([...group.members.values()].some((member) => member.status === "unconfirmed")) {
      await invalidate("group_exit_unconfirmed");
      return;
    }
    const directory = rt.state.workspace?.directory;
    let canonical: WorktreeIdentity;
    try {
      if (!directory) throw new Error("The run has no worktree.");
      canonical = await deps.identity(directory);
    } catch (error) {
      deps.log(`run ${rt.runId}: isolated group identity read failed: ${message(error)}`);
      await invalidate("group_identity_unreadable");
      return;
    }
    const bodies: RunEventBody[] = [];
    for (const [, member] of held) {
      for (const item of settleIsolatedGroup(member.evidence, group.identity, canonical)) bodies.push({ kind: "evidence.recorded", evidence: item });
    }
    await append(rt, bodies);
  }

  // -------------------------------------------------------------------------------------------
  // barriers

  /** Records the end of a pending barrier once every stop effect has reported. */
  async function settleBarriers(rt: Runtime, effects: readonly Effect[]): Promise<boolean> {
    for (const barrier of rt.state.barriers) {
      if (barrier.status !== "pending") continue;
      const keys = effects.filter((effect) => (effect.kind === "interrupt_agent" || effect.kind === "cancel_checks") && effect.barrierId === barrier.barrierId).map((effect) => effect.key);
      if (keys.some((key) => !rt.executed.has(key) || !rt.barrierResults.has(key))) continue;
      let waiting = false;
      let unresolved: string | null = null;
      for (const id of barrier.attempts) {
        for (const role of ROLES) {
          const binding = rt.state.attempts[id]?.roles[role]?.binding;
          if (!binding || binding.agentId !== null) continue;
          if (rt.creating.has(binding.creationKey)) waiting = true;
          else if (!rt.createRejected.has(binding.creationKey)) unresolved = `The ${role} of ${id} has no known agent.`;
        }
      }
      if (waiting) continue;
      const failed = keys.map((key) => rt.barrierResults.get(key)).find((result) => result !== undefined && !result.ok);
      for (const key of keys) {
        rt.barrierResults.delete(key);
        rt.executed.delete(key);
      }
      if (failed || unresolved !== null) {
        await append(rt, [{ kind: "quiesce.unconfirmed", barrierId: barrier.barrierId, message: failed?.message ?? unresolved ?? "unconfirmed" }]);
      } else {
        await append(rt, [{ kind: "quiesce.confirmed", barrierId: barrier.barrierId }]);
      }
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // scheduling

  async function step(rt: Runtime): Promise<void> {
    for (let round = 0; round < 500; round += 1) {
      if (rt.faulted !== null || !rt.recovered || agents === null) return;
      const effects = decide(rt.state);
      const [first] = effects;
      if (first?.kind === "record") {
        await append(rt, first.events);
        continue;
      }
      let changed = false;
      for (const effect of effects) {
        if (rt.executed.has(effect.key)) continue;
        if (effect.kind === "start_attempt") {
          await append(rt, [startedEvent(effect)]);
          changed = true;
          break;
        }
        if (effect.kind === "finish_run") {
          await append(rt, [{ kind: "run.finished", cycleId: effect.cycleId }]);
          changed = true;
          break;
        }
        if (effect.kind === "open_cycle") {
          const directory = rt.state.workspace?.directory;
          if (!directory) continue;
          rt.executed.add(effect.key);
          let identity: WorktreeIdentity;
          const opening = effect.scope === "finish" ? undefined : rt.state.attempts[effect.scope.attemptId];
          const joinsGroup = rt.group !== null && opening !== undefined && checkMode(rt.state, graphJob(rt.state, opening.jobId)) === "isolated";
          try {
            identity = joinsGroup && rt.group ? rt.group.identity : await deps.identity(directory);
          } catch (error) {
            deps.log(`run ${rt.runId}: identity read failed: ${message(error)}`);
            retryLater(rt, effect.key);
            continue;
          }
          await append(rt, [{ kind: "cycle.opened", cycleId: effect.cycleId, attemptId: effect.scope === "finish" ? null : effect.scope.attemptId, identity }]);
          changed = true;
          break;
        }
        dispatch(rt, effect);
      }
      if (changed) continue;
      if (await settleBarriers(rt, effects)) continue;
      return;
    }
    deps.log(`run ${rt.runId}: scheduling did not settle`);
  }

  async function tick(runId: string): Promise<void> {
    await locked(runId, async (rt) => {
      try {
        await step(rt);
      } catch (error) {
        deps.log(`run ${runId}: ${message(error)}`);
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // recovery

  async function hostFacts(rt: Runtime, port: AgentPort): Promise<{ facts: HostFacts; live: ProcessRecord[] }> {
    const state = rt.state;
    const agentFacts = new Map<string, AgentFact>();
    const ids = new Set<string>();
    for (const a of Object.values(state.attempts)) {
      if (a.endedAt !== null) continue;
      for (const role of ROLES) {
        const agentId = a.roles[role]?.binding.agentId;
        if (agentId) ids.add(agentId);
      }
    }
    for (const barrier of state.barriers) for (const ref of barrier.agents) ids.add(ref.agentId);

    let workspaces: HostFacts["workspaces"] = [];
    const branchName = state.workspace?.branchName ?? `flightpath/run-${rt.runId}`;
    if (state.workspace === null || state.workspace.workspaceId === null) {
      const found = await port.findWorkspaces({ projectId: state.snapshot.projectId, branchName, runId: rt.runId });
      if (found === "unavailable") workspaces = "unavailable";
      else {
        const list: Exclude<HostFacts["workspaces"], "unavailable"> = [];
        for (const workspace of found) {
          try {
            list.push({ ...workspace, baseCommit: await deps.headCommit(workspace.directory) });
          } catch {
            workspaces = "unavailable";
          }
        }
        if (workspaces !== "unavailable") workspaces = list;
      }
    }

    let byKey: Map<string, string[]> | "unavailable" = new Map();
    const workspaceId = state.workspace?.workspaceId ?? null;
    for (const a of Object.values(state.attempts)) {
      if (a.endedAt !== null) continue;
      for (const role of ROLES) {
        const binding = a.roles[role]?.binding;
        if (!binding || binding.agentId !== null || byKey === "unavailable") continue;
        if (workspaceId === null) continue;
        const found = await port.findAgents({ workspaceId, creationKey: binding.creationKey });
        if (found === "unavailable") byKey = "unavailable";
        else {
          byKey.set(binding.creationKey, found);
          for (const id of found) ids.add(id);
        }
      }
    }
    for (const id of ids) {
      const status = rt.gone.has(id) ? "closed" : await port.status(id);
      if (status !== null) agentFacts.set(id, status);
    }

    const live: ProcessRecord[] = [];
    for (const a of Object.values(state.attempts)) {
      if (a.endedAt !== null) continue;
      for (const record of unfinishedChecks(state, a.attemptId).records) {
        const stateOf = await deps.processes.processState(record);
        if (stateOf === "gone") continue;
        if (stateOf === "alive" && (await deps.processes.terminateRecorded(record)).exited) continue;
        live.push(record);
      }
    }
    return {
      facts: { agents: agentFacts, workspaces, agentsByKey: byKey, liveCheckGroups: new Set(live.map((record) => `${record.pid}:${record.startedAt}`)), idempotentCreate: deps.idempotentCreate ?? false },
      live,
    };
  }

  /** Submits a held review once its reviewer's turn has ended, with the identity read now. */
  async function submitHeld(rt: Runtime, attemptId: string, agentId: string): Promise<void> {
    const held = rt.heldReviews.get(attemptId);
    if (!held || held.agentId !== agentId) return;
    rt.heldReviews.delete(attemptId);
    const directory = rt.state.workspace?.directory;
    if (!directory) return;
    try {
      const identity = await deps.identity(directory);
      const result = submitReview(rt.state, { ...held, identity });
      if (result.ok) await append(rt, result.events);
      else deps.log(`run ${rt.runId}: held review refused: ${result.code}`);
    } catch (error) {
      deps.log(`run ${rt.runId}: review identity read failed: ${message(error)}`);
    }
  }

  async function reconcileRun(rt: Runtime, port: AgentPort): Promise<void> {
    const { facts, live } = await hostFacts(rt, port);
    // An idle reviewer has ended the turn in which its held review was acknowledged.
    for (const [attemptId, held] of [...rt.heldReviews]) {
      const a = rt.state.attempts[attemptId];
      if (!a || a.endedAt !== null || a.roles.reviewer?.binding.agentId !== held.agentId || facts.agents.get(held.agentId) !== "idle") continue;
      await submitHeld(rt, attemptId, held.agentId);
      if (rt.state.attempts[attemptId]?.endedAt === null) await append(rt, turnEnded(rt.state, { attemptId, agentId: held.agentId, result: "completed" }));
    }
    const events = reconcile(rt.state, facts, deps.now().toISOString());
    await append(
      rt,
      events.map(({ seq: _seq, id: _id, at: _at, ...body }) => body),
    );
    if (live.length === 0) await deps.copies.removeAll(deps.copiesDir(rt.state.snapshot.projectId, rt.runId)).catch((error: unknown) => deps.log(`copy cleanup failed: ${message(error)}`));
  }

  async function recoverRun(runId: string, port: AgentPort): Promise<void> {
    await locked(runId, async (rt) => {
      if (rt.recovered || rt.faulted !== null) return;
      try {
        await reconcileRun(rt, port);
        rt.recovered = true;
      } catch (error) {
        deps.log(`run ${runId}: recovery failed: ${message(error)}`);
      }
    });
  }

  async function recoverAll(): Promise<void> {
    const port = agents;
    if (port === null) return;
    for (const run of await deps.store.listLive()) {
      await recoverRun(run.runId, port);
      await tick(run.runId);
    }
  }

  // -------------------------------------------------------------------------------------------
  // events from the host

  async function routeAgent(agent: { id: string; metadata: Readonly<Record<string, unknown>> }): Promise<{ runId: string; attemptId: string; role: AgentRole } | null> {
    const reservation = reservationOf(agent.metadata);
    if (reservation?.kind !== "attempt") return null;
    try {
      await locked(reservation.runId, () => Promise.resolve());
    } catch {
      return null;
    }
    return { runId: reservation.runId, attemptId: reservation.attemptId, role: reservation.role };
  }

  return {
    async attach(port) {
      agents = port;
      // Concurrent attaches share one recovery; a failed one is retried by the next attach.
      attaching ??= recoverAll().catch((error: unknown) => {
        attaching = null;
        throw error;
      });
      await attaching;
    },

    async prepare() {
      for (const run of await deps.store.listLive()) {
        await locked(run.runId, async (rt) => {
          for (const a of Object.values(rt.state.attempts)) {
            if (a.endedAt !== null) continue;
            for (const record of unfinishedChecks(rt.state, a.attemptId).records) {
              if ((await deps.processes.processState(record)) === "alive") await deps.processes.terminateRecorded(record);
            }
          }
        }).catch((error: unknown) => deps.log(`run ${run.runId}: preparation failed: ${message(error)}`));
      }
    },

    async register(snapshot) {
      await locked(snapshot.runId, (rt) => {
        rt.recovered = true;
        return Promise.resolve();
      });
    },

    tick,

    read: (runId) => locked(runId, (rt) => Promise.resolve(rt.state)),

    health: (runId) => locked(runId, (rt) => Promise.resolve(healthOf(rt))),
    peek: (runId) =>
      lock.run(runId, async () => {
        const known = runtimes.get(runId);
        if (known) return { state: known.state, health: healthOf(known) };
        const loaded = await deps.store.load(runId);
        return { state: replay(loaded.snapshot, loaded.events), health: loaded.health };
      }),

    async act(runId, action) {
      const result = await locked(runId, async (rt) => {
        const outcome = await action(rt.state, {
          identity: () => {
            const directory = rt.state.workspace?.directory;
            if (!directory) return Promise.reject(new PipelineError("workspace_unbound", "The run has no worktree yet."));
            return deps.identity(directory);
          },
        });
        await append(rt, outcome.events);
        return outcome;
      });
      await tick(runId);
      return result;
    },

    async retryStop(runId) {
      const result = await locked(runId, async (rt) => {
        const outcome = retryStopAction(rt.state);
        if (!outcome.ok) return outcome;
        const port = agents;
        const workspaceId = rt.state.workspace?.workspaceId;
        if (port && workspaceId) {
          for (const barrier of rt.state.barriers) {
            if (barrier.status !== "unconfirmed") continue;
            for (const id of barrier.attempts) {
              for (const role of ROLES) {
                const binding = rt.state.attempts[id]?.roles[role]?.binding;
                if (!binding || binding.agentId !== null) continue;
                const found = await port.findAgents({ workspaceId, creationKey: binding.creationKey });
                const [only] = found === "unavailable" ? [] : found;
                if (found !== "unavailable" && found.length === 1 && only) await append(rt, [{ kind: "attempt.agent_bound", attemptId: id, role, agentId: only }]);
              }
            }
          }
        }
        await append(rt, outcome.events);
        return outcome;
      });
      await tick(runId);
      return result;
    },

    async resume(runId) {
      const result = await locked(runId, async (rt): Promise<ActionResult> => {
        if (rt.state.pause === "binding_unknown") {
          const port = agents;
          if (port === null) return { ok: false, code: "host_unavailable", message: "The host is not connected yet.", events: [] };
          await reconcileRun(rt, port);
          rt.recovered = true;
          return { ok: true, events: [] };
        }
        const outcome = resumeRun(rt.state);
        await append(rt, outcome.events);
        return outcome;
      });
      await tick(runId);
      return result;
    },

    async bindFromGrant(runId, attemptId, role, agentId) {
      await locked(runId, (rt) => bindAgent(rt, attemptId, role, agentId));
    },

    holdReview(runId, submission) {
      return locked(runId, async (rt): Promise<ActionResult> => {
        const a = rt.state.attempts[submission.attemptId];
        if (!a || a.endedAt !== null || a.stopping !== null || a.outcome !== null || a.roles.reviewer?.binding.agentId !== submission.agentId) {
          return { ok: false, code: "stale_attempt", message: "The attempt is no longer current.", events: [] };
        }
        // Journaled before the acknowledgement so a restart before the turn ends keeps it.
        const events = await append(rt, [{ kind: "review.held", ...submission }]);
        rt.heldReviews.set(submission.attemptId, submission);
        return { ok: true, events };
      });
    },

    async onTurnEnded(event) {
      const route = await routeAgent(event.agent);
      if (!route) return;
      await locked(route.runId, async (rt) => {
        rt.turns.set(event.agent.id, (rt.turns.get(event.agent.id) ?? 0) + 1);
        const a = rt.state.attempts[route.attemptId];
        const binding = a?.roles[route.role]?.binding;
        if (!a || !binding) return;
        if (binding.agentId === null) await bindAgent(rt, route.attemptId, route.role, event.agent.id);
        if (rt.state.attempts[route.attemptId]?.roles[route.role]?.binding.agentId !== event.agent.id) return;
        if (route.role === "reviewer") await submitHeld(rt, route.attemptId, event.agent.id);
        const outcome = event.outcome;
        if (outcome.kind === "failed") {
          const kind = classifyProviderFailure(outcome.error);
          const latest = rt.state.attempts[route.attemptId];
          if (kind !== null && latest && latest.endedAt === null && latest.stopping === null) {
            const settings = latest.roles[route.role]?.binding.settings;
            const result = providerFailed(rt.state, {
              attemptId: route.attemptId,
              role: route.role,
              failure: { provider: settings?.provider ?? "unknown", model: settings?.model ?? "unknown", class: kind, message: failureMessage(outcome.error), at: deps.now().toISOString() },
            });
            if (result.ok) {
              await append(rt, result.events);
              return;
            }
          }
          await append(rt, turnEnded(rt.state, { attemptId: route.attemptId, agentId: event.agent.id, result: "failed", message: outcome.error.message.slice(0, 2_000) }));
          return;
        }
        await append(rt, turnEnded(rt.state, { attemptId: route.attemptId, agentId: event.agent.id, result: outcome.kind === "completed" ? "completed" : "cancelled" }));
      });
      await tick(route.runId);
    },

    async onAgentGone(event) {
      const route = await routeAgent(event.agent);
      if (!route) return;
      await locked(route.runId, async (rt) => {
        rt.gone.add(event.agent.id);
        const a = rt.state.attempts[route.attemptId];
        if (!a || a.endedAt !== null || a.stopping !== null) return;
        if (a.roles[route.role]?.binding.agentId !== event.agent.id) return;
        const current = currentCycle(rt.state, a);
        if (route.role === "reviewer" && current?.review) return;
        if (route.role === "worker" && a.outputs !== null && a.workerSettled) return;
        await append(rt, turnEnded(rt.state, { attemptId: route.attemptId, agentId: event.agent.id, result: "cancelled" }));
      });
      await tick(route.runId);
    },

    recoverAll,

    subscribe(runId, listener) {
      let set = listeners.get(runId);
      if (!set) {
        set = new Set();
        listeners.set(runId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(runId) === set) listeners.delete(runId);
      };
    },

    async idle(runId) {
      let quiet = 0;
      let last = -1;
      while (quiet < 3) {
        const rt = runtimes.get(runId);
        if (!rt) return;
        await lock.run(runId, () => Promise.resolve());
        if (rt.inflight.size === 0) return;
        if (rt.stopping.size > 0) {
          await Promise.allSettled([...rt.stopping]);
          quiet = 0;
          continue;
        }
        await Promise.race([Promise.allSettled([...rt.inflight]), sleep(20)]);
        quiet = rt.state.seq === last ? quiet + 1 : 0;
        last = rt.state.seq;
      }
    },
  };
}
