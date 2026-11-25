// Plan rules (Stage 3 P3.2, owner rulings R1/R2): eligibility, basis currency, approval currency
// and task transitions, over pure core graph commands on the branching fixture.
import { describe, expect, it } from "vitest";
import { DomainError } from "../shared/errors";
import { applyAnswer, insertQuestion, skipQuestion, updateDefinition } from "../shared/graph";
import { Ref, type ApprovalReceipt, type Feature, type Plan, type PlanRevision, type RefKey, type Session, type TaskDefinitionV2 } from "../shared/model";
import { basedOnSnapshot, contentHash, contentHashV2, decisionSnapshotHash } from "./plan-hash";
import { approvalBlockers, basisCurrent, currency, eligibility, taskTransition } from "./plan-rules";
import { UI_ORIGIN, type WriteOrigin } from "./sessions";
import { NOW_ISO, act, answered, loadBranching, opt, pick, q, r, session } from "./test-support/build";
import { receipt } from "./test-support/plans";
import { z } from "zod";

const S = ["s1"];
const Q1 = r("s1", "q1");
const Q2 = r("s1", "q2");
const Q3 = r("s1", "q3");
const Q4 = r("s1", "q4");
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent" }, quoted: "go" };

const answer = (s: Session[], ref: Ref, o: string) => applyAnswer(s, ref, pick(o)).sessions;
const answerAll = (steps: Array<[Ref, string]>, base = loadBranching()) => steps.reduce((s, [ref, o]) => answer(s, ref, o), base);
/** q1=a, q3=c, q4=c: q2 (activated by q1∈{b}) is inactive. */
const branchA = () => answerAll([[Q1, "a"], [Q3, "c"], [Q4, "c"]]);
/** q1=b, q2=yes, q3=c, q4=c: all four active and valid. */
const branchB = () => answerAll([[Q1, "b"], [Q2, "yes"], [Q3, "c"], [Q4, "c"]]);

/** A revision drafted from `sessions` the way ruling 2 defines it (independent of plan commands). */
function revisionOf(sessions: Session[], rev = 1): PlanRevision {
  const basedOn = basedOnSnapshot(sessions, S).map(({ value: _v, ...entry }) => entry);
  const dsh = decisionSnapshotHash(sessions, S);
  const body = { markdown: `# Plan rev ${rev}`, tasks: [{ id: "t1", title: "Task", description: "" }], basedOn, decisionSnapshotHash: dsh };
  return { rev, createdAt: NOW_ISO, contentHash: contentHash(body), ...body };
}
const planOf = (revision: PlanRevision): Plan => ({ id: "plan-1", title: "Plan", sessionIds: S, revisions: [revision], approvals: [], taskStates: [], intents: [], tickets: [] });
const receiptFor = (revision: PlanRevision): ApprovalReceipt =>
  receipt({ planId: "plan-1", planRev: revision.rev, contentHash: revision.contentHash, decisionSnapshotHash: revision.decisionSnapshotHash });
const refsOf = (e: DomainError) => z.object({ refs: z.array(Ref) }).parse(e.details).refs;

describe("eligibility", () => {
  it("rejects an active unanswered question with its ref", () => {
    const out = eligibility(answerAll([[Q1, "a"]]), S);
    expect("error" in out).toBe(true);
    if (!("error" in out)) return;
    expect(out.error.code).toBe("plan_ineligible");
    expect(refsOf(out.error)).toEqual(expect.arrayContaining([Q3, Q4]));
    expect(z.object({ reasons: z.array(z.string()) }).parse(out.error.details).reasons.length).toBeGreaterThan(0);
  });

  it("rejects an active stale question and an unknown session", () => {
    const stale = answer(branchA(), Q3, "d"); // q4 (invalidated by q3) becomes stale
    const out = eligibility(stale, S);
    expect("error" in out && out.error.code).toBe("plan_ineligible");
    if ("error" in out) expect(refsOf(out.error)).toContainEqual(Q4);
    const unknown = eligibility(branchA(), ["nope"]);
    expect("error" in unknown && unknown.error.code).toBe("not_found");
  });

  it("R2: an inactive branch question is excluded without error", () => {
    const out = eligibility(branchA(), S);
    expect(out).toEqual({ basis: [Q1, Q3, Q4] });
  });

  it("R1: an active skipped question is eligible and enters basedOn as skipped", () => {
    const skipped = skipQuestion(branchA(), Q4, NOW_ISO).sessions;
    expect(eligibility(skipped, S)).toEqual({ basis: [Q1, Q3, Q4] });
    expect(revisionOf(skipped).basedOn.find((b) => b.questionId === "q4")?.validity).toBe("skipped");
  });
});

describe("basisCurrent and currency", () => {
  it("no receipt → unapproved; a copy without a receipt → unverified; intact basis with receipt → current", () => {
    const s = branchA();
    const rev = revisionOf(s);
    expect(basisCurrent(s, S, rev)).toEqual({ ok: true, reasons: [] });
    expect(currency(s, planOf(rev), null, false).status).toBe("unapproved");
    expect(currency(s, planOf(rev), null, true).status).toBe("unverified");
    expect(currency(s, planOf(rev), receiptFor(rev), false)).toEqual({ status: "current", reasons: [] });
  });

  it("a receipt for other hashes is not_current", () => {
    const s = branchA();
    const rev = revisionOf(s);
    expect(currency(s, planOf(rev), { ...receiptFor(rev), contentHash: "f".repeat(64) }, false).status).toBe("not_current");
  });

  it("a re-answer is not_current with a reason naming the ref and revs", () => {
    const s = branchA();
    const rev = revisionOf(s);
    const later = answer(s, Q3, "d");
    const c = currency(later, planOf(rev), receiptFor(rev), false);
    expect(c.status).toBe("not_current");
    const reason = c.reasons.find((x) => x.includes("s1/q3"));
    expect(reason, c.reasons.join(" | ")).toBeDefined();
    expect(reason, "names the old and new answer revs").toMatch(/1\D+2/);
  });

  it("a stale upstream without a new answer revision, and a definition edit, are not_current", () => {
    const s = branchA();
    const rev = revisionOf(s);
    // q4 goes stale when q3 changes; q4 itself keeps answer rev 1.
    const stale = currency(answer(s, Q3, "d"), planOf(rev), receiptFor(rev), false);
    expect(stale.status).toBe("not_current");
    expect(stale.reasons.some((x) => x.includes("s1/q4")), stale.reasons.join(" | ")).toBe(true);
    const edited = updateDefinition(s, Q3, { title: "Renamed" }, NOW_ISO).sessions;
    const def = currency(edited, planOf(rev), receiptFor(rev), false);
    expect(def.status).toBe("not_current");
    expect(def.reasons.some((x) => x.includes("s1/q3"))).toBe(true);
  });

  it("R2: a basis question deactivating is not_current with \"is no longer active\"", () => {
    const s = branchB();
    const rev = revisionOf(s);
    expect(rev.basedOn.map((b) => b.questionId)).toEqual(["q1", "q2", "q3", "q4"]);
    const c = currency(answer(s, Q1, "a"), planOf(rev), receiptFor(rev), false);
    expect(c.status).toBe("not_current");
    expect(c.reasons.some((x) => x.includes("s1/q2") && x.includes("is no longer active")), c.reasons.join(" | ")).toBe(true);
  });

  it("R2: a hidden-branch edit keeps basisCurrent ok and the snapshot hash", () => {
    const s = branchA();
    const rev = revisionOf(s);
    const hidden = updateDefinition(s, Q2, { title: "Hidden edit" }, NOW_ISO).sessions;
    expect(basisCurrent(hidden, S, rev)).toEqual({ ok: true, reasons: [] });
    expect(decisionSnapshotHash(hidden, S)).toBe(rev.decisionSnapshotHash);
    expect(currency(hidden, planOf(rev), receiptFor(rev), false).status).toBe("current");
  });

  it("R2: a branch change that activates q2 is not_current with \"became active\" and the parent's rev", () => {
    const s = branchA();
    const rev = revisionOf(s);
    const switched = answer(s, Q1, "b");
    const c = currency(switched, planOf(rev), receiptFor(rev), false);
    expect(c.status).toBe("not_current");
    expect(c.reasons.some((x) => x.includes("s1/q2") && x.includes("became active")), c.reasons.join(" | ")).toBe(true);
    expect(c.reasons.some((x) => x.includes("s1/q1"))).toBe(true);
    expect(decisionSnapshotHash(switched, S)).not.toBe(rev.decisionSnapshotHash);
  });

  it("R2: a new unconditional question is not_current; a new question on an unselected option is not", () => {
    const s = branchA();
    const rev = revisionOf(s);
    const draft = { title: "New", context: "", options: [opt("y"), opt("n")], allowFreeText: false, activatedBy: [], invalidatedBy: [] };
    const added = insertQuestion(s, "s1", "q9", draft).sessions;
    const c = currency(added, planOf(rev), receiptFor(rev), false);
    expect(c.status).toBe("not_current");
    expect(c.reasons.some((x) => x.includes("s1/q9") && x.includes("became active")), c.reasons.join(" | ")).toBe(true);
    const hiddenNew = insertQuestion(s, "s1", "q8", { ...draft, activatedBy: [act(Q1, "b")] }).sessions;
    expect(currency(hiddenNew, planOf(rev), receiptFor(rev), false).status).toBe("current");
  });

  it("R1: a skipped basis entry blocks approval even with a matching receipt; answer + new draft restores it", () => {
    const skipped = skipQuestion(branchA(), Q4, NOW_ISO).sessions;
    const rev1 = revisionOf(skipped);
    const blocked = basisCurrent(skipped, S, rev1);
    expect(blocked.ok).toBe(false);
    expect(blocked.reasons.some((x) => /is skipped; answer it/.test(x)), blocked.reasons.join(" | ")).toBe(true);
    expect(currency(skipped, planOf(rev1), receiptFor(rev1), false).status).not.toBe("current");

    const answered = answer(skipped, Q4, "d");
    expect(basisCurrent(answered, S, rev1).ok).toBe(false);
    const rev2 = revisionOf(answered, 2);
    expect(rev2.basedOn.find((b) => b.questionId === "q4")?.validity).toBe("valid");
    expect(basisCurrent(answered, S, rev2)).toEqual({ ok: true, reasons: [] });
  });

  it("a tampered stored contentHash fails basisCurrent", () => {
    const s = branchA();
    const rev = { ...revisionOf(s), contentHash: "0".repeat(64) };
    expect(basisCurrent(s, S, rev).ok).toBe(false);
  });
});

describe("taskTransition", () => {
  const STATUSES = ["todo", "in_progress", "done", "verified"] as const;
  const ALLOWED = new Set(["todo>in_progress", "in_progress>done", "in_progress>todo", "done>verified", "done>in_progress"]);

  it("allows exactly the ruling 7 edges (UI, current, with note)", () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const out = taskTransition(from, to, { origin: UI_ORIGIN, note: "checked", current: true });
        if (ALLOWED.has(`${from}>${to}`)) expect(out, `${from}>${to}`).toBeNull();
        else {
          expect(out, `${from}>${to}`).toBeInstanceOf(DomainError);
          expect(out!.code, `${from}>${to}`).toBe("task_transition");
        }
      }
    }
  });

  it("in_progress needs a current approval", () => {
    for (const from of ["todo", "done"] as const) {
      expect(taskTransition(from, "in_progress", { origin: UI_ORIGIN, current: false })?.code).toBe("plan_not_current");
    }
    expect(taskTransition("in_progress", "done", { origin: UI_ORIGIN, current: false })).toBeNull();
  });

  it("verified needs the UI origin and a non-empty note; chat moves only to in_progress or done", () => {
    expect(taskTransition("done", "verified", { origin: CHAT, note: "checked", current: true })).toBeInstanceOf(DomainError);
    expect(taskTransition("done", "verified", { origin: UI_ORIGIN, current: true })).toBeInstanceOf(DomainError);
    expect(taskTransition("done", "verified", { origin: UI_ORIGIN, note: "", current: true })).toBeInstanceOf(DomainError);
    expect(taskTransition("in_progress", "todo", { origin: CHAT, current: true })).toBeInstanceOf(DomainError);
    expect(taskTransition("todo", "in_progress", { origin: CHAT, current: true })).toBeNull();
    expect(taskTransition("in_progress", "done", { origin: CHAT, current: true })).toBeNull();
  });
});

// Redesign Stage R0.6 (task card §7.2/§7.3): basisCurrent compares the revision hash with the
// function matching its schema (contentHashFor), so a correct v2 revision is not reported as a
// content-hash mismatch, a tampered one is, and legacy revisions behave as today.
describe("basisCurrent with versioned hashes", () => {
  const hashReasons = (reasons: string[]) => reasons.filter((x) => /content hash/i.test(x));
  function v2RevisionOf(sessions: Session[]): PlanRevision {
    const basedOn = basedOnSnapshot(sessions, S).map(({ value: _v, ...entry }) => entry);
    const body = {
      markdown: "# Plan v2",
      tasks: [{ id: "t1", title: "Task", description: "", dependsOn: [], parallel: false, completion: "auto" as const, grill: false, dod: "" }],
      basedOn,
      decisionSnapshotHash: decisionSnapshotHash(sessions, S),
    };
    return { rev: 1, createdAt: NOW_ISO, schema: 2, contentHash: contentHashV2(body), ...body };
  }

  it("a correct schema 2 revision has no content-hash reason and is current on an unchanged basis", () => {
    const sessions = branchB();
    const out = basisCurrent(sessions, S, v2RevisionOf(sessions));
    expect(hashReasons(out.reasons)).toEqual([]);
    expect(out.ok).toBe(true);
  });

  it("a tampered schema 2 revision reports the content-hash mismatch", () => {
    const sessions = branchB();
    const rev = v2RevisionOf(sessions);
    if (!("schema" in rev) || rev.schema !== 2) throw new Error("expected a schema 2 revision");
    rev.tasks[0].dod = "- [check] tampered";
    const out = basisCurrent(sessions, S, rev);
    expect(hashReasons(out.reasons)).toHaveLength(1);
    expect(out.ok).toBe(false);
  });

  it("a legacy revision behaves as today: correct is current, tampered reports the mismatch", () => {
    const sessions = branchB();
    const legacy = revisionOf(sessions);
    expect(basisCurrent(sessions, S, legacy)).toEqual({ ok: true, reasons: [] });
    const tampered = { ...legacy, markdown: `${legacy.markdown} (edited)` };
    expect(hashReasons(basisCurrent(sessions, S, tampered).reasons)).toHaveLength(1);
  });
});

// Stage R1.0 (card §1.4): approvalBlockers is the one list plan.get shows and plan.approve enforces.
// Stage R2.1 (task card 2026-10-29 §2.5): the R1.0 cases keep their scenarios with the R2 context;
// a schema 2 latest revision now gets the real DoD and grilling gates instead of gates_not_available.
describe("R1.0 approvalBlockers", () => {
  const v2Of = (sessions: Session[], rev: number): PlanRevision => {
    const basedOn = basedOnSnapshot(sessions, S).map(({ value: _v, ...entry }) => entry);
    const tasks = [{ id: "t1", title: "Task", description: "", dependsOn: [], parallel: false, completion: "auto" as const, grill: false, dod: "" }];
    const body = { markdown: `# Plan rev ${rev}`, tasks, basedOn, decisionSnapshotHash: decisionSnapshotHash(sessions, S) };
    return { rev, createdAt: NOW_ISO, schema: 2, contentHash: contentHashV2(body), ...body } as PlanRevision;
  };
  const f1: Feature = {
    id: "f1", title: "Feature one", description: "", kind: "feature", status: "created", dependsOn: [], relatedTo: [],
    everStarted: false, createdAt: NOW_ISO, createdBy: { kind: "human" }, coordinatorHistory: [], events: [],
  };
  const ctxOf = (sessions: Session[], features: Feature[] = []) => ({ features, sessions, cancelled: new Set<RefKey>() });

  it("a legacy latest revision has no blockers", () => {
    const s = branchA();
    expect(approvalBlockers(planOf(revisionOf(s)), ctxOf(s))).toEqual([]);
  });

  it("a plan with no revision has no blockers", () => {
    const s = branchA();
    expect(approvalBlockers({ ...planOf(revisionOf(s)), revisions: [] }, ctxOf(s))).toEqual([]);
  });

  it("a bound schema 2 latest revision gets the real gates: missing DoD, then feature and plan grilling without links", () => {
    const s = branchA();
    const blockers = approvalBlockers({ ...planOf(revisionOf(s)), featureId: "f1", revisions: [revisionOf(s), v2Of(s, 2)] }, ctxOf(s, [f1]));
    expect(blockers).toEqual([{ code: "dod_missing", taskId: "t1" }, { code: "grilling_required" }, { code: "grilling_required" }]);
    expect(blockers.map((b) => b.code)).not.toContain("gates_not_available");
  });

  it("only the latest revision counts: a legacy revision after a v2 one is unblocked, and a v2 one after legacy is blocked", () => {
    const s = branchA();
    expect(approvalBlockers({ ...planOf(revisionOf(s)), revisions: [v2Of(s, 1), revisionOf(s, 2)] }, ctxOf(s))).toEqual([]);
    expect(approvalBlockers({ ...planOf(revisionOf(s)), revisions: [revisionOf(s, 1), v2Of(s, 2)] }, ctxOf(s))).toEqual([
      { code: "dod_missing", taskId: "t1" },
      { code: "grilling_required" },
    ]);
  });

  it("is pure: the plan and the context (features and sessions) are not modified", () => {
    const s = branchA();
    const plan: Plan = { ...planOf(revisionOf(s)), featureId: "f1", revisions: [v2Of(s, 1)] };
    const ctx = ctxOf(s, [f1]);
    const before = JSON.stringify(plan);
    const ctxBefore = JSON.stringify({ features: ctx.features, sessions: ctx.sessions });
    approvalBlockers(plan, ctx);
    expect(JSON.stringify(plan)).toBe(before);
    expect(JSON.stringify({ features: ctx.features, sessions: ctx.sessions })).toBe(ctxBefore);
    expect(ctx.cancelled.size).toBe(0);
  });
});

// Stage R1.5 (task card §8.2, §8.4 item 2; owner Q33=1): a cancelled basis decision makes approval
// not current with "<ref> was cancelled"; drafts exclude it; the empty-default context keeps today's
// results. Old revisions are checked with pure basisCurrent (currency covers only the latest).
describe("R1.5 cancellation context", () => {
  const key = (ref: Ref) => `${ref.sessionId}/${ref.questionId}` as const;
  const basisOf = (rev: PlanRevision) => rev.basedOn.map((b) => ({ sessionId: b.sessionId, questionId: b.questionId }));

  it("basisCurrent: a cancelled basedOn ref reports '<ref> was cancelled' and not 'is no longer active'", () => {
    const s = branchA();
    const rev = revisionOf(s);
    const target = basisOf(rev)[0];
    const out = basisCurrent(s, S, rev, new Set([key(target)]));
    expect(out.ok).toBe(false);
    expect(out.reasons).toContain(`${key(target)} was cancelled`);
    expect(out.reasons.some((x) => x.includes(key(target)) && x.includes("no longer active"))).toBe(false);
  });

  it("basisCurrent on an old (non-latest) revision reports the cancellation directly", () => {
    const s = branchA();
    const oldRev = revisionOf(s, 1);
    const target = basisOf(oldRev)[1];
    expect(basisCurrent(s, S, oldRev, new Set([key(target)])).reasons).toContain(`${key(target)} was cancelled`);
  });

  it("currency with a matching receipt and the context is not_current with the reason", () => {
    const s = branchA();
    const rev = revisionOf(s);
    const target = basisOf(rev)[0];
    const c = currency(s, planOf(rev), receiptFor(rev), false, new Set([key(target)]));
    expect(c.status).toBe("not_current");
    expect(c.reasons).toContain(`${key(target)} was cancelled`);
  });

  it("eligibility with the context excludes the ref, and the remaining decided basis is eligible", () => {
    const s = branchA();
    const target = basisOf(revisionOf(s))[0];
    const out = eligibility(s, S, new Set([key(target)]));
    expect("basis" in out).toBe(true);
    if ("basis" in out) expect(out.basis.map(key)).not.toContain(key(target));
  });

  it("controls: a cancellation outside basedOn keeps basisCurrent ok; no or empty context keeps today's results", () => {
    const s = branchA();
    const rev = revisionOf(s);
    expect(basisCurrent(s, S, rev, new Set(["other/x" as const]))).toEqual({ ok: true, reasons: [] });
    expect(basisCurrent(s, S, rev, new Set())).toEqual(basisCurrent(s, S, rev));
    expect(currency(s, planOf(rev), receiptFor(rev), false, new Set())).toEqual({ status: "current", reasons: [] });
    expect(eligibility(s, S, new Set())).toEqual(eligibility(s, S));
  });

  it("controls: an unanswered remaining active question is still plan_ineligible; an empty basis after exclusion is 'no active questions'", () => {
    const partial = answerAll([[Q1, "a"]]);
    const out = eligibility(partial, S, new Set([key(Q1)]));
    expect("error" in out && out.error.code).toBe("plan_ineligible");
    const s = branchA();
    const all = new Set(activeBasisOf(s).map(key));
    const empty = eligibility(s, S, all);
    expect("error" in empty && empty.error.code).toBe("plan_ineligible");
    if ("error" in empty) expect(empty.error.message).toMatch(/no active questions/);
  });
  const activeBasisOf = (s: Session[]) => basedOnSnapshot(s, S).map((e) => ({ sessionId: e.sessionId, questionId: e.questionId }));
});

// Stage R2.1 (task card 2026-10-29 §1.2, §2.4; labelled default G1/Q34): a grilling session is
// complete iff it exists, has at least one active non-cancelled question over the full graph, and
// every such question is valid. grillingComplete is new in R2.1, so it is loaded from the module
// namespace: a missing export fails its own check instead of breaking collection.
const grillingCompleteFn = async () => {
  const rules = await import("./plan-rules");
  expect(typeof rules.grillingComplete, "plan-rules exports grillingComplete").toBe("function");
  return rules.grillingComplete;
};
const OA = [opt("a"), opt("b")];
/** A session whose questions are all answered "a" (valid). */
const doneSession = (id: string, n = 1) => session(id, Array.from({ length: n }, (_, i) => answered(q(`${id}q${i + 1}`, { options: OA }), "a")));
/** A session with one unanswered question. */
const openSession = (id: string) => session(id, [q(`${id}q1`, { options: OA })]);
const validities = (sessions: Session[], id: string) => basedOnSnapshot(sessions, [id]).map((e) => `${e.questionId}:${e.validity}`);

describe("R2.1 grillingComplete", () => {
  it("an undefined id, an unknown id and an empty session are not complete", async () => {
    const complete = await grillingCompleteFn();
    const sessions = [doneSession("g"), session("empty", [])];
    expect(complete(sessions, undefined)).toBe(false);
    expect(complete(sessions, "missing")).toBe(false);
    expect(complete(sessions, "empty")).toBe(false);
    expect(complete(sessions, "g"), "control: a fully answered session is complete").toBe(true);
  });

  it("one valid question is complete; several valid questions are complete; the cancelled default is empty", async () => {
    const complete = await grillingCompleteFn();
    expect(complete([doneSession("g")], "g", new Set())).toBe(true);
    expect(complete([doneSession("g", 3)], "g")).toBe(true);
    expect(complete(branchB(), "s1"), "branch B: all four s1 questions active and valid").toBe(true);
  });

  it("one unanswered question makes it incomplete", async () => {
    const mixed = session("g", [answered(q("g1", { options: OA }), "a"), q("g2", { options: OA })]);
    expect(validities([mixed], "g")).toEqual(["g1:valid", "g2:unanswered"]);
    const complete = await grillingCompleteFn();
    expect(complete([openSession("g")], "g")).toBe(false);
    expect(complete([mixed], "g")).toBe(false);
  });

  it("a skipped question makes it incomplete (skipped is not complete)", async () => {
    const skipped = skipQuestion(branchB(), Q4, NOW_ISO).sessions;
    expect(validities(skipped, "s1")).toEqual(["q1:valid", "q2:valid", "q3:valid", "q4:skipped"]);
    const complete = await grillingCompleteFn();
    expect(complete(skipped, "s1")).toBe(false);
  });

  it("a stale question makes it incomplete", async () => {
    const stale = answer(answer(branchB(), Q1, "a"), Q1, "b");
    const v = validities(stale, "s1");
    expect(v.some((x) => x.endsWith(":stale")), v.join(",")).toBe(true);
    expect(v.every((x) => x.endsWith(":valid") || x.endsWith(":stale")), v.join(",")).toBe(true);
    const complete = await grillingCompleteFn();
    expect(complete(stale, "s1")).toBe(false);
  });

  it("cancelled questions are ignored; a session whose only question is cancelled is not complete", async () => {
    const complete = await grillingCompleteFn();
    const only = doneSession("c");
    expect(complete([only], "c"), "control: not cancelled").toBe(true);
    expect(complete([only], "c", new Set<RefKey>(["c/cq1"]))).toBe(false);
    const withOpen = session("g", [answered(q("g1", { options: OA }), "a"), q("g2", { options: OA })]);
    expect(complete([withOpen], "g")).toBe(false);
    expect(complete([withOpen], "g", new Set<RefKey>(["g/g2"])), "the cancelled unanswered question is ignored").toBe(true);
    expect(complete([withOpen], "g", new Set<RefKey>(["g/g1"])), "cancelling the valid one leaves the open one").toBe(false);
  });

  it("full graph: a grilling question activated by an answer in another session is required while active and ignored once deactivated", async () => {
    const grill = session("g", [answered(q("g1", { options: OA }), "a"), q("g2", { options: [opt("yes"), opt("no")], activatedBy: [act(Q2, "yes")] })]);
    const active = [...branchB(), grill];
    expect(validities(active, "g")).toEqual(["g1:valid", "g2:unanswered"]);
    expect(validities(answer(active, Q2, "no"), "g"), "precondition: s1/q2 = no deactivates g2").toEqual(["g1:valid"]);
    const complete = await grillingCompleteFn();
    expect(complete(active, "g"), "g2 is active (s1/q2 = yes) and unanswered").toBe(false);
    expect(complete([grill], "g"), "without the other session g2 has no active parent").toBe(true);
    const answeredG2 = answer(active, r("g", "g2"), "no");
    expect(complete(answeredG2, "g"), "g2 answered while active").toBe(true);
    const deactivated = answer(active, Q2, "no");
    expect(validities(deactivated, "g")).toEqual(["g1:valid"]);
    expect(complete(deactivated, "g"), "s1/q2 = no deactivates g2, which is then ignored").toBe(true);
    const reactivated = answer(deactivated, Q2, "yes");
    expect(complete(reactivated, "g"), "re-activation makes g2 required again").toBe(false);
  });

  it("is pure: sessions and the cancelled set are not modified", async () => {
    const complete = await grillingCompleteFn();
    const sessions = [...branchB(), doneSession("g")];
    const cancelled = new Set<RefKey>(["g/gq1"]);
    const before = JSON.stringify(sessions);
    complete(sessions, "g", cancelled);
    expect(JSON.stringify(sessions)).toBe(before);
    expect([...cancelled]).toEqual(["g/gq1"]);
  });
});

// Stage R2.1 (task card 2026-10-29 §2.2, §2.4): approvalBlockers over the plan and its context.
describe("R2.1 approvalBlockers gates", () => {
  const feature = (partial: Partial<Feature> = {}): Feature => ({
    id: "f1", title: "Feature one", description: "", kind: "feature", status: "created", dependsOn: [], relatedTo: [],
    everStarted: false, createdAt: NOW_ISO, createdBy: { kind: "human" }, coordinatorHistory: [], events: [], ...partial,
  });
  const task = (id: string, partial: Partial<TaskDefinitionV2> = {}): TaskDefinitionV2 => ({
    id, title: `Task ${id}`, description: "", dependsOn: [], parallel: false, completion: "auto", grill: false, dod: "- [check] npm test", ...partial,
  });
  const v2 = (sessions: Session[], tasks: TaskDefinitionV2[], rev = 1): PlanRevision => {
    const basedOn = basedOnSnapshot(sessions, S).map(({ value: _v, ...entry }) => entry);
    const body = { markdown: `# Plan rev ${rev}`, tasks, basedOn, decisionSnapshotHash: decisionSnapshotHash(sessions, S) };
    return { rev, createdAt: NOW_ISO, schema: 2, contentHash: contentHashV2(body), ...body };
  };
  const plan = (revisions: PlanRevision[], partial: Partial<Plan> = {}): Plan => ({ ...planOf(revisions[0] ?? revisionOf(branchB())), revisions, ...partial });
  /** Every link points at a complete session: fg (feature), pg (plan), tg (task t2). */
  const complete = () => [...branchB(), doneSession("fg"), doneSession("pg"), doneSession("tg")];
  const ctx = (sessions: Session[], features: Feature[] = [feature({ grillSessionId: "fg" })], cancelled: ReadonlySet<RefKey> = new Set()) => ({ features, sessions, cancelled });
  const satisfied = (sessions: Session[]) =>
    plan([v2(sessions, [task("t1"), task("t2", { grill: true, grillSessionId: "tg" })])], { featureId: "f1", grillSessionId: "pg" });

  it("every gate satisfied: a bound schema 2 revision has no blockers", () => {
    const s = complete();
    expect(approvalBlockers(satisfied(s), ctx(s))).toEqual([]);
  });

  it("each blocker alone", () => {
    const s = complete();
    const base = satisfied(s);
    const latest = (tasks: TaskDefinitionV2[]) => plan([v2(s, tasks)], { featureId: "f1", grillSessionId: "pg" });
    // DoD: empty and whitespace-only are missing.
    expect(approvalBlockers(latest([task("t1", { dod: " \n\t " }), task("t2", { grill: true, grillSessionId: "tg" })]), ctx(s))).toEqual([{ code: "dod_missing", taskId: "t1" }]);
    expect(approvalBlockers(latest([task("t1"), task("t2", { grill: true, grillSessionId: "tg", dod: "" })]), ctx(s))).toEqual([{ code: "dod_missing", taskId: "t2" }]);
    // Feature grilling: linked but incomplete carries the sessionId; unlinked has none.
    const withOpen = [...s, openSession("fo")];
    expect(approvalBlockers(base, ctx(withOpen, [feature({ grillSessionId: "fo" })]))).toEqual([{ code: "grilling_required", sessionId: "fo" }]);
    expect(approvalBlockers(base, ctx(s, [feature()]))).toEqual([{ code: "grilling_required" }]);
    // Plan grilling.
    expect(approvalBlockers({ ...base, grillSessionId: undefined }, ctx(s))).toEqual([{ code: "grilling_required" }]);
    expect(approvalBlockers({ ...base, grillSessionId: "gone" }, ctx(s)), "a link to a missing session keeps its sessionId").toEqual([{ code: "grilling_required", sessionId: "gone" }]);
    // Task grilling, only for grill: true tasks.
    expect(approvalBlockers(latest([task("t1"), task("t2", { grill: true })]), ctx(s))).toEqual([{ code: "grilling_required", taskId: "t2" }]);
    expect(approvalBlockers(latest([task("t1"), task("t2", { grill: true, grillSessionId: "fo" })]), ctx(withOpen))).toEqual([{ code: "grilling_required", taskId: "t2", sessionId: "fo" }]);
    expect(approvalBlockers(latest([task("t1"), task("t2", { grill: false, grillSessionId: "fo" })]), ctx(withOpen)), "grill: false needs no session").toEqual([]);
  });

  it("all blockers together in the stated order: DoD per task, feature, plan, then grill tasks in task order", () => {
    const s = [...branchB(), openSession("fo"), openSession("po"), openSession("to")];
    const p = plan(
      [v2(s, [task("t1", { dod: "" }), task("t2", { grill: true, grillSessionId: "to", dod: "  " }), task("t3", { grill: true }), task("t4", { dod: "" })])],
      { featureId: "f1", grillSessionId: "po" },
    );
    expect(approvalBlockers(p, ctx(s, [feature({ grillSessionId: "fo" })]))).toEqual([
      { code: "dod_missing", taskId: "t1" },
      { code: "dod_missing", taskId: "t2" },
      { code: "dod_missing", taskId: "t4" },
      { code: "grilling_required", sessionId: "fo" },
      { code: "grilling_required", sessionId: "po" },
      { code: "grilling_required", taskId: "t2", sessionId: "to" },
      { code: "grilling_required", taskId: "t3" },
    ]);
  });

  it("a bug feature needs no feature grilling session; plan and task gates still apply", () => {
    const s = branchB();
    const p = plan([v2(s, [task("t1", { dod: "" }), task("t2", { grill: true })])], { featureId: "f1" });
    expect(approvalBlockers(p, ctx(s, [feature({ kind: "bug" })]))).toEqual([
      { code: "dod_missing", taskId: "t1" },
      { code: "grilling_required" },
      { code: "grilling_required", taskId: "t2" },
    ]);
    expect(approvalBlockers(p, ctx(s, [feature()])), "control: kind feature adds the feature gate").toEqual([
      { code: "dod_missing", taskId: "t1" },
      { code: "grilling_required" },
      { code: "grilling_required" },
      { code: "grilling_required", taskId: "t2" },
    ]);
  });

  it("an unbound schema 2 plan gets the DoD, plan and task gates but no feature gate", () => {
    const s = complete();
    const p = plan([v2(s, [task("t1", { dod: "" }), task("t2", { grill: true })])]);
    expect(approvalBlockers(p, ctx(s, []))).toEqual([{ code: "dod_missing", taskId: "t1" }, { code: "grilling_required" }, { code: "grilling_required", taskId: "t2" }]);
    expect(approvalBlockers(plan([v2(s, [task("t1")])], { grillSessionId: "pg" }), ctx(s, [])), "unbound with plan grilling complete").toEqual([]);
  });

  it("cancellation in the context reaches the gates: a linked session whose only question is cancelled blocks", () => {
    const s = complete();
    expect(approvalBlockers(satisfied(s), ctx(s, undefined, new Set<RefKey>(["pg/pgq1"])))).toEqual([{ code: "grilling_required", sessionId: "pg" }]);
  });

  it("legacy: an unbound legacy latest revision has no blockers even with an empty-description task; a bound legacy latest is legacy_revision", () => {
    const s = branchB();
    const legacy = revisionOf(s);
    expect(legacy.tasks[0]?.description).toBe("");
    expect(approvalBlockers(plan([legacy]), ctx(s, []))).toEqual([]);
    expect(approvalBlockers(plan([v2(s, [task("t1", { dod: "" })]), revisionOf(s, 2)]), ctx(s, []))).toEqual([]);
    expect(approvalBlockers(plan([legacy], { featureId: "f1" }), ctx(s))).toEqual([{ code: "legacy_revision" }]);
  });

  it("a bound plan whose feature record is missing is not_found with the featureId", () => {
    const s = complete();
    let caught: unknown;
    try {
      approvalBlockers(satisfied(s), ctx(s, []));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught).toMatchObject({ code: "not_found", details: { featureId: "f1" } });
  });

  it("never produces gates_not_available", () => {
    const s = branchB();
    for (const p of [plan([v2(s, [task("t1")])], { featureId: "f1" }), plan([v2(s, [task("t1", { dod: "" })])])]) {
      expect(approvalBlockers(p, ctx(s)).map((b) => b.code)).not.toContain("gates_not_available");
    }
  });
});

// Stage R2.3 (task card 2026-10-29 §4.2): a superseded latest revision is not current before any
// receipt check; any task move to or from cancelled is task_transition. The pure transition
// rejections already hold at R2.2 (cancelled is not in the edge set), so they are controls; the
// rework currency rule is new.
describe("R2.3 rework currency and cancelled transitions", () => {
  const reworked = (plan: Plan, planRev: number): Plan => ({
    ...plan,
    reworks: [{ planRev, at: NOW_ISO, reason: "Scope changed", actor: { kind: "human" } }],
  });

  it("a superseded latest revision is not_current with the rework reason, before receipt checks", () => {
    const s = branchB();
    const rev = revisionOf(s);
    const plan = planOf(rev);
    expect(currency(s, plan, receiptFor(rev), false), "control: current without a rework").toEqual({ status: "current", reasons: [] });
    const sent = { status: "not_current", reasons: ["revision 1 was sent for rework"] };
    expect(currency(s, reworked(plan, 1), receiptFor(rev), false)).toEqual(sent);
    expect(currency(s, reworked(plan, 1), null, false), "before the receipt check").toEqual(sent);
    expect(currency(s, reworked(plan, 1), null, true), "before the copy-only check").toEqual(sent);
  });

  it("a rework of an older revision does not supersede a newer latest revision", () => {
    const s = branchB();
    const rev1 = revisionOf(s, 1);
    const rev2 = revisionOf(s, 2);
    const plan: Plan = { ...planOf(rev1), revisions: [rev1, rev2] };
    expect(currency(s, reworked(plan, 1), receiptFor(rev2), false)).toEqual({ status: "current", reasons: [] });
    expect(currency(s, reworked(plan, 1), null, false)).toEqual({ status: "unapproved", reasons: [] });
  });

  it("is pure: the plan and its reworks are not modified", () => {
    const s = branchB();
    const rev = revisionOf(s);
    const plan = reworked(planOf(rev), 1);
    const before = JSON.stringify(plan);
    currency(s, plan, receiptFor(rev), false);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("control: every move to or from cancelled is task_transition, whatever the context", () => {
    const others = ["todo", "in_progress", "done", "verified"] as const;
    for (const current of [true, false]) {
      for (const other of others) {
        expect(taskTransition("cancelled", other, { origin: UI_ORIGIN, note: "n", current })?.code, `cancelled>${other}`).toBe("task_transition");
        expect(taskTransition(other, "cancelled", { origin: UI_ORIGIN, note: "n", current })?.code, `${other}>cancelled`).toBe("task_transition");
      }
      expect(taskTransition("cancelled", "cancelled", { origin: UI_ORIGIN, current })?.code).toBe("task_transition");
    }
  });
});
