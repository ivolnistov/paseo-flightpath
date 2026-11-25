// Regression: an existing recommendation can be cleared, alone or together with removing that option.
import { describe, expect, it } from "vitest";
import { answered, NOW_ISO, opt, q, r, session } from "../server/test-support/build";
import { throwsCode } from "../server/test-support/expect-error";
import { canonicalJson } from "./canonical";
import { findQuestion, updateDefinition } from "./graph";
import { Question } from "./model";

const REF = r("s1", "q1");
const recommended = () => [
  session("s1", [answered(q("q1", { options: [opt("a"), opt("b"), opt("c")], recommendedOptionId: "b" }), "a")]),
];

describe("clearing a recommendation", () => {
  it("recommendedOptionId: null removes the stored recommendation and keeps options and answer", () => {
    const s = recommended();
    const before = canonicalJson(s);
    const change = updateDefinition(s, REF, { recommendedOptionId: null }, NOW_ISO);
    const q1 = findQuestion(change.sessions, REF);
    expect("recommendedOptionId" in q1).toBe(false);
    expect(() => Question.parse(q1)).not.toThrow();
    expect(q1.options.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(change.definitionRev).toBe(2);
    expect(q1.definitionRev).toBe(2);
    expect(q1.validity).toBe("valid");
    expect(q1.revisions).toEqual(findQuestion(s, REF).revisions);
    expect(change.staleMarked).toEqual([]);
    expect(canonicalJson(s)).toBe(before);
  });

  it("clearing and removing the recommended option together leaves valid data", () => {
    const change = updateDefinition(recommended(), REF, { recommendedOptionId: null, options: [opt("a"), opt("c")] }, NOW_ISO);
    const q1 = findQuestion(change.sessions, REF);
    expect("recommendedOptionId" in q1).toBe(false);
    expect(() => Question.parse(q1)).not.toThrow();
    expect(q1.options.map((o) => o.id)).toEqual(["a", "c"]);
    expect(change.definitionRev).toBe(2);
    // The answer used "a", which survives, so the question is not stale.
    expect(q1.validity).toBe("valid");
    expect(q1.stale).toBeUndefined();
  });

  it("removing the recommended option without clearing it is rejected", () => {
    throwsCode(() => updateDefinition(recommended(), REF, { options: [opt("a"), opt("c")] }, NOW_ISO), "invalid_input");
  });

  it("clearing an absent recommendation is a no-op for definitionRev", () => {
    const s = [session("s1", [q("q1", { options: [opt("a")] })])];
    const change = updateDefinition(s, REF, { recommendedOptionId: null }, NOW_ISO);
    expect(change.definitionRev).toBe(1);
    expect("recommendedOptionId" in findQuestion(change.sessions, REF)).toBe(false);
  });
});
