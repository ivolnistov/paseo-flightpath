import { describe, expect, it } from "vitest";
import type { RunPreview } from "../shared/rpc";
import { JOB_STATUSES, type ProviderFailure } from "../shared/run";
import type { Job, Workflow } from "../shared/workflow";
import { addOp, deriveJobId, editOp, editorLocks, editorState, mergeCriteria } from "./edit-model";
import { attempt, evidence, exampleGraph, graphJob, runDetail, runJob, runView } from "./test-support/graphs";
import {
  attentionDetails,
  CRITERIA_TITLE,
  criteriaRows,
  defaultView,
  FINAL_APPROVAL,
  jobActions,
  jobRows,
  lineDiff,
  openChats,
  proposalDelta,
  proposalState,
  providerChoices,
  runActions,
  runBlockers,
  startBlockers,
  statusLabel,
} from "./view-model";
import { highlightSpans, markRange, tokenizeYaml } from "./yaml-text";

describe("views and labels", () => {
  it("defaults to Task list on a compact layout and Diagram elsewhere", () => {
    expect(defaultView(true)).toBe("list");
    expect(defaultView(false)).toBe("diagram");
  });

  it("maps every job status to exactly one label", () => {
    const labels = Object.fromEntries(JOB_STATUSES.map((status) => [status, statusLabel({ status })]));
    expect(labels).toEqual({
      waiting: "Waiting",
      running: "In progress",
      checking: "In progress",
      reviewing: "In progress",
      awaiting_human: "Needs review",
      needs_human: "Needs attention",
      succeeded: "Done",
      failed: "Failed",
      stopped: "Stopped",
      cancelled: "Cancelled",
    });
    expect(statusLabel({ status: "succeeded" }, true)).toBe("Accepted");
  });

  it("gives an agent job and a task item awaiting human acceptance the same marker", () => {
    const graph = exampleGraph();
    const view = runView([runJob("discover", "awaiting_human"), runJob("implement.main", "awaiting_human"), runJob("lint", "needs_human")]);
    const rows = new Map(jobRows(graph, view).map((row) => [row.id, row]));
    expect(rows.get("discover")?.marker).toBe("needs-review");
    expect(rows.get("implement.main")?.marker).toBe("needs-review");
    expect(rows.get("lint")?.marker).toBe("needs-attention");
    expect(rows.get("discover")?.humanGate).toBe(true);
  });

  it("titles the approval job Final approval and marks a job a person accepted", () => {
    const view = runView([runJob("discover", "succeeded", { attempts: [attempt("discover", 1, { outcome: "succeeded" })] })], {
      evidence: [evidence("discover#1", "c1", "acceptance", null, "pass")],
    });
    const rows = jobRows(exampleGraph(), view);
    expect(rows.find((row) => row.id === "accept")).toMatchObject({ title: FINAL_APPROVAL, subtitle: "accept", humanGate: true });
    expect(rows.find((row) => row.id === "discover")?.label).toBe("Accepted");
    expect(rows.find((row) => row.id === "lint")?.label).toBeNull();
  });

  it("lists retired matrix instances after the live jobs, as history", () => {
    const view = runView([runJob("lint", "waiting"), runJob("module-tests[2]", "succeeded", { retired: true })]);
    const rows = jobRows(exampleGraph(), view);
    expect(rows[rows.length - 1]).toMatchObject({ id: "module-tests[2]", retired: true, label: "Done" });
  });
});

describe("acceptance criteria", () => {
  const job = graphJob({
    id: "build",
    uses: "agent",
    done: [{ criterion: "Docs updated" }, { run: ["npm", "test"] }, { criterion: "API stable" }, { run: "npm run lint" }, { criterion: "Reviewed" }],
  });

  it("is titled Acceptance criteria and shows met, not met, pending and stale with evidence per cycle", () => {
    expect(CRITERIA_TITLE).toBe("Acceptance criteria");
    const view = runView(
      [
        runJob("build", "reviewing", {
          attempts: [attempt("build", 1)],
          criteria: [
            { index: 0, status: "met" },
            { index: 2, status: "not_met" },
            { index: 4, status: "stale" },
          ],
        }),
      ],
      {
        evidence: [
          evidence("build#1", "build#1/c1", "check", 0, "late"),
          evidence("build#1", "build#1/c2", "check", 0, "pass", { mode: "isolated", outputTail: "ok" }),
          evidence("build#1", "build#1/c2", "check", 1, "fail", { exitCode: 2 }),
          evidence("build#1", "build#1/c2", "criterion", 0, "pass"),
          evidence("build#1", "build#1/c2", "criterion", 2, "fail"),
          evidence("build#0", "other", "check", 0, "fail"),
        ],
        invalidatedCycles: ["build#1/c1"],
      },
    );
    const rows = criteriaRows(job, view);
    expect(rows.map((row) => [row.index, row.kind, row.status])).toEqual([
      [0, "criterion", "met"],
      [1, "check", "met"],
      [2, "criterion", "not_met"],
      [3, "check", "not_met"],
      [4, "criterion", "stale"],
    ]);
    expect(rows[1]?.text).toBe("npm test");
    expect(rows[1]?.cycles).toEqual([
      expect.objectContaining({ cycleId: "build#1/c1", invalidated: true, result: "late" }),
      expect.objectContaining({ cycleId: "build#1/c2", invalidated: false, result: "pass", mode: "isolated", exitCode: 0, outputTail: "ok" }),
    ]);
    expect(rows[3]?.cycles).toEqual([expect.objectContaining({ exitCode: 2 })]);
  });

  it("shows every item pending without a run, and a checks job's commands as its criteria", () => {
    expect(criteriaRows(job).map((row) => row.status)).toEqual(["pending", "pending", "pending", "pending", "pending"]);
    const checks = graphJob({ id: "lint", uses: "checks", with: { run: ["npm ci", ["npm", "test", "--", "a b"]] } });
    expect(criteriaRows(checks).map((row) => row.text)).toEqual(["npm ci", 'npm test -- "a b"']);
  });
});

describe("job actions", () => {
  const graph = exampleGraph();
  const detail = (jobs: ReturnType<typeof runJob>[]) => runDetail(runView(jobs), graph);
  const find = (id: string) => {
    const job = graph.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error(id);
    return job;
  };

  it("offers Accept on a task and Approve on the approval job, never one in place of the other", () => {
    const task = runJob("implement.main", "awaiting_human", { activeCycleId: "c1" });
    const final = runJob("accept", "awaiting_human", { activeCycleId: "c9" });
    const run = detail([task, final]);
    const taskActions = jobActions(find("implement.main"), task, run).map((action) => action.kind);
    const finalActions = jobActions(find("accept"), final, run).map((action) => action.kind);
    expect(taskActions).toContain("accept");
    expect(taskActions).not.toContain("approve");
    expect(finalActions).toContain("approve");
    expect(finalActions).not.toContain("accept");
  });

  it("requires a mark for every human text criterion on a standalone agent job", () => {
    const live = runJob("discover", "awaiting_human", { activeCycleId: "c1" });
    expect(jobActions(find("discover"), live, detail([live]))).toContainEqual({ kind: "accept", cycleId: "c1", criteria: [0] });
  });

  it("offers exactly Retry on primary, Retry on fallback and Stop for a needs_human job and lists both failures", () => {
    const failures: ProviderFailure[] = [
      { target: "primary", provider: "a", model: "m1", class: "quota", message: "limit", at: "t1" },
      { target: "fallback", provider: "b", model: "m2", class: "unavailable", message: "down", at: "t2" },
    ];
    const live = runJob("discover", "needs_human", { providerFailures: failures });
    expect(jobActions(find("discover"), live, detail([live]))).toEqual([
      { kind: "retry", target: "primary", label: "Retry on primary" },
      { kind: "retry", target: "fallback", label: "Retry on fallback" },
      { kind: "stop" },
    ]);
    expect(jobRows(graph, runView([live])).find((row) => row.id === "discover")).toMatchObject({ label: "Needs attention", marker: "needs-attention" });
    expect(attentionDetails(live)).toEqual(["primary: a/m1 · quota · t1 · limit", "fallback: b/m2 · unavailable · t2 · down"]);
    expect(attentionDetails(runJob("discover", "failed", { providerFailures: failures }))).toEqual([]);
  });

  it("offers Grant return for an exhausted rework and nothing on a finished run", () => {
    const live = runJob("review", "failed", { reason: "rework_exhausted" });
    expect(jobActions(find("review"), live, detail([live])).map((action) => action.kind)).toEqual(["grant-return", "retry"]);
    const finished = runDetail(runView([live], { status: "finished" }), graph);
    expect(jobActions(find("review"), live, finished)).toEqual([]);
  });

  it("gives one Open chat per bound agent of the latest attempt", () => {
    const agent = (role: "worker" | "reviewer", agentId: string | null) => ({ role, creationKey: `${role}-key`, agentId, settings: { provider: "p", model: "m" }, target: "primary" as const, intentAt: "t", boundAt: agentId ? "t" : null });
    const live = runJob("build", "reviewing", { attempts: [attempt("build", 1, { agents: [agent("worker", "w1"), agent("reviewer", "r1")] })] });
    expect(openChats(live).map((chat) => chat.agentId)).toEqual(["w1", "r1"]);
    const unbound = runJob("build", "running", { attempts: [attempt("build", 1, { agents: [agent("worker", null)] })] });
    expect(openChats(unbound)).toEqual([]);
  });
});

describe("run actions and blockers", () => {
  it("offers Retry stop on quiesce_unconfirmed and only Resume and Cancel on binding_unknown", () => {
    expect(runActions({ status: "paused", pauseReason: "quiesce_unconfirmed" })).toEqual(["retry-stop", "cancel"]);
    expect(runActions({ status: "paused", pauseReason: "binding_unknown" })).toEqual(["resume", "cancel"]);
    expect(runActions({ status: "running", pauseReason: null })).toEqual(["pause", "cancel"]);
    expect(runActions({ status: "finished", pauseReason: null })).toEqual([]);
  });

  it("names the jobs holding a run that has no active job", () => {
    const blocked = runDetail(runView([runJob("discover", "succeeded"), runJob("implement.main", "awaiting_human"), runJob("lint", "waiting"), runJob("accept", "failed", { reason: "changes_requested" })]));
    expect(runBlockers(blocked).map((blocker) => [blocker.id, blocker.label, blocker.title])).toEqual([
      ["implement.main", "Needs review", "implement"],
      ["accept", "Failed", FINAL_APPROVAL],
    ]);
    expect(runBlockers(runDetail(runView([runJob("lint", "running"), runJob("accept", "failed")])))).toEqual([]);
    expect(runBlockers(runDetail(runView([runJob("accept", "failed")], { status: "finished" })))).toEqual([]);
  });
});

describe("start and proposals", () => {
  const preview = (extra: Partial<RunPreview>): RunPreview => ({ workflowDigest: "a".repeat(64), diagnostics: [], jobCount: 6, settings: {}, hasDraft: false, graph: null, blockers: [], ...extra });

  it("blocks Start while any blocker exists or the preview is missing", () => {
    expect(startBlockers(preview({}))).toEqual([]);
    expect(startBlockers(preview({ blockers: ["inputs_invalid", "settings_unresolved"] }))).toHaveLength(2);
    expect(startBlockers(null)).toHaveLength(1);
  });

  it("lists primary and fallback per role", () => {
    expect(
      providerChoices({ worker: { primary: { provider: "a", model: "m", reasoning: "high" }, fallback: { provider: "b", model: "n" }, retries: 2 }, reviewer: { primary: { provider: "a", model: "r", profile: "rev" }, retries: 1 } }),
    ).toEqual([
      { role: "worker", target: "primary", label: "a/m · high" },
      { role: "worker", target: "fallback", label: "b/n" },
      { role: "reviewer", target: "primary", label: "rev (a/r)" },
    ]);
  });

  it("disables Apply for a stale or invalid proposal", () => {
    expect(proposalState({ status: "pending", diagnostics: [] }).canApply).toBe(true);
    expect(proposalState({ status: "stale", diagnostics: [] }).canApply).toBe(false);
    expect(proposalState({ status: "pending", diagnostics: [{}] }).canApply).toBe(false);
    expect(proposalState({ status: "applied", diagnostics: [] }).canApply).toBe(false);
  });

  it("reports added, removed and changed jobs and a line diff", () => {
    const job = (id: string, extra: Partial<Job> = {}): Job => ({ id, needs: [], uses: "checks", with: {}, outputs: {}, done: [], ...extra });
    const base = { jobs: [job("a"), job("b"), job("c")] };
    const next = { jobs: [job("a"), job("c", { needs: ["a"] }), job("d")] };
    expect(proposalDelta(base, next)).toEqual({ added: ["d"], removed: ["b"], changed: ["c"] });
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
  });
});

describe("job editor", () => {
  const job: Job = {
    id: "build",
    name: "Build",
    needs: ["plan"],
    uses: "agent",
    with: { prompt: "Do it for ${{ inputs.goal }}", context: "${{ needs.plan.outputs.notes }}", agent: { model: "a/m1", reasoning: "low" } },
    outputs: {},
    done: [{ criterion: "One" }, { run: "npm test" }, { criterion: "Two" }],
  };

  it("sends leaf changes only, so unrelated `with` keys and `run` items are never rewritten", () => {
    const state = editorState(job);
    expect(state.agent?.selection).toEqual({ kind: "model", value: "a/m1" });
    const op = editOp(job, { ...state, agent: state.agent && { ...state.agent, selection: { kind: "model", value: "b/m2" }, fallback: { model: "c/m3", reasoning: "high" } }, criteria: ["One!", "Two", "Three"] });
    expect(op).toEqual({
      kind: "job.patch",
      id: "build",
      changes: [
        { path: ["with", "agent", "model"], value: "b/m2" },
        { path: ["with", "agent", "fallback"], value: { model: "c/m3", reasoning: "high" } },
        { path: ["done"], value: [{ criterion: "One!" }, { run: "npm test" }, { criterion: "Two" }, { criterion: "Three" }] },
      ],
    });
    expect(editOp(job, state)).toBeNull();
  });

  it("edits an existing block's prompt, name, acceptance and needs, and removes cleared settings", () => {
    const state = editorState(job);
    expect(editOp(job, { ...state, prompt: "New prompt", name: "", acceptance: "human", needs: [], agent: state.agent && { ...state.agent, reasoning: null } })).toEqual({
      kind: "job.patch",
      id: "build",
      changes: [
        { path: ["name"], remove: true },
        { path: ["acceptance"], value: "human" },
        { path: ["with", "prompt"], value: "New prompt" },
        { path: ["with", "agent", "reasoning"], remove: true },
        { path: ["needs"], remove: true },
      ],
    });
  });

  it("produces the patch the server regression applies for a prompt, model and reasoning edit", () => {
    const tasks: Job = {
      id: "build",
      needs: [],
      uses: "run-tasks",
      with: { prompt: "Build it", context: "docs/notes.md", agent: { model: "a/m1", retries: 3, fallback: { model: "b/m2", reasoning: "low" } }, reviewer: { profile: "rev" } },
      outputs: {},
      done: [],
    };
    const state = editorState(tasks);
    const agent = state.agent;
    if (!agent) throw new Error("agent settings are editable here");
    expect(editOp(tasks, { ...state, prompt: "Build it well", agent: { ...agent, selection: { kind: "model", value: "a/m9" }, reasoning: "medium", fallback: { model: "b/m2", reasoning: "high" } } })).toEqual({
      kind: "job.patch",
      id: "build",
      changes: [
        { path: ["with", "prompt"], value: "Build it well" },
        { path: ["with", "agent", "model"], value: "a/m9" },
        { path: ["with", "agent", "fallback", "reasoning"], value: "high" },
        { path: ["with", "agent", "reasoning"], value: "medium" },
      ],
    });
  });

  it("edits one fallback key in place", () => {
    const withFallback: Job = { ...job, with: { ...job.with, agent: { model: "a/m1", fallback: { model: "c/m3", reasoning: "low" } } } };
    const state = editorState(withFallback);
    const op = editOp(withFallback, { ...state, agent: state.agent && { ...state.agent, fallback: { model: "c/m3", reasoning: "high" } } });
    expect(op).toEqual({ kind: "job.patch", id: "build", changes: [{ path: ["with", "agent", "fallback", "reasoning"], value: "high" }] });
  });

  it("leaves settings it cannot show to YAML", () => {
    expect(editorLocks({ ...job, with: { agent: { model: "${{ inputs.model }}" } } }).agent).toMatch(/expression/);
    expect(editorLocks({ ...job, with: { agent: { model: "a/b", extra: 1 } } }).agent).toMatch(/keys/);
    const checksLocks = editorLocks({ ...job, uses: "checks" });
    expect(checksLocks.prompt).toMatch(/no prompt/);
    expect(checksLocks.criteria).toMatch(/agent jobs/);
    expect(editorState({ ...job, with: { prompt: ["not", "text"] } }).prompt).toBeNull();
  });

  it("merges criteria in place and removes dropped ones", () => {
    expect(mergeCriteria(job.done, ["Only"])).toEqual([{ criterion: "Only" }, { run: "npm test" }]);
  });

  it("adds a block with a free id derived from its name", () => {
    expect(deriveJobId("Run Tests!", "checks", ["run-tests"])).toBe("run-tests-2");
    const model: Pick<Workflow, "jobs"> = { jobs: [job] };
    expect(addOp({ uses: "checks", name: "Lint", prompt: "", command: "npm run lint", needs: ["build"] }, model.jobs.map((j) => j.id))).toEqual({
      kind: "job.add",
      id: "lint",
      fields: { uses: "checks", name: "Lint", needs: ["build"], with: { run: ["npm run lint"] } },
    });
  });
});

describe("YAML marks", () => {
  const text = "jobs:\n  build:\n    uses: nope # bad\n";

  it("marks a diagnostic's exact range, else its line", () => {
    expect(markRange(text, { range: { start: 25, end: 29 }, line: 3 })).toEqual({ start: 25, end: 29 });
    expect(markRange(text, { range: null, line: 2 })).toEqual({ start: 6, end: 14 });
    expect(markRange(text, { range: null, line: 0 })).toBeNull();
  });

  it("covers every character exactly once with colored spans, split at marks", () => {
    const spans = highlightSpans(text, tokenizeYaml(text), [{ start: 25, end: 29, active: true }]);
    expect(spans.map((span) => text.slice(span.start, span.end)).join("")).toBe(text);
    expect(spans.filter((span) => span.marked).map((span) => text.slice(span.start, span.end))).toEqual(["nope"]);
    expect(spans.find((span) => text.slice(span.start, span.end) === "build")?.kind).toBe("key");
    expect(spans.find((span) => text.slice(span.start, span.end) === "# bad")?.kind).toBe("comment");
  });
});
