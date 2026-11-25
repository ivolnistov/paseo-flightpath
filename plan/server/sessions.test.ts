import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Ref } from "../shared/model";
import { QuestionUpdate, type Result } from "../shared/rpc";
import { nodeStoreFs } from "./fs-port";
import { jsonString, opt, readJsonObject } from "./test-support/build";
import { faultFs } from "./test-support/fault-fs";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

let project: TestProject;
afterEach(async () => {
  await project?.cleanup();
});

const P = "prj_test";
const ab = [opt("a"), opt("b")];
const yesNo = [opt("yes"), opt("no")];

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out[relative(dir, full)] = await readFile(full, "utf8");
    }
  };
  await walk(dir);
  return out;
}

/** Fresh project, initialised; returns helpers that track the expected revision. */
async function started() {
  project = await makeProject();
  const { service, paseo } = project;
  ok(await service.init(paseo, { projectId: P }));
  let revision = 1;
  const rev = () => revision;
  /** Asserts a mutation result moved the revision by exactly one and version agrees. */
  // Mutation values differ per contract; callers narrow the returned value.
  const step = async <T extends { revision: number }>(p: Promise<Result<T>>): Promise<T> => {
    const value = ok(await p);
    expect(value.revision).toBe(revision + 1);
    revision = value.revision;
    expect(ok(await service.version(paseo, { projectId: P })).revision).toBe(revision);
    return value;
  };
  // Every caller passes valid create fields (options, activatedBy, invalidatedBy, recommendedOptionId).
  const question = async (sessionId: string, title: string, extra: Partial<Parameters<typeof service.questionCreate>[1]> = {}) =>
    (
      await step(
        service.questionCreate(paseo, {
          projectId: P,
          expectedRevision: revision,
          sessionId,
          title,
          context: "",
          options: ab,
          allowFreeText: false,
          activatedBy: [],
          invalidatedBy: [],
          ...extra,
        }),
      )
    ) as { revision: number; questionId: string; visibilityChanged: Ref[] };
  const newSession = async (title: string) =>
    ((await step(service.sessionCreate(paseo, { projectId: P, expectedRevision: revision, title }))) as { sessionId: string })
      .sessionId;
  const answer = (sessionId: string, questionId: string, input: { optionId?: string; text?: string; note?: string }) =>
    service.questionAnswer(paseo, { projectId: P, expectedRevision: revision, sessionId, questionId, ...input });
  const view = async (sessionId: string) => ok(await service.sessionGet(paseo, { projectId: P, sessionId }));
  const qv = async (sessionId: string, questionId: string) => (await view(sessionId)).questions.find((x) => x.question.id === questionId)!;
  return { service, paseo, rev, step, question, newSession, answer, view, qv };
}

describe("lifecycle and project identity", () => {
  it("version reports missing, init creates revision 1, a second init is a no-op", async () => {
    project = await makeProject();
    const { service, paseo } = project;
    expect(ok(await service.version(paseo, { projectId: P }))).toMatchObject({ status: "missing", revision: null });
    expect(ok(await service.init(paseo, { projectId: P }))).toEqual({ created: true, revision: 1 });
    expect(ok(await service.init(paseo, { projectId: P }))).toMatchObject({ created: false, revision: 1 });
    expect(ok(await service.version(paseo, { projectId: P }))).toMatchObject({ status: "ok", revision: 1 });
  });

  it("every method rejects an unknown projectId and a path-like projectId without touching disk", async () => {
    project = await makeProject();
    const { service, paseo, parent, root } = project;
    const parentBefore = await readdir(parent);
    const rootBefore = await readdir(root);
    const any = {
      expectedRevision: 1,
      sessionId: "s1",
      questionId: "q1",
      title: "t",
      text: "t",
      optionId: "a",
      linkId: "l1",
      kind: "informs",
      from: { sessionId: "s1" },
      to: { sessionId: "s2" },
      patch: { title: "t" },
      relation: { kind: "invalidation", target: { sessionId: "s1", questionId: "q1" }, invalidation: { upstream: { sessionId: "s1", questionId: "q2" } } },
      context: "",
      options: [],
      allowFreeText: false,
      activatedBy: [],
      invalidatedBy: [],
    };
    const methods = [
      "version", "init", "overview", "sessionGet", "sessionCreate", "questionCreate", "questionUpdate", "questionAnswer",
      "questionConfirm", "questionSkip", "questionDiscuss", "relationAdd", "relationRemove", "linkCreate", "linkDelete",
    ] as const;
    for (const m of methods) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deliberately invalid projectId through every service method; asserts the guard codes
      const call = service[m] as (p: unknown, i: unknown) => Promise<Parameters<typeof err>[0]>;
      expect(err(await call(paseo, { ...any, projectId: "prj_other" })).code, m).toBe("unknown_project");
      expect(err(await call(paseo, { ...any, projectId: "../x" })).code, m).toBe("invalid_input");
    }
    expect(await readdir(parent)).toEqual(parentBefore);
    expect(await readdir(root)).toEqual(rootBefore);
  });
});

describe("branching flow (Stage 1 acceptance)", () => {
  it("answers, switches branches, adds an invalidation and confirms with UI provenance", async () => {
    const t = await started();
    const sid = await t.newSession("Synthetic flow");
    const q1 = (await t.question(sid, "Root")).questionId;
    const Q1 = { sessionId: sid, questionId: q1 };
    const created = await t.question(sid, "Follow-up", { options: yesNo, activatedBy: [{ parent: Q1, optionIds: ["b"] }] });
    const q2 = created.questionId;
    const Q2 = { sessionId: sid, questionId: q2 };
    expect((await t.qv(sid, q2)).visibility).toBe("inactive");

    let a = (await t.step(t.answer(sid, q1, { optionId: "a" }))) as { rev: number; valueChanged: boolean; staleMarked: Ref[]; visibilityChanged: Ref[] };
    expect(a.rev).toBe(1);
    expect((await t.qv(sid, q2)).visibility).toBe("inactive");

    a = (await t.step(t.answer(sid, q1, { optionId: "b" }))) as typeof a;
    expect(a).toMatchObject({ rev: 2, valueChanged: true });
    expect(a.visibilityChanged).toContainEqual(Q2);

    await t.step(t.answer(sid, q2, { optionId: "yes" }));

    const rel = (await t.step(
      t.service.relationAdd(t.paseo, {
        projectId: P,
        expectedRevision: t.rev(),
        relation: { kind: "invalidation", target: Q2, invalidation: { upstream: Q1 } },
      }),
    )) as { staleMarked: Ref[] };
    expect(rel.staleMarked).toEqual([]);

    a = (await t.step(t.answer(sid, q1, { optionId: "b" }))) as typeof a;
    expect(a).toMatchObject({ rev: 3, valueChanged: false, staleMarked: [] });

    a = (await t.step(t.answer(sid, q1, { optionId: "a" }))) as typeof a;
    expect(a.rev).toBe(4);
    expect(await t.qv(sid, q2)).toMatchObject({ visibility: "inactive", question: { validity: "stale" } });

    a = (await t.step(t.answer(sid, q1, { optionId: "b" }))) as typeof a;
    expect(a.rev).toBe(5);
    const back = await t.qv(sid, q2);
    expect(back.visibility).toBe("active");
    expect(back.question.validity).toBe("stale");
    // Core rule (shared/graph applyAnswer): each value change overwrites the cause with the new rev.
    expect(back.question.stale).toMatchObject({ causeSessionId: sid, causeQuestionId: q1, causeRev: 5 });

    const confirmed = (await t.step(
      t.service.questionConfirm(t.paseo, { projectId: P, expectedRevision: t.rev(), sessionId: sid, questionId: q2 }),
    )) as { rev: number };
    expect(confirmed.rev).toBe(2);
    const final = await t.qv(sid, q2);
    expect(final.question.validity).toBe("valid");
    expect(final.status).toBe("answered");
    for (const qid of [q1, q2]) {
      for (const rev of (await t.qv(sid, qid)).question.revisions) {
        expect(rev).toMatchObject({ source: "ui", actor: { kind: "human" } });
      }
    }
  });
});

describe("conflicts and validation", () => {
  it("a stale expectedRevision gets revision_conflict and changes nothing", async () => {
    const t = await started();
    await t.newSession("one");
    await t.newSession("two");
    expect(t.rev()).toBe(3);
    const before = ok(await t.service.overview(t.paseo, { projectId: P }));
    const e = err(await t.service.sessionCreate(t.paseo, { projectId: P, expectedRevision: 1, title: "late" }));
    expect(e.code).toBe("revision_conflict");
    expect(e.details).toEqual({ expected: 1, actual: 3 });
    expect(ok(await t.service.overview(t.paseo, { projectId: P }))).toEqual(before);
  });

  it("UI vs another writer on one revision: exactly one answer lands", async () => {
    const t = await started();
    const sid = await t.newSession("race");
    const qid = (await t.question(sid, "Root")).questionId;
    const other = project.makeService();
    const input = (optionId: string) => ({ projectId: P, expectedRevision: t.rev(), sessionId: sid, questionId: qid, optionId });
    const results = await Promise.all([t.service.questionAnswer(t.paseo, input("a")), other.questionAnswer(t.paseo, input("b"))]);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    const failed = results.filter((x) => !x.ok);
    expect(failed).toHaveLength(1);
    expect(err(failed[0]).code).toBe("revision_conflict");
    expect((await t.qv(sid, qid)).question.revisions).toHaveLength(1);
  });

  it("rejects malformed and inactive answers without changing the revision", async () => {
    const t = await started();
    const sid = await t.newSession("validation");
    const q1 = (await t.question(sid, "Root")).questionId;
    const q2 = (await t.question(sid, "Child", { activatedBy: [{ parent: { sessionId: sid, questionId: q1 }, optionIds: ["b"] }] })).questionId;
    const cases: Array<[string, { optionId?: string; text?: string }, string]> = [
      [q1, { optionId: "a", text: "both" }, "invalid_input"],
      [q1, {}, "invalid_input"],
      [q1, { text: "free text not allowed" }, "invalid_input"],
      [q1, { optionId: "zzz" }, "invalid_input"],
      [q2, { optionId: "a" }, "question_inactive"],
    ];
    for (const [qid, input, code] of cases) {
      expect(err(await t.answer(sid, qid, input)).code, JSON.stringify(input)).toBe(code);
      expect(ok(await t.service.version(t.paseo, { projectId: P })).revision).toBe(t.rev());
    }
    expect(err(await t.service.questionConfirm(t.paseo, { projectId: P, expectedRevision: t.rev(), sessionId: sid, questionId: q1 })).code).toBe(
      "not_stale",
    );
  });

  it("questionUpdate removing the answered option stales the question itself; a no-op patch keeps definitionRev", async () => {
    const t = await started();
    const sid = await t.newSession("definitions");
    const q1 = (await t.question(sid, "Root")).questionId;
    const q3 = (await t.question(sid, "Dependent", { invalidatedBy: [{ upstream: { sessionId: sid, questionId: q1 } }] })).questionId;
    await t.step(t.answer(sid, q1, { optionId: "a" }));
    await t.step(t.answer(sid, q3, { optionId: "a" }));
    const q3Before = (await t.qv(sid, q3)).question;

    const update = (patch: Record<string, unknown>) =>
      t.step(t.service.questionUpdate(t.paseo, { projectId: P, expectedRevision: t.rev(), sessionId: sid, questionId: q1, patch }));
    const removed = (await update({ options: [opt("b")] })) as { definitionRev: number };
    expect(removed.definitionRev).toBe(2);
    const root = (await t.qv(sid, q1)).question;
    expect(root.validity).toBe("stale");
    expect(root.stale).toMatchObject({ causeSessionId: sid, causeQuestionId: q1, causeRev: 1 });
    expect((await t.qv(sid, q3)).question).toEqual(q3Before);

    const noop = (await update({ title: "Root" })) as { definitionRev: number };
    expect(noop.definitionRev).toBe(2);
  });

  it("questionUpdate clears an existing recommendation with null, alone and while removing that option", async () => {
    const t = await started();
    const sid = await t.newSession("recommendation");
    const qid = (await t.question(sid, "Root", { options: [opt("a"), opt("b"), opt("c")], recommendedOptionId: "b" })).questionId;
    await t.step(t.answer(sid, qid, { optionId: "a" }));
    expect((await t.qv(sid, qid)).question.recommendedOptionId).toBe("b");
    const update = (patch: Record<string, unknown>) =>
      t.step(t.service.questionUpdate(t.paseo, { projectId: P, expectedRevision: t.rev(), sessionId: sid, questionId: qid, patch }));

    const cleared = (await update({ recommendedOptionId: null })) as { definitionRev: number; staleMarked: Ref[] };
    expect(cleared.definitionRev).toBe(2);
    expect(cleared.staleMarked).toEqual([]);
    let stored = (await t.qv(sid, qid)).question;
    expect("recommendedOptionId" in stored).toBe(false);
    expect(stored.options.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(stored.validity).toBe("valid");

    // Re-recommend, then clear and remove that option in one patch.
    await update({ recommendedOptionId: "c" });
    const both = (await update({ recommendedOptionId: null, options: [opt("a"), opt("b")] })) as { definitionRev: number };
    expect(both.definitionRev).toBe(4);
    // A fresh service instance reads the persisted, valid snapshot.
    const reread = ok(await project.makeService().sessionGet(t.paseo, { projectId: P, sessionId: sid }));
    stored = reread.questions.find((x) => x.question.id === qid)!.question;
    expect("recommendedOptionId" in stored).toBe(false);
    expect(stored.options.map((o) => o.id)).toEqual(["a", "b"]);
    expect(stored.validity).toBe("valid");
    expect(stored.revisions).toHaveLength(1);
    expect(ok(await t.service.version(t.paseo, { projectId: P })).status).toBe("ok");
  });

  it("relationAdd rejects mixed and cross-session cycles and missing parents without a write", async () => {
    const t = await started();
    const s1 = await t.newSession("one");
    const q1 = (await t.question(s1, "Root")).questionId;
    const Q1 = { sessionId: s1, questionId: q1 };
    const q2 = (await t.question(s1, "Child", { activatedBy: [{ parent: Q1, optionIds: ["b"] }] })).questionId;
    const s2 = await t.newSession("two");
    const x = (await t.question(s2, "Cross", { activatedBy: [{ parent: { sessionId: s1, questionId: q2 }, optionIds: ["a"] }] })).questionId;
    const add = (upstream: Ref) =>
      t.service.relationAdd(t.paseo, { projectId: P, expectedRevision: t.rev(), relation: { kind: "invalidation", target: Q1, invalidation: { upstream } } });
    expect(err(await add({ sessionId: s1, questionId: q2 })).code).toBe("relation_cycle");
    expect(err(await add({ sessionId: s2, questionId: x })).code).toBe("relation_cycle");
    expect(err(await add({ sessionId: s1, questionId: "missing" })).code).toBe("unresolved_ref");
    expect(ok(await t.service.version(t.paseo, { projectId: P })).revision).toBe(t.rev());
  });

  it("questionDiscuss appends a note and changes no validity or revision", async () => {
    const t = await started();
    const sid = await t.newSession("discuss");
    const q1 = (await t.question(sid, "Root")).questionId;
    await t.step(t.answer(sid, q1, { optionId: "a" }));
    const before = (await t.view(sid)).questions.map((x) => ({ id: x.question.id, validity: x.question.validity, revisions: x.question.revisions }));
    const out = (await t.step(
      t.service.questionDiscuss(t.paseo, { projectId: P, expectedRevision: t.rev(), sessionId: sid, questionId: q1, text: "Thinking aloud" }),
    )) as { noteId: string };
    const after = await t.view(sid);
    expect(after.questions.map((x) => ({ id: x.question.id, validity: x.question.validity, revisions: x.question.revisions }))).toEqual(before);
    const note = after.questions.find((x) => x.question.id === q1)!.question.discussion;
    expect(note).toEqual([expect.objectContaining({ id: out.noteId, text: "Thinking aloud", actor: { kind: "human" } })]);
  });

  it("links are descriptive: no status change, listed in the overview, refs checked, unknown delete is not_found", async () => {
    const t = await started();
    const s1 = await t.newSession("one");
    const q1 = (await t.question(s1, "Root")).questionId;
    const s2 = await t.newSession("two");
    await t.question(s2, "Other");
    const before = [await t.view(s1), await t.view(s2)].map((v) => v.questions.map((x) => x.status));
    const created = (await t.step(
      t.service.linkCreate(t.paseo, { projectId: P, expectedRevision: t.rev(), kind: "informs", from: { sessionId: s1, questionId: q1 }, to: { sessionId: s2 } }),
    )) as { linkId: string };
    expect([await t.view(s1), await t.view(s2)].map((v) => v.questions.map((x) => x.status))).toEqual(before);
    expect(ok(await t.service.overview(t.paseo, { projectId: P })).links).toEqual([
      expect.objectContaining({ id: created.linkId, kind: "informs", from: { sessionId: s1, questionId: q1 }, to: { sessionId: s2 } }),
    ]);
    expect(
      err(await t.service.linkCreate(t.paseo, { projectId: P, expectedRevision: t.rev(), kind: "informs", from: { sessionId: s1 }, to: { sessionId: "nope" } })).code,
    ).toBe("unresolved_ref");
    expect(err(await t.service.linkDelete(t.paseo, { projectId: P, expectedRevision: t.rev(), linkId: "nope" })).code).toBe("not_found");
  });
});

describe("store failures", () => {
  it("an invalid store reports invalid from version and store_invalid elsewhere, leaving bytes unchanged", async () => {
    const t = await started();
    const sid = await t.newSession("victim");
    const decisions = join(project.root, ".decisions");
    const manifest = readJsonObject(await readFile(join(decisions, "manifest.json"), "utf8"));
    const file = join(decisions, "generations", jsonString(manifest, "generation"), "sessions", `${sid}.json`);
    const text = await readFile(file, "utf8");
    await writeFile(file, text.slice(0, Math.floor(text.length / 2)));
    const bytes = await tree(decisions);

    expect(ok(await t.service.version(t.paseo, { projectId: P })).status).toBe("invalid");
    expect(err(await t.service.overview(t.paseo, { projectId: P })).code).toBe("store_invalid");
    expect(err(await t.service.sessionGet(t.paseo, { projectId: P, sessionId: sid })).code).toBe("store_invalid");
    expect(err(await t.service.sessionCreate(t.paseo, { projectId: P, expectedRevision: t.rev(), title: "x" })).code).toBe("store_invalid");
    expect(await tree(decisions)).toEqual(bytes);
  });

  it("an unexpected fs error becomes internal and is logged", async () => {
    const t = await started();
    const injected = faultFs(nodeStoreFs, { failOn: (op) => op === "readFile" });
    const broken = project.makeService({ fs: injected });
    expect(err(await broken.overview(t.paseo, { projectId: P })).code).toBe("internal");
    expect(project.logs.some(([, e]) => e instanceof Error && e.message === "injected")).toBe(true);
  });
});

// Redesign Stage R0.6 (task card §9 item 13): questionUpdate passed its whole command input as the
// graph ref, so a self-staling update returned staleMarked entries with extra keys that the strict
// Refs output contract (parsed on the client) rejects.
describe("questionUpdate staleMarked refs", () => {
  it("a self-staling update returns exactly [{ sessionId, questionId }] and satisfies the question.update output contract", async () => {
    const t = await started();
    const sid = await t.newSession("strict refs");
    const q1 = (await t.question(sid, "Root")).questionId;
    await t.step(t.answer(sid, q1, { optionId: "a" }));
    const result = await t.service.questionUpdate(t.paseo, {
      projectId: P,
      expectedRevision: t.rev(),
      sessionId: sid,
      questionId: q1,
      patch: { options: [opt("b")] },
    });
    const value = ok(result);
    expect(value.staleMarked).toEqual([{ sessionId: sid, questionId: q1 }]);
    for (const ref of value.staleMarked) expect(Object.keys(ref).sort()).toEqual(["questionId", "sessionId"]);
    expect(QuestionUpdate.output.safeParse(result).success).toBe(true);
  });
});
