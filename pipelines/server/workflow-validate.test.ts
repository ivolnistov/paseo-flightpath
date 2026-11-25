import { describe, expect, it } from "vitest";
import { diagnose, expectSingleAt, FEATURE_WORKFLOW, FULL_WORKFLOW, parseValid } from "./test-fixtures";
import { scanReferences } from "./workflow-validate";

const HEADER = `inputs: { goal: { type: string }, n: { type: number }, tasks: { type: tasks, required: false } }
jobs:
  discover:
    uses: agent
    with: { prompt: find }
    outputs: { modules: { type: list, items: string }, summary: { type: string }, count: { type: number } }
`;

const withJob = (job: string): string => `${HEADER}${job}`;

describe("validateWorkflow", () => {
  it("accepts the example workflow without the matrix job", () => {
    parseValid(FEATURE_WORKFLOW);
  });

  it("accepts the full example workflow with its matrix job", () => {
    parseValid(FULL_WORKFLOW);
  });

  it("accepts the reference forms of the design", () => {
    parseValid(
      withJob(`  use:
    needs: [discover]
    uses: agent
    with: { prompt: "Goal \${{ inputs.goal }} has \${{ needs.discover.outputs.count }} items: \${{ needs.discover.outputs.summary }}" }
  test:
    needs: [discover]
    uses: checks
    with: { isolated: true, run: [npm ci, [npm, test, --, "\${{ inputs.goal }}"], [node, "--count=\${{ needs.discover.outputs.count }}"]] }
`),
    );
  });

  it("accepts text criteria on agent jobs in both acceptance modes", () => {
    parseValid(
      withJob(`  auto: { uses: agent, with: { prompt: a }, done: [{ criterion: works }, { run: npm test }] }
  manual: { uses: agent, acceptance: human, with: { prompt: b }, done: [{ criterion: works }, { run: [npm, test] }] }
`),
    );
  });

  it.each<[string, string, string, number?]>([
    ["needs_unknown", "  b: { needs: [ghost], uses: approval }\n", "ghost"],
    ["needs_self", "  b: { needs: [b], uses: approval }\n", "b]"],
    ["uses_unknown", "  b: { uses: actions/checkout }\n", "actions/checkout"],
    ["with_unknown", "  b: { uses: approval, with: { prompt: ok, timeout: 5 } }\n", "timeout"],
    ["with_type", "  b: { uses: checks, with: { run: [x], isolated: yes } }\n", "yes"],
    ["ref_not_in_needs", '  b: { uses: agent, with: { prompt: "${{ needs.discover.outputs.summary }}" } }\n', '"${{ needs.discover'],
    ["ref_unknown_output", '  b: { needs: [discover], uses: agent, with: { prompt: "${{ needs.discover.outputs.nope }}" } }\n', '"${{ needs.discover'],
    ["ref_unknown_input", '  b: { uses: agent, with: { prompt: "${{ inputs.nope }}" } }\n', '"${{ inputs.nope'],
    ["ref_type", '  b: { needs: [discover], uses: agent, with: { prompt: "All: ${{ needs.discover.outputs.modules }}" } }\n', '"All:'],
    ["expression_unsupported", '  b: { uses: agent, with: { prompt: "${{ github.sha }}" } }\n', '"${{ github'],
    ["run_tasks_multiple", "  b: { uses: run-tasks, with: { prompt: x } }\n  c: { uses: run-tasks, with: { prompt: y } }\n", "run-tasks", 2],
    ["rework_target_not_ancestor", "  b: { uses: approval }\n  c: { uses: review, rework: { to: b } }\n", "b }"],
    ["rework_on_wrong_job", "  b: { needs: [discover], uses: checks, with: { run: [x] }, rework: { to: discover } }\n", "rework"],
    ["criterion_unverified", "  b: { uses: checks, with: { run: [x] }, done: [{ criterion: green }] }\n", "{ criterion: green }"],
    ["acceptance_invalid", "  b: { uses: checks, acceptance: human, with: { run: [x] } }\n", "acceptance"],
  ])("reports %s at its position", (code, job, needle, occurrence = 1) => {
    const text = withJob(job);
    const diagnostic = expectSingleAt(text, diagnose(text), code, needle, occurrence);
    expect(diagnostic.jobId).toBeDefined();
  });

  it("reports needs_cycle on every job of the cycle", () => {
    const text = withJob("  a: { needs: [c], uses: approval }\n  b: { needs: [a], uses: approval }\n  c: { needs: [b], uses: approval }\n");
    expect(diagnose(text).map((d) => [d.code, d.jobId, d.range && text.slice(d.range.start, d.range.end), d.line])).toEqual([
      ["needs_cycle", "a", "c", 7],
      ["needs_cycle", "b", "a", 8],
      ["needs_cycle", "c", "b", 9],
    ]);
  });

  it("requires a prompt on agent jobs", () => {
    expect(diagnose(withJob("  b: { uses: agent }\n")).map((d) => d.code)).toEqual(["with_type"]);
  });

  it("requires run on checks jobs", () => {
    expect(diagnose(withJob("  b: { uses: checks, with: { run: [] } }\n")).map((d) => d.code)).toEqual(["with_type"]);
  });

  it("rejects an embedded tasks input and a tasks value that is not a tasks input", () => {
    expect(diagnose(withJob('  b: { uses: agent, with: { prompt: "Do ${{ inputs.tasks }}" } }\n')).map((d) => d.code)).toEqual(["ref_type"]);
    expect(diagnose(withJob('  b: { uses: run-tasks, with: { tasks: "${{ inputs.goal }}" } }\n')).map((d) => d.code)).toEqual(["ref_type"]);
    expect(diagnose(withJob("  b: { uses: run-tasks, with: { tasks: [a] } }\n")).map((d) => d.code)).toEqual(["with_type"]);
  });

  it("rejects a non-string exact reference in a prompt", () => {
    expect(diagnose(withJob('  b: { uses: agent, with: { prompt: "${{ inputs.n }}" } }\n')).map((d) => d.code)).toEqual(["ref_type"]);
  });

  it("rejects an unknown agent settings key inside with", () => {
    const text = withJob("  b: { uses: review, with: { agent: { profile: r, sandbox: none } } }\n");
    expectSingleAt(text, diagnose(text), "unknown_key", "sandbox");
  });

  it("rejects outputs on non-agent jobs", () => {
    const text = withJob("  b: { uses: approval, outputs: { x: { type: string } } }\n");
    expectSingleAt(text, diagnose(text), "unknown_key", "outputs", 2);
  });

  describe("commands", () => {
    it.each([
      ["bare", "npm test ${{ inputs.goal }}"],
      ["inside single quotes", "npm test '${{ inputs.goal }}'"],
      ["inside double quotes", 'npm test "${{ inputs.goal }}"'],
    ])("rejects a reference in a shell string, %s", (_label, shell) => {
      const text = withJob(`  b:\n    uses: checks\n    with:\n      run:\n        - ${JSON.stringify(shell)}\n`);
      expectSingleAt(text, diagnose(text), "command_shell_ref", JSON.stringify(shell));
    });

    it("rejects a reference in a plain-scalar shell string", () => {
      const text = withJob("  b:\n    uses: checks\n    with:\n      run:\n        - echo ${{ inputs.goal }}\n");
      expectSingleAt(text, diagnose(text), "command_shell_ref", "echo");
    });

    it("rejects a reference in the executable", () => {
      const text = withJob('  b: { uses: checks, with: { run: [["${{ inputs.goal }}", "--x"]] } }\n');
      expectSingleAt(text, diagnose(text), "command_exec_ref", '"${{ inputs.goal }}"');
    });

    it.each([
      ["an empty argv", "[[]]", "[]"],
      ["a number element", "[[sleep, 5]]", "5"],
      ["a nested list element", "[[echo, [a]]]", "[a]"],
      ["a mapping element", "[[echo, { a: 1 }]]", "{ a: 1 }"],
    ])("rejects %s", (_label, run, needle) => {
      const text = withJob(`  b: { uses: checks, with: { run: ${run} } }\n`);
      expectSingleAt(text, diagnose(text), "command_argv_invalid", needle);
    });

    it("rejects a non-scalar reference in a later argv element", () => {
      const text = withJob('  b: { needs: [discover], uses: checks, with: { run: [[echo, "${{ needs.discover.outputs.modules }}"]] } }\n');
      expect(diagnose(text).map((d) => d.code)).toEqual(["ref_type"]);
    });

    it("rejects any reference in done commands", () => {
      expect(diagnose(withJob('  b: { uses: agent, with: { prompt: p }, done: [{ run: "npm test ${{ inputs.goal }}" }] }\n')).map((d) => d.code)).toEqual(["command_shell_ref"]);
      expect(diagnose(withJob('  b: { uses: agent, with: { prompt: p }, done: [{ run: ["${{ inputs.goal }}"] }] }\n')).map((d) => d.code)).toEqual(["command_exec_ref"]);
      expect(diagnose(withJob('  b: { uses: agent, with: { prompt: p }, done: [{ run: [npm, "${{ inputs.goal }}"] }] }\n')).map((d) => d.code)).toEqual(["expression_unsupported"]);
      expect(diagnose(withJob("  b: { uses: agent, with: { prompt: p }, done: [{ run: [] }] }\n")).map((d) => d.code)).toEqual(["command_argv_invalid"]);
    });
  });
});

describe("matrix", () => {
  it("accepts static and dynamic matrices on agent and checks jobs", () => {
    parseValid(
      withJob(`  fixed:
    uses: agent
    strategy: { matrix: { lang: [en, de] } }
    with: { prompt: "Translate into \${{ matrix.lang }}" }
  dynamic:
    needs: [discover]
    uses: checks
    strategy: { matrix: { module: "\${{ needs.discover.outputs.modules }}" }, max-parallel: 3 }
    with: { run: [[npm, test, --, "\${{ matrix.module }}"]] }
  numbers:
    uses: checks
    strategy: { matrix: { n: [1, 2, 3] } }
    with: { run: [[seq, "\${{ matrix.n }}"]] }
`),
    );
  });

  it.each<[string, string, string, number?]>([
    ["matrix_keys", "  b: { uses: checks, strategy: { matrix: { a: [1], b: [2] } }, with: { run: [x] } }\n", "{ a: [1]"],
    ["matrix_ref_not_list", '  b: { needs: [discover], uses: checks, strategy: { matrix: { m: "${{ needs.discover.outputs.summary }}" } }, with: { run: [x] } }\n', '"${{ needs.discover'],
    ["matrix_ref_not_list", '  b: { uses: checks, strategy: { matrix: { m: "${{ inputs.goal }}" } }, with: { run: [x] } }\n', '"${{ inputs.goal'],
    ["matrix_uses_unsupported", "  b: { uses: review, strategy: { matrix: { m: [1] } } }\n", "strategy"],
    ["matrix_outputs_unsupported", "  b: { uses: agent, strategy: { matrix: { m: [1] } }, with: { prompt: p }, outputs: { x: { type: string } } }\n", "outputs", 2],
    ["matrix_empty", "  b: { uses: checks, strategy: { matrix: { m: [] } }, with: { run: [x] } }\n", "[] }"],
    ["matrix_invalid", "  b: { uses: checks, strategy: { matrix: { m: [a, a] } }, with: { run: [x] } }\n", "[a, a]"],
    ["matrix_invalid", "  b: { uses: checks, strategy: { matrix: { m: [a, [b]] } }, with: { run: [x] } }\n", "[b]"],
    ["ref_not_in_needs", '  b: { uses: checks, strategy: { matrix: { m: "${{ needs.discover.outputs.modules }}" } }, with: { run: [x] } }\n', '"${{ needs.discover'],
    ["ref_unknown_output", '  b: { needs: [discover], uses: checks, strategy: { matrix: { m: "${{ needs.discover.outputs.nope }}" } }, with: { run: [x] } }\n', '"${{ needs.discover'],
    ["expression_unsupported", '  b: { uses: agent, with: { prompt: "${{ matrix.m }}" } }\n', '"${{ matrix.m'],
    ["expression_unsupported", '  b: { uses: agent, strategy: { matrix: { m: [x] } }, with: { prompt: "${{ matrix.other }}" } }\n', '"${{ matrix.other'],
  ])("reports %s at its position", (code, job, needle, occurrence = 1) => {
    const text = withJob(job);
    expectSingleAt(text, diagnose(text), code, needle, occurrence);
  });

  it("reports matrix_too_large for more than 64 static items", () => {
    const items = Array.from({ length: 65 }, (_, index) => index).join(", ");
    const text = withJob(`  b: { uses: checks, strategy: { matrix: { m: [${items}] } }, with: { run: [x] } }\n`);
    expectSingleAt(text, diagnose(text), "matrix_too_large", "[0, 1");
  });

  it("rejects a matrix reference in a shell string and in done commands", () => {
    const shell = withJob('  b: { uses: checks, strategy: { matrix: { m: [x] } }, with: { run: ["npm test ${{ matrix.m }}"] } }\n');
    expectSingleAt(shell, diagnose(shell), "command_shell_ref", '"npm test');
    const done = withJob('  b: { uses: agent, strategy: { matrix: { m: [x] } }, with: { prompt: p }, done: [{ run: [npm, "${{ matrix.m }}"] }] }\n');
    expect(diagnose(done).map((d) => d.code)).toEqual(["expression_unsupported"]);
  });

  it("types an exact matrix reference by its items", () => {
    expect(diagnose(withJob('  b: { uses: agent, strategy: { matrix: { n: [1, 2] } }, with: { prompt: "${{ matrix.n }}" } }\n')).map((d) => d.code)).toEqual(["ref_type"]);
    expect(diagnose(withJob('  b: { uses: agent, strategy: { matrix: { n: [1, 2] } }, with: { prompt: "Run ${{ matrix.n }}" } }\n'))).toEqual([]);
  });
});

describe("scanReferences", () => {
  it("recognizes exact and embedded references", () => {
    expect(scanReferences("${{ inputs.goal }}")).toEqual({ refs: [{ kind: "input", name: "goal" }], exact: true, invalid: [] });
    expect(scanReferences("a ${{needs.x.outputs.y}} b").exact).toBe(false);
    expect(scanReferences("${{ matrix.module }}").refs).toEqual([{ kind: "matrix", key: "module" }]);
  });

  it("flags unterminated and unknown expressions", () => {
    expect(scanReferences("${{ inputs.goal").invalid).toEqual(["${{"]);
    expect(scanReferences("${{ inputs.a || inputs.b }}").invalid).toHaveLength(1);
  });
});
