import { describe, expect, it } from "vitest";
import { WorkflowSchema } from "../shared/rpc";
import { FULL_WORKFLOW, parseValid } from "./test-fixtures";
import { parseWorkflow } from "./workflow-parse";
import { validateWorkflow } from "./workflow-validate";

describe("workflow wire schema", () => {
  it("accepts a parsed matrix job as the strict wire model", () => {
    expect(WorkflowSchema.safeParse(parseValid(FULL_WORKFLOW)).success).toBe(true);
  });

  it("accepts a parsed matrix whose items only fail validation", () => {
    const { workflow } = parseWorkflow("jobs:\n  a:\n    uses: checks\n    strategy: { matrix: { m: [{ x: 1 }] } }\n    with: { run: [true] }\n");
    if (!workflow) throw new Error("expected a parsed workflow");
    expect(validateWorkflow(workflow)).not.toEqual([]);
    expect(WorkflowSchema.safeParse(workflow).success).toBe(true);
  });

  it("still rejects unknown strategy keys", () => {
    const model = structuredClone(parseValid(FULL_WORKFLOW));
    const job = model.jobs.find((item) => item.strategy);
    if (!job?.strategy) throw new Error("expected a matrix job");
    Object.assign(job.strategy, { extra: 1 });
    expect(WorkflowSchema.safeParse(model).success).toBe(false);
  });
});
