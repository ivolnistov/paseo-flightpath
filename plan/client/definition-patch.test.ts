// F1 regression: a stale edit draft must never revert a field another client changed.
// Executes the real definitionPatch helper and a real service/store; the editor and hook wiring
// (base captured once, explicit expectedRevision) are not mounted here.
import { afterEach, describe, expect, it } from "vitest";
import type { Option, Question } from "../shared/model";
import { opt, q } from "../server/test-support/build";
import { err, makeProject, ok, type TestProject } from "../server/test-support/service";
import { definitionPatch, type DefinitionDraft } from "./definition-patch";

const draftOf = (question: Question, edits: Partial<DefinitionDraft> = {}): DefinitionDraft => ({
  title: question.title,
  context: question.context,
  options: question.options,
  ...(question.recommendedOptionId !== undefined ? { recommendedOptionId: question.recommendedOptionId } : {}),
  allowFreeText: question.allowFreeText,
  ...edits,
});

const base = () =>
  q("q1", { title: "Original title", context: "Original context", options: [opt("a"), opt("b")], recommendedOptionId: "b" });

describe("definitionPatch", () => {
  it("sends only fields changed relative to the opened base", () => {
    expect(definitionPatch(base(), draftOf(base()))).toEqual({});
    expect(definitionPatch(base(), draftOf(base(), { context: "A context" }))).toEqual({ context: "A context" });
    expect(definitionPatch(base(), draftOf(base(), { allowFreeText: true }))).toEqual({ allowFreeText: true });
  });

  it("diffing against the opened base omits a title another client changed; diffing against the live question would revert it", () => {
    const opened = base();
    const live = { ...opened, title: "B title" };
    const draft = draftOf(opened, { context: "A context" });
    expect(definitionPatch(opened, draft)).toEqual({ context: "A context" });
    // Why the base must be pinned: the same draft diffed against the refreshed question carries the stale title.
    expect(definitionPatch(live, draft)).toMatchObject({ title: "Original title" });
  });

  it("clears a removed recommendation with null and omits an unchanged one", () => {
    const { recommendedOptionId: _drop, ...noRec } = draftOf(base());
    expect(definitionPatch(base(), noRec)).toEqual({ recommendedOptionId: null });
    expect(definitionPatch(base(), draftOf(base(), { recommendedOptionId: "a" }))).toEqual({ recommendedOptionId: "a" });
    expect(definitionPatch(q("q1", { options: [opt("a")] }), draftOf(q("q1", { options: [opt("a")] })))).toEqual({});
  });

  it("compares options canonically: key order is ignored, array order and content are not", () => {
    const reKeyed = base().options.map((o) => ({ label: o.label, id: o.id }) as Option);
    expect(definitionPatch(base(), draftOf(base(), { options: reKeyed }))).toEqual({});
    const reordered = [...base().options].reverse();
    expect(definitionPatch(base(), draftOf(base(), { options: reordered }))).toEqual({ options: reordered });
    const relabelled = [opt("a"), { id: "b", label: "Renamed" }];
    expect(definitionPatch(base(), draftOf(base(), { options: relabelled }))).toEqual({ options: relabelled });
  });
});

describe("two clients editing one question (real service and store)", () => {
  let project: TestProject;
  afterEach(async () => {
    await project?.cleanup();
  });

  it("a stale draft pinned to revision N conflicts, keeps B's title, and applies only after reopening", async () => {
    project = await makeProject();
    const { paseo } = project;
    const A = project.service;
    const B = project.makeService();
    const P = "prj_test";
    ok(await A.init(paseo, { projectId: P }));
    const sessionId = ok(await A.sessionCreate(paseo, { projectId: P, expectedRevision: 1, title: "F1" })).sessionId;
    const created = ok(
      await A.questionCreate(paseo, {
        projectId: P, expectedRevision: 2, sessionId, title: "Original title", context: "Original context",
        options: [opt("a"), opt("b")], recommendedOptionId: "b", allowFreeText: false, activatedBy: [], invalidatedBy: [],
      }),
    );
    const questionId = created.questionId;
    const read = async () => {
      const view = ok(await A.sessionGet(paseo, { projectId: P, sessionId }));
      return { revision: view.revision, question: view.questions.find((x) => x.question.id === questionId)!.question };
    };

    // A opens the editor at revision N.
    const opened = await read();
    const N = opened.revision;
    expect(N).toBe(3);

    // B changes only the title at N → N+1.
    expect(ok(await B.questionUpdate(paseo, { projectId: P, expectedRevision: N, sessionId, questionId, patch: { title: "B title" } })).revision).toBe(N + 1);
    const afterB = await read();

    // A edits the context of its N-based draft; the patch carries no title.
    const patch = definitionPatch(opened.question, draftOf(opened.question, { context: "A context" }));
    expect(patch).toEqual({ context: "A context" });

    // Saving with the pinned base revision conflicts and writes nothing.
    for (let attempt = 0; attempt < 2; attempt++) {
      const e = err(await A.questionUpdate(paseo, { projectId: P, expectedRevision: N, sessionId, questionId, patch }));
      expect(e.code).toBe("revision_conflict");
      expect(e.details).toEqual({ expected: N, actual: N + 1 });
      expect(await read()).toEqual(afterB);
    }
    expect(afterB.question).toMatchObject({ title: "B title", context: "Original context", definitionRev: 2 });

    // Deliberately reopened on N+1, the same edit applies without reverting B's title.
    const reopened = await read();
    const patch2 = definitionPatch(reopened.question, draftOf(reopened.question, { context: "A context" }));
    expect(patch2).toEqual({ context: "A context" });
    const saved = ok(await A.questionUpdate(paseo, { projectId: P, expectedRevision: reopened.revision, sessionId, questionId, patch: patch2 }));
    expect(saved).toMatchObject({ revision: N + 2, definitionRev: 3 });
    const final = await read();
    expect(final.question).toMatchObject({ title: "B title", context: "A context", recommendedOptionId: "b", definitionRev: 3 });
    expect(final.question.options.map((o) => o.id)).toEqual(["a", "b"]);
  });
});
