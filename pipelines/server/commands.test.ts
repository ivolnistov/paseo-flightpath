import { describe, expect, it } from "vitest";
import { resolveCommand } from "./commands";
import { graphJob, type RunState } from "./run-engine";
import { Sim, snapshotOf } from "./run-test-kit";

const WORKFLOW = `name: Commands
inputs: { name: { type: string, required: false, default: plain } }
jobs:
  src: { uses: agent, with: { prompt: p, agent: { model: p/m } }, outputs: { value: { type: string }, list: { type: list, items: string } } }
  c:
    needs: [src]
    uses: checks
    with:
      run:
        - "echo \\"$HOME\\" '\${x}' && rm -rf /tmp/x | cat"
        - [npm, test, --, "\${{ needs.src.outputs.value }}"]
        - [tool, "--name=\${{ inputs.name }}", "\${{ needs.src.outputs.value }}"]
`;

/** State after `src` succeeded with `value`. */
function stateWith(value: unknown): RunState {
  const sim = new Sim(snapshotOf(WORKFLOW, { inputs: { name: "plain" } }), {
    worker: (attempt, s) => {
      const agentId = s.state.attempts[attempt]?.roles.worker?.binding.agentId ?? "";
      return [
        { kind: "attempt.outputs_accepted", attemptId: attempt, role: "worker", agentId, outputs: { value, list: ["a"] }, summary: "" },
        { kind: "agent.turn_ended", attemptId: attempt, role: "worker", agentId, result: "completed" },
      ];
    },
    check: () => "hold",
  });
  sim.run();
  expect(sim.state.jobs.src?.succeeded).toBe("src#1");
  return sim.state;
}

function commands(state: RunState): Array<string | string[]> {
  const run = graphJob(state, "c").with.run;
  if (!Array.isArray(run)) throw new Error("no run list");
  return run.filter((item): item is string | string[] => typeof item === "string" || Array.isArray(item));
}

describe("resolveCommand", () => {
  it("returns a shell string byte-identical", () => {
    const state = stateWith("x");
    const [shell = ""] = commands(state);
    expect(resolveCommand(shell, graphJob(state, "c"), state)).toEqual({ ok: true, command: { shell: "echo \"$HOME\" '${x}' && rm -rf /tmp/x | cat" } });
  });

  it.each([
    ["single quote", "it's"],
    ["double quote", 'say "hi"'],
    ["space", "two words"],
    ["command substitution", "$(rm -rf /)"],
    ["backtick", "`id`"],
    ["newline", "line1\nline2"],
    ["leading dash", "--force"],
    ["everything", `a'b"c d$(e)\`f\`\n-g`],
  ])("keeps a value with a %s as one exact argument", (_label, value) => {
    const state = stateWith(value);
    const [, argv = []] = commands(state);
    expect(resolveCommand(argv, graphJob(state, "c"), state)).toEqual({ ok: true, command: { argv: ["npm", "test", "--", value] } });
  });

  it("resolves embedded references inside one element and keeps literal elements", () => {
    const state = stateWith("v w");
    const [, , argv = []] = commands(state);
    expect(resolveCommand(argv, graphJob(state, "c"), state)).toEqual({ ok: true, command: { argv: ["tool", "--name=plain", "v w"] } });
  });

  it("fails with ref_value_invalid for a NUL byte, an oversized value or a non-scalar value", () => {
    for (const value of ["a\0b", "x".repeat(4097), "é".repeat(2049)]) {
      const state = stateWith(value);
      const [, argv = []] = commands(state);
      expect(resolveCommand(argv, graphJob(state, "c"), state)).toEqual({ ok: false, reason: "ref_value_invalid" });
    }
    const ok = stateWith("x".repeat(4096));
    expect(resolveCommand(commands(ok)[1] ?? [], graphJob(ok, "c"), ok)).toMatchObject({ ok: true });
    const state = stateWith("x");
    expect(resolveCommand(["npm", "${{ needs.src.outputs.list }}"], graphJob(state, "c"), state)).toEqual({ ok: false, reason: "ref_value_invalid" });
  });

  it("does not resolve outputs of a job without a current successful attempt", () => {
    const state = stateWith("x");
    const superseded = structuredClone(state);
    const src = superseded.jobs.src;
    if (!src) throw new Error("missing job");
    src.succeeded = null;
    expect(resolveCommand(commands(state)[1] ?? [], graphJob(state, "c"), superseded)).toEqual({ ok: false, reason: "ref_value_invalid" });
  });

  it("fails the checks job with ref_value_invalid without retrying", () => {
    const sim = new Sim(snapshotOf(WORKFLOW, { inputs: { name: "plain" } }), {
      worker: (attempt, s) => {
        const agentId = s.state.attempts[attempt]?.roles.worker?.binding.agentId ?? "";
        return [
          { kind: "attempt.outputs_accepted", attemptId: attempt, role: "worker", agentId, outputs: { value: "bad\0", list: [] }, summary: "" },
          { kind: "agent.turn_ended", attemptId: attempt, role: "worker", agentId, result: "completed" },
        ];
      },
    });
    sim.run();
    expect(sim.state.jobs.c).toMatchObject({ terminal: "failed", reason: "ref_value_invalid" });
    expect(sim.effectsSeen.some((effect) => effect.kind === "run_checks")).toBe(false);
  });
});
