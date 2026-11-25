// Canonical roadmap links: project-scoped question, current-answer and revision-pinned answer
// forms; malformed text parses to null, never to a guessed target.
import { describe, expect, it } from "vitest";
import { answerLink, parseLink, parseShortRef, questionLink } from "./links";

const x = { projectId: "prj_1", sessionId: "01M5S", number: 7 };

describe("building links", () => {
  it("uses the canonical forms", () => {
    expect(questionLink(x)).toBe("roadmap://prj_1/s/01M5S/q/7");
    expect(answerLink(x)).toBe("roadmap://prj_1/s/01M5S/q/7/answer");
    expect(answerLink(x, 3)).toBe("roadmap://prj_1/s/01M5S/q/7/answer/r3");
  });
});

describe("parseLink", () => {
  it("round-trips every form", () => {
    expect(parseLink(questionLink(x))).toEqual({ ...x, kind: "question" });
    expect(parseLink(answerLink(x))).toEqual({ ...x, kind: "answer" });
    expect(parseLink(answerLink(x, 3))).toEqual({ ...x, kind: "answer", rev: 3 });
  });

  it("only a current-answer or question link has no pinned revision", () => {
    expect(parseLink(questionLink(x))?.rev).toBeUndefined();
    expect(parseLink(answerLink(x))?.rev).toBeUndefined();
  });

  it("reads the kind from the path structure, not from ids that happen to contain 'answer'", () => {
    const tricky = { projectId: "prj_answer", sessionId: "answer", number: 2 };
    expect(parseLink(questionLink(tricky))).toEqual({ ...tricky, kind: "question" });
    expect(parseLink(answerLink(tricky))).toEqual({ ...tricky, kind: "answer" });
  });

  it.each([
    ["number 0", "roadmap://prj_1/s/01M5S/q/0"],
    ["negative number", "roadmap://prj_1/s/01M5S/q/-1"],
    ["non-numeric number", "roadmap://prj_1/s/01M5S/q/seven"],
    ["fractional number", "roadmap://prj_1/s/01M5S/q/1.5"],
    ["revision 0", "roadmap://prj_1/s/01M5S/q/7/answer/r0"],
    ["revision without r", "roadmap://prj_1/s/01M5S/q/7/answer/3"],
    ["unknown suffix", "roadmap://prj_1/s/01M5S/q/7/question"],
    ["trailing segment", "roadmap://prj_1/s/01M5S/q/7/answer/r3/x"],
    ["missing session segment", "roadmap://prj_1/01M5S/q/7"],
    ["missing project", "roadmap:///s/01M5S/q/7"],
    ["other scheme", "https://example.com/s/01M5S/q/7"],
    ["short reference", "Q7"],
    ["empty text", ""],
  ])("returns null for %s", (_label, text) => {
    expect(parseLink(text)).toBeNull();
  });
});

describe("parseShortRef", () => {
  it("reads Q<n> in either case", () => {
    expect(parseShortRef("Q12")).toBe(12);
    expect(parseShortRef("q12")).toBe(12);
    expect(parseShortRef("Q1")).toBe(1);
  });

  it.each(["Q0", "Q", "Q-1", "Q1x", "12", "QQ1", ""])("returns null for %j", (text) => {
    expect(parseShortRef(text)).toBeNull();
  });
});
