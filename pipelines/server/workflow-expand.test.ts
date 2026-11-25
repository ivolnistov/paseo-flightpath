import { describe, expect, it } from "vitest";
import { DiagnosticsError } from "../shared/errors";
import type { TaskInput } from "../shared/tasks";
import type { ExpandedGraph } from "../shared/workflow";
import { parseTasks } from "./start-inputs";
import { FEATURE_WORKFLOW, parseValid } from "./test-fixtures";
import { expandWorkflow, resolveAgentSettings } from "./workflow-expand";

function tasks(text: string): TaskInput[] {
  const result = parseTasks(text);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.tasks;
}

function edges(graph: ExpandedGraph): string[] {
  return graph.edges.map((edge) => `${edge.from}->${edge.to}`).sort();
}

function expandError(fn: () => unknown): DiagnosticsError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DiagnosticsError) return error;
    throw error;
  }
  throw new Error("expected a DiagnosticsError");
}

const THREE_TASKS = "- { id: t1, title: Base }\n- { id: t2, title: Left, needs: [t1] }\n- { id: t3, title: Right, needs: [t1], acceptance: human }\n";

describe("expandWorkflow", () => {
  it("expands tasks with exactly their needs, the run-tasks needs and the join", () => {
    const workflow = parseValid(FEATURE_WORKFLOW);
    const graph = expandWorkflow(workflow, { goal: "g", tasks: tasks(THREE_TASKS) });
    expect(graph.jobs.map((job) => job.id)).toEqual(["discover", "implement.t1", "implement.t2", "implement.t3", "lint", "review", "accept"]);
    expect(edges(graph)).toEqual(
      [
        "implement.t1->implement.t2",
        "implement.t1->implement.t3",
        "discover->implement.t1",
        "discover->implement.t2",
        "discover->implement.t3",
        "implement.t1->lint",
        "implement.t2->lint",
        "implement.t3->lint",
        "lint->review",
        "review->accept",
      ].sort(),
    );
    expect(edges(graph)).not.toContain("implement.t2->implement.t3");
    expect(edges(graph)).not.toContain("implement.t3->implement.t2");
    expect(graph.groups).toEqual([{ id: "implement", kind: "tasks", jobIds: ["implement.t1", "implement.t2", "implement.t3"] }]);
    expect(graph.reworks).toEqual([{ from: "review", to: "implement", max: 2 }]);
    expect(graph.maxParallel).toBe(3);
    const t3 = graph.jobs.find((job) => job.id === "implement.t3");
    expect(t3).toMatchObject({ sourceJobId: "implement", uses: "run-task", taskId: "t3", name: "Right", humanAcceptance: true, criteria: "reviewer" });
    expect(t3?.with).toEqual({ prompt: "${{ inputs.goal }}", context: "${{ needs.discover.outputs.modules }}", title: "Right" });
  });

  it("expands to exactly <job>.main without tasks", () => {
    const graph = expandWorkflow(parseValid(FEATURE_WORKFLOW), { goal: "g" });
    const group = graph.jobs.filter((job) => job.sourceJobId === "implement");
    expect(group.map((job) => job.id)).toEqual(["implement.main"]);
    expect(group[0]?.with.prompt).toBe("${{ inputs.goal }}");
    expect(group[0]?.taskId).toBeUndefined();
    expect(edges(graph)).toContain("discover->implement.main");
    expect(edges(graph)).toContain("implement.main->lint");
  });

  it("treats an empty task list like no tasks", () => {
    const graph = expandWorkflow(parseValid(FEATURE_WORKFLOW), { goal: "g", tasks: [] });
    expect(graph.groups[0]?.jobIds).toEqual(["implement.main"]);
  });

  it("refuses with tasks_empty when there are neither tasks nor a prompt", () => {
    const workflow = parseValid('inputs: { tasks: { type: tasks, required: false } }\njobs:\n  implement: { uses: run-tasks, with: { tasks: "${{ inputs.tasks }}" } }\n');
    const error = expandError(() => expandWorkflow(workflow, {}));
    expect(error.diagnostics.map((d) => [d.code, d.jobId, d.line])).toEqual([["tasks_empty", "implement", 3]]);
  });

  it("refuses with tasks_reviewer_missing when a criterion has no reviewer", () => {
    const workflow = parseValid('inputs: { tasks: { type: tasks } }\njobs:\n  implement: { uses: run-tasks, with: { tasks: "${{ inputs.tasks }}" } }\n');
    const list = tasks("- { id: t1, title: x, done: [{ criterion: Works }] }\n- { id: t2, title: y, done: [{ run: make }] }\n");
    expect(expandError(() => expandWorkflow(workflow, { tasks: list })).diagnostics.map((d) => [d.code, d.jobId, d.line, d.column])).toEqual([["tasks_reviewer_missing", "implement", 3, 33]]);
  });

  it("allows criteria without a reviewer in human criteria mode", () => {
    const workflow = parseValid('inputs: { tasks: { type: tasks } }\njobs:\n  implement: { uses: run-tasks, with: { tasks: "${{ inputs.tasks }}", criteria: human } }\n');
    const graph = expandWorkflow(workflow, { tasks: tasks("- { id: t1, title: x, done: [{ criterion: Works }] }\n") });
    expect(graph.jobs[0]).toMatchObject({ criteria: "human", humanAcceptance: false });
    expect(graph.jobs[0]?.reviewer).toBeUndefined();
  });

  it("binds a task reviewer only for tasks with criteria", () => {
    const graph = expandWorkflow(parseValid(FEATURE_WORKFLOW), { goal: "g", tasks: tasks("- { id: t1, title: x, done: [{ criterion: Works }] }\n- { id: t2, title: y }\n") });
    const [t1, t2] = graph.jobs.filter((job) => job.uses === "run-task");
    expect(t1?.reviewer).toEqual({ profile: "reviewer", fallback: { model: "provider-b/model-b", reasoning: "medium" }, retries: 2 });
    expect(t2?.reviewer).toBeUndefined();
  });

  it("derives standalone agent criteria and the reviewer binding from acceptance", () => {
    const workflow = parseValid(`defaults: { agent: { profile: base } }
jobs:
  auto: { uses: agent, with: { prompt: a, agent: { model: p/m } }, done: [{ criterion: ok }] }
  manual: { uses: agent, acceptance: human, with: { prompt: b }, done: [{ criterion: ok }] }
  plain: { uses: agent, with: { prompt: c }, done: [{ run: make }] }
`);
    const [auto, manual, plain] = expandWorkflow(workflow, {}).jobs;
    expect(auto).toMatchObject({ criteria: "reviewer", humanAcceptance: false, agent: { model: "p/m", retries: 2 }, reviewer: { model: "p/m", retries: 2 } });
    expect(manual).toMatchObject({ criteria: "human", humanAcceptance: true });
    expect(manual?.reviewer).toBeUndefined();
    expect(plain?.reviewer).toBeUndefined();
  });

  it("marks isolated checks and keeps commands literal", () => {
    const workflow = parseValid("jobs:\n  t: { uses: checks, with: { isolated: true, run: [npm ci] } }\n  u: { uses: checks, with: { run: [x] } }\n");
    const [t, u] = expandWorkflow(workflow, {}).jobs;
    expect(t).toMatchObject({ isolated: true, kind: "testing", with: { isolated: true, run: ["npm ci"] } });
    expect(u?.isolated).toBe(false);
  });
});

describe("resolveAgentSettings", () => {
  const inherited = { profile: "implementer", reasoning: "high" as const, fallback: { model: "b/fallback", reasoning: "medium" as const }, retries: 4 };

  it("inherits everything when the job sets nothing", () => {
    expect(resolveAgentSettings(inherited, undefined)).toEqual(inherited);
  });

  it("replaces the inherited selection with an explicit model and keeps the rest", () => {
    expect(resolveAgentSettings(inherited, { model: "a/primary" })).toEqual({ model: "a/primary", fallback: { model: "b/fallback", reasoning: "medium" }, retries: 4 });
  });

  it("replaces the inherited selection with an explicit profile", () => {
    expect(resolveAgentSettings({ model: "a/m", reasoning: "low", retries: 1 }, { profile: "reviewer" })).toEqual({ profile: "reviewer", retries: 1 });
  });

  it("overrides only reasoning when no selection is given", () => {
    expect(resolveAgentSettings(inherited, { reasoning: "low" })).toMatchObject({ profile: "implementer", reasoning: "low" });
  });

  it("replaces the whole fallback block", () => {
    expect(resolveAgentSettings(inherited, { fallback: { model: "c/other" } }).fallback).toEqual({ model: "c/other" });
  });

  it("defaults retries to 2", () => {
    expect(resolveAgentSettings({}, {}).retries).toBe(2);
  });

  it("applies inheritance through expansion", () => {
    const workflow = parseValid(`defaults:
  agent: { profile: implementer, fallback: { model: b/fb, reasoning: medium }, retries: 3 }
jobs:
  a: { uses: agent, with: { prompt: x, agent: { model: a/m, reasoning: high } } }
  b: { uses: review, with: { agent: { fallback: { model: c/fb } } } }
`);
    const [a, b] = expandWorkflow(workflow, {}).jobs;
    expect(a?.agent).toEqual({ model: "a/m", reasoning: "high", fallback: { model: "b/fb", reasoning: "medium" }, retries: 3 });
    expect(b?.agent).toEqual({ profile: "implementer", fallback: { model: "c/fb" }, retries: 3 });
  });
});
