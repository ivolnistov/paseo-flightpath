// Timeline tool-call matching (Stage 5 T5.4): exact server-bound tool names only, completed calls only,
// candidate refs from the generic `unknown` detail; refs are candidates, never authority.
import { readFileSync } from "node:fs";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { extractCandidates, rowIdFor, TOOL_NAME_SET } from "./timeline-match";

const CLAUDE = (tool: string) => `mcp__decision-roadmap__${tool}`;
const CODEX = (tool: string) => `decision-roadmap.${tool}`;
/** The Codex discussion chat's preapproval entry; its enabled tools include roadmap_ask but no answer or confirm. */
const CODEX_ALIAS = (tool: string) => `decision-roadmap-discuss.${tool}`;

/** A protocol `ToolCallTimelineItem` with the generic detail. */
const call = (name: string, input: unknown, output: unknown = null, status: "running" | "completed" | "failed" | "canceled" = "completed") => ({
  type: "tool_call",
  callId: "call-1",
  name,
  detail: { type: "unknown", input, output },
  status,
  error: status === "failed" ? { message: "boom" } : null,
});
const askOutput = (questionIds: unknown) => JSON.stringify({ revision: 2, questionIds, visibilityChanged: [] });
const askInput = { expectedRevision: 1, sessionId: "s1", questions: [{ title: "Synthetic", options: [] }] };

describe("TOOL_NAME_SET (T5.4)", () => {
  it("holds exactly the Claude and Codex server-bound names and nothing for OpenCode or Pi", () => {
    // R3.5 expected change (card §6.2a "Timeline run rows"): the four run-scoped tools join each provider set.
    const RUN = ["roadmap_run_next", "roadmap_task_claim", "roadmap_task_progress", "roadmap_run_ack"];
    expect([...(TOOL_NAME_SET.claude ?? [])].sort()).toEqual(
      [CLAUDE("roadmap_answer"), CLAUDE("roadmap_ask"), CLAUDE("roadmap_confirm"), ...RUN.map(CLAUDE)].sort(),
    );
    // Review regression (KensAI c0057): roadmap_ask through the Codex discussion chat's preapproval entry.
    expect([...(TOOL_NAME_SET.codex ?? [])].sort()).toEqual(
      [CODEX("roadmap_answer"), CODEX("roadmap_ask"), CODEX("roadmap_confirm"), ...RUN.map(CODEX), CODEX_ALIAS("roadmap_ask")].sort(),
    );
    expect(TOOL_NAME_SET.opencode).toBeUndefined();
    expect(TOOL_NAME_SET.pi).toBeUndefined();
  });
});

describe("extractCandidates (T5.4)", () => {
  for (const [provider, name] of [
    ["claude", CLAUDE],
    ["codex", CODEX],
  ] as const) {
    it(`${provider}: completed answer and confirm yield the input ref`, () => {
      expect(extractCandidates(provider, call(name("roadmap_answer"), { expectedRevision: 3, sessionId: "s1", questionId: "q1", optionId: "a" }))).toEqual([
        { sessionId: "s1", questionId: "q1" },
      ]);
      expect(extractCandidates(provider, call(name("roadmap_confirm"), { expectedRevision: 3, sessionId: "s1", questionId: "q2" }))).toEqual([
        { sessionId: "s1", questionId: "q2" },
      ]);
    });

    it(`${provider}: completed ask yields one ref per output question id, from a JSON string or a text block`, () => {
      const expected = [
        { sessionId: "s1", questionId: "q1" },
        { sessionId: "s1", questionId: "q2" },
      ];
      expect(extractCandidates(provider, call(name("roadmap_ask"), askInput, askOutput(["q1", "q2"])))).toEqual(expected);
      expect(extractCandidates(provider, call(name("roadmap_ask"), askInput, { type: "text", text: askOutput(["q1", "q2"]) }))).toEqual(expected);
    });

    it(`${provider}: question ids may contain dots`, () => {
      expect(extractCandidates(provider, call(name("roadmap_answer"), { sessionId: "s1", questionId: "q.with.dots" }))).toEqual([
        { sessionId: "s1", questionId: "q.with.dots" },
      ]);
    });

    it(`${provider}: running, failed and canceled calls yield nothing`, () => {
      for (const status of ["running", "failed", "canceled"] as const) {
        expect(extractCandidates(provider, call(name("roadmap_answer"), { sessionId: "s1", questionId: "q1" }, null, status)), status).toEqual([]);
        expect(extractCandidates(provider, call(name("roadmap_ask"), askInput, askOutput(["q1"]), status)), status).toEqual([]);
      }
    });

    it(`${provider}: malformed or missing payloads yield nothing`, () => {
      const ask = name("roadmap_ask");
      const answer = name("roadmap_answer");
      expect(extractCandidates(provider, call(ask, askInput, "{ not json"))).toEqual([]);
      expect(extractCandidates(provider, call(ask, askInput, { type: "text", text: "{ not json" }))).toEqual([]);
      expect(extractCandidates(provider, call(ask, askInput, askOutput("q1")))).toEqual([]);
      expect(extractCandidates(provider, call(ask, askInput, null))).toEqual([]);
      expect(extractCandidates(provider, call(ask, { questions: [] }, askOutput(["q1"])))).toEqual([]);
      expect(extractCandidates(provider, call(answer, { sessionId: "s1" }))).toEqual([]);
      expect(extractCandidates(provider, call(answer, { questionId: "q1" }))).toEqual([]);
      expect(extractCandidates(provider, call(answer, { sessionId: "", questionId: "q1" }))).toEqual([]);
      expect(extractCandidates(provider, call(answer, { sessionId: "s1", questionId: 7 }))).toEqual([]);
      expect(extractCandidates(provider, call(answer, "s1/q1"))).toEqual([]);
      expect(extractCandidates(provider, call(answer, null))).toEqual([]);
    });
  }

  // Installed 0.12.0 provider envelopes (stage 5 card, "Installed 0.12.0 output clarification"; source
  // `@getpaseo/server/dist/server/server/agent/providers/`): Claude buildToolOutput parses the MCP JSON and
  // the generic detail keeps `{ output: payload }`; Codex mapMcpToolCallItem keeps the MCP result envelope.
  it("claude: the actual { output: payload } envelope yields the ask refs", () => {
    const payload = { revision: 2, questionIds: ["q1", "q2"], visibilityChanged: [] };
    expect(extractCandidates("claude", call(CLAUDE("roadmap_ask"), askInput, { output: payload }))).toEqual([
      { sessionId: "s1", questionId: "q1" },
      { sessionId: "s1", questionId: "q2" },
    ]);
  });

  it("codex: the actual { content: [text block] } envelope yields the ask refs", () => {
    const envelope = { content: [{ type: "text", text: askOutput(["q1", "q2"]) }] };
    expect(extractCandidates("codex", call(CODEX("roadmap_ask"), askInput, envelope))).toEqual([
      { sessionId: "s1", questionId: "q1" },
      { sessionId: "s1", questionId: "q2" },
    ]);
  });

  it("malformed, error and unevidenced envelopes yield nothing", () => {
    const ask = (provider: "claude" | "codex", output: unknown) =>
      extractCandidates(provider, call(provider === "claude" ? CLAUDE("roadmap_ask") : CODEX("roadmap_ask"), askInput, output));
    const payload = { revision: 2, questionIds: ["q1"], visibilityChanged: [] };
    // Claude wrapper: non-JSON fallback string, missing or wrong-typed ids, error result (no output).
    expect(ask("claude", { output: "Tool failed: not json" })).toEqual([]);
    expect(ask("claude", { output: { revision: 2 } })).toEqual([]);
    expect(ask("claude", { output: { questionIds: "q1" } })).toEqual([]);
    expect(ask("claude", { output: null })).toEqual([]);
    expect(ask("claude", undefined)).toEqual([]);
    // Codex envelope: malformed text, empty or non-text content, MCP error result.
    expect(ask("codex", { content: [{ type: "text", text: "{ not json" }] })).toEqual([]);
    expect(ask("codex", { content: [] })).toEqual([]);
    expect(ask("codex", { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] })).toEqual([]);
    expect(ask("codex", { content: "not an array" })).toEqual([]);
    expect(ask("codex", { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] })).toEqual([]);
    // Not evidenced in 0.12.0: no recursive wrapper search, structuredContent or bare arrays.
    for (const provider of ["claude", "codex"] as const) {
      expect(ask(provider, { output: { output: payload } }), provider).toEqual([]);
      expect(ask(provider, { structuredContent: payload }), provider).toEqual([]);
      expect(ask(provider, { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }), provider).toEqual([]);
      expect(ask(provider, [{ type: "text", text: JSON.stringify(payload) }]), provider).toEqual([]);
    }
  });

  it("protocol-invalid tool items yield nothing (installed AgentTimelineItemPayloadSchema)", () => {
    const valid = call(CLAUDE("roadmap_answer"), { sessionId: "s1", questionId: "q1" });
    expect(AgentTimelineItemPayloadSchema.safeParse(valid).success).toBe(true);
    expect(extractCandidates("claude", valid)).toEqual([{ sessionId: "s1", questionId: "q1" }]);
    const { callId: _callId, ...withoutCallId } = valid;
    const invalid: Record<string, unknown> = {
      "missing callId": withoutCallId,
      "numeric callId": { ...valid, callId: 7 },
      "completed with a non-null error": { ...valid, error: { message: "boom" } },
      "detail without a type": { ...valid, detail: { input: valid.detail.input, output: null } },
    };
    for (const [label, item] of Object.entries(invalid)) {
      expect(AgentTimelineItemPayloadSchema.safeParse(item).success, `${label} must be schema-invalid`).toBe(false);
      expect(extractCandidates("claude", item), label).toEqual([]);
    }
  });

  it("only exact server-bound names match: bare, foreign-server, lookalike and cross-provider names yield nothing", () => {
    const input = { sessionId: "s1", questionId: "q1" };
    const names = [
      "roadmap_answer", // Codex empty-server fallback is not authoritative
      "mcp__other__roadmap_answer",
      "other.roadmap_answer",
      "mcp__decision-roadmap__roadmap_answer_extra",
      "mcp__decision-roadmap-evil__roadmap_answer",
      "xmcp__decision-roadmap__roadmap_answer",
      "decision-roadmap.roadmap_answer.extra",
      "evil.decision-roadmap.roadmap_answer",
      "mcp__decision-roadmap__roadmap_list",
    ];
    for (const provider of ["claude", "codex"]) {
      for (const n of names) expect(extractCandidates(provider, call(n, input)), `${provider} ${n}`).toEqual([]);
    }
    expect(extractCandidates("claude", call(CODEX("roadmap_answer"), input))).toEqual([]);
    expect(extractCandidates("codex", call(CLAUDE("roadmap_answer"), input))).toEqual([]);
  });

  it("OpenCode and Pi items yield nothing until their exact names are known (E6)", () => {
    const input = { sessionId: "s1", questionId: "q1" };
    for (const provider of ["opencode", "pi"]) {
      for (const n of [CLAUDE("roadmap_answer"), CODEX("roadmap_answer"), "roadmap_answer", "decision-roadmap_roadmap_answer"]) {
        expect(extractCandidates(provider, call(n, input)), `${provider} ${n}`).toEqual([]);
      }
    }
  });

  it("non tool-call items and non-objects yield nothing", () => {
    expect(extractCandidates("claude", { type: "assistant_message", text: "mcp__decision-roadmap__roadmap_answer" })).toEqual([]);
    expect(extractCandidates("claude", { ...call(CLAUDE("roadmap_answer"), { sessionId: "s1", questionId: "q1" }), type: "plugin" })).toEqual([]);
    for (const item of [null, undefined, "tool_call", 42, []]) expect(extractCandidates("claude", item)).toEqual([]);
  });
});

describe("rowIdFor (T5.4)", () => {
  it("is deterministic and reference-only", () => {
    expect(rowIdFor({ sessionId: "s1", questionId: "q1" })).toBe("q.s1.q1");
    expect(rowIdFor({ sessionId: "s1", questionId: "q1" })).toBe(rowIdFor({ sessionId: "s1", questionId: "q1" }));
    expect(rowIdFor({ sessionId: "s1", questionId: "q.with.dots" })).toBe("q.s1.q.with.dots");
    expect(rowIdFor({ sessionId: "s1", questionId: "q2" })).not.toBe(rowIdFor({ sessionId: "s1", questionId: "q1" }));
  });
});

describe("module boundary", () => {
  it("timeline-match imports no client module", () => {
    const src = readFileSync(new URL("./timeline-match.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["'](\.\.\/client\/|react|react-native|@getpaseo\/plugin\/client)/);
  });
});

// Stage R3.5 (card §6.2a "Timeline run rows"): run candidates. The new exports are loaded from the
// module namespace so the file collects before they exist.
describe("R3.5 run candidates", () => {
  const load = async () => {
    const mod = await import("./timeline-match");
    for (const name of ["extractRunCandidates", "runRowIdFor"] as const) expect(typeof mod[name], `timeline-match exports ${name}`).toBe("function");
    expect(mod.RUN_ROW_KIND).toBe("decision-run");
    expect(mod.RUN_ROW_VERSION).toBe(1);
    return mod;
  };
  const RUN_TOOLS = ["roadmap_run_next", "roadmap_task_claim", "roadmap_task_progress", "roadmap_run_ack"];
  const runInput = (extra: Record<string, unknown> = {}) => ({ runId: "run-1", runToken: "tok-SECRET", taskId: "t1", ...extra });

  for (const [provider, name] of [
    ["claude", CLAUDE],
    ["codex", CODEX],
  ] as const) {
    it(`${provider}: each completed run-scoped tool with a non-empty runId yields exactly { runId }`, async () => {
      const m = await load();
      for (const tool of RUN_TOOLS) expect(m.extractRunCandidates(provider, call(name(tool), runInput(), "{}")), tool).toEqual([{ runId: "run-1" }]);
    });

    it(`${provider}: running, failed or canceled calls, a missing or empty runId, start/bind and question tools yield nothing`, async () => {
      const m = await load();
      for (const status of ["running", "failed", "canceled"] as const) expect(m.extractRunCandidates(provider, call(name("roadmap_run_next"), runInput(), null, status)), status).toEqual([]);
      expect(m.extractRunCandidates(provider, call(name("roadmap_task_claim"), { taskId: "t1" }))).toEqual([]);
      expect(m.extractRunCandidates(provider, call(name("roadmap_task_claim"), runInput({ runId: "" })))).toEqual([]);
      expect(m.extractRunCandidates(provider, call(name("roadmap_task_claim"), runInput({ runId: 7 })))).toEqual([]);
      for (const tool of ["roadmap_start", "roadmap_feature_bind", "roadmap_ask", "roadmap_answer"]) expect(m.extractRunCandidates(provider, call(name(tool), runInput())), tool).toEqual([]);
    });

    it(`${provider}: a near-miss name (suffix, prefix, other server) yields nothing`, async () => {
      const m = await load();
      for (const n of [`${name("roadmap_run_next")}_evil`, `x${name("roadmap_run_next")}`, name("roadmap_run_nex"), provider === "claude" ? "mcp__evil__roadmap_run_next" : "evil.roadmap_run_next"]) {
        expect(m.extractRunCandidates(provider, call(n, runInput())), n).toEqual([]);
      }
    });
  }

  it("other providers, malformed items and the question extractor stay unaffected", async () => {
    const m = await load();
    expect(m.extractRunCandidates("opencode", call(CLAUDE("roadmap_run_next"), runInput()))).toEqual([]);
    for (const raw of [null, 7, "x", { type: "tool_call" }, { ...call(CLAUDE("roadmap_run_next"), runInput()), detail: null }]) expect(m.extractRunCandidates("claude", raw)).toEqual([]);
    expect(extractCandidates("claude", call(CLAUDE("roadmap_run_next"), runInput()))).toEqual([]);
  });

  it("runRowIdFor is run.<runId>, deterministic and reference-only", async () => {
    const m = await load();
    expect(m.runRowIdFor({ runId: "run-1" })).toBe("run.run-1");
    expect(m.runRowIdFor({ runId: "run-1" })).toBe(m.runRowIdFor({ runId: "run-1" }));
    expect(m.runRowIdFor({ runId: "run-2" })).not.toBe(m.runRowIdFor({ runId: "run-1" }));
  });
});

// Review regression (KensAI c0057): a Codex discussion chat may ask through its preapproval entry
// `decision-roadmap-discuss`, whose enabled tools are the preapproved read tools and roadmap_ask. Its
// ask yields the same candidates as through the roadmap server; answer, confirm and run tools are not
// enabled there and yield nothing, and lookalike names stay rejected.
describe("extractCandidates for the Codex preapproval entry", () => {
  it("a completed ask through the entry yields the same refs as through the roadmap server", () => {
    const expected = [
      { sessionId: "s1", questionId: "q1" },
      { sessionId: "s1", questionId: "q2" },
    ];
    const envelope = { content: [{ type: "text", text: askOutput(["q1", "q2"]) }] };
    expect(extractCandidates("codex", call(CODEX("roadmap_ask"), askInput, envelope))).toEqual(expected);
    expect(extractCandidates("codex", call(CODEX_ALIAS("roadmap_ask"), askInput, envelope))).toEqual(expected);
  });

  it("answer, confirm and run tools under the entry, lookalikes, other providers and unfinished calls yield nothing", () => {
    const envelope = { content: [{ type: "text", text: askOutput(["q1"]) }] };
    const ref = { expectedRevision: 3, sessionId: "s1", questionId: "q1", optionId: "a" };
    expect(extractCandidates("codex", call(CODEX_ALIAS("roadmap_answer"), ref))).toEqual([]);
    expect(extractCandidates("codex", call(CODEX_ALIAS("roadmap_confirm"), ref))).toEqual([]);
    expect(extractCandidates("codex", call(CODEX_ALIAS("roadmap_run_next"), { runId: "r1" }))).toEqual([]);
    for (const name of ["decision-roadmap-discussx.roadmap_ask", "decision-roadmap-discuss.roadmap_askx", "x.decision-roadmap-discuss.roadmap_ask", "decision-roadmap-discuss-roadmap_ask", "decision-roadmap-discuss.ROADMAP_ASK"]) {
      expect(extractCandidates("codex", call(name, askInput, envelope)), name).toEqual([]);
    }
    expect(extractCandidates("claude", call(CODEX_ALIAS("roadmap_ask"), askInput, envelope))).toEqual([]);
    expect(extractCandidates("claude", call("mcp__decision-roadmap-discuss__roadmap_ask", askInput, { output: { revision: 2, questionIds: ["q1"] } }))).toEqual([]);
    expect(extractCandidates("codex", call(CODEX_ALIAS("roadmap_ask"), askInput, envelope, "running"))).toEqual([]);
  });
});
