import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { Evidence, ProcessRecord, WorktreeIdentity } from "../../shared/run";
import { LABELS, METADATA_KEY, type AgentPort, type AgentStatus, type CreateAgentInput } from "../agent-port";
import { ChecksUnconfirmedError, type CheckBatch, type RunChecksInput } from "../check-runner";
import type { ProcessPort, ProcessState } from "../process-port";
import type { RunDriverDeps } from "../run-driver";
import type { ScratchCopyResult } from "../scratch-copy";

export type FakeAgent = {
  id: string;
  workspaceId: string;
  creationKey: string;
  input: CreateAgentInput;
  labels: Record<string, string>;
  metadata: Record<string, unknown>;
  status: AgentStatus;
  sent: string[];
};

type Never = { never: true };

/**
 * An in-memory Paseo host: workspaces, agents with labels and statuses, scripted creation and
 * interruption, worktree identities per directory, scripted check batches and recorded processes.
 */
export class FakeHost implements AgentPort {
  workspaces: Array<{ workspaceId: string; projectId: string; branchName: string; directory: string; runId: string }> = [];
  agents = new Map<string, FakeAgent>();
  calls = { createWorkspace: 0, createAgent: [] as string[], interrupt: [] as string[], findAgents: 0, findWorkspaces: 0 };
  lookups: "ok" | "unavailable" = "ok";
  /** How `createAgent` behaves: complete, throw, or register the agent and never answer (a crash before the binding). */
  onCreateAgent: (input: CreateAgentInput) => "ok" | "hang" | Error = () => "ok";
  onCreateWorkspace: () => "ok" | "hang" = () => "ok";
  /** How `interrupt` behaves: stop the turn, leave it running, or throw. */
  interruptMode: "stop" | "ignore" | "throw" = "stop";
  trees = new Map<string, WorktreeIdentity>();
  heads = new Map<string, string>();
  private next = 0;

  // ----- AgentPort

  createWorkspace(x: { projectId: string; branchName: string; runId: string }): Promise<{ workspaceId: string; directory: string }> {
    this.calls.createWorkspace += 1;
    const workspaceId = `wks_${String(++this.next).padStart(16, "0")}`;
    const directory = `/fake/${x.runId}`;
    this.workspaces.push({ workspaceId, projectId: x.projectId, branchName: x.branchName, directory, runId: x.runId });
    this.trees.set(directory, { headCommit: "base", indexTree: "i0", contentTree: "t0" });
    this.heads.set(directory, "base");
    if (this.onCreateWorkspace() === "hang") return new Promise<Never>(() => undefined).then(() => ({ workspaceId, directory }));
    return Promise.resolve({ workspaceId, directory });
  }

  findWorkspaces(x: { projectId: string; branchName: string }): Promise<Array<{ workspaceId: string; branchName: string; directory: string }> | "unavailable"> {
    this.calls.findWorkspaces += 1;
    if (this.lookups === "unavailable") return Promise.resolve("unavailable");
    return Promise.resolve(this.workspaces.filter((w) => w.projectId === x.projectId && w.branchName === x.branchName).map(({ workspaceId, branchName, directory }) => ({ workspaceId, branchName, directory })));
  }

  createAgent(input: CreateAgentInput): Promise<{ agentId: string }> {
    this.calls.createAgent.push(input.creationKey);
    const behaviour = this.onCreateAgent(input);
    if (behaviour instanceof Error) return Promise.reject(behaviour);
    const id = `agent-${++this.next}`;
    this.agents.set(id, {
      id,
      workspaceId: input.workspaceId,
      creationKey: input.creationKey,
      input,
      labels: { [LABELS.run]: input.runId, [LABELS.attempt]: input.attemptId, [LABELS.role]: input.role, [LABELS.key]: input.creationKey },
      metadata: { [METADATA_KEY]: { kind: "attempt", reservationId: input.reservationId, runId: input.runId, attemptId: input.attemptId, role: input.role, creationKey: input.creationKey } },
      status: "running",
      sent: [input.prompt],
    });
    if (behaviour === "hang") return new Promise<Never>(() => undefined).then(() => ({ agentId: id }));
    return Promise.resolve({ agentId: id });
  }

  findAgents(x: { workspaceId: string; creationKey: string }): Promise<string[] | "unavailable"> {
    this.calls.findAgents += 1;
    if (this.lookups === "unavailable") return Promise.resolve("unavailable");
    return Promise.resolve([...this.agents.values()].filter((agent) => agent.labels[LABELS.key] === x.creationKey).map((agent) => agent.id));
  }

  status(agentId: string): Promise<AgentStatus | null> {
    return Promise.resolve(this.agents.get(agentId)?.status ?? null);
  }

  send(agentId: string, text: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new Error("unknown agent"));
    agent.sent.push(text);
    agent.status = "running";
    return Promise.resolve();
  }

  interrupt(agentId: string): Promise<AgentStatus | null> {
    this.calls.interrupt.push(agentId);
    const agent = this.agents.get(agentId);
    if (this.interruptMode === "throw") return Promise.reject(new Error("interrupt failed"));
    if (agent && this.interruptMode === "stop" && agent.status === "running") agent.status = "idle";
    return Promise.resolve(agent?.status ?? null);
  }

  // ----- helpers for tests

  agentFor(creationKey: string): FakeAgent | undefined {
    return [...this.agents.values()].find((agent) => agent.creationKey === creationKey);
  }

  agentsFor(creationKey: string): FakeAgent[] {
    return [...this.agents.values()].filter((agent) => agent.creationKey === creationKey);
  }

  /** The hook event for the end of an agent's turn; the agent becomes idle. */
  turnEnded(agentId: string, outcome: PluginTurnOutcome = { kind: "completed" }): { agent: { id: string; metadata: Record<string, unknown> }; turnId: string | null; outcome: PluginTurnOutcome } {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    agent.status = "idle";
    return { agent: { id: agent.id, metadata: agent.metadata }, turnId: `turn-${++this.next}`, outcome };
  }

  /** A worktree write by the agent working in `directory`. */
  write(directory: string): void {
    const tree = this.trees.get(directory) ?? { headCommit: "base", indexTree: "i0", contentTree: "t0" };
    this.trees.set(directory, { ...tree, contentTree: `t${++this.next}` });
  }

  identity = (dir: string): Promise<WorktreeIdentity> => {
    const tree = this.trees.get(dir);
    return tree ? Promise.resolve({ ...tree }) : Promise.reject(new Error(`no worktree at ${dir}`));
  };

  headCommit = (dir: string): Promise<string> => Promise.resolve(this.heads.get(dir) ?? "base");
}

export type ScriptedCommand = {
  exitCode?: number;
  /** Holds the command until `release()` is called. */
  hold?: boolean;
  /** Called while the command runs. */
  during?: () => void;
};

/** Scripted check batches: records every launch, honours cancel, reports evidence like the real runner. */
export class FakeChecks {
  batches: Array<{ input: RunChecksInput; cancelled: boolean; release: () => void; done: Promise<Evidence[]> }> = [];
  script: (input: RunChecksInput, index: number) => ScriptedCommand = () => ({});
  /** What a cancel reports, and after how long. */
  cancelResult: { exited: boolean; delayMs: number } = { exited: true, delayMs: 0 };
  unconfirmedExit = false;
  activePeak = 0;
  active = 0;
  private pid = 5000;

  constructor(private readonly host: FakeHost) {}

  start = (input: RunChecksInput): CheckBatch => {
    let releaseHold: () => void = () => undefined;
    let cancelled = false;
    const entry = { input, cancelled: false, release: () => releaseHold(), done: Promise.resolve<Evidence[]>([]) };
    const run = async (): Promise<Evidence[]> => {
      this.active += 1;
      this.activePeak = Math.max(this.activePeak, this.active);
      try {
        const out: Evidence[] = [];
        for (const [index] of input.commands.entries()) {
          if (cancelled) return out;
          const pid = ++this.pid;
          await input.record({ index, process: { pid, pgid: pid, startedAt: `start-${pid}` } });
          const command = this.script(input, index);
          if (command.hold) await new Promise<void>((resolve) => (releaseHold = resolve));
          command.during?.();
          if (cancelled) return out;
          if (this.unconfirmedExit) {
            throw new ChecksUnconfirmedError([{ pid, pgid: pid, startedAt: `start-${pid}` }]);
          }
          const identity = input.mode === "exclusive" ? await this.host.identity(input.canonicalDir) : input.identity;
          const drift = identity.contentTree !== input.identity.contentTree || identity.headCommit !== input.identity.headCommit || identity.indexTree !== input.identity.indexTree;
          const code = command.exitCode ?? 0;
          out.push({ id: `${input.cycleId}:check:${index}`, attemptId: input.attemptId, cycleId: input.cycleId, kind: "check", item: index, result: drift ? "late" : code === 0 ? "pass" : "fail", mode: input.mode, exitCode: code, outputTail: "", identity, at: new Date().toISOString() });
          if (drift) return out;
        }
        return out;
      } finally {
        this.active -= 1;
      }
    };
    entry.done = run();
    this.batches.push(entry);
    return {
      done: entry.done,
      cancel: async () => {
        cancelled = true;
        entry.cancelled = true;
        releaseHold();
        await new Promise((resolve) => setTimeout(resolve, this.cancelResult.delayMs));
        await entry.done.catch(() => undefined);
        return { exited: this.cancelResult.exited };
      },
    };
  };
}

/** Recorded processes for recovery: their state and whether termination is observed. */
export class FakeProcesses implements Pick<ProcessPort, "processState" | "terminateRecorded" | "processAlive"> {
  states = new Map<number, ProcessState>();
  terminateExits = true;
  terminated: number[] = [];

  processState = (record: ProcessRecord): Promise<ProcessState> => Promise.resolve(this.states.get(record.pid) ?? "gone");
  processAlive = async (record: ProcessRecord): Promise<boolean> => (await this.processState(record)) !== "gone";
  terminateRecorded = (record: ProcessRecord): Promise<{ exited: boolean }> => {
    const state = this.states.get(record.pid) ?? "gone";
    if (state === "gone") return Promise.resolve({ exited: true });
    if (state === "unknown") return Promise.resolve({ exited: false });
    this.terminated.push(record.pid);
    if (this.terminateExits) this.states.set(record.pid, "gone");
    return Promise.resolve({ exited: this.terminateExits });
  };
}

export type FakeCopies = RunDriverDeps["copies"] & { created: string[]; removed: string[]; fail: boolean };

export function fakeCopies(): FakeCopies {
  const copies: FakeCopies = {
    created: [],
    removed: [],
    fail: false,
    create: (x): Promise<ScratchCopyResult> => {
      if (copies.fail) return Promise.resolve({ ok: false, reason: "synthetic copy failure" });
      copies.created.push(x.targetDir);
      return Promise.resolve({ ok: true, dir: x.targetDir });
    },
    remove: (dir) => {
      copies.removed.push(dir);
      return Promise.resolve();
    },
    removeAll: () => Promise.resolve(),
  };
  return copies;
}
