import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DiagnosticsError, PipelineError } from "../shared/errors";
import type { RunDetail, RunPreview, RunSummaryView } from "../shared/rpc";
import { canonicalJson } from "../shared/canonical";
import type { ProviderTarget, RunSnapshot, RunSnapshotBody } from "../shared/run";
import type { Diagnostic } from "../shared/workflow";
import type { AgentPort, AgentReservation } from "./agent-port";
import { jobChanges, type JobChanges } from "./changes";
import type { PipelineFs } from "./fs-port";
import { createKeyedLock, type KeyedLock } from "./keyed-lock";
import { projectPaths } from "./paths";
import { acceptJob, approveJob, cancelRun, grantReturn, pauseRun, requestChanges, retryJob, stopJob, type ActionResult } from "./run-actions";
import type { RunAction, RunDriver } from "./run-driver";
import { openBarriers, pauseReason, runStatus, toRunView, unfinishedChecks, type RunState } from "./run-engine";
import type { RunStore } from "./run-store";
import { resolveSettings, type HostCatalog } from "./settings-resolve";
import { parseStartInputs } from "./start-inputs";
import { expandWorkflow, resolveAgentSettings } from "./workflow-expand";
import { parseWorkflow } from "./workflow-parse";
import type { WorkflowStore } from "./workflow-store";
import { validateWorkflow } from "./workflow-validate";
import type { GitPort } from "./worktree-identity";

export type RunServiceDeps = {
  workflows: WorkflowStore;
  store: RunStore;
  driver: RunDriver;
  fs: PipelineFs;
  git: GitPort;
  stateDir: string;
  catalog(): Promise<HostCatalog>;
  /** The host port once an SDK context supplied it. */
  agents(): AgentPort | null;
  /** Creates the workflow chat agent through the host. */
  createChatAgent?(x: { workspaceId: string; projectId: string; model: string; reservation: AgentReservation; title: string }): Promise<{ agentId: string }>;
  reservation(subject: string): string;
  now(): Date;
  newRunId?(): string;
  lock?: KeyedLock;
  log(message: string): void;
};

export type StartRequest = { inputs: Record<string, unknown>; workflowDigest: string; startKey: string };

export interface RunService {
  preview(projectId: string, inputs: Record<string, unknown>): Promise<RunPreview>;
  start(projectId: string, request: StartRequest): Promise<{ runId: string }>;
  list(projectId: string): Promise<RunSummaryView[]>;
  get(runId: string): Promise<RunDetail>;
  pause(runId: string): Promise<RunDetail>;
  resume(runId: string): Promise<RunDetail>;
  cancel(runId: string): Promise<RunDetail>;
  retryStop(runId: string): Promise<RunDetail>;
  stopJob(runId: string, jobId: string): Promise<RunDetail>;
  retryJob(runId: string, jobId: string, target?: ProviderTarget): Promise<RunDetail>;
  acceptJob(runId: string, jobId: string, cycleId: string, criteria?: number[]): Promise<RunDetail>;
  approveJob(runId: string, jobId: string, cycleId: string): Promise<RunDetail>;
  requestChanges(runId: string, jobId: string, note: string, taskIds?: string[]): Promise<RunDetail>;
  grantReturn(runId: string, jobId: string): Promise<RunDetail>;
  changes(runId: string, jobId: string): Promise<JobChanges>;
  openChat(projectId: string, workspaceId: string, model?: string): Promise<{ agentId: string }>;
  isWorkflowChat(projectId: string, agentId: string, reason: string): Promise<boolean>;
}

/** A refusal with a stable code and, for Start, the diagnostics behind it. */
export class RunServiceError extends PipelineError {
  constructor(
    code: string,
    message: string,
    readonly diagnostics?: Diagnostic[],
  ) {
    super(code, message);
    this.name = "RunServiceError";
  }
}

function defaultRunId(now: Date): string {
  return `r${now.getTime().toString(36)}${randomBytes(16).toString("hex")}`;
}

type Computed = {
  preview: RunPreview;
  body: Omit<RunSnapshotBody, "runId" | "projectId" | "startKey" | "createdAt" | "startedBy"> | null;
};

const ChatRecordSchema = z.object({ agents: z.array(z.string()) }).strict();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Whether a Start request repeats the submission that created `existing`: same workflow and validated inputs. */
function sameSubmission(existing: RunSnapshot, request: { inputs: Record<string, unknown>; workflowDigest: string }): boolean {
  if (existing.workflow.sha256 !== request.workflowDigest) return false;
  const workflow = parseWorkflow(existing.workflow.yaml).workflow;
  if (workflow === null) return false;
  const inputs = parseStartInputs(workflow.inputs, request.inputs);
  return inputs.ok && canonicalJson(inputs.values) === canonicalJson(existing.inputs);
}

export function createRunService(deps: RunServiceDeps): RunService {
  const lock = deps.lock ?? createKeyedLock();
  const pendingChats = new Set<string>();
  const published = new Set<string>();

  async function compute(projectId: string, rawInputs: Record<string, unknown>, catalog: () => Promise<HostCatalog>): Promise<Computed> {
    const view = await deps.workflows.get(projectId);
    const base: RunPreview = { workflowDigest: view.saved?.digest ?? null, diagnostics: [], jobCount: 0, settings: {}, hasDraft: view.draft !== null, graph: null, blockers: [] };
    if (view.saved === null) return { preview: { ...base, blockers: ["workflow_missing"] }, body: null };
    const { workflow, diagnostics: parseDiagnostics } = parseWorkflow(view.saved.yaml);
    const diagnostics = workflow === null ? parseDiagnostics : [...parseDiagnostics, ...validateWorkflow(workflow)];
    if (workflow === null || diagnostics.length > 0) return { preview: { ...base, diagnostics, blockers: ["workflow_invalid"] }, body: null };
    const inputs = parseStartInputs(workflow.inputs, rawInputs);
    if (!inputs.ok) return { preview: { ...base, diagnostics: inputs.diagnostics, blockers: ["inputs_invalid"] }, body: null };
    let graph: ReturnType<typeof expandWorkflow>;
    try {
      graph = expandWorkflow(workflow, inputs.values);
    } catch (error) {
      if (error instanceof DiagnosticsError) return { preview: { ...base, diagnostics: error.diagnostics, blockers: ["inputs_invalid"] }, body: null };
      throw error;
    }
    let hostCatalog: HostCatalog;
    try {
      hostCatalog = await catalog();
    } catch (error) {
      deps.log(`host catalog unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
      return { preview: { ...base, jobCount: graph.jobs.length, graph, blockers: ["host_unavailable"] }, body: null };
    }
    const settings = resolveSettings(graph, hostCatalog);
    if (!settings.ok) return { preview: { ...base, jobCount: graph.jobs.length, graph, diagnostics: settings.issues, blockers: ["settings_unresolved"] }, body: null };
    return {
      preview: { ...base, jobCount: graph.jobs.length, graph, settings: settings.settings },
      body: { workflow: { yaml: view.saved.yaml, sha256: view.saved.digest }, inputs: inputs.values, graph, settings: settings.settings },
    };
  }

  async function detail(runId: string): Promise<RunDetail> {
    const state = await deps.driver.read(runId);
    const health = await deps.driver.health(runId);
    return detailOf(state, health);
  }

  function detailOf(state: RunState, health: RunDetail["health"]): RunDetail {
    const barrier = openBarriers(state)[0];
    let waits: RunDetail["waits"] = null;
    if (barrier) {
      const agents = new Set<string>();
      let processes = 0;
      for (const id of barrier.attempts) {
        const a = state.attempts[id];
        for (const rs of Object.values(a?.roles ?? {})) agents.add(rs.binding.agentId ?? `unbound:${rs.binding.creationKey}`);
        processes += unfinishedChecks(state, id).records.length;
      }
      for (const ref of barrier.agents) agents.add(ref.agentId);
      waits = { agents: [...agents], processes };
    }
    const { workflow } = parseWorkflow(state.snapshot.workflow.yaml);
    return {
      view: toRunView(state),
      graph: state.graph,
      settings: state.snapshot.settings,
      workflowName: workflow?.name ?? null,
      startKey: state.snapshot.startKey,
      createdAt: state.snapshot.createdAt,
      health,
      waits,
    };
  }

  const act = async (runId: string, action: RunAction): Promise<RunDetail> => {
    const result: ActionResult = await deps.driver.act(runId, action);
    if (!result.ok) throw new RunServiceError(result.code, result.message);
    return detail(runId);
  };

  const chatPath = (projectId: string): string => join(projectPaths(deps.stateDir, projectId).dir, "chat.json");

  async function chatAgents(projectId: string): Promise<string[]> {
    const bytes = await deps.fs.readFile(chatPath(projectId));
    if (bytes === null) return [];
    try {
      const parsed = ChatRecordSchema.safeParse(JSON.parse(decoder.decode(bytes)));
      return parsed.success ? parsed.data.agents : [];
    } catch {
      return [];
    }
  }

  return {
    async preview(projectId, inputs) {
      return (await compute(projectId, inputs, deps.catalog)).preview;
    },

    start(projectId, request) {
      return lock.run(`start:${projectId}`, async () => {
        const existing = await deps.store.findByStartKey(projectId, request.startKey);
        if (existing) {
          if (!sameSubmission(existing, request)) throw new RunServiceError("start_key_conflict", "This start key belongs to a run started with other inputs or another workflow version. Start again.");
          // A run published by this process may have failed to register; registering it again is
          // idempotent. Runs from an earlier process are left to recovery.
          if (published.has(existing.runId)) {
            await deps.driver.register(existing);
            await deps.driver.tick(existing.runId);
          }
          return { runId: existing.runId };
        }
        const view = await deps.workflows.get(projectId);
        if (view.saved === null || view.saved.digest !== request.workflowDigest) throw new RunServiceError("preview_stale", "The saved workflow changed since the preview. Review it and start again.");
        const { preview, body } = await compute(projectId, request.inputs, deps.catalog);
        if (body === null || preview.workflowDigest !== request.workflowDigest) {
          throw new RunServiceError(preview.workflowDigest !== request.workflowDigest ? "preview_stale" : (preview.blockers[0] ?? "start_invalid"), "The workflow cannot start.", preview.diagnostics);
        }
        const now = deps.now();
        const snapshot = await deps.store.create({
          ...body,
          runId: deps.newRunId?.() ?? defaultRunId(now),
          projectId,
          startKey: request.startKey,
          createdAt: now.toISOString(),
          startedBy: "human",
        });
        published.add(snapshot.runId);
        await deps.driver.register(snapshot);
        await deps.driver.tick(snapshot.runId);
        return { runId: snapshot.runId };
      });
    },

    async list(projectId) {
      const out: RunSummaryView[] = [];
      for (const summary of await deps.store.list(projectId)) {
        try {
          const { state, health } = await deps.driver.peek(summary.runId);
          out.push({ runId: summary.runId, startKey: summary.startKey, createdAt: summary.createdAt, status: runStatus(state), pauseReason: pauseReason(state), health });
        } catch {
          out.push({ runId: summary.runId, startKey: summary.startKey, createdAt: summary.createdAt, status: null, pauseReason: null, health: "journal_corrupt" });
        }
      }
      return out;
    },

    get: detail,
    pause: (runId) => act(runId, (state) => pauseRun(state)),
    async resume(runId) {
      const result = await deps.driver.resume(runId);
      if (!result.ok) throw new RunServiceError(result.code, result.message);
      return detail(runId);
    },
    cancel: (runId) => act(runId, (state) => cancelRun(state)),
    async retryStop(runId) {
      const result = await deps.driver.retryStop(runId);
      if (!result.ok) throw new RunServiceError(result.code, result.message);
      return detail(runId);
    },
    stopJob: (runId, jobId) => act(runId, (state) => stopJob(state, { jobId })),
    retryJob: (runId, jobId, target) => act(runId, (state) => retryJob(state, { jobId, ...(target === undefined ? {} : { target }) })),
    acceptJob: (runId, jobId, cycleId, criteria) =>
      act(runId, async (state, context) => acceptJob(state, { jobId, cycleId, identity: await context.identity(), ...(criteria === undefined ? {} : { criteria }) })),
    approveJob: (runId, jobId, cycleId) => act(runId, async (state, context) => approveJob(state, { jobId, cycleId, identity: await context.identity() })),
    requestChanges: (runId, jobId, note, taskIds) => act(runId, (state) => requestChanges(state, { jobId, note, ...(taskIds === undefined ? {} : { taskIds }) })),
    grantReturn: (runId, jobId) => act(runId, (state) => grantReturn(state, { jobId })),

    async changes(runId, jobId) {
      const state = await deps.driver.read(runId);
      const workspace = state.workspace;
      if (!state.jobs[jobId]) throw new RunServiceError("unknown_job", "Unknown job.");
      if (!workspace?.directory || !workspace.baseCommit) throw new RunServiceError("workspace_unbound", "The run has no worktree yet.");
      return jobChanges(deps.git, { directory: workspace.directory, baseCommit: workspace.baseCommit, state, jobId });
    },

    async openChat(projectId, workspaceId, model) {
      const create = deps.createChatAgent;
      if (!create || deps.agents() === null) throw new RunServiceError("host_unavailable", "The host is not connected yet.");
      let chosen = model;
      if (chosen === undefined) {
        const view = await deps.workflows.get(projectId);
        const text = view.draft?.yaml ?? view.saved?.yaml;
        const workflow = text === undefined ? null : parseWorkflow(text).workflow;
        const settings = workflow ? resolveAgentSettings(workflow.defaults.agent, undefined) : null;
        if (settings?.model !== undefined) chosen = settings.model;
        else if (settings?.profile !== undefined) {
          const catalog = await deps.catalog();
          const profile = catalog.profiles.find((candidate) => candidate.id === settings.profile || candidate.name === settings.profile);
          const profileModel = profile?.model || catalog.providers.find((entry) => entry.id === profile?.provider)?.defaultModel;
          if (profile && profileModel) chosen = `${profile.provider}/${profileModel}`;
        }
      }
      if (chosen === undefined) throw new RunServiceError("chat_model_unresolved", "Choose a model for the workflow chat.");
      const reservation: AgentReservation = { kind: "workflow", reservationId: deps.reservation(`workflow:${projectId}`), projectId };
      return lock.run(`chat:${projectId}`, async () => {
        pendingChats.add(projectId);
        try {
          const created = await create({ workspaceId, projectId, model: chosen, reservation, title: "Pipeline workflow chat" });
          const agents = [...new Set([...(await chatAgents(projectId)), created.agentId])];
          await deps.fs.ensureDir(projectPaths(deps.stateDir, projectId).dir);
          await deps.fs.replaceFile(chatPath(projectId), encoder.encode(`${JSON.stringify({ agents })}\n`));
          return created;
        } finally {
          pendingChats.delete(projectId);
        }
      });
    },

    async isWorkflowChat(projectId, agentId, reason) {
      if (reason === "create" && pendingChats.has(projectId)) return true;
      return (await chatAgents(projectId)).includes(agentId);
    },
  };
}
