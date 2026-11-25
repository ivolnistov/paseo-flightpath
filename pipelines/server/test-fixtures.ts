import { expect } from "vitest";
import type { Diagnostic, Workflow } from "../shared/workflow";
import { parseWorkflow } from "./workflow-parse";
import { validateWorkflow } from "./workflow-validate";

/** The design's example workflow without the matrix job. */
export const FEATURE_WORKFLOW = `name: Feature delivery
inputs: { goal: { type: string }, tasks: { type: tasks, required: false } }
defaults:
  max-parallel: 3
  agent: { profile: implementer, fallback: { model: provider-b/model-b, reasoning: medium }, retries: 2 }
jobs:
  discover:
    uses: agent
    acceptance: human
    with: { prompt: "List the modules affected by: \${{ inputs.goal }}" }
    outputs: { modules: { type: list, items: string } }
    done: [{ criterion: Every affected module is listed. }]
  implement:
    needs: [discover]
    uses: run-tasks
    with: { prompt: "\${{ inputs.goal }}", tasks: "\${{ inputs.tasks }}", context: "\${{ needs.discover.outputs.modules }}", reviewer: { profile: reviewer } }
  lint: { needs: [implement], uses: checks, with: { run: [npm run lint] } }
  review: { needs: [lint], uses: review, with: { agent: { profile: reviewer } }, rework: { to: implement, max: 2 } }
  accept: { needs: [review], uses: approval }
`;

/** The design's full example workflow, with its dynamic matrix job. */
export const FULL_WORKFLOW = `name: Feature delivery
inputs: { goal: { type: string }, tasks: { type: tasks, required: false } }
defaults:
  max-parallel: 3
  agent: { profile: implementer, fallback: { model: provider-b/model-b, reasoning: medium }, retries: 2 }
jobs:
  discover:
    uses: agent
    acceptance: human
    with: { prompt: "List the modules affected by: \${{ inputs.goal }}" }
    outputs: { modules: { type: list, items: string } }
    done: [{ criterion: Every affected module is listed. }]
  implement:
    needs: [discover]
    uses: run-tasks
    with: { prompt: "\${{ inputs.goal }}", tasks: "\${{ inputs.tasks }}", context: "\${{ needs.discover.outputs.modules }}", reviewer: { profile: reviewer } }
  lint: { needs: [implement], uses: checks, with: { run: [npm run lint] } }
  module-tests:
    needs: [discover, implement]
    uses: checks
    strategy: { matrix: { module: "\${{ needs.discover.outputs.modules }}" }, max-parallel: 2 }
    with: { isolated: true, run: [npm ci, [npm, test, --, "\${{ matrix.module }}"]] }
  review: { needs: [lint, module-tests], uses: review, with: { agent: { profile: reviewer } }, rework: { to: implement, max: 2 } }
  accept: { needs: [review], uses: approval }
`;

export function parseValid(text: string): Workflow {
  const { workflow, diagnostics } = parseWorkflow(text);
  expect(diagnostics).toEqual([]);
  if (!workflow) throw new Error("expected a workflow");
  expect(validateWorkflow(workflow)).toEqual([]);
  return workflow;
}

/** Parse diagnostics, or validation diagnostics when parsing succeeds. */
export function diagnose(text: string): Diagnostic[] {
  const { workflow, diagnostics } = parseWorkflow(text);
  if (!workflow) return diagnostics;
  return validateWorkflow(workflow);
}

/** The one-based line and column of `offset` in `text`. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

/** Asserts exactly one diagnostic with `code` whose range starts at the `occurrence`-th `needle`. */
export function expectSingleAt(text: string, diagnostics: Diagnostic[], code: string, needle: string, occurrence = 1): Diagnostic {
  expect(diagnostics.map((d) => d.code)).toEqual([code]);
  const [diagnostic] = diagnostics;
  if (!diagnostic) throw new Error("missing diagnostic");
  let offset = -1;
  for (let i = 0; i < occurrence; i += 1) offset = text.indexOf(needle, offset + 1);
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(diagnostic.range?.start).toBe(offset);
  expect({ line: diagnostic.line, column: diagnostic.column }).toEqual(positionOf(text, offset));
  return diagnostic;
}
