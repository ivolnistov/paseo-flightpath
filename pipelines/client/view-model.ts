import { canonicalJson } from "../shared/canonical";
import type { RunDetail, RunPreview } from "../shared/rpc";
import type { CriterionStatus, Evidence, JobStatus, ProviderFailure, ResolvedAgent, ResolvedSettings, RunView } from "../shared/run";
import type { Command, ExpandedGraph, GraphJob, Job, Workflow } from "../shared/workflow";

export type PlanningView = "diagram" | "list" | "yaml";
export type GraphView = "diagram" | "list";

export const FINAL_APPROVAL = "Final approval";
export const CRITERIA_TITLE = "Acceptance criteria";

/** Task list on a compact layout, Diagram elsewhere. */
export function defaultView(compact: boolean): GraphView {
  return compact ? "list" : "diagram";
}

export type StatusLabel = "Waiting" | "In progress" | "Needs review" | "Needs attention" | "Done" | "Accepted" | "Failed" | "Stopped" | "Cancelled";
export type StatusTone = "muted" | "accent" | "warning" | "danger" | "success";

/** One label per job status; a succeeded job a person accepted or approved is "Accepted". */
export function statusLabel(job: { status: JobStatus }, accepted = false): StatusLabel {
  switch (job.status) {
    case "waiting":
      return "Waiting";
    case "running":
    case "checking":
    case "reviewing":
      return "In progress";
    case "awaiting_human":
      return "Needs review";
    case "needs_human":
      return "Needs attention";
    case "succeeded":
      return accepted ? "Accepted" : "Done";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "cancelled":
      return "Cancelled";
  }
}

export function statusTone(label: StatusLabel): StatusTone {
  switch (label) {
    case "Waiting":
    case "Cancelled":
      return "muted";
    case "In progress":
      return "accent";
    case "Needs review":
    case "Needs attention":
    case "Stopped":
      return "warning";
    case "Failed":
      return "danger";
    case "Done":
    case "Accepted":
      return "success";
  }
}

export type RunJob = RunView["jobs"][number];

export function jobTitle(job: GraphJob): string {
  return job.uses === "approval" ? FINAL_APPROVAL : job.name;
}

/** A person decides this job: final approval, human acceptance, or human-judged criteria. */
export function isHumanGate(job: GraphJob): boolean {
  return job.uses === "approval" || job.humanAcceptance || (job.criteria === "human" && job.done.some((item) => "criterion" in item));
}

export type JobRow = {
  id: string;
  sourceJobId: string;
  title: string;
  /** The YAML job name under "Final approval", else null. */
  subtitle: string | null;
  uses: GraphJob["uses"];
  kind: GraphJob["kind"];
  needs: string[];
  group: { id: string; kind: "tasks" | "matrix" } | null;
  humanGate: boolean;
  /** Shared by Diagram and Task list: a job or task that waits for a person now. */
  marker: "needs-review" | "needs-attention" | null;
  status: JobStatus | null;
  label: StatusLabel | null;
  reason: string | null;
  criteria: number;
  checks: number;
  attempts: number;
  retired: boolean;
  /** `<provider>/<model>` or `profile <name>`, when the job runs an agent. */
  agent: string | null;
};

function accepted(run: RunView, job: RunJob): boolean {
  const last = job.attempts[job.attempts.length - 1];
  if (!last) return false;
  return run.evidence.some((evidence) => evidence.attemptId === last.attemptId && (evidence.kind === "acceptance" || evidence.kind === "approval"));
}

function agentSummary(job: GraphJob): string | null {
  const agent = job.agent;
  if (!agent) return null;
  if (agent.profile) return `profile ${agent.profile}`;
  return agent.model ?? null;
}

/** Commands this job's checks run, in evidence item order. */
export function jobCommands(job: GraphJob): Command[] {
  if (job.uses === "checks") {
    const run = job.with.run;
    if (!Array.isArray(run)) return [];
    const items: unknown[] = run;
    return items.filter((item): item is Command => typeof item === "string" || (Array.isArray(item) && item.every((part) => typeof part === "string")));
  }
  return job.done.flatMap((item) => ("run" in item ? [item.run] : []));
}

/** Rows in graph order; with a run, each row carries its live status. Retired matrix instances follow. */
export function jobRows(graph: ExpandedGraph, run?: RunView): JobRow[] {
  const groupOf = new Map<string, { id: string; kind: "tasks" | "matrix" }>();
  for (const group of graph.groups) for (const id of group.jobIds) groupOf.set(id, { id: group.id, kind: group.kind });
  const needs = new Map<string, string[]>();
  for (const edge of graph.edges) needs.set(edge.to, [...(needs.get(edge.to) ?? []), edge.from]);
  const runJobs = new Map((run?.jobs ?? []).map((job) => [job.id, job]));
  const rows = graph.jobs.map((job) => {
    const live = runJobs.get(job.id);
    return toRow(job, groupOf.get(job.id) ?? (job.matrix ? { id: job.id, kind: "matrix" as const } : null), needs.get(job.id) ?? [], run, live);
  });
  if (run) {
    for (const live of run.jobs) {
      if (!live.retired) continue;
      const source = graph.jobs.find((job) => live.id.startsWith(`${job.sourceJobId}[`));
      rows.push({
        ...toRow(
          source ?? { id: live.id, sourceJobId: live.id, name: live.id, kind: "testing", uses: "checks", with: {}, outputs: {}, done: [], criteria: "reviewer", humanAcceptance: false, isolated: false },
          null,
          [],
          run,
          live,
        ),
        id: live.id,
        title: live.id,
        retired: true,
      });
    }
  }
  return rows;
}

function toRow(job: GraphJob, group: JobRow["group"], needs: string[], run: RunView | undefined, live: RunJob | undefined): JobRow {
  const label = run && live ? statusLabel(live, accepted(run, live)) : null;
  return {
    id: job.id,
    sourceJobId: job.sourceJobId,
    title: jobTitle(job),
    subtitle: job.uses === "approval" && job.name !== FINAL_APPROVAL ? job.name : null,
    uses: job.uses,
    kind: job.kind,
    needs,
    group,
    humanGate: isHumanGate(job),
    marker: live?.status === "awaiting_human" ? "needs-review" : live?.status === "needs_human" ? "needs-attention" : null,
    status: live?.status ?? null,
    label,
    reason: live?.reason ?? null,
    criteria: job.done.filter((item) => "criterion" in item).length,
    checks: jobCommands(job).length,
    attempts: live?.attempts.length ?? 0,
    retired: live?.retired === true,
    agent: agentSummary(job),
  };
}

export function commandText(command: Command): string {
  return typeof command === "string" ? command : command.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

export type CycleEvidence = {
  cycleId: string;
  result: Evidence["result"];
  mode: Evidence["mode"];
  exitCode: number | null;
  outputTail: string | null;
  at: string;
  invalidated: boolean;
};

export type CriterionRow = {
  /** Index in `done`, or in `with.run` for a checks job. */
  index: number;
  kind: "check" | "criterion";
  text: string;
  status: CriterionStatus;
  cycles: CycleEvidence[];
};

function evidenceStatus(evidence: Evidence | undefined, invalidated: ReadonlySet<string>): CriterionStatus {
  if (!evidence) return "pending";
  if (evidence.result === "late" || invalidated.has(evidence.cycleId)) return "stale";
  return evidence.result === "pass" ? "met" : "not_met";
}

/**
 * The job's acceptance criteria. Without a run every item is pending. With a run, each item has
 * its status for the current attempt and its evidence by verification cycle, invalidated cycles marked.
 */
export function criteriaRows(job: GraphJob, run?: RunView): CriterionRow[] {
  const live = run?.jobs.find((candidate) => candidate.id === job.id);
  const current = live?.attempts[live.attempts.length - 1];
  const invalidated = new Set(run?.invalidatedCycles ?? []);
  const evidenceOf = (kind: "check" | "criterion", item: number): CycleEvidence[] =>
    (run?.evidence ?? [])
      .filter((evidence) => current !== undefined && evidence.attemptId === current.attemptId && evidence.kind === kind && evidence.item === item)
      .map((evidence) => ({
        cycleId: evidence.cycleId,
        result: evidence.result,
        mode: evidence.mode,
        exitCode: evidence.exitCode,
        outputTail: evidence.outputTail,
        at: evidence.at,
        invalidated: invalidated.has(evidence.cycleId),
      }));
  const latest = (kind: "check" | "criterion", item: number): Evidence | undefined =>
    current === undefined ? undefined : [...(run?.evidence ?? [])].reverse().find((evidence) => evidence.attemptId === current.attemptId && evidence.kind === kind && evidence.item === item);

  if (job.uses === "checks") {
    return jobCommands(job).map((command, index) => ({
      index,
      kind: "check",
      text: commandText(command),
      status: evidenceStatus(latest("check", index), invalidated),
      cycles: evidenceOf("check", index),
    }));
  }
  let commandIndex = 0;
  return job.done.map((item, index) => {
    if ("run" in item) {
      const at = commandIndex++;
      return { index, kind: "check", text: commandText(item.run), status: evidenceStatus(latest("check", at), invalidated), cycles: evidenceOf("check", at) };
    }
    const status = live?.criteria.find((criterion) => criterion.index === index)?.status ?? "pending";
    return { index, kind: "criterion", text: item.criterion, status, cycles: evidenceOf("criterion", index) };
  });
}

export type ProposalDelta = { added: string[]; removed: string[]; changed: string[] };

/** Job-level difference between two parsed workflows; source positions are ignored. */
export function proposalDelta(base: Pick<Workflow, "jobs"> | null, proposed: Pick<Workflow, "jobs"> | null): ProposalDelta {
  const before = new Map((base?.jobs ?? []).map((job) => [job.id, job]));
  const after = new Map((proposed?.jobs ?? []).map((job) => [job.id, job]));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...after.entries()].flatMap(([id, job]) => {
    const old = before.get(id);
    return old !== undefined && canonicalJson(old) !== canonicalJson(job) ? [id] : [];
  });
  return { added, removed, changed };
}

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** A line diff by longest common subsequence; long texts fall back to removed-then-added. */
export function lineDiff(before: string, after: string, maxCells = 4_000_000): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > maxCells) return [...a.map((text) => ({ kind: "removed" as const, text })), ...b.map((text) => ({ kind: "added" as const, text }))];
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      out.push({ kind: "removed", text: a[i] ?? "" });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j] ?? "" });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) out.push({ kind: "removed", text: a[i] ?? "" });
  for (; j < b.length; j += 1) out.push({ kind: "added", text: b[j] ?? "" });
  return out;
}

export type ProposalState = { canApply: boolean; reason: string | null };

/** Apply needs a pending proposal on the current editable text with zero diagnostics. */
export function proposalState(proposal: { status: string; diagnostics: readonly unknown[] }): ProposalState {
  if (proposal.status === "stale") return { canApply: false, reason: "The workflow changed after this proposal was written." };
  if (proposal.status !== "pending") return { canApply: false, reason: `This proposal is ${proposal.status}.` };
  if (proposal.diagnostics.length > 0) return { canApply: false, reason: `The proposal has ${proposal.diagnostics.length} problem${proposal.diagnostics.length === 1 ? "" : "s"}.` };
  return { canApply: true, reason: null };
}

const BLOCKER_TEXT: Record<RunPreview["blockers"][number], string> = {
  workflow_missing: "Save a workflow before starting a run.",
  workflow_invalid: "The saved workflow has errors.",
  inputs_invalid: "Some inputs are missing or invalid.",
  settings_unresolved: "A job's model or profile is not available on this host.",
  host_unavailable: "The host is not connected yet.",
};

/** Why Start is disabled; empty when it may start. A missing preview blocks too. */
export function startBlockers(preview: RunPreview | null): string[] {
  if (preview === null) return ["Checking the workflow and inputs."];
  if (preview.workflowDigest === null && preview.blockers.length === 0) return [BLOCKER_TEXT.workflow_missing];
  return preview.blockers.map((blocker) => BLOCKER_TEXT[blocker]);
}

export type ProviderChoice = { role: "worker" | "reviewer"; target: "primary" | "fallback"; label: string };

export function agentText(agent: ResolvedAgent): string {
  const base = agent.profile ? `${agent.profile} (${agent.provider}/${agent.model})` : `${agent.provider}/${agent.model}`;
  return agent.reasoning ? `${base} · ${agent.reasoning}` : base;
}

/** Primary and fallback per role, as resolved at Start. */
export function providerChoices(job: { worker?: ResolvedSettings; reviewer?: ResolvedSettings } | undefined): ProviderChoice[] {
  const out: ProviderChoice[] = [];
  for (const role of ["worker", "reviewer"] as const) {
    const settings = job?.[role];
    if (!settings) continue;
    out.push({ role, target: "primary", label: agentText(settings.primary) });
    if (settings.fallback) out.push({ role, target: "fallback", label: agentText(settings.fallback) });
  }
  return out;
}

const ACTIVE: ReadonlySet<JobStatus> = new Set(["running", "checking", "reviewing"]);
const BLOCKING: ReadonlySet<JobStatus> = new Set(["awaiting_human", "needs_human", "failed", "stopped"]);

export type Blocker = { id: string; title: string; label: StatusLabel; reason: string | null };

/** The jobs holding up a run that is not finished and has no active job. */
export function runBlockers(run: Pick<RunDetail, "view" | "graph">): Blocker[] {
  const { view, graph } = run;
  if (view.status === "finished" || view.status === "cancelled") return [];
  const live = view.jobs.filter((job) => !job.retired);
  if (live.some((job) => ACTIVE.has(job.status))) return [];
  const titleOf = (id: string): string => {
    const job = graph.jobs.find((candidate) => candidate.id === id);
    return job ? jobTitle(job) : id;
  };
  return live.filter((job) => BLOCKING.has(job.status)).map((job) => ({ id: job.id, title: titleOf(job.id), label: statusLabel(job, false), reason: job.reason }));
}

export type JobAction =
  | { kind: "stop" }
  | { kind: "retry"; target?: "primary" | "fallback"; label: string }
  | { kind: "accept"; cycleId: string; criteria: number[] }
  | { kind: "approve"; cycleId: string }
  | { kind: "request-changes"; taskIds: boolean }
  | { kind: "grant-return" };

/** Text criteria a person marks before Accept: only on a standalone or task job judged by a human. */
export function humanCriteria(job: GraphJob): number[] {
  if (job.criteria !== "human") return [];
  return job.done.flatMap((item, index) => ("criterion" in item ? [index] : []));
}

/**
 * The job actions the server would accept now. Accept is offered on agent and task jobs only and
 * Approve on the `approval` job only; neither replaces the other.
 */
export function jobActions(job: GraphJob, live: RunJob | undefined, run: Pick<RunDetail, "view" | "graph">): JobAction[] {
  if (!live || live.retired || run.view.status === "finished" || run.view.status === "cancelled") return [];
  const actions: JobAction[] = [];
  const unexpanded = job.matrix !== undefined && job.matrixIndex === undefined;
  switch (live.status) {
    case "running":
    case "checking":
    case "reviewing":
      actions.push({ kind: "stop" });
      break;
    case "awaiting_human": {
      const cycleId = live.activeCycleId;
      if (cycleId !== null && job.uses === "approval") actions.push({ kind: "approve", cycleId });
      else if (cycleId !== null && (job.uses === "agent" || job.uses === "run-task")) actions.push({ kind: "accept", cycleId, criteria: humanCriteria(job) });
      actions.push({ kind: "request-changes", taskIds: job.uses === "approval" && reworkTargetsTasks(job, run.graph) });
      break;
    }
    case "needs_human":
      actions.push({ kind: "retry", target: "primary", label: "Retry on primary" }, { kind: "retry", target: "fallback", label: "Retry on fallback" }, { kind: "stop" });
      break;
    case "failed":
      if (live.reason === "rework_exhausted") actions.push({ kind: "grant-return" });
      if (!unexpanded) actions.push({ kind: "retry", label: "Retry" });
      break;
    case "stopped":
      if (!unexpanded) actions.push({ kind: "retry", label: "Retry" });
      break;
    case "waiting":
    case "succeeded":
    case "cancelled":
      break;
  }
  return actions;
}

function reworkTargetsTasks(job: GraphJob, graph: ExpandedGraph): boolean {
  const rework = graph.reworks.find((candidate) => candidate.from === job.sourceJobId);
  return rework !== undefined && graph.groups.some((group) => group.kind === "tasks" && group.id === rework.to);
}

export type RunAction = "pause" | "resume" | "cancel" | "retry-stop";

/** Stop run, Resume, Cancel, and Retry stop while a stop is unconfirmed; `binding_unknown` allows only Resume and Cancel. */
export function runActions(view: Pick<RunView, "status" | "pauseReason">): RunAction[] {
  if (view.status === "finished" || view.status === "cancelled") return [];
  if (view.pauseReason === null) return view.status === "running" ? ["pause", "cancel"] : ["resume", "cancel"];
  switch (view.pauseReason) {
    case "quiesce_unconfirmed":
      return ["retry-stop", "cancel"];
    case "binding_unknown":
      return ["resume", "cancel"];
    case "human":
    case "recovery":
      return ["resume", "cancel"];
  }
}

export const RUN_ACTION_LABEL: Record<RunAction, string> = { pause: "Stop run", resume: "Resume", cancel: "Cancel run", "retry-stop": "Retry stop" };

export function pauseText(reason: RunView["pauseReason"]): string | null {
  switch (reason) {
    case null:
      return null;
    case "human":
      return "Paused by a person.";
    case "recovery":
      return "Paused after a restart; Resume continues the run.";
    case "binding_unknown":
      return "Paused: Pipeline could not confirm which agent belongs to an attempt. Resume repeats the check.";
    case "quiesce_unconfirmed":
      return "Paused: a stop was not confirmed. Retry stop interrupts the work again.";
  }
}

export function failureText(failure: ProviderFailure): string {
  return `${failure.target}: ${failure.provider}/${failure.model} · ${failure.class} · ${failure.at}${failure.message ? ` · ${failure.message}` : ""}`;
}

/** The provider failures a `needs_human` job lists, one line each; empty for any other status. */
export function attentionDetails(live: RunJob | undefined): string[] {
  return live?.status === "needs_human" ? live.providerFailures.map(failureText) : [];
}

export type OpenChat = { agentId: string; label: string };

/** One Open chat per bound agent of the job's latest attempt. */
export function openChats(live: RunJob | undefined): OpenChat[] {
  const last = live?.attempts[live.attempts.length - 1];
  if (!last) return [];
  return last.agents.flatMap((agent) => (agent.agentId === null ? [] : [{ agentId: agent.agentId, label: `Open ${agent.role} chat` }]));
}

/** The text a task job works on, from the run snapshot. */
export function taskText(job: GraphJob): Array<{ label: string; text: string }> {
  const out: Array<{ label: string; text: string }> = [];
  for (const key of ["title", "description", "prompt"] as const) {
    const value = job.with[key];
    if (typeof value === "string" && value.trim() !== "") out.push({ label: key[0]?.toUpperCase() + key.slice(1), text: value });
  }
  return out;
}

export type JobSource = { model: Workflow; job: Job };

/** The workflow job behind a graph job, for the editor. */
export function sourceJob(model: Workflow | null, job: GraphJob): JobSource | null {
  const found = model?.jobs.find((candidate) => candidate.id === job.sourceJobId);
  return model && found ? { model, job: found } : null;
}
