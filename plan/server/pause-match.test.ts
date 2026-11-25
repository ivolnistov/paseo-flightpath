// Automatic grilling S2/G4 (task card §4.3 matchPause, answerResponse, attributeResolution; PLAN
// §3.4; TR2–TR4): only the exact single pause card of the current operation, shown by the bound
// target through Claude AskUserQuestion or Codex synchronous request_user_input, is ours. Tool, plan,
// mode and other kinds, other agents, the async Codex variant, other plugins' questions and stale
// tokens are never ours; a bundled or altered card with the current token is a mismatch. Host
// decorations are ignored. Pure.
import { describe, expect, it } from "vitest";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { cardText, claudeCard, codexCard } from "./test-support/fake-paseo-agents";
import { need, pauseSnapshot, PLANNER } from "./test-support/grilling";

const load = () =>
  import("./pause").catch((e: unknown) => {
    throw new Error(`missing module server/pause.ts: ${String(e)}`);
  });

const OP = "01JOPERATIONCURRENT0000000";
const OLD = "01JOPERATIONPREVIOUS000000";
const target = { agentId: PLANNER, operationId: OP };
const planner = { id: PLANNER };
const withInput = (r: AgentPermissionRequest, input: Record<string, unknown>): AgentPermissionRequest => ({ ...r, input });

describe("matchPause: the exact card", () => {
  it("a Claude AskUserQuestion card with Claude's decorations matches, with the request snapshot", async () => {
    const matchPause = need((await load()).matchPause, "pause.matchPause");
    expect(matchPause(planner, claudeCard(OP, { requestId: "req-claude" }), target)).toEqual({
      kind: "match",
      snapshot: { requestId: "req-claude", provider: "claude", name: "AskUserQuestion", questionText: cardText(OP), header: "Roadmap", optionLabels: ["Continue", "Stop"] },
    });
  });

  it("a Codex request_user_input card with Codex's decorations (id, isOther, isSecret, label-only options) matches", async () => {
    const matchPause = need((await load()).matchPause, "pause.matchPause");
    expect(matchPause(planner, codexCard(OP, { requestId: "req-codex" }), target)).toEqual({
      kind: "match",
      snapshot: { requestId: "req-codex", provider: "codex", name: "request_user_input", questionText: cardText(OP), header: "Roadmap", optionLabels: ["Continue", "Stop"] },
    });
  });

  it("multiSelect absent or false is single-select; any other per-question key is ignored", async () => {
    const matchPause = need((await load()).matchPause, "pause.matchPause");
    const plain = withInput(claudeCard(OP), {
      questions: [{ question: cardText(OP), header: "Roadmap", options: [{ label: "Continue" }, { label: "Stop" }], extraHostKey: { nested: true } }],
    });
    expect(matchPause(planner, plain, target).kind).toBe("match");
  });
});

describe("matchPause: never ours (foreign)", () => {
  it.each(["tool", "plan", "mode", "other"] as const)("kind %s carrying the exact card is foreign", async (kind) => {
    const matchPause = need((await load()).matchPause, "pause.matchPause");
    expect(matchPause(planner, { ...claudeCard(OP), kind }, target)).toEqual({ kind: "foreign" });
  });

  it("provider/name pairs other than claude/AskUserQuestion and codex/request_user_input are foreign (async Codex included)", async () => {
    const matchPause = need((await load()).matchPause, "pause.matchPause");
    expect(matchPause(planner, codexCard(OP, { name: "request_user_input_async" }), target)).toEqual({ kind: "foreign" });
    expect(matchPause(planner, { ...claudeCard(OP), name: "request_user_input" }, target)).toEqual({ kind: "foreign" });
    expect(matchPause(planner, { ...codexCard(OP), name: "AskUserQuestion" }, target)).toEqual({ kind: "foreign" });
    expect(matchPause(planner, { ...claudeCard(OP), provider: "opencode", name: "question" }, target)).toEqual({ kind: "foreign" });
    expect(matchPause(planner, { ...claudeCard(OP), name: "askuserquestion" }, target)).toEqual({ kind: "foreign" });
  });

  it("the exact card from an agent other than the target is foreign", async () => {
    const matchPause = need((await load()).matchPause, "pause.matchPause");
    expect(matchPause({ id: "agent-B" }, claudeCard(OP), target)).toEqual({ kind: "foreign" });
  });

  it("another plugin's question, and a question without any input, carry no DR-OP- token and are foreign", async () => {
    const matchPause = need((await load()).matchPause, "pause.matchPause");
    const other = withInput(claudeCard(OP), { questions: [{ question: "Which database?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }] }] });
    expect(matchPause(planner, other, target)).toEqual({ kind: "foreign" });
    const { input: _input, ...noInput } = claudeCard(OP);
    expect(matchPause(planner, noInput, target)).toEqual({ kind: "foreign" });
  });
});

describe("matchPause: the token is read from question text only", () => {
  it("a token only in the header is foreign (no question text contains DR-OP-)", async () => {
    const matchPause = need((await load()).matchPause, "pause.matchPause");
    const headerOnly = withInput(claudeCard(OP), { questions: [{ question: "waiting", header: `DR-OP-${OP}`, options: [{ label: "Continue" }, { label: "Stop" }] }] });
    expect(matchPause(planner, headerOnly, target)).toEqual({ kind: "foreign" });
  });
});

describe("matchPause: a previous operation's card is stale", () => {
  it("only another operation's token → stale (no match, no mismatch)", async () => {
    const matchPause = need((await load()).matchPause, "pause.matchPause");
    const out = matchPause(planner, claudeCard(OLD), target);
    expect(out.kind).toBe("stale");
    expect(JSON.stringify(out)).toContain(OLD);
  });
});

describe("matchPause: the current token with a deviating card is a mismatch", () => {
  const variants: Array<[string, Record<string, unknown>]> = [
    ["the card bundled with a second question", { questions: [{ question: cardText(OP), header: "Roadmap", options: [{ label: "Continue" }, { label: "Stop" }] }, { question: "Also: tabs or spaces?", header: "Style", options: [{ label: "Tabs" }, { label: "Spaces" }] }] }],
    ["altered question text", { questions: [{ question: `${cardText(OP)} please`, header: "Roadmap", options: [{ label: "Continue" }, { label: "Stop" }] }] }],
    ["another header", { questions: [{ question: cardText(OP), header: "Roadmap ", options: [{ label: "Continue" }, { label: "Stop" }] }] }],
    ["options reversed", { questions: [{ question: cardText(OP), header: "Roadmap", options: [{ label: "Stop" }, { label: "Continue" }] }] }],
    ["an extra option", { questions: [{ question: cardText(OP), header: "Roadmap", options: [{ label: "Continue" }, { label: "Stop" }, { label: "Later" }] }] }],
    ["multi-select", { questions: [{ question: cardText(OP), header: "Roadmap", options: [{ label: "Continue" }, { label: "Stop" }], multiSelect: true }] }],
  ];

  it.each(variants)("%s → mismatch with a reason", async (_name, input) => {
    const matchPause = need((await load()).matchPause, "pause.matchPause");
    const out = matchPause(planner, withInput(claudeCard(OP), input), target);
    expect(out.kind).toBe("mismatch");
    if (out.kind === "mismatch") expect(out.reason.length).toBeGreaterThan(0);
  });
});

describe("answerResponse (TR2)", () => {
  it("allows with the summary keyed by the snapshot's exact question text and header; nothing else", async () => {
    const answerResponse = need((await load()).answerResponse, "pause.answerResponse");
    const pause = pauseSnapshot({ questionText: cardText(OP), header: "Roadmap" });
    const summary = "Decision Roadmap: block 1 accepted (session \"S\", block b1)\nq1 2\nq2 text:\n  two\n  lines";
    expect(answerResponse(pause, summary)).toEqual({ behavior: "allow", updatedInput: { answers: { [cardText(OP)]: summary, Roadmap: summary } } });
  });

  it("uses the snapshot's fields, never template constants", async () => {
    const answerResponse = need((await load()).answerResponse, "pause.answerResponse");
    const pause = pauseSnapshot({ questionText: "Exact text as shown", header: "Header as shown" });
    expect(answerResponse(pause, "S")).toEqual({ behavior: "allow", updatedInput: { answers: { "Exact text as shown": "S", "Header as shown": "S" } } });
  });
});

describe("attributeResolution (TR4)", () => {
  const pause = pauseSnapshot({ questionText: cardText(OP), header: "Roadmap" });
  const SUMMARY = "Decision Roadmap: block 1 accepted\nq1 1";
  const allow = (answers?: Record<string, unknown>): AgentPermissionResponse => ({ behavior: "allow", ...(answers !== undefined ? { updatedInput: { answers } } : {}) });

  it("an allow whose answer under the question text or the header equals the recorded summary is the plugin's", async () => {
    const attribute = need((await load()).attributeResolution, "pause.attributeResolution");
    expect(attribute(allow({ [cardText(OP)]: SUMMARY, Roadmap: SUMMARY }), pause, SUMMARY)).toBe("plugin");
    expect(attribute(allow({ [cardText(OP)]: SUMMARY }), pause, SUMMARY)).toBe("plugin");
    expect(attribute(allow({ Roadmap: SUMMARY }), pause, SUMMARY)).toBe("plugin");
  });

  it("any other allow with readable answers is external (also when no summary is recorded)", async () => {
    const attribute = need((await load()).attributeResolution, "pause.attributeResolution");
    expect(attribute(allow({ [cardText(OP)]: "Continue" }), pause, SUMMARY)).toBe("external");
    expect(attribute(allow({ Roadmap: "Stop" }), pause, SUMMARY)).toBe("external");
    expect(attribute(allow({ [cardText(OP)]: SUMMARY }), pause, undefined)).toBe("external");
  });

  it("an allow without readable answers is the host's (unattributed)", async () => {
    const attribute = need((await load()).attributeResolution, "pause.attributeResolution");
    expect(attribute(allow(), pause, SUMMARY)).toBe("host");
    expect(attribute({ behavior: "allow", updatedInput: { questions: [] } }, pause, SUMMARY)).toBe("host");
  });
});

describe("MAX_ATTEMPTS", () => {
  it("is 3 calls in total (TR10)", async () => {
    expect(need((await load()).MAX_ATTEMPTS, "pause.MAX_ATTEMPTS")).toBe(3);
  });
});
