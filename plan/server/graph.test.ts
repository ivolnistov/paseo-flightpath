import { describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import {
  addRelation,
  applyAnswer,
  computeVisibility,
  confirmAnswer,
  findQuestion,
  layoutDepth,
  removeRelation,
  updateDefinition,
  type Relation,
} from "../shared/graph";
import { refKey, type Ref, type Session } from "../shared/model";
import { NOW_ISO, act, confirmBy, inv, loadBranching, opt, pick, r } from "./test-support/build";
import { throwsCode } from "./test-support/expect-error";

const Q1 = r("s1", "q1");
const Q2 = r("s1", "q2");
const Q3 = r("s1", "q3");
const Q4 = r("s1", "q4");
const X1 = r("s2", "x1");

const answer = (s: Session[], ref: Ref, optionId: string) => applyAnswer(s, ref, pick(optionId)).sessions;
const answerAll = (s: Session[], steps: Array<[Ref, string]>) =>
  steps.reduce((acc, [ref, o]) => answer(acc, ref, o), s);
const visible = (s: Session[], ref: Ref) => computeVisibility(s).get(refKey(ref));
const sortRefs = (refs: Ref[]) => [...refs].sort((a, b) => refKey(a).localeCompare(refKey(b)));
const depths = (s: Session[], sessionId: string) => Object.fromEntries(layoutDepth(s, sessionId));

describe("activation and cross-session visibility", () => {
  it("q2 is inactive without a q1 answer, inactive after q1=a, active after q1=b", () => {
    const base = loadBranching();
    expect(visible(base, Q2)).toBe("inactive");
    expect(visible(answer(base, Q1, "a"), Q2)).toBe("inactive");
    expect(visible(answer(base, Q1, "b"), Q2)).toBe("active");
    expect(visible(base, Q1)).toBe("active");
  });

  it("branch switching A→B→A→B keeps q2's answer, revisions and validity; visibility is not stored", () => {
    let s = answerAll(loadBranching(), [[Q1, "a"], [Q1, "b"], [Q2, "yes"]]);
    const stored = canonicalJson(findQuestion(s, Q2));
    const q2 = findQuestion(s, Q2);
    expect(q2.answer?.optionId).toBe("yes");
    expect(q2.revisions).toHaveLength(1);
    expect(q2.validity).toBe("valid");

    for (const [choice, expected] of [["a", "inactive"], ["b", "active"], ["a", "inactive"], ["b", "active"]] as const) {
      s = answer(s, Q1, choice);
      expect(visible(s, Q2)).toBe(expected);
      expect(canonicalJson(findQuestion(s, Q2))).toBe(stored);
    }
  });

  it("s2/x1 is active only while s1/q2 is active, valid and yes; an inactive parent deactivates it", () => {
    let s = loadBranching();
    expect(visible(s, X1)).toBe("inactive");
    s = answer(s, Q1, "b");
    expect(visible(s, X1)).toBe("inactive"); // q2 active but unanswered
    s = answer(s, Q2, "no");
    expect(visible(s, X1)).toBe("inactive");
    s = answer(s, Q2, "yes");
    expect(visible(s, X1)).toBe("active");
    s = answer(s, Q1, "a");
    expect(visible(s, Q2)).toBe("inactive");
    expect(findQuestion(s, Q2).answer?.optionId).toBe("yes");
    expect(visible(s, X1)).toBe("inactive");
  });

  it("a stale parent deactivates its children until it is confirmed", () => {
    let s = addRelation(loadBranching(), { kind: "invalidation", target: Q2, invalidation: inv(Q1) }).sessions;
    s = answerAll(s, [[Q1, "b"], [Q2, "yes"]]);
    expect(visible(s, X1)).toBe("active");
    s = answerAll(s, [[Q1, "a"], [Q1, "b"]]);
    expect(findQuestion(s, Q2).validity).toBe("stale");
    expect(visible(s, Q2)).toBe("active");
    expect(visible(s, X1)).toBe("inactive");
    s = confirmAnswer(s, Q2, confirmBy).sessions;
    expect(findQuestion(s, Q2).validity).toBe("valid");
    expect(visible(s, X1)).toBe("active");
  });

  it("applyAnswer on an inactive question throws question_inactive and leaves the input intact", () => {
    const s = loadBranching();
    const before = canonicalJson(s);
    throwsCode(() => applyAnswer(s, Q2, pick("yes")), "question_inactive");
    expect(canonicalJson(s)).toBe(before);
  });
});

describe("dependency invalidation", () => {
  it("the first answer to q1 marks nothing stale", () => {
    const s = answer(loadBranching(), Q3, "c");
    const change = applyAnswer(s, Q1, pick("a"));
    expect(change.staleMarked).toEqual([]);
    expect(change.rev).toBe(1);
    expect(change.valueChanged).toBe(true);
    expect(findQuestion(change.sessions, Q3).validity).toBe("valid");
    expect(findQuestion(change.sessions, Q1).validity).toBe("valid");
  });

  it("changing q1 a→b marks answered q3 and transitively q4 stale with the cause; unanswered stays unanswered", () => {
    const s = answerAll(loadBranching(), [[Q1, "a"], [Q3, "c"], [Q4, "d"]]);
    const change = applyAnswer(s, Q1, pick("b"));
    expect(change.rev).toBe(2);
    expect(change.valueChanged).toBe(true);
    const cause = { causeSessionId: "s1", causeQuestionId: "q1", causeRev: 2, at: NOW_ISO };
    for (const ref of [Q3, Q4]) {
      const question = findQuestion(change.sessions, ref);
      expect(question.validity).toBe("stale");
      expect(question.stale).toEqual(cause);
      expect(question.answer?.optionId).toBeDefined();
    }
    expect(findQuestion(change.sessions, X1).validity).toBe("unanswered");
    expect(findQuestion(change.sessions, X1).stale).toBeUndefined();
    expect(sortRefs(change.staleMarked)).toEqual([Q3, Q4]);
  });

  it("re-answering q1 with the same value creates a revision without stale marks", () => {
    let s = answerAll(loadBranching(), [[Q1, "a"], [Q1, "b"], [Q3, "c"]]);
    const change = applyAnswer(s, Q1, pick("b"));
    expect(change.rev).toBe(3);
    expect(change.valueChanged).toBe(false);
    expect(change.staleMarked).toEqual([]);
    s = change.sessions;
    expect(findQuestion(s, Q1).revisions.map((a) => a.rev)).toEqual([1, 2, 3]);
    expect(findQuestion(s, Q3).validity).toBe("valid");
  });

  it("invalidation reaching an inactive question is recorded and revealed on reactivation", () => {
    let s = answerAll(loadBranching(), [[Q1, "b"], [Q2, "yes"], [X1, "y"]]);
    expect(visible(s, X1)).toBe("active");
    const toA = applyAnswer(s, Q1, pick("a"));
    s = toA.sessions;
    expect(visible(s, X1)).toBe("inactive");
    expect(findQuestion(s, X1).validity).toBe("stale");
    expect(findQuestion(s, X1).stale).toEqual({ causeSessionId: "s1", causeQuestionId: "q1", causeRev: 2, at: NOW_ISO });
    expect(toA.staleMarked).toContainEqual(X1);
    expect(sortRefs(toA.visibilityChanged)).toEqual(sortRefs([Q2, X1]));

    s = answer(s, Q1, "b");
    expect(visible(s, X1)).toBe("active");
    const x1 = findQuestion(s, X1);
    expect(x1.validity).toBe("stale");
    expect(x1.stale).toMatchObject({ causeSessionId: "s1", causeQuestionId: "q1", causeRev: 3 });
    expect(x1.answer?.optionId).toBe("y");
  });

  it("activation-only edges do not propagate stale", () => {
    const s = answerAll(loadBranching(), [[Q1, "b"], [Q2, "yes"]]);
    const change = applyAnswer(s, Q1, pick("a"));
    expect(findQuestion(change.sessions, Q2).validity).toBe("valid");
    expect(findQuestion(change.sessions, Q2).stale).toBeUndefined();
    expect(change.staleMarked).not.toContainEqual(Q2);
  });

  it("confirm on a stale question appends a same-value revision and clears stale; non-stale throws not_stale", () => {
    let s = answerAll(loadBranching(), [[Q1, "a"], [Q3, "c"], [Q4, "d"], [Q1, "b"]]);
    const q4Before = canonicalJson(findQuestion(s, Q4));
    const change = confirmAnswer(s, Q3, confirmBy);
    s = change.sessions;
    const q3 = findQuestion(s, Q3);
    expect(change.rev).toBe(2);
    expect(change.staleMarked).toEqual([]);
    expect(q3.revisions).toHaveLength(2);
    expect(q3.revisions[1]).toMatchObject({ rev: 2, optionId: "c" });
    expect(q3.answer).toEqual(q3.revisions[1]);
    expect(q3.validity).toBe("valid");
    expect(q3.stale).toBeUndefined();
    expect(canonicalJson(findQuestion(s, Q4))).toBe(q4Before); // confirm does not propagate
    throwsCode(() => confirmAnswer(s, Q3, confirmBy), "not_stale");
  });

  it("removing the option the current answer uses marks that question stale with itself as cause", () => {
    const s = answerAll(loadBranching(), [[Q1, "a"], [Q3, "c"], [Q4, "c"]]);
    const change = updateDefinition(s, Q3, { options: [opt("d")] }, NOW_ISO);
    const q3 = findQuestion(change.sessions, Q3);
    expect(change.definitionRev).toBe(2);
    expect(q3.definitionRev).toBe(2);
    expect(q3.validity).toBe("stale");
    expect(q3.stale).toEqual({ causeSessionId: "s1", causeQuestionId: "q3", causeRev: 1, at: NOW_ISO });
    expect(findQuestion(change.sessions, Q4).validity).toBe("valid");
    expect(findQuestion(change.sessions, Q4).stale).toBeUndefined();
  });
});

describe("graph integrity", () => {
  it("addRelation with an unknown session, question or option id throws unresolved_ref", () => {
    const s = loadBranching();
    throwsCode(() => addRelation(s, { kind: "invalidation", target: r("s9", "q1"), invalidation: inv(Q1) }), "unresolved_ref");
    throwsCode(() => addRelation(s, { kind: "invalidation", target: Q3, invalidation: inv(r("s1", "q99")) }), "unresolved_ref");
    throwsCode(() => addRelation(s, { kind: "activation", target: Q3, activation: act(Q1, "zzz") }), "unresolved_ref");
  });

  it("activation, invalidation, mixed, cross-session mixed cycles and self-edges throw relation_cycle", () => {
    const s = loadBranching();
    const before = canonicalJson(s);
    const cycles: Relation[] = [
      { kind: "activation", target: Q1, activation: act(Q2, "yes") }, // q1→q2 (act) + q2→q1 (act)
      { kind: "invalidation", target: Q1, invalidation: inv(Q4) }, // q1→q3→q4→q1 (inv)
      { kind: "invalidation", target: Q1, invalidation: inv(Q2) }, // q1 –act→ q2 –inv→ q1
      { kind: "invalidation", target: Q1, invalidation: inv(X1) }, // x1 depends on q1; x1 –inv→ q1
      { kind: "invalidation", target: Q3, invalidation: inv(Q3) }, // self-edge
    ];
    for (const rel of cycles) {
      throwsCode(() => addRelation(s, rel), "relation_cycle");
      expect(canonicalJson(s)).toBe(before);
    }
  });

  it("duplicate edge add throws invalid_input; removing a missing edge throws not_found", () => {
    const s = loadBranching();
    throwsCode(() => addRelation(s, { kind: "invalidation", target: Q3, invalidation: inv(Q1) }), "invalid_input");
    throwsCode(() => addRelation(s, { kind: "activation", target: Q2, activation: act(Q1, "b") }), "invalid_input");
    throwsCode(() => removeRelation(s, { kind: "invalidation", target: Q3, invalidation: inv(Q2) }), "not_found");
  });

  it("layoutDepth is the longest path on the combined DAG, across sessions", () => {
    const s = loadBranching();
    expect(depths(s, "s1")).toEqual({ q1: 0, q2: 1, q3: 1, q4: 2 });
    expect(depths(s, "s2")).toEqual({ x1: 2 });
    const linked = addRelation(s, { kind: "invalidation", target: Q3, invalidation: inv(Q2) });
    expect(linked.staleMarked).toEqual([]);
    expect(depths(linked.sessions, "s1")).toEqual({ q1: 0, q2: 1, q3: 2, q4: 3 });
  });

  it("every command leaves its input deep-equal", () => {
    const base = answerAll(loadBranching(), [[Q1, "a"], [Q3, "c"], [Q1, "b"]]);
    const snapshot = canonicalJson(base);
    const commands: Array<() => unknown> = [
      () => applyAnswer(base, Q1, pick("a")),
      () => applyAnswer(base, Q2, pick("yes")),
      () => confirmAnswer(base, Q3, confirmBy),
      () => updateDefinition(base, Q3, { options: [opt("d")], title: "Renamed" }, NOW_ISO),
      () => addRelation(base, { kind: "invalidation", target: Q3, invalidation: inv(Q2) }),
      () => removeRelation(base, { kind: "invalidation", target: Q3, invalidation: inv(Q1) }),
      () => computeVisibility(base),
      () => layoutDepth(base, "s1"),
    ];
    for (const run of commands) {
      run();
      expect(canonicalJson(base)).toBe(snapshot);
    }
    const removed = removeRelation(base, { kind: "invalidation", target: Q3, invalidation: inv(Q1) });
    expect(findQuestion(removed.sessions, Q3).invalidatedBy).toEqual([]);
    expect(findQuestion(base, Q3).invalidatedBy).toEqual([inv(Q1)]);
  });
});
