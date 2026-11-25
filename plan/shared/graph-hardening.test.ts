import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeStoreFs } from "../server/fs-port";
import { openStore } from "../server/store";
import { act, fixedClock, inv, loadBranching, nextId, opt, pick, q, r, session } from "../server/test-support/build";
import { throwsCode } from "../server/test-support/expect-error";
import { faultFs } from "../server/test-support/fault-fs";
import { emptyData, writeSnapshot } from "../server/test-support/snapshot";
import { canonicalJson } from "./canonical";
import {
  applyAnswer,
  computeVisibility,
  findQuestion,
  insertQuestion,
  invalidationClosure,
  layoutDepth,
  skipQuestion,
  validateGraph,
  type QuestionDraft,
} from "./graph";
import { refKey, type Question, type Ref, type Session } from "./model";

const NOW_ISO = fixedClock().toISOString();
const sortRefs = (refs: Ref[]) => [...refs].sort((a, b) => refKey(a).localeCompare(refKey(b)));
const depths = (s: Session[], id: string) => Object.fromEntries(layoutDepth(s, id));
const yesNo = [opt("yes"), opt("no")];
/** Raw session without schema parsing, for graphs the builders would refuse. */
const raw = (id: string, questions: Question[]): Session => ({
  id,
  title: `Session ${id}`,
  createdAt: NOW_ISO,
  status: "active",
  questions: questions.map((x, i) => ({ ...x, order: i })),
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function newRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dr-hard-")));
  roots.push(root);
  return root;
}

describe("unique ids", () => {
  it("two sessions with the same id are rejected with duplicate: session", () => {
    const e = throwsCode(() => validateGraph([raw("s1", [q("a")]), raw("s1", [q("b")])]), "invalid_input");
    expect(e.details).toMatchObject({ duplicate: "session", id: "s1" });
  });

  it("a question id twice in one session is rejected; the same id in two sessions is valid", () => {
    const e = throwsCode(() => validateGraph([raw("s1", [q("a"), q("a")])]), "invalid_input");
    expect(e.details).toMatchObject({ duplicate: "question", id: "a", sessionId: "s1" });
    expect(() => validateGraph([raw("s1", [q("a")]), raw("s2", [q("a")])])).not.toThrow();
  });

  it("a hand-written generation with duplicate question ids reads as invalid (control: unique ids read ok)", async () => {
    const control = await newRoot();
    await writeSnapshot(control, emptyData("prj_test", [raw("s1", [q("a"), q("b")])]), 1);
    expect((await openStore({ storeRoot: control, projectId: "prj_test" }).read()).status).toBe("ok");

    const root = await newRoot();
    await writeSnapshot(root, emptyData("prj_test", [raw("s1", [q("a"), q("a")])]), 1);
    expect((await openStore({ storeRoot: root, projectId: "prj_test" }).read()).status).toBe("invalid");
  });

  it("duplicate link ids read as invalid (control: distinct link ids read ok)", async () => {
    const link = (id: string) => ({ id, kind: "informs" as const, from: { sessionId: "s1" }, to: { sessionId: "s2" } });
    const sessions = [raw("s1", [q("a")]), raw("s2", [q("b")])];

    const control = await newRoot();
    const ok = emptyData("prj_test", sessions);
    ok.meta.links = [link("l1"), link("l2")];
    await writeSnapshot(control, ok, 1);
    expect((await openStore({ storeRoot: control, projectId: "prj_test" }).read()).status).toBe("ok");

    const root = await newRoot();
    const dup = emptyData("prj_test", sessions);
    dup.meta.links = [link("l1"), link("l1")];
    await writeSnapshot(root, dup, 1);
    expect((await openStore({ storeRoot: root, projectId: "prj_test" }).read()).status).toBe("invalid");
  });
});

describe("cycle guards on unvalidated input", () => {
  const actCycle = () => [
    raw("s1", [q("a", { options: yesNo, activatedBy: [act(r("s1", "b"), "yes")] }), q("b", { options: yesNo, activatedBy: [act(r("s1", "a"), "yes")] })]),
  ];
  const invCycle = () => [
    raw("s1", [q("a", { options: yesNo, invalidatedBy: [inv(r("s1", "b"))] }), q("b", { options: yesNo, invalidatedBy: [inv(r("s1", "a"))] })]),
  ];

  it("computeVisibility and layoutDepth throw relation_cycle on an activation cycle, without stack overflow", () => {
    throwsCode(() => computeVisibility(actCycle()), "relation_cycle");
    throwsCode(() => layoutDepth(actCycle(), "s1"), "relation_cycle");
  });

  it("invalidationClosure terminates on an invalidation cycle; applyAnswer rejects it via its precondition", () => {
    expect(invalidationClosure(invCycle(), r("s1", "a"))).toEqual([r("s1", "b")]);
    throwsCode(() => applyAnswer(invCycle(), r("s1", "a"), pick("yes")), "relation_cycle");
  });
});

describe("diamonds are not cycles", () => {
  const R = r("d", "r");
  const X = r("d", "x");
  const Y = r("d", "y");
  const Z = r("d", "z");
  const diamond = () => [
    session("d", [
      q("r", { options: yesNo }),
      q("x", { options: yesNo, activatedBy: [act(R, "yes")], invalidatedBy: [inv(R)] }),
      q("y", { options: yesNo, invalidatedBy: [inv(R)] }),
      q("z", { options: yesNo, activatedBy: [act(X, "yes")], invalidatedBy: [inv(X), inv(Y)] }),
    ]),
  ];
  const answer = (s: Session[], ref: Ref, o: string) => applyAnswer(s, ref, pick(o)).sessions;

  it("validates, has longest-path depths, computes four visibilities and activates z", () => {
    const s = diamond();
    expect(() => validateGraph(s)).not.toThrow();
    expect(depths(s, "d")).toEqual({ r: 0, x: 1, y: 1, z: 2 });
    expect(computeVisibility(s).size).toBe(4);
    const answered = answer(answer(s, R, "yes"), X, "yes");
    expect(computeVisibility(answered).get(refKey(Z))).toBe("active");
  });

  it("invalidationClosure visits the shared descendant once; a change marks x, y, z stale", () => {
    const s = diamond();
    expect(invalidationClosure(s, R)).toEqual([X, Y, Z]);
    const all = [R, X, Y, Z].reduce((acc, ref) => answer(acc, ref, "yes"), s);
    const change = applyAnswer(all, R, pick("no"));
    expect(change.staleMarked).toHaveLength(3);
    expect(sortRefs(change.staleMarked)).toEqual(sortRefs([X, Y, Z]));
    for (const ref of [X, Y, Z]) expect(findQuestion(change.sessions, ref).validity).toBe("stale");
  });

  it("an activation diamond across two sessions validates with correct depths", () => {
    const s = [
      session("s1", [q("r", { options: yesNo }), q("x", { options: yesNo, activatedBy: [act(r("s1", "r"), "yes")] })]),
      session("s2", [
        q("y", { options: yesNo, activatedBy: [act(r("s1", "r"), "yes")] }),
        q("z", { options: yesNo, activatedBy: [act(r("s1", "x"), "yes"), act(r("s2", "y"), "yes")] }),
      ]),
    ];
    expect(() => validateGraph(s)).not.toThrow();
    expect(() => computeVisibility(s)).not.toThrow();
    expect(depths(s, "s1")).toEqual({ r: 0, x: 1 });
    expect(depths(s, "s2")).toEqual({ y: 1, z: 2 });
  });
});

describe("insertQuestion and skipQuestion", () => {
  const draft = (partial: Partial<QuestionDraft> = {}): QuestionDraft => ({
    title: "Inserted",
    context: "",
    options: yesNo,
    allowFreeText: false,
    activatedBy: [],
    invalidatedBy: [],
    ...partial,
  });

  it("insertQuestion appends an unanswered question at max order + 1 and leaves the input unchanged", () => {
    const s = loadBranching();
    const before = canonicalJson(s);
    const change = insertQuestion(s, "s1", "q5", draft());
    expect(change.questionId).toBe("q5");
    expect(change.staleMarked).toEqual([]);
    expect(change.visibilityChanged).toEqual([]);
    expect(findQuestion(change.sessions, r("s1", "q5"))).toMatchObject({
      order: 4,
      definitionRev: 1,
      validity: "unanswered",
      revisions: [],
      discussion: [],
    });
    expect(canonicalJson(s)).toBe(before);
  });

  it("insertQuestion rejects an unknown activation parent and an unknown session", () => {
    const s = loadBranching();
    throwsCode(() => insertQuestion(s, "s1", "q5", draft({ activatedBy: [act(r("s1", "q99"), "a")] })), "unresolved_ref");
    throwsCode(() => insertQuestion(s, "s9", "q5", draft()), "not_found");
  });

  it("an inserted question activated by an existing one is inactive until the matching answer", () => {
    const s = insertQuestion(loadBranching(), "s1", "q5", draft({ activatedBy: [act(r("s1", "q1"), "a")] })).sessions;
    const key = refKey(r("s1", "q5"));
    expect(computeVisibility(s).get(key)).toBe("inactive");
    expect(computeVisibility(applyAnswer(s, r("s1", "q1"), pick("b")).sessions).get(key)).toBe("inactive");
    expect(computeVisibility(applyAnswer(s, r("s1", "q1"), pick("a")).sessions).get(key)).toBe("active");
  });

  it("skipQuestion keeps the answer, deactivates activation children and marks nothing stale", () => {
    let s = loadBranching();
    for (const [ref, o] of [[r("s1", "q1"), "b"], [r("s1", "q2"), "yes"]] as const) s = applyAnswer(s, ref, pick(o)).sessions;
    expect(computeVisibility(s).get("s2/x1")).toBe("active");
    const change = skipQuestion(s, r("s1", "q2"), NOW_ISO);
    const q2 = findQuestion(change.sessions, r("s1", "q2"));
    expect(q2.validity).toBe("skipped");
    expect(q2.answer?.optionId).toBe("yes");
    expect(q2.stale).toBeUndefined();
    expect(computeVisibility(change.sessions).get("s2/x1")).toBe("inactive");
    expect(change.visibilityChanged).toEqual([r("s2", "x1")]);
    expect(change.staleMarked).toEqual([]);
  });

  it("skipping an inactive question throws question_inactive", () => {
    throwsCode(() => skipQuestion(loadBranching(), r("s1", "q2"), NOW_ISO), "question_inactive");
  });
});

describe("store prune failure", () => {
  it("a failing rm during prune still commits and logs a prune message", async () => {
    const root = await newRoot();
    const logs: Array<[string, unknown]> = [];
    const store = openStore({
      storeRoot: root,
      projectId: "prj_test",
      now: fixedClock,
      newId: nextId,
      fs: faultFs(nodeStoreFs, { failOn: (op) => op === "rm" }),
      log: (message: string, error?: unknown) => void logs.push([message, error]),
    });
    await store.init();
    for (let rev = 1; rev <= 3; rev++) {
      const out = await store.transact(rev, (d) => {
        d.sessions.push(session(`p${rev}`, [q("only")]));
      });
      expect(out.revision).toBe(rev + 1);
    }
    expect(await store.read()).toMatchObject({ status: "ok", revision: 4 });
    expect(logs.some(([m]) => /prune/i.test(m))).toBe(true);
  });
});
