// "Out of scope" as its own stored validity, distinct from skipped: the pure graph mark keeps the
// answer, its revisions and discussion, clears the question's own staleness, marks no dependent
// stale and leaves dependents' existing staleness alone; activation children of the marked
// question are hidden exactly as for a skip. Status and counts report it separately.
//
// Fixture `session-branching.json`: s1: q1(a,b); q2(yes,no) activated by q1∈{b}; q3(c,d)
// invalidated by q1; q4(c,d) invalidated by q3. s2: x1(y,n) activated by s1/q2∈{yes},
// invalidated by s1/q1.
import { describe, expect, it } from "vitest";
import { applyAnswer, computeVisibility, findQuestion, markOutOfScope } from "./graph";
import { Question, Stale, Validity, type Session } from "./model";
import { Counts, QuestionStatusSchema } from "./rpc";
import { questionStatus } from "./status";
import { canonicalJson } from "./canonical";
import { answered, fixedClock, loadBranching, pick, q, r } from "../server/test-support/build";
import { throwsCode } from "../server/test-support/expect-error";

const NOW_ISO = fixedClock().toISOString();

function answerAll(s: Session[], picks: Array<[ReturnType<typeof r>, string]>): Session[] {
  for (const [ref, optionId] of picks) s = applyAnswer(s, ref, pick(optionId)).sessions;
  return s;
}

describe("model and status", () => {
  it("out_of_scope is a stored validity, distinct from skipped", () => {
    expect(Validity.options).toEqual(expect.arrayContaining(["skipped", "out_of_scope"]));
    expect(Question.safeParse(q("x", { validity: "out_of_scope" })).success).toBe(true);
    expect(Question.safeParse({ ...answered(q("x", { options: [{ id: "a", label: "A" }] }), "a"), validity: "out_of_scope" }).success).toBe(true);
  });

  it("an out-of-scope question carries no stale marker", () => {
    const stale = { causeSessionId: "s", causeQuestionId: "u", causeRev: 2, at: NOW_ISO };
    expect(Question.safeParse(q("x", { validity: "out_of_scope", stale })).success).toBe(false);
  });

  // A stale or review marker names exactly one cause: an answer revision, or an out-of-scope mark.
  it("a stale marker carries exactly one cause: causeRev, or causeKind out_of_scope with an optional mark id", () => {
    const base = { causeSessionId: "s", causeQuestionId: "u", at: NOW_ISO };
    expect(Stale.safeParse({ ...base, causeRev: 2 }).success).toBe(true);
    expect(Stale.safeParse({ ...base, causeKind: "out_of_scope", causeMarkId: "m1" }).success).toBe(true);
    expect(Stale.safeParse({ ...base, causeKind: "out_of_scope" }).success).toBe(true);
    expect(Stale.safeParse(base).success).toBe(false);
    expect(Stale.safeParse({ ...base, causeRev: 2, causeKind: "out_of_scope" }).success).toBe(false);
    expect(Stale.safeParse({ ...base, causeRev: 2, causeMarkId: "m1" }).success).toBe(false);
    expect(Stale.safeParse({ ...base, causeMarkId: "m1" }).success).toBe(false);
    expect(Stale.safeParse({ ...base, causeKind: "answer", causeRev: 2 }).success).toBe(false);
    expect(Stale.safeParse({ ...base, causeRev: 0 }).success).toBe(false);
    expect(Stale.safeParse({ ...base, causeKind: "out_of_scope", causeMarkId: "" }).success).toBe(false);
    expect(Stale.safeParse({ ...base, causeRev: 2, extra: 1 }).success).toBe(false);
  });

  it("maps to the out_of_scope status, while inactive still wins", () => {
    expect(questionStatus("active", "out_of_scope")).toBe("out_of_scope");
    expect(questionStatus("active", "skipped")).toBe("skipped");
    expect(questionStatus("inactive", "out_of_scope")).toBe("inactive");
  });

  it("the status enum and counts carry out_of_scope separately from skipped", () => {
    expect(QuestionStatusSchema.safeParse("out_of_scope").success).toBe(true);
    const counts = { open: 0, answered: 0, stale: 0, skipped: 1, inactive: 0, out_of_scope: 2 };
    expect(Counts.parse(counts)).toEqual(counts);
    const { out_of_scope: _drop, ...withoutOutOfScope } = counts;
    expect(Counts.safeParse(withoutOutOfScope).success).toBe(false);
  });
});

describe("markOutOfScope", () => {
  it("keeps the answer and revisions, hides activation children and marks nothing stale", () => {
    const s = answerAll(loadBranching(), [[r("s1", "q1"), "b"], [r("s1", "q2"), "yes"]]);
    expect(computeVisibility(s).get("s2/x1")).toBe("active");
    const change = markOutOfScope(s, r("s1", "q2"), NOW_ISO);
    const q2 = findQuestion(change.sessions, r("s1", "q2"));
    expect(q2.validity).toBe("out_of_scope");
    expect(q2.answer?.optionId).toBe("yes");
    expect(q2.revisions).toHaveLength(1);
    expect(computeVisibility(change.sessions).get("s2/x1")).toBe("inactive");
    expect(change.visibilityChanged).toEqual([r("s2", "x1")]);
    expect(change.staleMarked).toEqual([]);
  });

  it("clears the question's own staleness without adding a revision", () => {
    let s = answerAll(loadBranching(), [[r("s1", "q1"), "a"], [r("s1", "q3"), "c"], [r("s1", "q1"), "b"]]);
    expect(findQuestion(s, r("s1", "q3")).validity).toBe("stale");
    s = markOutOfScope(s, r("s1", "q3"), NOW_ISO).sessions;
    const q3 = findQuestion(s, r("s1", "q3"));
    expect(q3.validity).toBe("out_of_scope");
    expect(q3.stale).toBeUndefined();
    expect(q3.revisions.map((a) => a.optionId)).toEqual(["c"]);
    expect(q3.answer).toEqual(q3.revisions[0]);
  });

  // A parent's change to out of scope must be reconsidered by its children: an answered invalidation
  // dependent becomes stale with the out-of-scope question as cause and no answer revision as cause.
  it("marks an answered invalidation dependent stale, keeping its answer; an already stale one stays stale", () => {
    const valid = answerAll(loadBranching(), [[r("s1", "q1"), "a"], [r("s1", "q3"), "c"], [r("s1", "q4"), "c"]]);
    const afterValid = markOutOfScope(valid, r("s1", "q3"), NOW_ISO);
    const q4 = findQuestion(afterValid.sessions, r("s1", "q4"));
    expect(q4.validity).toBe("stale");
    expect(q4.stale).toMatchObject({ causeSessionId: "s1", causeQuestionId: "q3", causeKind: "out_of_scope" });
    expect({ ...q4.stale }).not.toHaveProperty("causeRev");
    expect(q4.revisions).toEqual(findQuestion(valid, r("s1", "q4")).revisions);
    expect(afterValid.staleMarked).toEqual([r("s1", "q4")]);

    const stale = answerAll(valid, [[r("s1", "q3"), "d"]]);
    expect(findQuestion(stale, r("s1", "q4")).validity).toBe("stale");
    const afterStale = markOutOfScope(stale, r("s1", "q3"), NOW_ISO);
    expect(findQuestion(afterStale.sessions, r("s1", "q4")).validity).toBe("stale");
  });

  it("is allowed on an unanswered active question", () => {
    const change = markOutOfScope(loadBranching(), r("s1", "q1"), NOW_ISO);
    const q1 = findQuestion(change.sessions, r("s1", "q1"));
    expect(q1.validity).toBe("out_of_scope");
    expect(q1.answer).toBeUndefined();
    expect(q1.revisions).toEqual([]);
  });

  it("is pure: the input sessions are not modified", () => {
    const s = answerAll(loadBranching(), [[r("s1", "q1"), "b"], [r("s1", "q2"), "yes"]]);
    const before = canonicalJson(s);
    markOutOfScope(s, r("s1", "q2"), NOW_ISO);
    expect(canonicalJson(s)).toBe(before);
  });

  it("refuses an inactive question and an unknown one", () => {
    throwsCode(() => markOutOfScope(loadBranching(), r("s1", "q2"), NOW_ISO), "question_inactive");
    throwsCode(() => markOutOfScope(loadBranching(), r("s1", "nope"), NOW_ISO), "not_found");
  });
});
