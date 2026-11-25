import { describe, expect, it } from "vitest";
import type { OutputDecl } from "../shared/workflow";
import { resolveWith, UnresolvedReferenceError, validateOutputs } from "./outputs";
import { graphJob } from "./run-engine";
import { Sim, snapshotOf } from "./run-test-kit";

const DECL: Record<string, OutputDecl> = {
  title: { type: "string" },
  count: { type: "number" },
  ok: { type: "boolean" },
  meta: { type: "object" },
  modules: { type: "list", items: "string" },
};
const VALID = { title: "t", count: 2, ok: false, meta: { a: 1 }, modules: ["x", "y"] };

function codes(value: unknown): Array<[string | null, string]> {
  const result = validateOutputs(DECL, value);
  return result.ok ? [] : result.errors.map((error) => [error.name, error.code]);
}

describe("validateOutputs", () => {
  it("accepts exact types and returns plain JSON", () => {
    expect(validateOutputs(DECL, VALID)).toEqual({ ok: true, outputs: VALID });
  });

  it("requires every declared output and refuses undeclared ones", () => {
    const { count: _count, ...missing } = VALID;
    expect(codes(missing)).toEqual([["count", "output_missing"]]);
    expect(codes({ ...VALID, extra: 1 })).toEqual([["extra", "output_undeclared"]]);
  });

  it("refuses inexact types", () => {
    expect(codes({ ...VALID, count: "2" })).toEqual([["count", "output_type"]]);
    expect(codes({ ...VALID, count: Number.NaN })).toEqual([["count", "output_type"]]);
    expect(codes({ ...VALID, meta: [] })).toEqual([["meta", "output_type"]]);
    expect(codes({ ...VALID, modules: "x" })).toEqual([["modules", "output_type"]]);
    expect(codes({ ...VALID, modules: ["x", 1] })).toEqual([["modules", "output_type"]]);
    expect(codes([])).toEqual([[null, "outputs_shape"]]);
  });

  it("caps lists at 256 items and the total at 256 KiB", () => {
    expect(codes({ ...VALID, modules: Array.from({ length: 256 }, () => "m") })).toEqual([]);
    expect(codes({ ...VALID, modules: Array.from({ length: 257 }, () => "m") })).toEqual([["modules", "output_too_large"]]);
    expect(codes({ ...VALID, title: "x".repeat(256 * 1024) })).toEqual([[null, "output_too_large"]]);
  });
});

describe("resolveWith", () => {
  const yaml = `name: Refs
inputs: { goal: { type: string } }
jobs:
  src: { uses: agent, with: { prompt: p, agent: { model: p/m } }, outputs: { modules: { type: list, items: string }, n: { type: number } } }
  use:
    needs: [src]
    uses: agent
    with: { prompt: "Goal \${{ inputs.goal }}, n=\${{ needs.src.outputs.n }}", agent: { model: p/m } }
`;

  it("keeps the type of an exact reference and stringifies embedded scalars from the current attempt", () => {
    const sim = new Sim(snapshotOf(yaml, { inputs: { goal: "ship" } }), {
      worker: (attempt, s) => {
        const agentId = s.state.attempts[attempt]?.roles.worker?.binding.agentId ?? "";
        if (!attempt.startsWith("src#")) return "hold";
        return [
          { kind: "attempt.outputs_accepted", attemptId: attempt, role: "worker", agentId, outputs: { modules: ["a", "b"], n: 3 }, summary: "" },
          { kind: "agent.turn_ended", attemptId: attempt, role: "worker", agentId, result: "completed" },
        ];
      },
    });
    sim.run();
    const job = graphJob(sim.state, "use");
    expect(resolveWith(job, sim.state)).toEqual({ prompt: "Goal ship, n=3", agent: { model: "p/m" } });
    const exact = { ...job, with: { context: "${{ needs.src.outputs.modules }}" } };
    expect(resolveWith(exact, sim.state)).toEqual({ context: ["a", "b"] });
  });

  it("refuses a reference to a job without a current successful attempt", () => {
    const sim = new Sim(snapshotOf(yaml, { inputs: { goal: "ship" } }), { worker: () => "hold" });
    sim.run();
    expect(() => resolveWith(graphJob(sim.state, "use"), sim.state)).toThrow(UnresolvedReferenceError);
  });
});
