import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DiagnosticsError, PipelineError } from "../shared/errors";
import { ProposalSchema, type CurrentDigests, type Proposal, type WorkflowPlan, type WorkflowView } from "../shared/rpc";
import type { Diagnostic, ExpandedGraph, Workflow } from "../shared/workflow";
import { digestOf, isTempName, type PipelineFs } from "./fs-port";
import { createKeyedLock, type KeyedLock } from "./keyed-lock";
import { projectPaths, type ProjectPaths } from "./paths";
import { applyEdit, type EditOp } from "./workflow-edit";
import { expandWorkflow } from "./workflow-expand";
import { parseWorkflow } from "./workflow-parse";
import { validateWorkflow } from "./workflow-validate";

/** A digest the caller sent no longer matches; nothing was written. */
export class WorkflowConflictError extends PipelineError {
  readonly current: CurrentDigests;

  constructor(current: CurrentDigests) {
    super("workflow_conflict", "The workflow changed since it was read. Reload to see the other change.");
    this.name = "WorkflowConflictError";
    this.current = current;
  }
}

/** The text has diagnostics where zero are required; nothing was written. */
export class WorkflowInvalidError extends PipelineError {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[], message: string) {
    super("workflow_invalid", message);
    this.name = "WorkflowInvalidError";
    this.diagnostics = diagnostics;
  }
}

export type NewProposal = { baseToken: string; yaml: string; summary: string; agentId: string };

export interface WorkflowStore {
  /** Reads under the project lock and drops a draft equal to the saved text. */
  get(projectId: string): Promise<WorkflowView>;
  setDraftText(projectId: string, input: { editableDigest: string; yaml: string }): Promise<WorkflowView>;
  editDraft(projectId: string, input: { editableDigest: string; op: EditOp }): Promise<WorkflowView>;
  discardDraft(projectId: string, input: { editableDigest: string }): Promise<WorkflowView>;
  save(projectId: string, input: { savedDigest: string; draftDigest: string }): Promise<WorkflowView>;
  /** Stores a proposal without touching the draft or the saved workflow. */
  addProposal(projectId: string, input: NewProposal): Promise<Proposal>;
  applyProposal(projectId: string, input: { proposalId: string; editableDigest: string }): Promise<WorkflowView>;
  discardProposal(projectId: string, input: { proposalId: string }): Promise<WorkflowView>;
}

export type WorkflowStoreOptions = {
  stateDir: () => string;
  fs: PipelineFs;
  now: () => Date;
  lock?: KeyedLock;
  newProposalId?: () => string;
  log?: (message: string) => void;
};

/**
 * `applying` is recorded before an apply writes the draft. The next read under the lock settles it
 * from the editable digest: the proposal's own digest means the draft was written (applied), the
 * base digest means it was not (pending again).
 */
const StoredProposalSchema = ProposalSchema.omit({ diagnostics: true, model: true }).extend({ applying: z.literal(true).optional() }).strict();
type StoredProposal = z.output<typeof StoredProposalSchema>;

type State = { paths: ProjectPaths; saved: Uint8Array | null; draft: Uint8Array | null };

/**
 * Proposal files kept per project. When a new proposal would exceed it, the oldest proposals that
 * can no longer be applied (applied, discarded or stale) are removed first; pending ones are kept,
 * and a new proposal is refused while every kept proposal is still pending.
 */
export const MAX_PROPOSALS = 16;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new PipelineError("store_invalid", "A stored workflow file is not valid UTF-8.", { cause: error });
  }
}

function diagnose(text: string): { diagnostics: Diagnostic[]; model: Workflow | null } {
  const { workflow, diagnostics } = parseWorkflow(text);
  if (workflow === null) return { diagnostics, model: null };
  return { diagnostics: validateWorkflow(workflow), model: workflow };
}

/**
 * The planning graph of a text with zero diagnostics, expanded without Start inputs. A `run-tasks`
 * job that takes its tasks only from Start is drawn as its single `<job>.main` task job; Start
 * still expands the real task list and refuses an empty one.
 */
function planGraph(model: Workflow | null, diagnostics: readonly Diagnostic[]): ExpandedGraph | null {
  if (model === null || diagnostics.length > 0) return null;
  try {
    return expandWorkflow(model, {});
  } catch (error) {
    if (!(error instanceof DiagnosticsError)) throw error;
    const awaitingTasks = new Set(error.diagnostics.map((item) => (item.code === "tasks_empty" ? item.jobId : undefined)));
    if (awaitingTasks.has(undefined)) return null;
    const placeholder: Workflow = { ...model, jobs: model.jobs.map((job) => (awaitingTasks.has(job.id) ? { ...job, with: { ...job.with, prompt: "" } } : job)) };
    try {
      return expandWorkflow(placeholder, {});
    } catch (retryError) {
      if (retryError instanceof DiagnosticsError) return null;
      throw retryError;
    }
  }
}

function plan(text: string): WorkflowPlan | null {
  const { diagnostics, model } = diagnose(text);
  const graph = planGraph(model, diagnostics);
  return model === null || graph === null ? null : { model, graph };
}

function digests(state: State): CurrentDigests {
  const savedDigest = digestOf(state.saved);
  const draftDigest = digestOf(state.draft);
  return { savedDigest, draftDigest, editableDigest: state.draft !== null ? draftDigest : savedDigest };
}

function defaultProposalId(): string {
  return `prp_${randomBytes(10).toString("hex")}`;
}

export function createWorkflowStore(opts: WorkflowStoreOptions): WorkflowStore {
  const { fs } = opts;
  const lock = opts.lock ?? createKeyedLock();
  const newProposalId = opts.newProposalId ?? defaultProposalId;
  const swept = new Set<string>();

  const log = opts.log ?? (() => undefined);

  const locked = async <T>(projectId: string, work: (paths: ProjectPaths) => Promise<T>): Promise<T> => {
    const paths = projectPaths(opts.stateDir(), projectId);
    return lock.run(paths.dir, async () => {
      if (!swept.has(paths.dir)) {
        await sweepTemps(paths);
        swept.add(paths.dir);
      }
      return work(paths);
    });
  };

  // Temp files exist only inside a write that holds the lock, so any found here were left by a crash.
  async function sweepTemps(paths: ProjectPaths): Promise<void> {
    for (const dir of [paths.dir, paths.proposals]) {
      for (const name of await fs.listDir(dir)) {
        if (isTempName(name)) await fs.remove(join(dir, name));
      }
    }
  }

  async function read(paths: ProjectPaths): Promise<State> {
    const saved = await fs.readFile(paths.workflow);
    let draft = await fs.readFile(paths.draft);
    if (draft !== null && saved !== null && digestOf(draft) === digestOf(saved)) {
      await fs.remove(paths.draft);
      draft = null;
    }
    const state = { paths, saved, draft };
    await settleApplying(state);
    return state;
  }

  async function settleApplying(state: State): Promise<void> {
    const editable = digests(state).editableDigest;
    for (const record of await loadProposals(state.paths)) {
      if (record.applying !== true) continue;
      const { applying: _applying, ...rest } = record;
      const status = digestOf(encoder.encode(record.yaml)) === editable ? "applied" : record.baseToken === editable ? "pending" : "stale";
      await writeProposal(state.paths, { ...rest, status });
    }
  }

  function expectEditable(state: State, editableDigest: string): void {
    const current = digests(state);
    if (current.editableDigest !== editableDigest) throw new WorkflowConflictError(current);
  }

  async function writeDraft(state: State, text: string): Promise<State> {
    const bytes = encoder.encode(text);
    if (state.saved !== null && digestOf(bytes) === digestOf(state.saved)) {
      if (state.draft !== null) await fs.remove(state.paths.draft);
      return { ...state, draft: null };
    }
    await fs.ensureDir(state.paths.dir);
    await fs.replaceFile(state.paths.draft, bytes);
    return { ...state, draft: bytes };
  }

  async function loadProposals(paths: ProjectPaths): Promise<StoredProposal[]> {
    const out: StoredProposal[] = [];
    for (const name of await fs.listDir(paths.proposals)) {
      if (isTempName(name) || !name.endsWith(".json")) continue;
      const record = await loadProposal(paths, name.slice(0, -".json".length));
      if (record !== null) out.push(record);
    }
    return out.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
  }

  // An unreadable proposal file is left in place and omitted; it never blocks the workflow.
  async function loadProposal(paths: ProjectPaths, id: string): Promise<StoredProposal | null> {
    let path: string;
    try {
      path = paths.proposal(id);
    } catch {
      return null;
    }
    const bytes = await fs.readFile(path);
    if (bytes === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(decode(bytes));
    } catch {
      return null;
    }
    const parsed = StoredProposalSchema.safeParse(raw);
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  }

  async function writeProposal(paths: ProjectPaths, record: StoredProposal): Promise<void> {
    await fs.replaceFile(paths.proposal(record.id), encoder.encode(`${JSON.stringify(record)}\n`));
  }

  async function makeRoomForProposal(paths: ProjectPaths, editableDigest: string): Promise<void> {
    const kept = await loadProposals(paths);
    const removable = kept.filter((record) => record.applying !== true && (record.status !== "pending" || record.baseToken !== editableDigest));
    let excess = kept.length - (MAX_PROPOSALS - 1);
    for (const record of removable) {
      if (excess <= 0) break;
      await fs.remove(paths.proposal(record.id));
      excess -= 1;
    }
    if (excess > 0) throw new PipelineError("proposal_limit", `${MAX_PROPOSALS} proposals are waiting for review. Apply or discard one before proposing again.`);
  }

  function present(record: StoredProposal, editableDigest: string): Proposal {
    const { applying: _applying, ...rest } = record;
    const status = rest.status === "pending" && rest.baseToken !== editableDigest ? "stale" : rest.status;
    const { diagnostics, model } = diagnose(rest.yaml);
    return { ...rest, status, diagnostics, model };
  }

  async function view(state: State): Promise<WorkflowView> {
    const current = digests(state);
    const saved = state.saved === null ? null : { yaml: decode(state.saved), digest: current.savedDigest };
    const draft = state.draft === null ? null : { yaml: decode(state.draft), digest: current.draftDigest };
    const editable = draft ?? saved;
    const { diagnostics, model } = editable === null ? { diagnostics: [], model: null } : diagnose(editable.yaml);
    const graph = planGraph(model, diagnostics);
    const savedPlan = draft !== null && saved !== null ? plan(saved.yaml) : null;
    const proposals = (await loadProposals(state.paths)).map((record) => present(record, current.editableDigest));
    return { saved, draft, editableDigest: current.editableDigest, diagnostics, model, graph, savedPlan, proposals };
  }

  function editableText(state: State): string {
    const bytes = state.draft ?? state.saved;
    return bytes === null ? "" : decode(bytes);
  }

  return {
    get: (projectId) => locked(projectId, async (paths) => view(await read(paths))),

    setDraftText: (projectId, { editableDigest, yaml }) =>
      locked(projectId, async (paths) => {
        const state = await read(paths);
        expectEditable(state, editableDigest);
        return view(await writeDraft(state, yaml));
      }),

    editDraft: (projectId, { editableDigest, op }) =>
      locked(projectId, async (paths) => {
        const state = await read(paths);
        expectEditable(state, editableDigest);
        return view(await writeDraft(state, applyEdit(editableText(state), op)));
      }),

    discardDraft: (projectId, { editableDigest }) =>
      locked(projectId, async (paths) => {
        const state = await read(paths);
        expectEditable(state, editableDigest);
        if (state.draft !== null) await fs.remove(paths.draft);
        return view({ ...state, draft: null });
      }),

    save: (projectId, { savedDigest, draftDigest }) =>
      locked(projectId, async (paths) => {
        const state = await read(paths);
        const current = digests(state);
        if (current.savedDigest !== savedDigest || current.draftDigest !== draftDigest) throw new WorkflowConflictError(current);
        if (state.draft === null) return view(state);
        const { diagnostics } = diagnose(decode(state.draft));
        if (diagnostics.length > 0) throw new WorkflowInvalidError(diagnostics, "The draft has errors; fix them before saving.");
        await fs.ensureDir(paths.dir);
        await fs.replaceFile(paths.workflow, state.draft);
        await fs.remove(paths.draft);
        return view({ paths, saved: state.draft, draft: null });
      }),

    addProposal: (projectId, input) =>
      locked(projectId, async (paths) => {
        const state = await read(paths);
        const parsed = StoredProposalSchema.safeParse({
          id: newProposalId(),
          baseToken: input.baseToken,
          yaml: input.yaml,
          summary: input.summary,
          agentId: input.agentId,
          createdAt: opts.now().toISOString(),
          status: "pending",
        });
        if (!parsed.success) throw new PipelineError("proposal_invalid", "The proposal is malformed.", { cause: parsed.error });
        const record = parsed.data;
        await fs.ensureDir(paths.proposals);
        await makeRoomForProposal(paths, digests(state).editableDigest);
        const published = await fs.publishNoClobber(paths.proposal(record.id), encoder.encode(`${JSON.stringify(record)}\n`));
        if (!published) throw new PipelineError("internal", "A proposal with this id already exists.");
        return present(record, digests(state).editableDigest);
      }),

    applyProposal: (projectId, { proposalId, editableDigest }) =>
      locked(projectId, async (paths) => {
        const state = await read(paths);
        expectEditable(state, editableDigest);
        const record = await loadProposal(paths, proposalId);
        if (record === null) throw new PipelineError("proposal_not_found", "The proposal does not exist.");
        if (record.status === "stale") throw new PipelineError("proposal_stale", "The proposal was written for a different text.");
        if (record.status !== "pending") throw new PipelineError("proposal_not_pending", `The proposal is already ${record.status}.`);
        if (record.baseToken !== editableDigest) {
          await writeProposal(paths, { ...record, status: "stale" });
          throw new PipelineError("proposal_stale", "The proposal was written for a different text.");
        }
        const { diagnostics } = diagnose(record.yaml);
        if (diagnostics.length > 0) throw new WorkflowInvalidError(diagnostics, "The proposal has errors and cannot be applied.");
        await writeProposal(paths, { ...record, applying: true });
        const next = await writeDraft(state, record.yaml);
        await writeProposal(paths, { ...record, status: "applied" });
        // Pending proposals on another base already read as stale; persisting it is best effort.
        const nextDigest = digests(next).editableDigest;
        for (const other of await loadProposals(paths)) {
          if (other.status !== "pending" || other.baseToken === nextDigest) continue;
          await writeProposal(paths, { ...other, status: "stale" }).catch((error: unknown) => {
            log(`could not mark proposal ${other.id} stale: ${error instanceof Error ? error.message : "unknown error"}`);
          });
        }
        return view(next);
      }),

    discardProposal: (projectId, { proposalId }) =>
      locked(projectId, async (paths) => {
        const state = await read(paths);
        const record = await loadProposal(paths, proposalId);
        if (record === null) throw new PipelineError("proposal_not_found", "The proposal does not exist.");
        if (record.status === "applied") throw new PipelineError("proposal_not_pending", "An applied proposal cannot be discarded.");
        if (record.status !== "discarded") await writeProposal(paths, { ...record, status: "discarded" });
        return view(state);
      }),
  };
}
