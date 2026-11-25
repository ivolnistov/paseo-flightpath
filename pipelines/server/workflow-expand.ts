import { DiagnosticsError } from "../shared/errors";
import type { TaskInput } from "../shared/tasks";
import {
  DEFAULT_RETRIES,
  defaultKind,
  isBuiltIn,
  isMatrixScalar,
  matrixInstanceId,
  matrixItemsProblem,
  type AgentSettings,
  type AgentSettingsDecl,
  type BuiltIn,
  type CriteriaMode,
  type ExpandedGraph,
  type GraphJob,
  type Job,
  type MatrixDecl,
  type Workflow,
} from "../shared/workflow";
import { readAgentDecl, Reporter } from "./workflow-parse";
import { matrixSource, scanReferences } from "./workflow-validate";

/**
 * Applies inheritance: an explicit `profile` or `model` replaces the inherited selection
 * (profile, model and reasoning) as a unit, a lone `reasoning` overrides the inherited one,
 * an explicit `fallback` replaces the inherited block, and `retries` is inherited when omitted.
 */
export function resolveAgentSettings(inherited: AgentSettingsDecl, own: AgentSettingsDecl | undefined): AgentSettings {
  const local = own ?? {};
  const selectionSource = local.profile !== undefined || local.model !== undefined ? local : inherited;
  const settings: AgentSettings = { retries: local.retries ?? inherited.retries ?? DEFAULT_RETRIES };
  if (selectionSource.profile !== undefined) settings.profile = selectionSource.profile;
  if (selectionSource.model !== undefined) settings.model = selectionSource.model;
  const reasoning = local.reasoning ?? selectionSource.reasoning;
  if (reasoning !== undefined) settings.reasoning = reasoning;
  const fallback = local.fallback ?? inherited.fallback;
  if (fallback !== undefined) settings.fallback = { ...fallback };
  return settings;
}

/**
 * Expands a validated workflow and validated Start inputs into the run graph. Refuses with
 * `tasks_empty` or `tasks_reviewer_missing`.
 */
export function expandWorkflow(workflow: Workflow, inputs: Record<string, unknown>): ExpandedGraph {
  const reporter = new Reporter(workflow.source);
  const graph: ExpandedGraph = { jobs: [], edges: [], groups: [], reworks: [], maxParallel: workflow.defaults.maxParallel };
  const settingsOf = (job: Job, key: "agent" | "reviewer"): AgentSettingsDecl | undefined => {
    const raw = job.with[key];
    if (raw === undefined) return undefined;
    return readAgentDecl(new Reporter({}), raw, [], "with_type") ?? undefined;
  };
  const expandedIds = new Map<string, string[]>();

  for (const job of workflow.jobs) {
    if (!isBuiltIn(job.uses)) throw new Error(`Job ${job.id} uses unknown built-in ${job.uses}; validate the workflow first.`);
    const uses: BuiltIn = job.uses;
    const base = {
      sourceJobId: job.id,
      kind: job.kind ?? defaultKind(uses),
      outputs: {},
      done: [],
      criteria: "reviewer" as CriteriaMode,
      humanAcceptance: false,
      isolated: false,
    };
    switch (uses) {
      case "agent": {
        const agent = resolveAgentSettings(workflow.defaults.agent, settingsOf(job, "agent"));
        const human = job.acceptance === "human";
        const graphJob: GraphJob = {
          ...base,
          id: job.id,
          name: job.name ?? job.id,
          uses: "agent",
          with: { ...job.with },
          outputs: { ...job.outputs },
          done: [...job.done],
          agent,
          criteria: human ? "human" : "reviewer",
          humanAcceptance: human,
        };
        if (!human && job.done.some((item) => "criterion" in item)) graphJob.reviewer = { ...agent };
        graph.jobs.push(graphJob);
        expandedIds.set(job.id, [job.id]);
        break;
      }
      case "run-tasks": {
        const ids = expandTasks(reporter, workflow, job, inputs, base, graph, settingsOf);
        expandedIds.set(job.id, ids);
        break;
      }
      case "checks":
        graph.jobs.push({ ...base, id: job.id, name: job.name ?? job.id, uses: "checks", with: { ...job.with }, isolated: job.with.isolated === true });
        expandedIds.set(job.id, [job.id]);
        break;
      case "review":
        graph.jobs.push({
          ...base,
          id: job.id,
          name: job.name ?? job.id,
          uses: "review",
          with: { ...job.with },
          agent: resolveAgentSettings(workflow.defaults.agent, settingsOf(job, "agent")),
        });
        expandedIds.set(job.id, [job.id]);
        break;
      case "approval":
        graph.jobs.push({ ...base, id: job.id, name: job.name ?? job.id, uses: "approval", with: { ...job.with } });
        expandedIds.set(job.id, [job.id]);
        break;
    }
    if (job.strategy) expandedIds.set(job.id, applyMatrix(graph, job));
    if (job.rework) graph.reworks.push({ from: job.id, to: job.rework.to, max: job.rework.max });
  }
  if (reporter.diagnostics.length > 0) throw new DiagnosticsError(reporter.diagnostics);

  const taskEdges = new Set(graph.edges.map((edge) => `${edge.from}\n${edge.to}`));
  const addEdge = (from: string, to: string): void => {
    const key = `${from}\n${to}`;
    if (taskEdges.has(key)) return;
    taskEdges.add(key);
    graph.edges.push({ from, to });
  };
  for (const job of workflow.jobs) {
    for (const target of expandedIds.get(job.id) ?? []) {
      for (const need of job.needs) {
        for (const source of expandedIds.get(need) ?? []) addEdge(source, target);
      }
    }
  }
  return graph;
}

/**
 * A static matrix replaces its job by instances `<job>[<index>]` in one `matrix` group. A dynamic
 * matrix keeps one unexpanded job that carries the declaration; the run expands it later.
 */
function applyMatrix(graph: ExpandedGraph, job: Job): string[] {
  const strategy = job.strategy;
  const at = graph.jobs.findIndex((candidate) => candidate.id === job.id);
  const template = graph.jobs[at];
  if (!strategy || !template) throw new Error(`Job ${job.id} has no matrix to expand.`);
  const [entry] = Object.entries(strategy.matrix);
  if (!entry) throw new Error(`Job ${job.id} has no matrix key; validate the workflow first.`);
  const [key, value] = entry;
  if (typeof value === "string") {
    const ref = matrixSource(value);
    if (!ref) throw new Error(`Job ${job.id} has an invalid matrix reference; validate the workflow first.`);
    template.matrix = { key, source: { ref }, maxParallel: strategy.maxParallel };
    return [job.id];
  }
  if (matrixItemsProblem(value) !== null || !value.every(isMatrixScalar)) throw new Error(`Job ${job.id} has an invalid matrix list; validate the workflow first.`);
  const decl: MatrixDecl = { key, source: { fixed: [...value] }, maxParallel: strategy.maxParallel };
  const instances = value.map((item, index): GraphJob => ({ ...structuredClone(template), id: matrixInstanceId(job.id, index), name: `${template.name} (${String(item)})`, matrix: decl, matrixIndex: index }));
  graph.jobs.splice(at, 1, ...instances);
  graph.groups.push({ id: job.id, kind: "matrix", jobIds: instances.map((instance) => instance.id) });
  return instances.map((instance) => instance.id);
}

type BaseJob = Pick<GraphJob, "sourceJobId" | "kind" | "outputs" | "done" | "criteria" | "humanAcceptance" | "isolated">;

function expandTasks(
  reporter: Reporter,
  workflow: Workflow,
  job: Job,
  inputs: Record<string, unknown>,
  base: BaseJob,
  graph: ExpandedGraph,
  settingsOf: (job: Job, key: "agent" | "reviewer") => AgentSettingsDecl | undefined,
): string[] {
  const tasks = tasksFor(workflow, job, inputs);
  const prompt = typeof job.with.prompt === "string" ? job.with.prompt : undefined;
  const criteria: CriteriaMode = job.with.criteria === "human" ? "human" : "reviewer";
  const agent = resolveAgentSettings(workflow.defaults.agent, settingsOf(job, "agent"));
  const reviewerDecl = settingsOf(job, "reviewer");
  const reviewer = reviewerDecl === undefined ? undefined : resolveAgentSettings(workflow.defaults.agent, reviewerDecl);
  const shared: Record<string, unknown> = {};
  if (prompt !== undefined) shared.prompt = prompt;
  if (job.with.context !== undefined) shared.context = job.with.context;

  if (tasks.length === 0) {
    if (prompt === undefined) {
      reporter.report("tasks_empty", ["jobs", job.id, "with"], `Job \`${job.id}\` has neither tasks nor \`with.prompt\`.`, { onKey: true, jobId: job.id });
      return [];
    }
    const id = `${job.id}.main`;
    graph.jobs.push({ ...base, id, name: job.name ?? job.id, uses: "run-task", with: { ...shared, title: job.name ?? job.id }, agent, criteria });
    graph.groups.push({ id: job.id, kind: "tasks", jobIds: [id] });
    return [id];
  }

  const ids: string[] = [];
  for (const task of tasks) {
    const id = `${job.id}.${task.id}`;
    const hasCriterion = task.done.some((item) => "criterion" in item);
    if (hasCriterion && criteria === "reviewer" && reviewer === undefined) {
      reporter.report("tasks_reviewer_missing", ["jobs", job.id, "with"], `Task \`${task.id}\` has acceptance criteria but \`${job.id}\` sets no \`with.reviewer\`.`, { onKey: true, jobId: job.id });
    }
    const taskWith: Record<string, unknown> = { ...shared, title: task.title };
    if (task.description !== undefined) taskWith.description = task.description;
    const graphJob: GraphJob = {
      ...base,
      id,
      name: task.title,
      uses: "run-task",
      taskId: task.id,
      with: taskWith,
      done: [...task.done],
      agent,
      criteria,
      humanAcceptance: task.acceptance === "human",
    };
    if (hasCriterion && criteria === "reviewer" && reviewer !== undefined) graphJob.reviewer = { ...reviewer };
    graph.jobs.push(graphJob);
    ids.push(id);
  }
  for (const task of tasks) {
    for (const need of task.needs) graph.edges.push({ from: `${job.id}.${need}`, to: `${job.id}.${task.id}` });
  }
  graph.groups.push({ id: job.id, kind: "tasks", jobIds: ids });
  return ids;
}

function tasksFor(workflow: Workflow, job: Job, inputs: Record<string, unknown>): TaskInput[] {
  const ref = typeof job.with.tasks === "string" ? scanReferences(job.with.tasks) : null;
  const first = ref?.exact ? ref.refs[0] : undefined;
  if (first?.kind !== "input" || workflow.inputs[first.name]?.type !== "tasks") return [];
  const value = inputs[first.name];
  if (value === undefined || value === null) return [];
  const list: unknown = value;
  if (!Array.isArray(list) || !list.every(isTaskInput)) throw new Error(`Input ${first.name} must hold parsed tasks.`);
  return list;
}

function isTaskInput(value: unknown): value is TaskInput {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && "title" in value && typeof value.title === "string" && "needs" in value && Array.isArray(value.needs) && "done" in value && Array.isArray(value.done);
}
