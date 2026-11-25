import { describe, expect, it } from "vitest";
import { PipelineError } from "../shared/errors";
import { FEATURE_WORKFLOW, parseValid } from "./test-fixtures";
import { applyEdit, type EditOp } from "./workflow-edit";

const BLOCK = `# Workflow header comment
name: Edits
jobs:
  # discovery comes first
  discover:
    uses: agent # inline comment
    with:
      prompt: Find modules
    # trailing comment inside discover
  build:
    needs: [discover]
    uses: checks
    with: { run: [npm ci] } # build comment
  ship: { needs: [build], uses: approval }
# footer comment
`;

/** Two jobs with identical lines and comments, so an edit must pick the right copy. */
const TWINS = `jobs:
  one:
    # same comment
    uses: checks # same
    with: { run: [make] }
  two:
    # same comment
    uses: checks # same
    with: { run: [make] }
  three:
    # same comment
    uses: checks # same
    with: { run: [make] }
`;

const cases: Array<{ name: string; before: string; op: EditOp; expected: string }> = [
  {
    name: "appends a key after the last key and before the job's trailing comment",
    before: BLOCK,
    op: { kind: "job.update", id: "discover", set: { name: "Discover" } },
    expected: `# Workflow header comment
name: Edits
jobs:
  # discovery comes first
  discover:
    uses: agent # inline comment
    with:
      prompt: Find modules
    name: Discover
    # trailing comment inside discover
  build:
    needs: [discover]
    uses: checks
    with: { run: [npm ci] } # build comment
  ship: { needs: [build], uses: approval }
# footer comment
`,
  },
  {
    name: "replaces a scalar in place and keeps its inline comment",
    before: BLOCK,
    op: { kind: "job.update", id: "discover", set: { uses: "review" } },
    expected: BLOCK.replace("    uses: agent # inline comment\n", "    uses: review # inline comment\n"),
  },
  {
    name: "replaces a block value with one line",
    before: BLOCK,
    op: { kind: "job.update", id: "discover", set: { with: { prompt: "Find ${{ inputs.goal }}" } } },
    expected: `# Workflow header comment
name: Edits
jobs:
  # discovery comes first
  discover:
    uses: agent # inline comment
    with: { prompt: "Find \${{ inputs.goal }}" }
    # trailing comment inside discover
  build:
    needs: [discover]
    uses: checks
    with: { run: [npm ci] } # build comment
  ship: { needs: [build], uses: approval }
# footer comment
`,
  },
  {
    name: "removes one key's line",
    before: BLOCK,
    op: { kind: "job.update", id: "build", unset: ["needs"] },
    expected: `# Workflow header comment
name: Edits
jobs:
  # discovery comes first
  discover:
    uses: agent # inline comment
    with:
      prompt: Find modules
    # trailing comment inside discover
  build:
    uses: checks
    with: { run: [npm ci] } # build comment
  ship: { needs: [build], uses: approval }
# footer comment
`,
  },
  {
    name: "replaces a flow value and keeps its comment",
    before: BLOCK,
    op: { kind: "job.update", id: "build", set: { with: { run: ["npm test"] } } },
    expected: BLOCK.replace("    with: { run: [npm ci] } # build comment\n", "    with: { run: [ npm test ] } # build comment\n"),
  },
  {
    name: "sets needs on a job without them",
    before: BLOCK,
    op: { kind: "job.setNeeds", id: "discover", needs: ["build", "ship"] },
    expected: BLOCK.replace("      prompt: Find modules\n", "      prompt: Find modules\n    needs: [ build, ship ]\n"),
  },
  {
    name: "replaces existing needs",
    before: BLOCK,
    op: { kind: "job.setNeeds", id: "build", needs: ["ship"] },
    expected: BLOCK.replace("    needs: [discover]\n", "    needs: [ ship ]\n"),
  },
  {
    name: "clears needs",
    before: BLOCK,
    op: { kind: "job.setNeeds", id: "build", needs: [] },
    expected: BLOCK.replace("    needs: [discover]\n", ""),
  },
  {
    name: "re-renders only a flow-style job",
    before: BLOCK,
    op: { kind: "job.setNeeds", id: "ship", needs: ["discover", "build"] },
    expected: BLOCK.replace("  ship: { needs: [build], uses: approval }\n", "  ship: { needs: [ discover, build ], uses: approval }\n"),
  },
  {
    name: "appends a job after the last job and before the footer comment",
    before: BLOCK,
    op: { kind: "job.add", id: "review", fields: { needs: ["ship"], uses: "review", with: { agent: { profile: "reviewer" } } } },
    expected: `# Workflow header comment
name: Edits
jobs:
  # discovery comes first
  discover:
    uses: agent # inline comment
    with:
      prompt: Find modules
    # trailing comment inside discover
  build:
    needs: [discover]
    uses: checks
    with: { run: [npm ci] } # build comment
  ship: { needs: [build], uses: approval }
  review:
    needs: [ ship ]
    uses: review
    with: { agent: { profile: reviewer } }
# footer comment
`,
  },
  {
    name: "removes a block job with its trailing comment",
    before: BLOCK,
    op: { kind: "job.remove", id: "discover" },
    expected: `# Workflow header comment
name: Edits
jobs:
  # discovery comes first
  build:
    needs: [discover]
    uses: checks
    with: { run: [npm ci] } # build comment
  ship: { needs: [build], uses: approval }
# footer comment
`,
  },
  {
    name: "removes a flow-style job line",
    before: BLOCK,
    op: { kind: "job.remove", id: "ship" },
    expected: `# Workflow header comment
name: Edits
jobs:
  # discovery comes first
  discover:
    uses: agent # inline comment
    with:
      prompt: Find modules
    # trailing comment inside discover
  build:
    needs: [discover]
    uses: checks
    with: { run: [npm ci] } # build comment
# footer comment
`,
  },
  {
    name: "edits only the middle copy of identical lines",
    before: TWINS,
    op: { kind: "job.update", id: "two", set: { uses: "review" } },
    expected: `jobs:
  one:
    # same comment
    uses: checks # same
    with: { run: [make] }
  two:
    # same comment
    uses: review # same
    with: { run: [make] }
  three:
    # same comment
    uses: checks # same
    with: { run: [make] }
`,
  },
  {
    name: "removes only the middle copy of identical jobs",
    before: TWINS,
    op: { kind: "job.remove", id: "two" },
    expected: `jobs:
  one:
    # same comment
    uses: checks # same
    with: { run: [make] }
  three:
    # same comment
    uses: checks # same
    with: { run: [make] }
`,
  },
  {
    name: "removes a key from the first copy only",
    before: TWINS,
    op: { kind: "job.update", id: "one", unset: ["with"] },
    expected: `jobs:
  one:
    # same comment
    uses: checks # same
  two:
    # same comment
    uses: checks # same
    with: { run: [make] }
  three:
    # same comment
    uses: checks # same
    with: { run: [make] }
`,
  },
  {
    name: "re-renders a flow job of the example workflow and nothing else",
    before: FEATURE_WORKFLOW,
    op: { kind: "job.update", id: "lint", set: { name: "Lint" } },
    expected: FEATURE_WORKFLOW.replace(
      "  lint: { needs: [implement], uses: checks, with: { run: [npm run lint] } }\n",
      "  lint: { needs: [ implement ], uses: checks, with: { run: [ npm run lint ] }, name: Lint }\n",
    ),
  },
  {
    name: "keeps CRLF line endings",
    before: "jobs:\r\n  a: # note\r\n    uses: approval\r\n",
    op: { kind: "job.add", id: "b", fields: { uses: "approval" } },
    expected: "jobs:\r\n  a: # note\r\n    uses: approval\r\n  b:\r\n    uses: approval\r\n",
  },
  {
    name: "adds a line break before appending to text without a final newline",
    before: "jobs:\n  a:\n    uses: approval",
    op: { kind: "job.update", id: "a", set: { name: "A" } },
    expected: "jobs:\n  a:\n    uses: approval\n    name: A\n",
  },
  {
    name: "adds a job to an empty flow jobs map",
    before: "jobs: {}\n",
    op: { kind: "job.add", id: "a", fields: { uses: "approval" } },
    expected: "jobs: { a: { uses: approval } }\n",
  },
];

describe("applyEdit", () => {
  it.each(cases)("$name", ({ before, op, expected }) => {
    expect(expected).not.toBe(before);
    expect(applyEdit(before, op)).toBe(expected);
  });

  it("produces workflows that still parse and validate", () => {
    const added = applyEdit(BLOCK, { kind: "job.add", id: "review", fields: { needs: ["ship"], uses: "review" } });
    expect(parseValid(added).jobs.map((job) => job.id)).toEqual(["discover", "build", "ship", "review"]);
    expect(parseValid(applyEdit(FEATURE_WORKFLOW, { kind: "job.update", id: "lint", set: { name: "Lint" } })).jobs.find((job) => job.id === "lint")?.name).toBe("Lint");
  });

  it.each<[string, EditOp, string]>([
    ["an unknown job", { kind: "job.remove", id: "ghost" }, "job_not_found"],
    ["a duplicate job", { kind: "job.add", id: "ship", fields: {} }, "job_exists"],
    ["an invalid id", { kind: "job.add", id: "Bad", fields: {} }, "edit_invalid"],
    ["an unknown key", { kind: "job.update", id: "ship", set: { "runs-on": "x" } as Record<string, unknown> }, "edit_invalid"],
    ["an empty need", { kind: "job.setNeeds", id: "ship", needs: [""] }, "edit_invalid"],
  ])("refuses %s", (_label, op, code) => {
    let caught: unknown;
    try {
      applyEdit(BLOCK, op);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PipelineError);
    expect(caught instanceof PipelineError ? caught.code : null).toBe(code);
  });

  it("refuses to edit text with YAML errors", () => {
    expect(() => applyEdit("jobs: { a: [\n", { kind: "job.remove", id: "a" })).toThrow(PipelineError);
  });
});

const AGENT = `jobs:
  build:
    # build notes stay
    uses: run-tasks
    with:
      # prompt explains the goal
      prompt: Build it # keep this
      context: docs/notes.md # unrelated
      agent:
        model: a/m1 # primary model
        # retries are tuned
        retries: 3
        fallback:
          model: b/m2 # fallback
          reasoning: low
      reviewer: { profile: rev } # unrelated too
      # trailing with comment
    name: Build
`;

describe("job.patch", () => {
  const patch = (changes: Array<{ path: string[]; value: unknown } | { path: string[]; remove: true }>): string => applyEdit(AGENT, { kind: "job.patch", id: "build", changes });

  it("replaces leaves inside `with` and keeps every other line and comment byte-identical", () => {
    const out = patch([
      { path: ["with", "prompt"], value: "Build it well" },
      { path: ["with", "agent", "model"], value: "a/m9" },
      { path: ["with", "agent", "fallback", "reasoning"], value: "high" },
    ]);
    expect(out).toBe(
      AGENT.replace("prompt: Build it # keep this", "prompt: Build it well # keep this")
        .replace("model: a/m1 # primary model", "model: a/m9 # primary model")
        .replace("reasoning: low", "reasoning: high"),
    );
  });

  it("adds new keys after the mapping's last key and removes keys by their lines only", () => {
    const out = patch([
      { path: ["with", "agent", "reasoning"], value: "medium" },
      { path: ["with", "agent", "profile"], value: "coder" },
      { path: ["with", "agent", "retries"], remove: true },
    ]);
    expect(out).toBe(
      AGENT.replace("        retries: 3\n", "").replace(
        "          reasoning: low\n",
        "          reasoning: low\n        reasoning: medium\n        profile: coder\n",
      ),
    );
  });

  it("removes a fallback whole and a mapping its last key leaves empty", () => {
    expect(patch([{ path: ["with", "agent", "fallback"], remove: true }])).toBe(AGENT.replace("        fallback:\n          model: b/m2 # fallback\n          reasoning: low\n", ""));
    const single = AGENT.replace("        fallback:\n          model: b/m2 # fallback\n          reasoning: low\n", "");
    const out = applyEdit(single, {
      kind: "job.patch",
      id: "build",
      changes: [
        { path: ["with", "agent", "model"], remove: true },
        { path: ["with", "agent", "retries"], remove: true },
      ],
    });
    expect(out).toBe(single.replace("      agent:\n        model: a/m1 # primary model\n        # retries are tuned\n        retries: 3\n", ""));
    expect(parseValid(out).jobs[0]?.with).toEqual({ prompt: "Build it", context: "docs/notes.md", reviewer: { profile: "rev" } });
  });

  it("creates a missing `agent` mapping in one key and edits flow mappings as a unit", () => {
    const bare = AGENT.replace(/      agent:\n(?: {8}.*\n)+/, "");
    expect(applyEdit(bare, { kind: "job.patch", id: "build", changes: [{ path: ["with", "agent", "model"], value: "c/m3" }, { path: ["with", "agent", "reasoning"], value: "high" }] })).toBe(
      bare.replace("      reviewer: { profile: rev } # unrelated too\n", "      reviewer: { profile: rev } # unrelated too\n      agent: { model: c/m3, reasoning: high }\n"),
    );
    expect(parseValid(applyEdit(bare, { kind: "job.patch", id: "build", changes: [{ path: ["with", "agent", "model"], value: "c/m3" }] })).jobs[0]?.with.reviewer).toEqual({ profile: "rev" });
    const flow = "jobs:\n  a: { uses: agent, with: { prompt: x, agent: { model: p/m } } }\n";
    const out = applyEdit(flow, { kind: "job.patch", id: "a", changes: [{ path: ["with", "agent", "model"], value: "p/n" }] });
    expect(parseValid(out).jobs[0]?.with).toEqual({ prompt: "x", agent: { model: "p/n" } });
  });

  it.each<[string, Array<{ path: string[]; value: unknown } | { path: string[]; remove: true }>]>([
    ["an unknown job key", [{ path: ["runs-on"], value: "x" }]],
    ["a path that is too deep", [{ path: ["with", "a", "b", "c", "d"], value: 1 }]],
    ["a key changed twice", [{ path: ["with", "agent"], remove: true }, { path: ["with", "agent", "model"], value: "x" }]],
    ["no changes", []],
  ])("refuses %s", (_label, changes) => {
    expect(() => applyEdit(AGENT, { kind: "job.patch", id: "build", changes })).toThrow(PipelineError);
  });
});
