// Stage R3.3 (task card 2026-10-29 R3 §4.2): the review contract. `ReviewRequest { binding, dod:
// { items }, taskTitle, taskDescription }` is written to the review command's stdin;
// `ReviewVerdict { binding, verdict, items: [{ index, verdict, note }], summary }` is parsed from its
// stdout. `./review-contract` is new in R3.3, so it is loaded from the module namespace.
import { describe, expect, it } from "vitest";

const load = async () => {
  const mod: Record<string, unknown> = await import("./review-contract");
  for (const name of ["ReviewRequest", "ReviewVerdict"]) expect(typeof mod[name], `shared/review-contract exports ${name}`).toBe("object");
  return import("./review-contract");
};

const identity = { headCommit: "a".repeat(40), indexTreeHash: "b".repeat(64), worktreeTreeHash: "c".repeat(64), untrackedHash: "d".repeat(64) };
const binding = { taskId: "t1", planId: "plan-1", planRev: 1, contentHash: "e".repeat(64), runToken: "tok-1", worktree: identity };
const item = (index: number) => ({ index, kind: "criterion" as const, text: `Criterion ${index}` });

describe("R3.3 ReviewRequest and ReviewVerdict", () => {
  it("parse the specified shapes, including an empty DoD", async () => {
    const c = await load();
    const request = { binding, dod: { items: [item(0), { index: 1, kind: "check" as const, text: "npm test", command: "npm test" }] }, taskTitle: "Build", taskDescription: "do" };
    expect(c.ReviewRequest.parse(request)).toEqual(request);
    expect(c.ReviewRequest.safeParse({ ...request, dod: { items: [] } }).success).toBe(true);
    const verdict = { binding, verdict: "pass", items: [{ index: 0, verdict: "pass", note: "ok" }, { index: 1, verdict: "pass", note: "ran" }], summary: "fine" };
    expect(c.ReviewVerdict.parse(verdict)).toEqual(verdict);
    expect(c.ReviewVerdict.safeParse({ ...verdict, verdict: "fail", items: [{ index: 0, verdict: "fail", note: "missing" }] }).success).toBe(true);
    expect(c.ReviewVerdict.safeParse({ ...verdict, items: [] }).success, "an empty item list parses (coverage is the runner's check)").toBe(true);
  });

  it("reject a missing binding, unknown verdict values, a negative or fractional index and missing fields", async () => {
    const c = await load();
    const verdict = { binding, verdict: "pass", items: [{ index: 0, verdict: "pass", note: "ok" }], summary: "fine" };
    const { binding: _b, ...noBinding } = verdict;
    for (const bad of [
      noBinding,
      { ...verdict, verdict: "maybe" },
      { ...verdict, items: [{ index: 0, verdict: "skip", note: "x" }] },
      { ...verdict, items: [{ index: -1, verdict: "pass", note: "x" }] },
      { ...verdict, items: [{ index: 0.5, verdict: "pass", note: "x" }] },
      { ...verdict, items: [{ index: 0, verdict: "pass" }] },
      { binding, verdict: "pass", items: [] },
      { ...verdict, binding: { ...binding, worktree: { headCommit: "x" } } },
    ]) {
      expect(c.ReviewVerdict.safeParse(bad).success, JSON.stringify(bad).slice(0, 90)).toBe(false);
    }
    expect(c.ReviewRequest.safeParse({ binding, dod: { items: [] }, taskTitle: "Build" }).success, "taskDescription is required").toBe(false);
  });
});
