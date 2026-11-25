// Persistent question numbers: the effective number is the stored `number`, else `order + 1`. New
// numbers are allocated past every effective number of the session, backfill stores only missing
// numbers, and the write guard rejects any generation that changes an effective number, deletes a
// session or question, or repeats a number within a session (stored and derived values mixed).
import { describe, expect, it } from "vitest";
import type { Question, RoadmapData, Session } from "./model";
import { assertNumbersStable, backfillNumbers, nextNumber, questionNumber } from "./numbering";
import { NOW_ISO, q } from "../server/test-support/build";
import { throwsCode } from "../server/test-support/expect-error";

/** A question at `order`, with a stored number only when one is given. */
const nq = (id: string, order: number, number?: number): Question => q(id, { order, ...(number !== undefined ? { number } : {}) });

const sess = (id: string, questions: Question[]): Session => ({ id, title: `Session ${id}`, createdAt: NOW_ISO, status: "active", questions });

function data(...sessions: Session[]): RoadmapData {
  return {
    meta: {
      version: 2,
      projectId: "prj_test",
      createdAt: NOW_ISO,
      links: [],
      sessionIds: sessions.map((s) => s.id),
      planIds: [],
      featureIds: [],
      runIds: [],
      settings: {},
    },
    sessions,
    plans: [],
    features: [],
    runs: [],
    delegations: [],
  };
}

describe("questionNumber", () => {
  it("is the stored number when present, else order + 1", () => {
    expect(questionNumber({ order: 0 })).toBe(1);
    expect(questionNumber({ order: 4 })).toBe(5);
    expect(questionNumber({ order: 4, number: 9 })).toBe(9);
    // A stored number wins even when it disagrees with the order it was created at.
    expect(questionNumber({ order: 0, number: 3 })).toBe(3);
  });
});

describe("nextNumber", () => {
  it("starts at 1 in an empty session", () => {
    expect(nextNumber(sess("s", []))).toBe(1);
  });

  it("is max(effective number) + 1 over stored and derived numbers", () => {
    expect(nextNumber(sess("s", [nq("a", 0), nq("b", 1)]))).toBe(3);
    expect(nextNumber(sess("s", [nq("a", 0), nq("b", 1, 7)]))).toBe(8);
    // A derived number above every stored one still counts.
    expect(nextNumber(sess("s", [nq("a", 0, 1), nq("b", 5)]))).toBe(7);
  });

  it("never fills a gap: numbers are not reused", () => {
    expect(nextNumber(sess("s", [nq("a", 0, 1), nq("b", 1, 5)]))).toBe(6);
  });
});

describe("backfillNumbers", () => {
  it("stores order + 1 on every unnumbered question and reports a change", () => {
    const s = sess("s", [nq("a", 0), nq("b", 1), nq("c", 2)]);
    expect(backfillNumbers(s)).toBe(true);
    expect(s.questions.map((x) => x.number)).toEqual([1, 2, 3]);
  });

  it("keeps existing stored numbers in a mixed session, even when they differ from order + 1", () => {
    const s = sess("s", [nq("a", 0), nq("b", 1, 9), nq("c", 2)]);
    expect(backfillNumbers(s)).toBe(true);
    expect(s.questions.map((x) => x.number)).toEqual([1, 9, 3]);
  });

  it("is idempotent and reports no change when every question is numbered", () => {
    const s = sess("s", [nq("a", 0, 1), nq("b", 1, 2)]);
    const before = JSON.stringify(s);
    expect(backfillNumbers(s)).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
    expect(backfillNumbers(sess("empty", []))).toBe(false);
  });

  it("never changes an effective number", () => {
    const s = sess("s", [nq("a", 0), nq("b", 1, 7), nq("c", 2)]);
    const effective = s.questions.map(questionNumber);
    backfillNumbers(s);
    expect(s.questions.map(questionNumber)).toEqual(effective);
  });
});

describe("assertNumbersStable", () => {
  // Mixed previous generation: a1 stored 1, a2 derived 2, a3 stored 7.
  const before = () => data(sess("s", [nq("a1", 0, 1), nq("a2", 1), nq("a3", 2, 7)]), sess("t", [nq("t1", 0)]));

  it("accepts an unchanged generation and the initial write", () => {
    expect(() => assertNumbersStable(before(), before())).not.toThrow();
    expect(() => assertNumbersStable(null, before())).not.toThrow();
  });

  it("accepts a backfill that stores exactly the previously derived numbers", () => {
    const after = data(sess("s", [nq("a1", 0, 1), nq("a2", 1, 2), nq("a3", 2, 7)]), sess("t", [nq("t1", 0, 1)]));
    expect(() => assertNumbersStable(before(), after)).not.toThrow();
  });

  it("accepts a new question with a fresh number and a new session", () => {
    const after = data(
      sess("s", [nq("a1", 0, 1), nq("a2", 1, 2), nq("a3", 2, 7), nq("a4", 3, 8)]),
      sess("t", [nq("t1", 0, 1)]),
      sess("u", [nq("u1", 0, 1)]),
    );
    expect(() => assertNumbersStable(before(), after)).not.toThrow();
  });

  it("matches questions by id, not by array position", () => {
    const after = data(sess("s", [nq("a3", 2, 7), nq("a1", 0, 1), nq("a2", 1, 2)]), sess("t", [nq("t1", 0, 1)]));
    expect(() => assertNumbersStable(before(), after)).not.toThrow();
  });

  it("rejects a backfill that stores a different value than the exposed derived number", () => {
    const after = data(sess("s", [nq("a1", 0, 1), nq("a2", 1, 3), nq("a3", 2, 7)]), sess("t", [nq("t1", 0)]));
    const e = throwsCode(() => assertNumbersStable(before(), after), "internal");
    expect(e.message).toMatch(/question number changed/);
  });

  it("rejects a change of a stored number", () => {
    const after = data(sess("s", [nq("a1", 0, 4), nq("a2", 1), nq("a3", 2, 7)]), sess("t", [nq("t1", 0)]));
    const e = throwsCode(() => assertNumbersStable(before(), after), "internal");
    expect(e.message).toMatch(/question number changed/);
  });

  it("rejects dropping a stored number whose order + 1 differs (the effective number would change)", () => {
    const after = data(sess("s", [nq("a1", 0, 1), nq("a2", 1), nq("a3", 2)]), sess("t", [nq("t1", 0)]));
    const e = throwsCode(() => assertNumbersStable(before(), after), "internal");
    expect(e.message).toMatch(/question number changed/);
  });

  it("rejects a write that deletes a question, numbered or not", () => {
    const withoutStored = data(sess("s", [nq("a2", 1), nq("a3", 2, 7)]), sess("t", [nq("t1", 0)]));
    expect(throwsCode(() => assertNumbersStable(before(), withoutStored), "internal").message).toMatch(/deleted|missing/i);
    const withoutDerived = data(sess("s", [nq("a1", 0, 1), nq("a3", 2, 7)]), sess("t", [nq("t1", 0)]));
    expect(throwsCode(() => assertNumbersStable(before(), withoutDerived), "internal").message).toMatch(/deleted|missing/i);
  });

  it("rejects a write that deletes a session", () => {
    const after = data(sess("s", [nq("a1", 0, 1), nq("a2", 1), nq("a3", 2, 7)]));
    expect(throwsCode(() => assertNumbersStable(before(), after), "internal").message).toMatch(/deleted|missing/i);
  });

  it("rejects repeated effective numbers within a session, across stored and derived values", () => {
    // A new question stored as 2 collides with a2's derived 2.
    const derivedClash = data(sess("s", [nq("a1", 0, 1), nq("a2", 1), nq("a3", 2, 7), nq("a4", 3, 2)]), sess("t", [nq("t1", 0)]));
    expect(throwsCode(() => assertNumbersStable(before(), derivedClash), "internal").message).toMatch(/duplicate|unique/i);
    const storedClash = data(sess("s", [nq("a1", 0, 1), nq("a2", 1), nq("a3", 2, 7), nq("a4", 3, 7)]), sess("t", [nq("t1", 0)]));
    expect(throwsCode(() => assertNumbersStable(before(), storedClash), "internal").message).toMatch(/duplicate|unique/i);
  });

  it("rejects duplicates even on the initial write and in a newly added session", () => {
    expect(throwsCode(() => assertNumbersStable(null, data(sess("s", [nq("a", 0, 1), nq("b", 1, 1)]))), "internal").message).toMatch(
      /duplicate|unique/i,
    );
    const after = data(sess("s", [nq("a1", 0, 1), nq("a2", 1), nq("a3", 2, 7)]), sess("t", [nq("t1", 0)]), sess("u", [nq("u1", 0), nq("u2", 1, 1)]));
    expect(throwsCode(() => assertNumbersStable(before(), after), "internal").message).toMatch(/duplicate|unique/i);
  });

  it("allows the same number in different sessions", () => {
    const after = data(sess("s", [nq("a1", 0, 1), nq("a2", 1, 2), nq("a3", 2, 7)]), sess("t", [nq("t1", 0, 1)]), sess("u", [nq("u1", 0, 7)]));
    expect(() => assertNumbersStable(before(), after)).not.toThrow();
  });
});
