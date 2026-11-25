import { describe, expect, it } from "vitest";
import { applyAnswer } from "../shared/graph";
import type { Link, RoadmapData, Ref, Session } from "../shared/model";
import { Overview, SessionView } from "../shared/rpc";
import { NOW_ISO, loadBranching, pick, r, session } from "./test-support/build";
import { throwsCode } from "./test-support/expect-error";
import { buildOverview, buildSessionView } from "./views";

const link = (id: string, from: Link["from"], to: Link["to"]): Link => ({ id, kind: "informs", from, to });
const L1 = link("l1", r("s1", "q1"), { sessionId: "s2" });
const L2 = link("l2", { sessionId: "s2" }, { sessionId: "s3" });

function data(sessions: Session[] = loadBranching()): RoadmapData {
  const all = [...sessions, session("s3", [])];
  return {
    meta: { version: 2, projectId: "prj_test", createdAt: NOW_ISO, links: [L1, L2], sessionIds: all.map((s) => s.id), planIds: [], featureIds: [], runIds: [], settings: {} },
    sessions: all,
    plans: [],
    features: [],
    runs: [],
    delegations: [],
  };
}
const answerAll = (steps: Array<[Ref, string]>) =>
  steps.reduce((s, [ref, o]) => applyAnswer(s, ref, pick(o)).sessions, loadBranching());
const byId = (view: ReturnType<typeof buildSessionView>) => Object.fromEntries(view.questions.map((qv) => [qv.question.id, qv]));

describe("buildSessionView", () => {
  it("reports longest-path depths and computed statuses, keeping stale cause data", () => {
    const fresh = SessionView.parse(buildSessionView(data(), 2, "s1"));
    expect(fresh.revision).toBe(2);
    expect(Object.fromEntries(fresh.questions.map((qv) => [qv.question.id, qv.depth]))).toEqual({ q1: 0, q2: 1, q3: 1, q4: 2 });
    expect(fresh.questions.map((qv) => qv.question.id)).toEqual(["q1", "q2", "q3", "q4"]);
    expect(byId(fresh).q2).toMatchObject({ status: "inactive", visibility: "inactive" });

    expect(byId(buildSessionView(data(answerAll([[r("s1", "q1"), "b"]])), 3, "s1")).q2).toMatchObject({
      status: "open",
      visibility: "active",
    });

    const stale = byId(buildSessionView(data(answerAll([[r("s1", "q1"), "a"], [r("s1", "q3"), "c"], [r("s1", "q1"), "b"]])), 5, "s1"));
    expect(stale.q3.status).toBe("stale");
    expect(stale.q3.question.stale).toMatchObject({ causeSessionId: "s1", causeQuestionId: "q1", causeRev: 2 });
  });

  it("lists a catalog of questions from every session with session titles", () => {
    const view = buildSessionView(data(), 1, "s1");
    expect(view.catalog.map((c) => [c.ref.sessionId, c.ref.questionId, c.sessionTitle])).toEqual([
      ["s1", "q1", "Synthetic branching session"],
      ["s1", "q2", "Synthetic branching session"],
      ["s1", "q3", "Synthetic branching session"],
      ["s1", "q4", "Synthetic branching session"],
      ["s2", "x1", "Synthetic dependent session"],
    ]);
    expect(view.catalog.find((c) => c.ref.questionId === "q2")).toMatchObject({ questionTitle: "Branch B follow-up", status: "inactive" });
  });

  it("includes only links touching the session", () => {
    expect(buildSessionView(data(), 1, "s1").links).toEqual([L1]);
    expect(buildSessionView(data(), 1, "s2").links).toEqual([L1, L2]);
  });

  it("throws not_found for an unknown session", () => {
    throwsCode(() => buildSessionView(data(), 1, "s9"), "not_found");
  });
});

describe("buildOverview", () => {
  it("counts by status with inactive taking precedence over stale, and reflects disabled", () => {
    // x1 answered while active, then q1 flips: x1 is inactive *and* stale.
    const sessions = answerAll([[r("s1", "q1"), "b"], [r("s1", "q2"), "yes"], [r("s2", "x1"), "y"], [r("s1", "q1"), "a"]]);
    const overview = Overview.parse(buildOverview(data(sessions), 6, true));
    expect(overview.revision).toBe(6);
    expect(overview.disabled).toBe(true);
    expect(overview.links).toEqual([L1, L2]);
    const counts = Object.fromEntries(overview.sessions.map((s) => [s.id, s.counts]));
    expect(counts.s1).toEqual({ open: 2, answered: 1, stale: 0, skipped: 0, inactive: 1, out_of_scope: 0 });
    expect(counts.s2).toEqual({ open: 0, answered: 0, stale: 0, skipped: 0, inactive: 1, out_of_scope: 0 });
    expect(counts.s3).toEqual({ open: 0, answered: 0, stale: 0, skipped: 0, inactive: 0, out_of_scope: 0 });
    expect(overview.sessions.map((s) => [s.id, s.title, s.status])).toEqual([
      ["s1", "Synthetic branching session", "active"],
      ["s2", "Synthetic dependent session", "active"],
      ["s3", "Session s3", "active"],
    ]);
    expect(buildOverview(data(), 1, false).disabled).toBe(false);
  });
});

// Stage R1.3a (task card §4.1.2): the session view carries that session's cancellation records only.
describe("R1.3a buildSessionView cancellations", () => {
  const rec = (id: string, ref: Ref) => ({ id, ref, reason: `Reason ${id}`, at: NOW_ISO, actor: { kind: "human" as const } });
  const withCancellations = (records: RoadmapData["meta"]["cancellations"]): RoadmapData => {
    const d = data();
    return { ...d, meta: { ...d.meta, cancellations: records } };
  };

  it("includes only the session's records, in stored order, and an empty list when none", () => {
    const records = [rec("c1", r("s1", "q2")), rec("c2", r("s2", "x1")), rec("c3", r("s1", "q1"))];
    const view = buildSessionView(withCancellations(records), 4, "s1");
    // Each record also lists its dependents for review (checked in block-summaries.test.ts).
    expect(view.cancellations).toMatchObject([records[0], records[2]]);
    expect((buildSessionView(withCancellations(records), 4, "s3")).cancellations).toEqual([]);
    expect((buildSessionView(data(), 4, "s1")).cancellations).toEqual([]);
    expect(SessionView.parse(buildSessionView(withCancellations(records), 4, "s1"))).toMatchObject({ cancellations: [records[0], records[2]] });
  });

  it("does not change the questions of the view (control: same questions with and without records)", () => {
    const records = [rec("c1", r("s1", "q2"))];
    expect(buildSessionView(withCancellations(records), 4, "s1").questions).toEqual(buildSessionView(data(), 4, "s1").questions);
  });
});
