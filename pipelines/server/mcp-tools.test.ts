import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFs } from "./fs-port";
import type { Grant } from "./grants";
import { PipelineError } from "../shared/errors";
import { callTool, MAX_RETURNED_DIAGNOSTICS, type ToolDeps } from "./mcp-tools";
import { createDriverHarness, type DriverHarness } from "./test-support/driver-harness";
import { createWorkflowStore } from "./workflow-store";

let h: DriverHarness;

beforeEach(async () => {
  h = await createDriverHarness();
});

afterEach(async () => {
  await h.dispose();
});

const YAML = `name: Ctx
inputs: { goal: { type: string } }
jobs:
  build:
    uses: agent
    with: { prompt: "Make \${{ inputs.goal }}", agent: { model: provider-a/m1, retries: 0 } }
    outputs: { version: { type: string } }
    done:
      - criterion: It works
      - criterion: It is documented
`;

function worker(attemptId = "build#1"): Grant {
  return { kind: "attempt", runId: "r1", attemptId, role: "worker", agentId: h.workerAgent("r1", attemptId) };
}

describe("job tools", () => {
  it("gives the worker its resolved prompt, criteria and outputs, and the reviewer the worker's result", async () => {
    await h.start(YAML, { runId: "r1", inputs: { goal: "a parser" } });
    const context = await callTool(h.tools, worker(), "pipeline_job_context", {});
    expect(context).toMatchObject({
      ok: true,
      value: {
        role: "worker",
        prompt: "Make a parser",
        attempt: 1,
        acceptanceCriteria: [
          { index: 0, text: "It works" },
          { index: 1, text: "It is documented" },
        ],
        outputs: { version: { type: "string" } },
        interrupted: null,
      },
    });
    expect(await h.complete("r1", "build#1", { version: "1.0" })).toEqual({ ok: true, value: { status: "accepted" } });
    const reviewer: Grant = { kind: "attempt", runId: "r1", attemptId: "build#1", role: "reviewer", agentId: h.reviewerAgent("r1", "build#1") };
    expect(await callTool(h.tools, reviewer, "pipeline_job_context", {})).toMatchObject({ ok: true, value: { role: "reviewer", worker: { summary: "done", outputs: { version: "1.0" } } } });
  });

  it("returns role_forbidden for a reviewer completing and a worker reviewing", async () => {
    await h.start(YAML, { runId: "r1", inputs: { goal: "x" } });
    await h.complete("r1", "build#1", { version: "1" });
    const reviewer: Grant = { kind: "attempt", runId: "r1", attemptId: "build#1", role: "reviewer", agentId: h.reviewerAgent("r1", "build#1") };
    expect(await callTool(h.tools, reviewer, "pipeline_job_complete", { outputs: {}, summary: "x" })).toMatchObject({ ok: false, code: "role_forbidden" });
    expect(await callTool(h.tools, worker(), "pipeline_review_submit", { outcome: "approved", findings: [], criteria: [] })).toMatchObject({ ok: false, code: "role_forbidden" });
    expect(await callTool(h.tools, worker(), "pipeline_workflow_get", {})).toMatchObject({ ok: false, code: "role_forbidden" });
    expect(await callTool(h.tools, { kind: "workflow", projectId: "proj", agentId: "chat" }, "pipeline_job_context", {})).toMatchObject({ ok: false, code: "role_forbidden" });
  });

  it("requires exactly one result per assigned criterion and fails the attempt on an unmet one", async () => {
    await h.start(YAML, { runId: "r1", inputs: { goal: "x" } });
    await h.complete("r1", "build#1", { version: "1" });
    expect(await h.review("r1", "build#1", { criteria: [{ index: 0, met: true }] })).toMatchObject({ ok: false, code: "criteria_invalid" });
    expect(
      await h.review("r1", "build#1", {
        criteria: [
          { index: 0, met: true },
          { index: 1, met: false },
        ],
      }),
    ).toMatchObject({ ok: true });
    await h.settle("r1");
    const state = await h.driver.read("r1");
    expect(state.attempts["build#1"]).toMatchObject({ outcome: "failed", reason: "criterion_not_met" });
    expect(state.evidence.filter((item) => item.kind === "criterion").map((item) => [item.item, item.result])).toEqual([
      [0, "pass"],
      [1, "fail"],
    ]);
  });

  it("returns outputs errors to the worker and stale_attempt to a superseded attempt", async () => {
    await h.start(YAML.replace("retries: 0", "retries: 1"), { runId: "r1", inputs: { goal: "x" } });
    const rejected = await callTool(h.tools, worker(), "pipeline_job_complete", { outputs: { version: 3 }, summary: "x" });
    expect(rejected).toMatchObject({ ok: false, code: "outputs_invalid" });
    await h.endTurn(h.workerAgent("r1", "build#1"), { kind: "failed", error: { message: "crashed" } });
    await h.settle("r1");
    expect(await callTool(h.tools, worker("build#1"), "pipeline_job_complete", { outputs: { version: "1" }, summary: "x" })).toMatchObject({ ok: false, code: "stale_attempt" });
    const context = await callTool(h.tools, worker("build#2"), "pipeline_job_context", {});
    expect(context).toMatchObject({ ok: true, value: { attempt: 2, cause: "retry" } });
  });
});

describe("workflow tools", () => {
  it("reads the editable workflow and stores a proposal with the caller's base token", async () => {
    const store = createWorkflowStore({ stateDir: () => h.dir, fs: createNodeFs(), now: () => new Date("2026-11-21T00:00:00Z") });
    const view = await store.setDraftText("proj", { editableDigest: "absent", yaml: "name: Draft\njobs:\n  a: { uses: approval }\n" });
    const deps: ToolDeps = { ...h.tools, workflows: { get: (id) => store.get(id), addProposal: (id, input) => store.addProposal(id, input) } };
    const chat: Grant = { kind: "workflow", projectId: "proj", agentId: "chat-1" };
    const got = await callTool(deps, chat, "pipeline_workflow_get", {});
    expect(got).toMatchObject({ ok: true, value: { token: view.editableDigest } });
    const proposed = await callTool(deps, chat, "pipeline_workflow_propose", { baseToken: view.editableDigest, yaml: "name: Changed\njobs:\n  a: { uses: approval }\n", summary: "rename" });
    expect(proposed).toMatchObject({ ok: true, value: { status: "pending" } });
    const after = await store.get("proj");
    expect(after.proposals).toHaveLength(1);
    expect(after.proposals[0]).toMatchObject({ baseToken: view.editableDigest, agentId: "chat-1" });
    expect(after.draft?.yaml).toContain("name: Draft");
  });

  it("returns a bounded diagnostics list and refuses a proposal over the limit as a tool error", async () => {
    const chat: Grant = { kind: "workflow", projectId: "proj", agentId: "chat-1" };
    const many = Array.from({ length: MAX_RETURNED_DIAGNOSTICS + 5 }, (_, index) => ({ code: "x", message: `d${index}`, line: 1, column: 1, range: null }));
    let limited = false;
    const deps: ToolDeps = {
      ...h.tools,
      workflows: {
        get: () => Promise.reject(new Error("unused")),
        addProposal: (_id, input) => {
          if (limited) return Promise.reject(new PipelineError("proposal_limit", "Too many proposals."));
          return Promise.resolve({ id: "prp_1", baseToken: input.baseToken, yaml: input.yaml, summary: input.summary, agentId: input.agentId, createdAt: "2026-11-21T00:00:00.000Z", status: "pending" as const, diagnostics: many, model: null });
        },
      },
    };
    const input = { baseToken: "a".repeat(64), yaml: "jobs: {}\n", summary: "s" };
    const proposed = await callTool(deps, chat, "pipeline_workflow_propose", input);
    expect(proposed).toMatchObject({ ok: true, value: { diagnostics: many.slice(0, MAX_RETURNED_DIAGNOSTICS), diagnosticCount: MAX_RETURNED_DIAGNOSTICS + 5 } });
    limited = true;
    expect(await callTool(deps, chat, "pipeline_workflow_propose", input)).toEqual({ ok: false, code: "proposal_limit", message: "Too many proposals." });
  });
});
