import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Ref } from "../shared/model";
import { SessionView } from "../shared/rpc";
import { buildTools, TOOL_NAMES } from "./mcp-tools";
import { createRoadmapCommands } from "./sessions";
import { callTool, sdkClient, startTestEndpoint, type TestEndpoint } from "./test-support/mcp";
import { ok } from "./test-support/service";

const P = "prj_test";
// Typed readers for the tool values these tests read (every accessed field is validated).
const Created = z.object({ sessionId: z.string() });
const Asked = z.object({ revision: z.number(), questionIds: z.array(z.string()) });
const Revision = z.object({ revision: z.number() });
const Answered = z.object({ staleMarked: z.array(Ref), visibilityChanged: z.array(Ref) });
const Linked = z.object({ linkId: z.string() });
// Automatic grilling S2 (task card §4.1): roadmap_pause_instructions is read-only, like the two readers.
const READ_TOOLS: readonly string[] = ["roadmap_overview", "roadmap_get_session", "roadmap_pause_instructions", "roadmap_resolve_link"];
const WRITE_TOOLS = TOOL_NAMES.filter((n) => !READ_TOOLS.includes(n));
const allLogs: string[] = [];
const sensitive: string[] = [];

// Load the official SDK once up front: its cold import under a parallel full run can exceed the
// 5 s per-test default on the first SDK test. Test timeouts and assertions are unchanged.
beforeAll(async () => {
  await import("@modelcontextprotocol/sdk/client/index.js");
  await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
}, 60_000);

let t: TestEndpoint | undefined;
let closeClient: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeClient?.().catch(() => undefined);
  closeClient = undefined;
  if (t) {
    allLogs.push(...t.logs);
    sensitive.push((await t.state.loadOrCreateEndpoint()).secret);
    await t.stop();
    t = undefined;
  }
});

async function setup() {
  t = await startTestEndpoint();
  t.ready();
  const { url } = await t.grantFor();
  sensitive.push(new URL(url).pathname, url.split(".").pop()!);
  const client = await sdkClient(url);
  closeClient = () => client.close();
  const call = (name: string, args: Record<string, unknown>) => callTool(client, name, args);
  const version = async () => ok(await t!.project.service.version(t!.paseo, { projectId: P })).revision!;
  const quote = (s: string) => (sensitive.push(s), s);
  return { t, client, call, version, quote, service: t.project.service, paseo: t.paseo };
}

/** Session with Q1(a,b), Q2 activated by Q1∈{b}, Q3 invalidated by Q1, created through MCP. */
async function seeded(s: Awaited<ReturnType<typeof setup>>) {
  const created = await s.call("roadmap_create_session", { expectedRevision: 1, title: "Chat session" });
  expect(created.isError, created.text).toBe(false);
  const { sessionId } = Created.parse(created.value);
  const ab = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  const asked = await s.call("roadmap_ask", {
    expectedRevision: 2,
    sessionId,
    questions: [
      { title: "Q1", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [] },
      { title: "Q2", context: "", options: ab, allowFreeText: false, activatedBy: [{ parent: { batchIndex: 0 }, optionIds: ["b"] }], invalidatedBy: [] },
      { title: "Q3", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [{ upstream: { batchIndex: 0 } }] },
    ],
  });
  expect(asked.isError, asked.text).toBe(false);
  const askedValue = Asked.parse(asked.value);
  expect(askedValue.revision).toBe(3);
  const [q1, q2, q3] = askedValue.questionIds;
  const ref = (questionId: string): Ref => ({ sessionId, questionId });
  return { sessionId, q1, q2, q3, Q1: ref(q1), Q2: ref(q2), Q3: ref(q3) };
}

describe("official SDK client", () => {
  it("lists exactly the Stage 2 tools from paseo-decision-roadmap", async () => {
    const s = await setup();
    expect(s.client.getServerVersion()?.name).toBe("paseo-decision-roadmap");
    const { tools } = await s.client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("roadmap_get_session returns the actual session view the UI sees", async () => {
    const s = await setup();
    const { sessionId, q1, q2, q3, Q1 } = await seeded(s);
    const out = await s.call("roadmap_get_session", { sessionId });
    expect(out.isError, out.text).toBe(false);
    const view = SessionView.parse(out.value);
    expect(view.revision).toBe(3);
    expect(view.session).toMatchObject({ id: sessionId, title: "Chat session", status: "active" });
    expect(view.questions.map((x) => [x.question.id, x.question.title, x.depth, x.visibility, x.status])).toEqual([
      [q1, "Q1", 0, "active", "open"],
      [q2, "Q2", 1, "inactive", "inactive"],
      [q3, "Q3", 1, "active", "open"],
    ]);
    expect(view.questions[1].question.activatedBy).toEqual([{ parent: Q1, optionIds: ["b"] }]);
    expect(view.questions[2].question.invalidatedBy).toEqual([{ upstream: Q1 }]);
    expect(view).toEqual(ok(await s.service.sessionGet(s.paseo, { projectId: P, sessionId })));
    expect((await s.call("roadmap_get_session", { sessionId: "missing" })).text).toMatch(/^not_found/);
  });

  it("tool descriptions carry the quoting and UI-only approval rules", async () => {
    const s = await setup();
    const { tools } = await s.client.listTools();
    const desc = Object.fromEntries(tools.map((x) => [x.name, x.description ?? ""]));
    expect(desc.roadmap_answer).toContain("quoted");
    expect(desc.roadmap_confirm).toContain("quoted");
    for (const name of WRITE_TOOLS) expect(desc[name], name).toContain("only in the Paseo UI");
  });
});

describe("chat and UI converge on one history", () => {
  it("MCP ask/answer and UI answer/confirm share revisions, staleness and provenance", async () => {
    const s = await setup();
    const { sessionId, q1, q2, q3, Q2, Q3 } = await seeded(s);
    ok(await s.service.questionAnswer(s.paseo, { projectId: P, expectedRevision: 3, sessionId, questionId: q1, optionId: "a" }));

    const a3 = await s.call("roadmap_answer", { expectedRevision: 4, sessionId, questionId: q3, optionId: "a", quoted: s.quote("Q3 should be A") });
    expect(a3.isError, a3.text).toBe(false);
    expect(Revision.parse(a3.value).revision).toBe(5);

    const a1 = await s.call("roadmap_answer", { expectedRevision: 5, sessionId, questionId: q1, optionId: "b", quoted: s.quote("Switch Q1 to B") });
    expect(a1.isError, a1.text).toBe(false);
    const a1Value = Answered.parse(a1.value);
    expect(a1Value.staleMarked).toContainEqual(Q3);
    expect(a1Value.visibilityChanged).toContainEqual(Q2);

    const view = ok(await s.service.sessionGet(s.paseo, { projectId: P, sessionId }));
    const byId = Object.fromEntries(view.questions.map((x) => [x.question.id, x]));
    expect(byId[q2].visibility).toBe("active");
    expect(byId[q3].status).toBe("stale");
    expect(byId[q3].question.stale).toMatchObject({ causeSessionId: sessionId, causeQuestionId: q1 });
    const chatRev = byId[q3].question.revisions[0];
    expect(chatRev).toMatchObject({ source: "chat", actor: { kind: "agent" }, quoted: "Q3 should be A" });
    expect("agentId" in chatRev.actor).toBe(false);
    expect(byId[q1].question.revisions.map((r) => r.source)).toEqual(["ui", "chat"]);

    ok(await s.service.questionConfirm(s.paseo, { projectId: P, expectedRevision: await s.version(), sessionId, questionId: q3 }));
    const after = ok(await s.service.sessionGet(s.paseo, { projectId: P, sessionId })).questions.find((x) => x.question.id === q3)!;
    expect(after.question.validity).toBe("valid");
    expect(after.question.revisions.at(-1)).toMatchObject({ source: "ui", actor: { kind: "human" } });
  });

  it("every write tool rejects an out-of-date expectedRevision with the retry hint and writes nothing", async () => {
    const s = await setup();
    const { sessionId, q1, Q1, Q3 } = await seeded(s);
    await s.call("roadmap_answer", { expectedRevision: 3, sessionId, questionId: q1, optionId: "a", quoted: s.quote("A please") });
    const current = await s.version();
    const stale = 1;
    const args: Record<string, Record<string, unknown>> = {
      roadmap_create_session: { expectedRevision: stale, title: "late" },
      roadmap_ask: { expectedRevision: stale, sessionId, questions: [{ title: "late", context: "", options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [] }] },
      roadmap_answer: { expectedRevision: stale, sessionId, questionId: q1, optionId: "b", quoted: s.quote("late B") },
      roadmap_confirm: { expectedRevision: stale, sessionId, questionId: q1, quoted: s.quote("late confirm") },
      roadmap_discuss: { expectedRevision: stale, sessionId, questionId: q1, text: "late note" },
      roadmap_relate: { expectedRevision: stale, action: "add", relation: { kind: "invalidation", target: Q3, invalidation: { upstream: { sessionId, questionId: q1 } } } },
      roadmap_update_question: { expectedRevision: stale, sessionId, questionId: q1, patch: { title: "late" } },
      roadmap_link: { expectedRevision: stale, kind: "informs", from: Q1, to: { sessionId } },
      // Automatic grilling S2: completion takes expectedRevision like every write (TR13).
      roadmap_grill_complete: { expectedRevision: stale, sessionId, operationId: "op-stale" },
      roadmap_out_of_scope: { expectedRevision: stale, sessionId, questionId: q1, quoted: s.quote("late scope") },
      roadmap_cancel_question: { expectedRevision: stale, sessionId, questionId: q1, reason: "late cancel", quoted: s.quote("late cancel") },
      roadmap_block_accept: { expectedRevision: stale, sessionId, blockId: "b1", quoted: s.quote("late accept") },
      roadmap_grill_propose_finish: { expectedRevision: stale, sessionId, summary: "late proposal" },
    };
    expect(Object.keys(args).sort()).toEqual([...WRITE_TOOLS].sort());
    for (const [name, a] of Object.entries(args)) {
      const out = await s.call(name, a);
      expect(out.isError, name).toBe(true);
      expect(out.text.startsWith("revision_conflict:"), `${name}: ${out.text}`).toBe(true);
      expect(out.text).toContain("Re-read with roadmap_overview or roadmap_get_session and retry with the current revision.");
      expect(await s.version()).toBe(current);
    }
  });

  it("a chat write and a UI write racing on one revision: exactly one lands", async () => {
    const s = await setup();
    const { sessionId, q1 } = await seeded(s);
    const [chat, ui] = await Promise.all([
      s.call("roadmap_answer", { expectedRevision: 3, sessionId, questionId: q1, optionId: "b", quoted: s.quote("B from chat") }),
      s.service.questionAnswer(s.paseo, { projectId: P, expectedRevision: 3, sessionId, questionId: q1, optionId: "a" }),
    ]);
    expect([!chat.isError, ui.ok].filter(Boolean)).toHaveLength(1);
    expect(await s.version()).toBe(4);
    const q = ok(await s.service.sessionGet(s.paseo, { projectId: P, sessionId })).questions.find((x) => x.question.id === q1)!;
    expect(q.question.revisions).toHaveLength(1);
    expect(q.question.revisions[0].source).toBe(chat.isError ? "ui" : "chat");
  });
});

describe("tool validation and core behaviour through MCP", () => {
  it("roadmap_answer without quoted is Invalid arguments naming quoted, without echoing values", async () => {
    const s = await setup();
    const { sessionId, q1 } = await seeded(s);
    const out = await s.call("roadmap_answer", { expectedRevision: 3, sessionId, questionId: q1, optionId: "a", note: "ECHO-SENTINEL-7731" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Invalid arguments");
    expect(out.text).toContain("quoted");
    expect(out.text).not.toContain("ECHO-SENTINEL-7731");
    expect(await s.version()).toBe(3);
  });

  it("roadmap_relate rejects a cycle and the removal of a missing edge", async () => {
    const s = await setup();
    const { Q1, Q2, Q3 } = await seeded(s);
    const cyc = await s.call("roadmap_relate", { expectedRevision: 3, action: "add", relation: { kind: "invalidation", target: Q1, invalidation: { upstream: Q2 } } });
    expect(cyc.text).toMatch(/^relation_cycle/);
    const missing = await s.call("roadmap_relate", { expectedRevision: 3, action: "remove", relation: { kind: "invalidation", target: Q3, invalidation: { upstream: Q2 } } });
    expect(missing.text).toMatch(/^not_found/);
    expect(await s.version()).toBe(3);
  });

  it("roadmap_link creates a descriptive link that changes no question status", async () => {
    const s = await setup();
    const { sessionId, Q1 } = await seeded(s);
    const statuses = async () => ok(await s.service.sessionGet(s.paseo, { projectId: P, sessionId })).questions.map((x) => x.status);
    const before = await statuses();
    const out = await s.call("roadmap_link", { expectedRevision: 3, kind: "informs", from: Q1, to: { sessionId } });
    expect(out.isError, out.text).toBe(false);
    expect(await statuses()).toEqual(before);
    expect(ok(await s.service.overview(s.paseo, { projectId: P })).links).toEqual([expect.objectContaining({ id: Linked.parse(out.value).linkId, from: Q1 })]);
  });

  it("roadmap_update_question removing the answered option marks the question stale", async () => {
    const s = await setup();
    const { sessionId, q1 } = await seeded(s);
    await s.call("roadmap_answer", { expectedRevision: 3, sessionId, questionId: q1, optionId: "a", quoted: s.quote("A it is") });
    const out = await s.call("roadmap_update_question", { expectedRevision: 4, sessionId, questionId: q1, patch: { options: [{ id: "b", label: "B" }] } });
    expect(out.isError, out.text).toBe(false);
    const q = ok(await s.service.sessionGet(s.paseo, { projectId: P, sessionId })).questions.find((x) => x.question.id === q1)!;
    expect(q.question.validity).toBe("stale");
    expect(q.question.stale).toMatchObject({ causeQuestionId: q1, causeRev: 1 });
  });
});

describe("redaction (runs last)", () => {
  it("tool-call logs contain no secret, signature, /mcp/ path or quoted text", () => {
    expect(sensitive.length).toBeGreaterThan(0);
    for (const line of allLogs) {
      expect(line).not.toContain("/mcp/");
      for (const s of sensitive) expect(line).not.toContain(s);
    }
  });
});

// Redesign Stage R0.6 (task card §7.2/§7.3, §9 item 12): roadmap_ask takes an optional batch-scope
// blockId; no block-accept tool exists. Schema-level only, no endpoint or network.
describe("roadmap_ask block scope (tool table, no network)", () => {
  const unusedDirectory = () => {
    throw new Error("schema checks must not open a store");
  };
  const ask = () => buildTools(createRoadmapCommands({ directory: unusedDirectory })).find((t) => t.name === "roadmap_ask")!;
  const base = {
    expectedRevision: 2,
    sessionId: "s1",
    questions: [{ title: "Q", context: "", options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [] }],
  };

  it("accepts an optional blockId and still rejects projectId and an empty blockId", () => {
    expect(ask().input.safeParse(base).success).toBe(true);
    expect(ask().input.safeParse({ ...base, blockId: "b1" }).success).toBe(true);
    expect(ask().input.safeParse({ ...base, blockId: "" }).success).toBe(false);
    expect(ask().input.safeParse({ ...base, blockId: "b1", projectId: P }).success).toBe(false);
  });

  // Chat-consent acceptance: blocks are accepted in the UI or through roadmap_block_accept with the
  // human's quoted consent; that is the only accept or block tool.
  it("describes the open-block requirement; roadmap_block_accept is the only accept or block tool", () => {
    expect(ask().description).toMatch(/block/i);
    expect(TOOL_NAMES.filter((n) => /accept|block/.test(n))).toEqual(["roadmap_block_accept"]);
  });
});

// Stage R2.4 (task card 2026-10-29 §3.2, §5): the endpoint table is buildTools(commands, extra). With
// the plan tools built with a DoD resolver, the extra table carries roadmap_dod_template exactly once
// after the Stage 2 tools; without it the plan tools stay the three Stage 3 tools. No tool approves,
// reworks or cancels. Table only (no network); a control for the R2.4 wiring in contribute.
describe("R2.4 tool table with the DoD template tool (no network)", () => {
  it("buildTools keeps the Stage 2 tools first and adds the resolver-built roadmap_dod_template exactly once", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createApprovalStore } = await import("./approvals");
    const { createPlanCommands } = await import("./plans");
    const { buildPlanTools, STAGE3_TOOL_NAMES } = await import("./plan-tools");
    const { fixedClock, nextId } = await import("./test-support/build");
    const stateDir = await mkdtemp(join(tmpdir(), "dr-mcp-tools-r24-"));
    try {
      const deps = { directory: () => { throw new Error("unused"); }, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } };
      const plans = createPlanCommands({ ...deps, approvals: createApprovalStore({ stateDir, log: () => undefined }) });
      const commands = createRoadmapCommands(deps);
      const resolver = async (_projectId: string): Promise<{ ok: true; value: { source: "none"; text: string } }> => ({ ok: true, value: { source: "none", text: "" } });
      const without = buildTools(commands, buildPlanTools(plans)).map((x) => x.name);
      const withResolver = buildTools(commands, buildPlanTools(plans, resolver)).map((x) => x.name);
      expect(without.slice(0, TOOL_NAMES.length)).toEqual([...TOOL_NAMES]);
      expect([...without.slice(TOOL_NAMES.length)].sort()).toEqual([...STAGE3_TOOL_NAMES].sort());
      expect(withResolver.slice(0, TOOL_NAMES.length)).toEqual([...TOOL_NAMES]);
      expect(withResolver.filter((n) => n === "roadmap_dod_template")).toEqual(["roadmap_dod_template"]);
      expect([...withResolver].sort()).toEqual([...TOOL_NAMES, ...STAGE3_TOOL_NAMES, "roadmap_dod_template"].sort());
      expect(new Set(withResolver).size).toBe(withResolver.length);
      // roadmap_cancel_question is the one cancel tool (agent-cancellation rule); nothing approves or reworks.
      for (const n of withResolver) expect(n).not.toMatch(/approve|rework/);
      expect(withResolver.filter((n) => /cancel/.test(n))).toEqual(["roadmap_cancel_question"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
