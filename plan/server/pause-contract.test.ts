// Automatic grilling S2/G3 (task card §4.2 pause-contract, PLAN §3.3, TR11): the exact pause card
// the planner is told to show, the contract text (only for the bound planner), and the do-not-pause
// notices for every other caller. Pure; missing exports fail per case.
import { describe, expect, it } from "vitest";
import { need } from "./test-support/grilling";

/** The module under test, or a per-case failure naming it (not a collection crash). */
const load = () =>
  import("./pause-contract").catch((e: unknown) => {
    throw new Error(`missing module server/pause-contract.ts: ${String(e)}`);
  });

describe("pause card constants", () => {
  it("header Roadmap, options Continue then Stop, token DR-OP-<id>, question text template", async () => {
    const contract = await load();
    expect(need(contract.PAUSE_HEADER, "pause-contract.PAUSE_HEADER")).toBe("Roadmap");
    expect(need(contract.PAUSE_OPTIONS, "pause-contract.PAUSE_OPTIONS")).toEqual(["Continue", "Stop"]);
    const token = need(contract.operationToken, "pause-contract.operationToken");
    expect(token("01JABCDEF")).toBe("DR-OP-01JABCDEF");
    const text = need(contract.pauseQuestionText, "pause-contract.pauseQuestionText");
    expect(text("01JABCDEF")).toBe("Decision Roadmap: waiting for block acceptance (DR-OP-01JABCDEF)");
    expect(text("op-1")).toBe("Decision Roadmap: waiting for block acceptance (DR-OP-op-1)");
  });
});

describe("pauseContractText (PLAN §3.3 behaviour; S2 KensAI c10)", () => {
  it("states the exact single card, not to answer or extend it, and completion via roadmap_grill_complete", async () => {
    const contract = await load();
    const text = need(contract.pauseContractText, "pause-contract.pauseContractText");
    const out = text({ openBlockId: "blk-open", operationId: "01JOPERATION" });
    expect(out).toContain("blk-open");
    expect(out).toContain('"Decision Roadmap: waiting for block acceptance (DR-OP-01JOPERATION)"');
    expect(out).toContain('header "Roadmap"');
    expect(out).toContain('options "Continue" and "Stop"');
    expect(out).toContain("exactly ONE question");
    expect(out).toContain("single-select");
    expect(out).toContain("Do not answer it yourself");
    expect(out).toContain("AskUserQuestion");
    expect(out).toContain("request_user_input");
    expect(out).toContain("roadmap_grill_complete");
  });

  it("c10: only the accepted block summary continues the grilling; any other answer (a native Continue or Stop) means stop and wait for the owner", async () => {
    const contract = await load();
    const text = need(contract.pauseContractText, "pause-contract.pauseContractText");
    const out = text({ openBlockId: "blk-open", operationId: "01JOPERATION" });
    expect(out, "the planner can recognise the summary by its first line").toContain("Decision Roadmap: block");
    expect(out).toMatch(/any other answer/i);
    expect(out).toMatch(/wait for the owner/i);
    expect(out, "no unconditional claim that every answer is the summary").not.toContain("The answer you receive is the owner's accepted batch summary;");
  });

  it("carries the exact card text, the block id and the operation token of the given operation only", async () => {
    const contract = await load();
    const text = need(contract.pauseContractText, "pause-contract.pauseContractText");
    const out = text({ openBlockId: "blk-2", operationId: "op-7" });
    expect(out).toContain('"Decision Roadmap: waiting for block acceptance (DR-OP-op-7)"');
    expect(out).toContain("blk-2");
    expect(out).not.toContain("blk-open");
    expect(out.match(/DR-OP-[A-Za-z0-9-]+/g)?.every((t) => t === "DR-OP-op-7")).toBe(true);
  });
});

// S2 corrected KensAI review (session 01a19904): c82 and c88.
describe("pauseContractText: option order and an unavailable tool (c82, c88)", () => {
  it("c82: states that the two options must appear in that order (the matcher requires Continue, then Stop)", async () => {
    const contract = await load();
    const out = need(contract.pauseContractText, "pause-contract.pauseContractText")({ openBlockId: "blk-open", operationId: "op-1" });
    expect(out).toMatch(/options "Continue" and "Stop",? in that order/);
  });

  it("c88: says what to do when the native question tool is not available in this chat (no card; the owner continues manually)", async () => {
    const contract = await load();
    const out = need(contract.pauseContractText, "pause-contract.pauseContractText")({ openBlockId: "blk-open", operationId: "op-1" });
    expect(out).toMatch(/not available|unavailable/i);
    expect(out).toMatch(/owner/);
  });
});

describe("notices for callers that must not pause (TR11)", () => {
  it("NOT_PLANNER_TEXT, NO_PLANNER_TEXT and UNSUPPORTED_TEXT(reason) are the card's exact sentences", async () => {
    const contract = await load();
    expect(need(contract.NOT_PLANNER_TEXT, "pause-contract.NOT_PLANNER_TEXT")).toBe("This session's planner is another chat; do not pause.");
    expect(need(contract.NO_PLANNER_TEXT, "pause-contract.NO_PLANNER_TEXT")).toBe("No planner chat is bound; the owner can bind one in the panel.");
    const unsupported = need(contract.UNSUPPORTED_TEXT, "pause-contract.UNSUPPORTED_TEXT");
    expect(unsupported("codex default mode")).toBe("This chat cannot pause natively (codex default mode); do not pause; the owner continues manually.");
  });

  it("no notice tells the chat to pause or names a card text", async () => {
    const contract = await load();
    for (const t of [need(contract.NOT_PLANNER_TEXT, "NOT_PLANNER_TEXT"), need(contract.NO_PLANNER_TEXT, "NO_PLANNER_TEXT"), need(contract.UNSUPPORTED_TEXT, "UNSUPPORTED_TEXT")("x")]) {
      expect(t).not.toContain("DR-OP-");
      expect(t).not.toMatch(/Now pause/);
    }
  });
});
