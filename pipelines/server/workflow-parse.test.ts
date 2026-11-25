import { describe, expect, it } from "vitest";
import { expectSingleAt, FEATURE_WORKFLOW, parseValid, positionOf } from "./test-fixtures";
import { parseWorkflow } from "./workflow-parse";

const minimal = (job: string): string => `jobs:\n  work:\n${job}`;

describe("parseWorkflow", () => {
  it("parses the example workflow into typed jobs", () => {
    const workflow = parseValid(FEATURE_WORKFLOW);
    expect(workflow.name).toBe("Feature delivery");
    expect(workflow.inputs).toEqual({ goal: { type: "string", required: true }, tasks: { type: "tasks", required: false } });
    expect(workflow.defaults).toEqual({
      maxParallel: 3,
      agent: { profile: "implementer", fallback: { model: "provider-b/model-b", reasoning: "medium" }, retries: 2 },
    });
    expect(workflow.jobs.map((job) => [job.id, job.uses, job.needs])).toEqual([
      ["discover", "agent", []],
      ["implement", "run-tasks", ["discover"]],
      ["lint", "checks", ["implement"]],
      ["review", "review", ["lint"]],
      ["accept", "approval", ["review"]],
    ]);
    const discover = workflow.jobs[0];
    expect(discover?.acceptance).toBe("human");
    expect(discover?.outputs).toEqual({ modules: { type: "list", items: "string" } });
    expect(discover?.done).toEqual([{ criterion: "Every affected module is listed." }]);
    expect(workflow.jobs[3]?.rework).toEqual({ to: "implement", max: 2 });
  });

  it("accepts a single need as a string and defaults rework max", () => {
    const workflow = parseValid("jobs:\n  a: { uses: agent, with: { prompt: x } }\n  b: { uses: review, needs: a, rework: { to: a } }\n");
    expect(workflow.jobs[1]?.needs).toEqual(["a"]);
    expect(workflow.jobs[1]?.rework).toEqual({ to: "a", max: 2 });
  });

  it("reports an unclosed flow sequence at its opening bracket", () => {
    const text = "jobs:\n  a: [x\n  b: 1\n";
    const { workflow, diagnostics } = parseWorkflow(text);
    expect(workflow).toBeNull();
    expect(diagnostics.map((d) => ({ code: d.code, line: d.line, column: d.column, range: d.range }))).toEqual([
      { code: "yaml_syntax", line: 3, column: 3, range: { start: 16, end: 17 } },
    ]);
  });

  it("keeps an end-of-text syntax error range inside the text", () => {
    const text = "jobs:\n  a: { uses: agent\n";
    expect(text.length).toBe(25);
    const { workflow, diagnostics } = parseWorkflow(text);
    expect(workflow).toBeNull();
    expect(diagnostics.map((d) => ({ code: d.code, line: d.line, column: d.column, range: d.range }))).toEqual([
      { code: "yaml_syntax", line: 3, column: 1, range: { start: 25, end: 25 } },
    ]);
  });

  it("reports duplicate keys at the repeated key", () => {
    const text = "jobs:\n  a: { uses: agent, with: { prompt: x } }\n  a: { uses: checks }\n";
    const { diagnostics } = parseWorkflow(text);
    expect(diagnostics.map((d) => ({ code: d.code, line: d.line, column: d.column, range: d.range }))).toEqual([
      { code: "duplicate_key", line: 3, column: 3, range: { start: 50, end: 51 } },
    ]);
  });

  it.each([
    ["a list", "- a\n- b\n"],
    ["a scalar", "hello\n"],
    ["an empty document", ""],
  ])("rejects %s as the document", (_label, text) => {
    const { workflow, diagnostics } = parseWorkflow(text);
    expect(workflow).toBeNull();
    expect(diagnostics.map((d) => d.code)).toEqual(["value_invalid"]);
  });

  it("rejects multiple documents", () => {
    expect(parseWorkflow("jobs: {}\n---\njobs: {}\n").diagnostics.map((d) => d.code)).toContain("yaml_syntax");
  });

  it("rejects unknown top-level keys at the key", () => {
    const text = "on: push\njobs:\n  a: { uses: approval }\n";
    expectSingleAt(text, parseWorkflow(text).diagnostics, "unknown_key", "on");
  });

  it("rejects unknown job keys", () => {
    const text = minimal("    uses: approval\n    runs-on: linux\n");
    const diagnostic = expectSingleAt(text, parseWorkflow(text).diagnostics, "unknown_key", "runs-on");
    expect(diagnostic.jobId).toBe("work");
  });

  it("rejects unknown agent settings keys", () => {
    const text = "defaults:\n  agent: { profile: p, temperature: 1 }\njobs:\n  a: { uses: approval }\n";
    expectSingleAt(text, parseWorkflow(text).diagnostics, "unknown_key", "temperature");
  });

  it("rejects unknown fallback keys", () => {
    const text = "defaults:\n  agent: { fallback: { model: a/b, profile: x } }\njobs:\n  a: { uses: approval }\n";
    expectSingleAt(text, parseWorkflow(text).diagnostics, "unknown_key", "profile");
  });

  it("reads a matrix strategy with max-parallel defaulting to 1", () => {
    const fixed = parseWorkflow(minimal("    uses: checks\n    strategy: { matrix: { m: [1, b, true] } }\n    with: { run: [x] }\n"));
    expect(fixed.diagnostics).toEqual([]);
    expect(fixed.workflow?.jobs[0]?.strategy).toEqual({ matrix: { m: [1, "b", true] }, maxParallel: 1 });
    const ref = parseWorkflow(minimal('    uses: checks\n    strategy: { matrix: { m: "${{ needs.a.outputs.x }}" }, max-parallel: 8 }\n    with: { run: [x] }\n'));
    expect(ref.diagnostics).toEqual([]);
    expect(ref.workflow?.jobs[0]?.strategy).toEqual({ matrix: { m: "${{ needs.a.outputs.x }}" }, maxParallel: 8 });
  });

  it("rejects strategy max-parallel outside 1..8", () => {
    const text = minimal("    uses: checks\n    strategy: { matrix: { m: [1] }, max-parallel: 9 }\n    with: { run: [x] }\n");
    expectSingleAt(text, parseWorkflow(text).diagnostics, "value_invalid", "9");
  });

  it("rejects unknown strategy keys", () => {
    const text = minimal("    uses: checks\n    strategy: { matrix: { m: [1] }, fail-fast: true }\n    with: { run: [x] }\n");
    expectSingleAt(text, parseWorkflow(text).diagnostics, "unknown_key", "fail-fast");
  });

  it("rejects a matrix without exactly one key", () => {
    const two = minimal("    uses: checks\n    strategy: { matrix: { m: [1], n: [2] } }\n    with: { run: [x] }\n");
    expectSingleAt(two, parseWorkflow(two).diagnostics, "matrix_keys", "{ m: [1], n");
    const none = minimal("    uses: checks\n    strategy: { max-parallel: 2 }\n    with: { run: [x] }\n");
    expectSingleAt(none, parseWorkflow(none).diagnostics, "matrix_keys", "strategy");
  });

  it("rejects a matrix value that is neither a list nor a reference", () => {
    const text = minimal("    uses: checks\n    strategy: { matrix: { m: 3 } }\n    with: { run: [x] }\n");
    expectSingleAt(text, parseWorkflow(text).diagnostics, "matrix_ref_not_list", "3 }");
  });

  it("rejects invalid job ids at the key", () => {
    const text = "jobs:\n  Bad.Id: { uses: approval }\n";
    expectSingleAt(text, parseWorkflow(text).diagnostics, "job_id_invalid", "Bad.Id");
  });

  it("rejects an invalid acceptance value", () => {
    const text = minimal("    uses: agent\n    acceptance: maybe\n    with: { prompt: x }\n");
    expectSingleAt(text, parseWorkflow(text).diagnostics, "acceptance_invalid", "maybe");
  });

  it("rejects invalid input types", () => {
    const text = "inputs: { n: { type: date } }\njobs:\n  a: { uses: approval }\n";
    expectSingleAt(text, parseWorkflow(text).diagnostics, "input_type_invalid", "date");
  });

  it("rejects a default of the wrong type", () => {
    const text = "inputs: { n: { type: number, default: many } }\njobs:\n  a: { uses: approval }\n";
    expectSingleAt(text, parseWorkflow(text).diagnostics, "input_type_invalid", "many");
  });

  it("rejects a second tasks input", () => {
    const text = "inputs: { a: { type: tasks }, b: { type: tasks } }\njobs:\n  a: { uses: approval }\n";
    expectSingleAt(text, parseWorkflow(text).diagnostics, "input_type_invalid", "tasks", 2);
  });

  it.each([
    ["an unknown type", "{ type: date }", "{ type: date }"],
    ["a list without items", "{ type: list }", "{ type: list }"],
    ["items on a scalar", "{ type: string, items: string }", "{ type: string, items: string }"],
  ])("rejects outputs with %s", (_label, decl, needle) => {
    const text = minimal(`    uses: agent\n    with: { prompt: x }\n    outputs: { o: ${decl} }\n`);
    expectSingleAt(text, parseWorkflow(text).diagnostics, "output_type_invalid", needle);
  });

  it("rejects a missing uses", () => {
    const text = minimal("    with: { prompt: x }\n");
    expectSingleAt(text, parseWorkflow(text).diagnostics, "uses_unknown", "work");
  });

  it.each([
    ["retries out of range", "{ retries: 11 }", "11"],
    ["a malformed model", "{ model: gpt }", "gpt"],
    ["unknown reasoning", "{ profile: p, reasoning: max }", "max"],
    ["both profile and model", "{ profile: p, model: a/b }", "a/b"],
    ["a fallback without model", "{ fallback: { reasoning: low } }", "{ reasoning: low }"],
  ])("rejects default agent settings with %s", (_label, settings, needle) => {
    const text = `defaults:\n  agent: ${settings}\njobs:\n  a: { uses: approval }\n`;
    expectSingleAt(text, parseWorkflow(text).diagnostics, "value_invalid", needle);
  });

  it("rejects max-parallel out of range", () => {
    const text = "defaults: { max-parallel: 9 }\njobs:\n  a: { uses: approval }\n";
    expectSingleAt(text, parseWorkflow(text).diagnostics, "value_invalid", "9");
  });

  it("rejects anchors and aliases", () => {
    const text = "defaults:\n  agent: &a { profile: p }\njobs:\n  a: { uses: review, with: { agent: *a } }\n";
    expectSingleAt(text, parseWorkflow(text).diagnostics, "value_invalid", "*a");
  });

  it("rejects a done item with both run and criterion", () => {
    const text = minimal("    uses: agent\n    with: { prompt: x }\n    done: [{ run: x, criterion: y }]\n");
    expectSingleAt(text, parseWorkflow(text).diagnostics, "value_invalid", "{ run: x, criterion: y }");
  });

  it("reports UTF-16 offsets after non-BMP characters", () => {
    const text = "name: \u{1F680} launch\nbogus: 1\njobs:\n  a: { uses: approval }\n";
    const [diagnostic] = parseWorkflow(text).diagnostics;
    expect(diagnostic?.range).toEqual({ start: text.indexOf("bogus"), end: text.indexOf("bogus") + 5 });
    expect(positionOf(text, text.indexOf("bogus"))).toEqual({ line: 2, column: 1 });
  });
});
