// Persistent question numbers over real temp stores. New questions store `max(effective) + 1`
// per session; the first write after an older release backfills `order + 1` on every question of
// every session, including questions of accepted blocks and cancelled questions; stored numbers are
// never rewritten, even when they differ from `order + 1`; and the store refuses any generation that
// changes an effective number or deletes a session or question.
//
// Numbers are read from the stored data, not from session views, so these tests do not depend on
// how views expose them.
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import type { Question, RoadmapData } from "../shared/model";
import type { QuestionBatchInput, StoreOpener, WriteOrigin } from "./sessions";
import { createRoadmapCommands, UI_ORIGIN } from "./sessions";
import { openStore } from "./store";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { rejectsCode } from "./test-support/expect-error";
import { fakeDirectory } from "./test-support/fake-dir";
import { resealQuestions, stripNumbers } from "./test-support/reseal";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent" }, quoted: "ask" };
const FIXTURE = fileURLToPath(new URL("./fixtures/v1-store/", import.meta.url));
const FIXTURE_PID = "prj_2d93f94da090e78c";
// Many fsync-backed commits per test on tmpdir; timeout only.
const FILE_HEAVY_TIMEOUT_MS = 30_000;

let project: TestProject | undefined;
const roots: string[] = [];
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type BatchQuestion = QuestionBatchInput["questions"][number];
const draft = (title: string, extra: Partial<BatchQuestion> = {}): BatchQuestion => ({
  title,
  context: "",
  options: ab,
  allowFreeText: false,
  activatedBy: [],
  invalidatedBy: [],
  ...extra,
});

function helpers(open: StoreOpener, projectId: string) {
  const commands = createRoadmapCommands({ directory: () => fakeDirectory({ projects: [] }), now: fixedClock, newId: nextId });
  const revision = async () => ok(await commands.version(open, { projectId }, UI_ORIGIN)).revision!;
  const at = async () => ({ projectId, expectedRevision: await revision() });
  const read = async () => (await open(projectId)).read();
  const data = async (): Promise<RoadmapData> => {
    const r = await read();
    if (r.status !== "ok") throw new Error(`expected ok store, got ${r.status}`);
    return r.data;
  };
  const session = async (sessionId: string) => {
    const s = (await data()).sessions.find((x) => x.id === sessionId);
    if (s === undefined) throw new Error(`no session ${sessionId}`);
    return s;
  };
  /** Stored numbers in question order; undefined where none is stored. */
  const numbers = async (sessionId: string) => (await session(sessionId)).questions.map((q: Question) => q.number);
  const numberOf = async (sessionId: string, questionId: string) => (await session(sessionId)).questions.find((q) => q.id === questionId)?.number;
  const openBlock = async (sessionId: string) => {
    const b = (await session(sessionId)).blocks?.find((x) => x.state === "open");
    if (b === undefined) throw new Error(`no open block in ${sessionId}`);
    return b.id;
  };
  const newSession = async (title: string) => ok(await commands.sessionCreate(open, { ...(await at()), title }, UI_ORIGIN)).sessionId;
  const create = async (sessionId: string, title: string, blockId?: string) =>
    ok(
      await commands.questionCreate(
        open,
        { ...(await at()), sessionId, title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], ...(blockId ? { blockId } : {}) },
        UI_ORIGIN,
      ),
    ).questionId;
  const batch = async (sessionId: string, blockId: string, questions: BatchQuestion[]) =>
    ok(await commands.questionCreateBatch(open, { ...(await at()), sessionId, blockId, questions }, CHAT)).questionIds;
  const accept = async (sessionId: string, blockId: string) => ok(await commands.blockAccept(open, { ...(await at()), sessionId, blockId }, UI_ORIGIN));
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  return { commands, open, revision, at, read, data, session, numbers, numberOf, openBlock, newSession, create, batch, accept, snapshot };
}

async function setup() {
  project = await makeProject();
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string, e?: unknown) => void project!.logs.push([m, e]) };
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  const h = helpers(open, P);
  ok(await h.commands.init(open, { projectId: P }, UI_ORIGIN));
  return { ...h, root: project.root };
}

/** A temp root holding a byte copy of the synthetic v1 store, opened through the commands. */
async function fixtureSetup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dr-numbers-")));
  roots.push(root);
  await cp(FIXTURE, join(root, ".decisions"), { recursive: true });
  const open: StoreOpener = async () => openStore({ storeRoot: root, projectId: FIXTURE_PID, now: fixedClock, newId: nextId, log: () => undefined });
  return helpers(open, FIXTURE_PID);
}

describe("numbers of new questions", () => {
  it(
    "are stored as 1..n per session and survive edit, answer, relation, discussion, skip, accept, cancel, close and reopen",
    async () => {
      const h = await setup();
      const s = await h.newSession("Numbers");
      const [qa, qb, qc] = await h.batch(s, "b1", [draft("A", { recommendedOptionId: "a" }), draft("B", { invalidatedBy: [{ upstream: { batchIndex: 0 } }] }), draft("C")]);
      expect(await h.numbers(s)).toEqual([1, 2, 3]);

      ok(await h.commands.questionUpdate(h.open, { ...(await h.at()), sessionId: s, questionId: qa, patch: { title: "A2" } }, UI_ORIGIN));
      ok(await h.commands.questionAnswer(h.open, { ...(await h.at()), sessionId: s, questionId: qa, optionId: "a" }, UI_ORIGIN));
      ok(
        await h.commands.relationAdd(
          h.open,
          { ...(await h.at()), relation: { kind: "invalidation", target: { sessionId: s, questionId: qc }, invalidation: { upstream: { sessionId: s, questionId: qa } } } },
          UI_ORIGIN,
        ),
      );
      ok(await h.commands.questionDiscuss(h.open, { ...(await h.at()), sessionId: s, questionId: qb, text: "note" }, UI_ORIGIN));
      ok(await h.commands.questionSkip(h.open, { ...(await h.at()), sessionId: s, questionId: qc }, UI_ORIGIN));
      // Re-answering moves the upstream revision and marks qb stale; numbers stay put.
      ok(await h.commands.questionAnswer(h.open, { ...(await h.at()), sessionId: s, questionId: qa, optionId: "b" }, UI_ORIGIN));
      expect(await h.numbers(s)).toEqual([1, 2, 3]);

      await h.accept(s, "b1");
      ok(await h.commands.decisionCancel(h.open, { ...(await h.at()), sessionId: s, questionId: qb, reason: "not needed" }, UI_ORIGIN));
      expect(await h.numbers(s)).toEqual([1, 2, 3]);

      // The next block continues the session's sequence; numbers are not per block.
      const [qd] = await h.batch(s, await h.openBlock(s), [draft("D")]);
      expect(await h.numberOf(s, qd)).toBe(4);

      const store = await h.open(P);
      await store.transact(await h.revision(), (d) => {
        d.sessions.find((x) => x.id === s)!.status = "closed";
      });
      ok(await h.commands.sessionReopen(h.open, { ...(await h.at()), sessionId: s }, UI_ORIGIN));
      expect(await h.numbers(s)).toEqual([1, 2, 3, 4]);
    },
    FILE_HEAVY_TIMEOUT_MS,
  );

  it("are per session, for legacy sessions without blocks too", async () => {
    const h = await setup();
    const s = await h.newSession("First");
    await h.create(s, "S1");
    await h.create(s, "S2");
    const t = await h.newSession("Second");
    await h.create(t, "T1");
    expect(await h.numbers(s)).toEqual([1, 2]);
    expect(await h.numbers(t)).toEqual([1]);
  });
});

describe("backfill of stores written before numbering", () => {
  it(
    "the v1 fixture: the first write stores order + 1 on every question of every session",
    async () => {
      const h = await fixtureSetup();
      const before = await h.read();
      expect(before).toMatchObject({ status: "ok", schemaVersion: 1 });
      const legacy = (await h.data()).sessions;
      expect(legacy.flatMap((s) => s.questions).every((q) => !("number" in q))).toBe(true);
      const expected = legacy.map((s) => s.questions.map((q) => q.order + 1));

      // An unrelated write: it touches none of the legacy sessions directly.
      await h.newSession("New");
      expect(await Promise.all(legacy.map((s) => h.numbers(s.id)))).toEqual(expected);

      // The next question of a legacy session continues after the backfilled numbers.
      const first = legacy[0];
      const added = await h.create(first.id, "Added");
      expect(await h.numberOf(first.id, added)).toBe(Math.max(...expected[0]) + 1);
    },
    FILE_HEAVY_TIMEOUT_MS,
  );

  it(
    "an older v2 store: accepted-block and cancelled questions are backfilled without tripping the frozen or cancelled guards",
    async () => {
      const h = await setup();
      const s = await h.newSession("Blocked");
      const [q1, q2] = await h.batch(s, "b1", [draft("Q1"), draft("Q2")]);
      ok(await h.commands.questionAnswer(h.open, { ...(await h.at()), sessionId: s, questionId: q1, optionId: "a" }, UI_ORIGIN));
      await h.accept(s, "b1");
      ok(await h.commands.decisionCancel(h.open, { ...(await h.at()), sessionId: s, questionId: q2, reason: "dropped" }, UI_ORIGIN));
      const l = await h.newSession("Legacy");
      await h.create(l, "L1");
      await h.create(l, "L2");

      await resealQuestions(h.root, P, stripNumbers);
      expect(await h.read()).toMatchObject({ status: "ok" });
      expect((await h.data()).sessions.flatMap((x) => x.questions).every((q) => !("number" in q))).toBe(true);

      const write = await h.commands.sessionCreate(h.open, { ...(await h.at()), title: "Unrelated" }, UI_ORIGIN);
      if (!write.ok) expect(write.error.code).not.toMatch(/block_frozen|decision_cancelled/);
      expect(write.ok).toBe(true);
      expect(await h.numbers(s)).toEqual([1, 2]);
      expect(await h.numbers(l)).toEqual([1, 2]);

      const [q3] = await h.batch(s, await h.openBlock(s), [draft("Q3")]);
      expect(await h.numberOf(s, q3)).toBe(3);
    },
    FILE_HEAVY_TIMEOUT_MS,
  );

  it(
    "a mixed store: stored numbers that differ from order + 1 are kept, missing ones get order + 1, and allocation continues after the maximum",
    async () => {
      const h = await setup();
      const s = await h.newSession("Mixed");
      const [first, second] = [await h.create(s, "M1"), await h.create(s, "M2")];
      // first keeps a stored 5 (order 0); second loses its number (derived 2).
      await resealQuestions(h.root, P, (q) => {
        if (q.id === first) q.number = 5;
        else delete q.number;
      });

      await h.newSession("Unrelated");
      expect(await h.numberOf(s, first)).toBe(5);
      expect(await h.numberOf(s, second)).toBe(2);

      const third = await h.create(s, "M3");
      expect(await h.numberOf(s, third)).toBe(6);
    },
    FILE_HEAVY_TIMEOUT_MS,
  );
});

describe("the store refuses a generation that breaks numbering", () => {
  /** s: questions S1 and S2 (neither referenced by the other); t: question T1. */
  async function numbered() {
    const h = await setup();
    const s = await h.newSession("S");
    const [s1, s2] = [await h.create(s, "S1"), await h.create(s, "S2")];
    const t = await h.newSession("T");
    await h.create(t, "T1");
    return { h, s, s1, s2, t, store: await h.open(P) };
  }

  it("a positive control: an edit that keeps every number commits", async () => {
    const { h, s, store } = await numbered();
    const before = await h.revision();
    await store.transact(before, (d) => {
      d.sessions.find((x) => x.id === s)!.title = "Renamed";
    });
    expect(await h.revision()).toBe(before + 1);
  });

  it("changing a stored number is internal, with no write", async () => {
    const { h, s, s1, store } = await numbered();
    expect(await h.numbers(s)).toEqual([1, 2]);
    const before = await h.snapshot();
    const e = await rejectsCode(
      store.transact(before.revision, (d) => {
        d.sessions.find((x) => x.id === s)!.questions.find((q) => q.id === s1)!.number = 9;
      }),
      "internal",
    );
    expect(e.message).toMatch(/question number changed/);
    expect(await h.snapshot()).toEqual(before);
  });

  // Deletion is refused whether or not the deleted question carries a stored number.
  it("deleting a question is internal, with no write", async () => {
    const { h, s, s2, store } = await numbered();
    const before = await h.snapshot();
    await rejectsCode(
      store.transact(before.revision, (d) => {
        const session = d.sessions.find((x) => x.id === s)!;
        session.questions = session.questions.filter((q) => q.id !== s2);
      }),
      "internal",
    );
    expect(await h.snapshot()).toEqual(before);
  });

  it("deleting a session is internal, with no write", async () => {
    const { h, t, store } = await numbered();
    const before = await h.snapshot();
    await rejectsCode(
      store.transact(before.revision, (d) => {
        d.sessions = d.sessions.filter((x) => x.id !== t);
      }),
      "internal",
    );
    expect(await h.snapshot()).toEqual(before);
  });

  it("a repeated number within a session is refused, with no write", async () => {
    const { h, s, s2, store } = await numbered();
    expect(await h.numbers(s)).toEqual([1, 2]);
    const before = await h.snapshot();
    // Either the schema or the numbering guard may refuse it; the store must not move.
    await expect(
      store.transact(before.revision, (d) => {
        d.sessions.find((x) => x.id === s)!.questions.find((q) => q.id === s2)!.number = 1;
      }),
    ).rejects.toThrow();
    expect(await h.snapshot()).toEqual(before);
  });
});

// Review regression: every write rewrites every session file, so the first write after an older
// release backfills numbers whatever wrote it: a feature command, a plan command or a direct store
// transaction, not only the session commands.
describe("backfill on writes outside the session commands", () => {
  it("the v1 fixture: a feature created as the first write stores order + 1 on every legacy question", async () => {
    const h = await fixtureSetup();
    const legacy = (await h.data()).sessions;
    const expected = legacy.map((s) => s.questions.map((q) => q.order + 1));
    const { createFeatureCommands } = await import("./features");
    const features = createFeatureCommands({ directory: () => fakeDirectory({ projects: [] }), now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } });
    ok(await features.create(h.open, { projectId: FIXTURE_PID, expectedRevision: await h.revision(), title: "New", description: "", kind: "feature" }, UI_ORIGIN));
    expect(await Promise.all(legacy.map((s) => h.numbers(s.id)))).toEqual(expected);
  });

  it("an older v2 store: a direct store transaction backfills the derived numbers", async () => {
    const h = await setup();
    const s = await h.newSession("Legacy");
    await h.create(s, "L1");
    await h.create(s, "L2");
    await resealQuestions(h.root, P, stripNumbers);
    expect(await h.numbers(s)).toEqual([undefined, undefined]);
    const store = await h.open(P);
    await store.transact(await h.revision(), (d) => {
      d.sessions.find((x) => x.id === s)!.title = "Renamed";
    });
    expect(await h.numbers(s)).toEqual([1, 2]);
  });
});
