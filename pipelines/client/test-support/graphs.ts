import type { RunDetail } from "../../shared/rpc";
import type { Attempt, Evidence, RunView } from "../../shared/run";
import type { ExpandedGraph, GraphJob } from "../../shared/workflow";

const base = { outputs: {}, done: [], criteria: "reviewer" as const, humanAcceptance: false, isolated: false };

export function graphJob(job: Partial<GraphJob> & Pick<GraphJob, "id" | "uses">): GraphJob {
  return { sourceJobId: job.id, name: job.id, kind: "coding", with: {}, ...base, ...job };
}

/** The design's example workflow as Planning expands it without Start inputs. */
export function exampleGraph(): ExpandedGraph {
  return {
    jobs: [
      graphJob({
        id: "discover",
        uses: "agent",
        kind: "coding",
        with: { prompt: "List the modules affected by: ${{ inputs.goal }}" },
        outputs: { modules: { type: "list", items: "string" } },
        done: [{ criterion: "Every affected module is listed." }],
        criteria: "human",
        humanAcceptance: true,
        agent: { profile: "implementer", retries: 2, fallback: { model: "provider-b/model-b", reasoning: "medium" } },
      }),
      graphJob({ id: "implement.main", sourceJobId: "implement", name: "implement", uses: "run-task", with: { title: "implement", prompt: "${{ inputs.goal }}" }, agent: { profile: "implementer", retries: 2 } }),
      graphJob({ id: "lint", uses: "checks", kind: "testing", with: { run: ["npm run lint"] } }),
      graphJob({
        id: "module-tests",
        uses: "checks",
        kind: "testing",
        isolated: true,
        with: { isolated: true, run: ["npm ci", ["npm", "test", "--", "${{ matrix.module }}"]] },
        matrix: { key: "module", source: { ref: { jobId: "discover", output: "modules" } }, maxParallel: 2 },
      }),
      graphJob({ id: "review", uses: "review", kind: "review", agent: { profile: "reviewer", retries: 2 } }),
      graphJob({ id: "accept", uses: "approval", kind: "acceptance" }),
    ],
    edges: [
      { from: "discover", to: "implement.main" },
      { from: "implement.main", to: "lint" },
      { from: "discover", to: "module-tests" },
      { from: "implement.main", to: "module-tests" },
      { from: "lint", to: "review" },
      { from: "module-tests", to: "review" },
      { from: "review", to: "accept" },
    ],
    groups: [{ id: "implement", kind: "tasks", jobIds: ["implement.main"] }],
    reworks: [{ from: "review", to: "implement", max: 2 }],
    maxParallel: 3,
  };
}

/** The example with `module-tests` as a static matrix of three instances. */
export function staticMatrixGraph(): ExpandedGraph {
  const graph = exampleGraph();
  const source = graph.jobs.find((job) => job.id === "module-tests");
  if (!source) throw new Error("fixture changed");
  const values = ["api", "web", "cli"];
  const instances = values.map((value, index) => ({ ...source, id: `module-tests[${index}]`, sourceJobId: "module-tests", name: `module-tests (${value})`, matrix: { key: "module", source: { fixed: values }, maxParallel: 2 }, matrixIndex: index }));
  return {
    ...graph,
    jobs: graph.jobs.flatMap((job) => (job.id === "module-tests" ? instances : [job])),
    edges: graph.edges.flatMap((edge) => {
      if (edge.to === "module-tests") return instances.map((instance) => ({ from: edge.from, to: instance.id }));
      if (edge.from === "module-tests") return instances.map((instance) => ({ from: instance.id, to: edge.to }));
      return [edge];
    }),
    groups: [...graph.groups, { id: "module-tests", kind: "matrix", jobIds: instances.map((instance) => instance.id) }],
  };
}

const identity = { headCommit: "h", indexTree: "i", contentTree: "c" };

export function attempt(jobId: string, n: number, extra: Partial<Attempt> = {}): Attempt {
  return { attemptId: `${jobId}#${n}`, jobId, n, cause: n === 1 ? "first" : "retry", startedAt: "2026-11-21T10:00:00Z", endedAt: null, agents: [], target: "primary", outcome: null, reason: null, outputs: null, ...extra };
}

export function evidence(attemptId: string, cycleId: string, kind: Evidence["kind"], item: number | null, result: Evidence["result"], extra: Partial<Evidence> = {}): Evidence {
  return { id: `${cycleId}:${kind}:${String(item)}:${result}`, attemptId, cycleId, kind, item, result, mode: kind === "check" ? "exclusive" : null, exitCode: kind === "check" ? (result === "pass" ? 0 : 1) : null, outputTail: null, identity, at: "2026-11-21T10:01:00Z", ...extra };
}

export function runView(jobs: RunView["jobs"], extra: Partial<RunView> = {}): RunView {
  return { runId: "r1", projectId: "p1", status: "running", pauseReason: null, workspace: null, jobs, evidence: [], invalidatedCycles: [], barrier: null, unresolvedIntents: [], ...extra };
}

export function runJob(id: string, status: RunView["jobs"][number]["status"], extra: Partial<RunView["jobs"][number]> = {}): RunView["jobs"][number] {
  return { id, status, reason: null, attempts: [], criteria: [], providerFailures: [], activeCycleId: null, ...extra };
}

export function runDetail(view: RunView, graph: ExpandedGraph = exampleGraph()): RunDetail {
  return { view, graph, settings: {}, workflowName: "Feature delivery", startKey: "k", createdAt: "2026-11-21T10:00:00Z", health: "ok", waits: null };
}
