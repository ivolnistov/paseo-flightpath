// Grilling blocks (redesign Stage R0.4, task card §5, plan Task R0.4, design §4): a session converts
// to blocks on its first block-scoped question, holds exactly one open block (the highest order),
// and an acceptance freezes the block and opens the next. Every definition or relation mutation of a
// question of an accepted block, and every new question in it, is rejected with block_frozen through
// the commands layer for both the UI and the chat (MCP) origin; answers, confirmations, skips and
// notes stay allowed and leave the accepted definition unchanged. Legacy sessions keep today's
// behaviour and gain no stored marker.
//
// Each frozen-rule case has an equivalent open-block control, so a rejection is attributable to the
// frozen rule and not to the operation itself.
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import { Session, type Ref } from "../shared/model";
import { QuestionCreate } from "../shared/rpc";
import { buildTools } from "./mcp-tools";
import { createRoadmapCommands, effectiveBlocks, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openStore } from "./store";
import { openProjectStore } from "./store-root";
import { fixedClock, NOW_ISO, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];
const chat = (quoted = "Use A"): WriteOrigin => ({ source: "chat", actor: { kind: "agent" }, quoted });

type Json = any; // command inputs carrying fields the shipped input types do not declare yet

let project: TestProject | undefined;
const roots: string[] = [];
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Commands over an initialised temp project, with small helpers that always use the current revision. */
async function setup() {
  project = await makeProject();
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string, e?: unknown) => void project!.logs.push([m, e]) };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  return helpers(commands, open, P);
}

function helpers(commands: ReturnType<typeof createRoadmapCommands>, open: StoreOpener, projectId: string) {
  const revision = async () => ok(await commands.version(open, { projectId }, UI_ORIGIN)).revision!;
  const data = async () => {
    const read = await (await open(projectId)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const sessionOf = async (sessionId: string): Promise<Json> => (await data()).sessions.find((s) => s.id === sessionId)!;
  const newSession = async (title = "Blocks") =>
    ok(await commands.sessionCreate(open, { projectId, expectedRevision: await revision(), title }, UI_ORIGIN)).sessionId;
  const create = async (sessionId: string, title: string, extra: Record<string, unknown> = {}) =>
    commands.questionCreate(
      open,
      { projectId, expectedRevision: await revision(), sessionId, title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], ...extra } as Json,
      UI_ORIGIN,
    );
  const createId = async (sessionId: string, title: string, extra: Record<string, unknown> = {}) => ok(await create(sessionId, title, extra)).questionId;
  const accept = async (sessionId: string, blockId: string, origin: WriteOrigin = UI_ORIGIN, expectedRevision?: number) =>
    commands.blockAccept(open, { projectId, expectedRevision: expectedRevision ?? (await revision()), sessionId, blockId }, origin);
  const ref = (sessionId: string, questionId: string): Ref => ({ sessionId, questionId });
  const at = async () => ({ projectId, expectedRevision: await revision() });
  return { commands, open, projectId, revision, data, sessionOf, newSession, create, createId, accept, ref, at };
}

type H = Awaited<ReturnType<typeof setup>>;

/** Asserts `result` is an error and that the store did not move. */
async function rejectedWithoutWrite(h: H, before: { revision: number; snapshot: string }, result: { ok: boolean }) {
  expect(result.ok).toBe(false);
  expect(await h.revision()).toBe(before.revision);
  expect(canonicalJson(await h.data())).toBe(before.snapshot);
}
const snapshot = async (h: H) => ({ revision: await h.revision(), snapshot: canonicalJson(await h.data()) });
/** The accepted definition of a question (what Accept froze), canonical. */
const definitionOf = (session: { questions: Json[] }, id: string): string => {
  const q = session.questions.find((x: Json) => x.id === id);
  return canonicalJson({
    id: q.id, order: q.order, number: q.number, blockId: q.blockId, title: q.title, context: q.context, options: q.options,
    recommendedOptionId: q.recommendedOptionId, allowFreeText: q.allowFreeText, definitionRev: q.definitionRev, activatedBy: q.activatedBy, invalidatedBy: q.invalidatedBy,
  });
};

// ---------------------------------------------------------------------------------------------

describe("converting a session to blocks", () => {
  it("the first block-scoped question on an empty session opens that block and joins it", async () => {
    const h = await setup();
    const s = await h.newSession();
    const q1 = await h.createId(s, "Q1", { blockId: "b1" });
    const session = await h.sessionOf(s);
    expect(session.blocks).toHaveLength(1);
    expect(session.blocks[0]).toMatchObject({ id: "b1", state: "open", openedAt: NOW_ISO });
    expect(Number.isInteger(session.blocks[0].order)).toBe(true);
    expect(session.blocks[0]).not.toHaveProperty("acceptedAt");
    expect(session.questions.map((q: Json) => [q.id, q.blockId])).toEqual([[q1, "b1"]]);
    expect(session.status).toBe("active");
    expect(Session.safeParse(session).success).toBe(true);
  });

  it("later questions join the open block", async () => {
    const h = await setup();
    const s = await h.newSession();
    await h.createId(s, "Q1", { blockId: "b1" });
    const q2 = await h.createId(s, "Q2", { blockId: "b1" });
    const session = await h.sessionOf(s);
    expect(session.blocks).toHaveLength(1);
    expect(session.questions.find((q: Json) => q.id === q2).blockId).toBe("b1");
  });

  it("a session with legacy questions keeps legacy semantics and rejects blockId with invalid_input", async () => {
    const h = await setup();
    const s = await h.newSession();
    await h.createId(s, "Legacy Q1");
    const before = await snapshot(h);
    const result = await h.create(s, "Q2", { blockId: "b1" });
    expect(err(result).code).toBe("invalid_input");
    await rejectedWithoutWrite(h, before, result);
    // Positive control: the same session still accepts a legacy question.
    const q3 = await h.createId(s, "Legacy Q3");
    const session = await h.sessionOf(s);
    expect(session).not.toHaveProperty("blocks");
    expect(session.questions.find((q: Json) => q.id === q3)).not.toHaveProperty("blockId");
  });

  it("a question without blockId on an empty session stays legacy (no blocks are stored)", async () => {
    const h = await setup();
    const s = await h.newSession();
    await h.createId(s, "Legacy Q1");
    const session = await h.sessionOf(s);
    expect(session).not.toHaveProperty("blocks");
    for (const q of session.questions) expect(q).not.toHaveProperty("blockId");
  });

  it("a blockId naming no block of a blocked session is rejected without a write", async () => {
    const h = await setup();
    const s = await h.newSession();
    await h.createId(s, "Q1", { blockId: "b1" });
    const before = await snapshot(h);
    await rejectedWithoutWrite(h, before, await h.create(s, "Q2", { blockId: "b9" }));
  });
});

describe("accepting blocks", () => {
  async function blocked() {
    const h = await setup();
    const s = await h.newSession();
    const q1 = await h.createId(s, "Q1", { blockId: "b1" });
    return { h, s, q1 };
  }

  it("UI acceptance freezes the open block, records a human acceptor and opens the next block", async () => {
    const { h, s } = await blocked();
    const rev = await h.revision();
    const out = ok(await h.accept(s, "b1"));
    expect(out).toMatchObject({ revision: rev + 1, blockId: "b1" });
    expect(typeof out.nextBlockId).toBe("string");
    expect(out.nextBlockId).not.toBe("b1");

    const session = await h.sessionOf(s);
    expect(session.blocks).toHaveLength(2);
    const [first, next] = session.blocks;
    expect(first).toMatchObject({ id: "b1", state: "accepted", acceptedAt: NOW_ISO });
    expect(first.acceptedBy.kind).toBe("human");
    expect(next).toMatchObject({ id: out.nextBlockId, state: "open", openedAt: NOW_ISO });
    expect(next.order).toBeGreaterThan(first.order);
    expect(Session.safeParse(session).success).toBe(true);
  });

  it("a session always has exactly one open block, the highest order, in creation order", async () => {
    const { h, s } = await blocked();
    const second = ok(await h.accept(s, "b1")).nextBlockId;
    await h.createId(s, "Q2", { blockId: second });
    const third = ok(await h.accept(s, second)).nextBlockId;
    const session = await h.sessionOf(s);
    expect(session.blocks.map((b: Json) => b.id)).toEqual(["b1", second, third]);
    const orders = session.blocks.map((b: Json) => b.order);
    expect([...orders].sort((x: number, y: number) => x - y)).toEqual(orders);
    expect(new Set(orders).size).toBe(orders.length);
    const open = session.blocks.filter((b: Json) => b.state === "open");
    expect(open.map((b: Json) => b.id)).toEqual([third]);
    expect(open[0].order).toBe(Math.max(...orders));
    expect(Session.safeParse(session).success).toBe(true);
  });

  it("questions join the new open block by its id", async () => {
    const { h, s } = await blocked();
    const next = ok(await h.accept(s, "b1")).nextBlockId;
    const q2 = await h.createId(s, "Q2", { blockId: next });
    expect((await h.sessionOf(s)).questions.find((q: Json) => q.id === q2).blockId).toBe(next);
  });

  it("the chat (MCP) origin cannot accept a block", async () => {
    const { h, s } = await blocked();
    const before = await snapshot(h);
    const result = await h.accept(s, "b1", chat("Accept the block"));
    expect(err(result).code).toBe("invalid_input");
    await rejectedWithoutWrite(h, before, result);
  });

  it("an already accepted, unknown or legacy-session block is not accepted", async () => {
    const { h, s } = await blocked();
    ok(await h.accept(s, "b1"));
    const legacy = await h.newSession("Legacy");
    await h.createId(legacy, "Legacy Q1");
    const before = await snapshot(h);
    await rejectedWithoutWrite(h, before, await h.accept(s, "b1"));
    await rejectedWithoutWrite(h, before, await h.accept(s, "b9"));
    await rejectedWithoutWrite(h, before, await h.accept(legacy, "b1"));
  });

  it("a stale expectedRevision is a revision_conflict", async () => {
    const { h, s } = await blocked();
    const before = await snapshot(h);
    const result = await h.accept(s, "b1", UI_ORIGIN, before.revision - 1);
    expect(err(result).code).toBe("revision_conflict");
    await rejectedWithoutWrite(h, before, result);
  });

  it("no question can be created in an accepted block", async () => {
    const { h, s } = await blocked();
    ok(await h.accept(s, "b1"));
    const before = await snapshot(h);
    const result = await h.create(s, "Late", { blockId: "b1" });
    expect(err(result).code).toBe("block_frozen");
    await rejectedWithoutWrite(h, before, result);
  });

  it("superseding a frozen decision is a new question linked by supersedes (links are not question edits)", async () => {
    const { h, s, q1 } = await blocked();
    const next = ok(await h.accept(s, "b1")).nextBlockId;
    const q2 = await h.createId(s, "Q1 revisited", { blockId: next });
    const out = await h.commands.linkCreate(h.open, { ...(await h.at()), kind: "supersedes", from: h.ref(s, q2), to: h.ref(s, q1) }, UI_ORIGIN);
    expect(out.ok).toBe(true);
  });
});

describe("frozen questions reject definition and relation mutations with block_frozen; answers stay allowed", () => {
  /**
   * Block b1 (accepted): f1 answered b; f2 answered then made stale by f1 (invalidatedBy f1);
   * f3 unanswered; f4 invalidatedBy f3. Open block: o1, o2 (invalidatedBy o1, stale), o3, o4.
   */
  async function frozen() {
    const h = await setup();
    const s = await h.newSession();
    const r = (id: string) => h.ref(s, id);
    const f1 = await h.createId(s, "F1", { blockId: "b1" });
    const f2 = await h.createId(s, "F2", { blockId: "b1", invalidatedBy: [{ upstream: r(f1) }] });
    const f3 = await h.createId(s, "F3", { blockId: "b1" });
    const f4 = await h.createId(s, "F4", { blockId: "b1", invalidatedBy: [{ upstream: r(f3) }] });
    const answer = async (q: string, optionId: string) =>
      ok(await h.commands.questionAnswer(h.open, { ...(await h.at()), ...r(q), optionId }, UI_ORIGIN));
    await answer(f1, "a");
    await answer(f2, "a");
    await answer(f1, "b");
    expect((await h.sessionOf(s)).questions.find((q: Json) => q.id === f2).validity).toBe("stale");
    const next = ok(await h.accept(s, "b1")).nextBlockId;

    const o1 = await h.createId(s, "O1", { blockId: next });
    const o2 = await h.createId(s, "O2", { blockId: next, invalidatedBy: [{ upstream: r(o1) }] });
    const o3 = await h.createId(s, "O3", { blockId: next });
    const o4 = await h.createId(s, "O4", { blockId: next });
    await answer(o1, "a");
    await answer(o2, "a");
    await answer(o1, "b");
    expect((await h.sessionOf(s)).questions.find((q: Json) => q.id === o2).validity).toBe("stale");
    return { h, s, r, f1, f2, f3, f4, o1, o2, o3, o4 };
  }

  /** Runs `attempt` against a frozen target and expects block_frozen with no write. */
  async function expectFrozen(h: H, attempt: () => Promise<{ ok: boolean }>) {
    const before = await snapshot(h);
    const result = (await attempt()) as Json;
    expect(err(result).code).toBe("block_frozen");
    await rejectedWithoutWrite(h, before, result);
  }

  it("question.update", async () => {
    const t = await frozen();
    await expectFrozen(t.h, async () => t.h.commands.questionUpdate(t.h.open, { ...(await t.h.at()), ...t.r(t.f1), patch: { title: "Edited" } }, UI_ORIGIN));
    ok(await t.h.commands.questionUpdate(t.h.open, { ...(await t.h.at()), ...t.r(t.o1), patch: { title: "Edited" } }, UI_ORIGIN));
  });

  // Answers on accepted blocks: re-answering, confirming, skipping and notes are allowed; the
  // accepted definition is what stays frozen.
  it("question.answer from the UI and from chat is allowed on a frozen question", async () => {
    const t = await frozen();
    const before = definitionOf(await t.h.sessionOf(t.s), t.f1);
    ok(await t.h.commands.questionAnswer(t.h.open, { ...(await t.h.at()), ...t.r(t.f1), optionId: "a" }, UI_ORIGIN));
    ok(await t.h.commands.questionAnswer(t.h.open, { ...(await t.h.at()), ...t.r(t.f3), optionId: "a" }, chat()));
    expect(definitionOf(await t.h.sessionOf(t.s), t.f1)).toBe(before);
    ok(await t.h.commands.questionAnswer(t.h.open, { ...(await t.h.at()), ...t.r(t.o3), optionId: "a" }, UI_ORIGIN));
    ok(await t.h.commands.questionAnswer(t.h.open, { ...(await t.h.at()), ...t.r(t.o4), optionId: "a" }, chat()));
  });

  it("question.confirm of a stale frozen answer is allowed", async () => {
    const t = await frozen();
    ok(await t.h.commands.questionConfirm(t.h.open, { ...(await t.h.at()), ...t.r(t.f2) }, UI_ORIGIN));
    expect((await t.h.sessionOf(t.s)).questions.find((q: Json) => q.id === t.f2).validity).toBe("valid");
    ok(await t.h.commands.questionConfirm(t.h.open, { ...(await t.h.at()), ...t.r(t.o2) }, UI_ORIGIN));
  });

  it("question.skip is allowed on a frozen question", async () => {
    const t = await frozen();
    ok(await t.h.commands.questionSkip(t.h.open, { ...(await t.h.at()), ...t.r(t.f3) }, UI_ORIGIN));
    ok(await t.h.commands.questionSkip(t.h.open, { ...(await t.h.at()), ...t.r(t.o3) }, UI_ORIGIN));
  });

  it("question.discuss from the UI and from chat is allowed on frozen and open questions", async () => {
    const t = await frozen();
    ok(await t.h.commands.questionDiscuss(t.h.open, { ...(await t.h.at()), ...t.r(t.f1), text: "Late note" }, UI_ORIGIN));
    ok(await t.h.commands.questionDiscuss(t.h.open, { ...(await t.h.at()), ...t.r(t.f1), text: "Late note" }, chat()));
    ok(await t.h.commands.questionDiscuss(t.h.open, { ...(await t.h.at()), ...t.r(t.o1), text: "Open note" }, UI_ORIGIN));
    ok(await t.h.commands.questionDiscuss(t.h.open, { ...(await t.h.at()), ...t.r(t.o1), text: "Chat note" }, chat()));
  });

  it("relation.add with a frozen target is block_frozen, from the UI and from chat", async () => {
    const t = await frozen();
    const add = async (relation: Json, origin: WriteOrigin = UI_ORIGIN) => t.h.commands.relationAdd(t.h.open, { ...(await t.h.at()), relation }, origin);
    await expectFrozen(t.h, () => add({ kind: "invalidation", target: t.r(t.f3), invalidation: { upstream: t.r(t.o1) } }));
    await expectFrozen(t.h, () => add({ kind: "activation", target: t.r(t.f3), activation: { parent: t.r(t.o1), optionIds: ["a"] } }));
    await expectFrozen(t.h, () => add({ kind: "invalidation", target: t.r(t.f3), invalidation: { upstream: t.r(t.o1) } }, chat()));
    await expectFrozen(t.h, () => add({ kind: "activation", target: t.r(t.f3), activation: { parent: t.r(t.o1), optionIds: ["a"] } }, chat()));
    // Positive control inside the open block.
    ok(await add({ kind: "invalidation", target: t.r(t.o4), invalidation: { upstream: t.r(t.o3) } }));
  });

  // Approved plan (Task R0.4): relations are frozen when the frozen question is their target. A
  // relation is stored on its target only, so an open question may depend on a frozen parent or
  // upstream, exactly as questionCreate already allows; the frozen question stays byte-identical.
  it("an open target may add and remove an activation and an invalidation on a frozen parent or upstream", async () => {
    const t = await frozen();
    const question = async (id: string): Promise<Json> => (await t.h.sessionOf(t.s)).questions.find((q: Json) => q.id === id);
    const accepted = async () => canonicalJson((await t.h.sessionOf(t.s)).blocks.filter((b: Json) => b.state === "accepted"));
    const frozenBefore = canonicalJson(await question(t.f1));
    const blocksBefore = await accepted();
    const call = async (command: "relationAdd" | "relationRemove", relation: Json, origin: WriteOrigin) =>
      t.h.commands[command](t.h.open, { ...(await t.h.at()), relation }, origin);
    const invalidation = { kind: "invalidation", target: t.r(t.o3), invalidation: { upstream: t.r(t.f1) } };
    const activation = { kind: "activation", target: t.r(t.o4), activation: { parent: t.r(t.f1), optionIds: ["b"] } };

    ok(await call("relationAdd", invalidation, UI_ORIGIN));
    ok(await call("relationAdd", activation, chat()));
    expect((await question(t.o3)).invalidatedBy).toContainEqual({ upstream: t.r(t.f1) });
    expect((await question(t.o4)).activatedBy).toContainEqual({ parent: t.r(t.f1), optionIds: ["b"] });
    expect(canonicalJson(await question(t.f1))).toBe(frozenBefore);
    expect(await accepted()).toBe(blocksBefore);
    // The dependent open question stays answerable.
    ok(await t.h.commands.questionAnswer(t.h.open, { ...(await t.h.at()), ...t.r(t.o4), optionId: "a" }, UI_ORIGIN));

    ok(await call("relationRemove", invalidation, chat()));
    ok(await call("relationRemove", activation, UI_ORIGIN));
    expect((await question(t.o3)).invalidatedBy).not.toContainEqual({ upstream: t.r(t.f1) });
    expect((await question(t.o4)).activatedBy).not.toContainEqual({ parent: t.r(t.f1), optionIds: ["b"] });
    expect(canonicalJson(await question(t.f1))).toBe(frozenBefore);
    expect(await accepted()).toBe(blocksBefore);
  });

  it("relation.remove of a relation with a frozen target is block_frozen", async () => {
    const t = await frozen();
    const remove = async (relation: Json, origin: WriteOrigin = UI_ORIGIN) => t.h.commands.relationRemove(t.h.open, { ...(await t.h.at()), relation }, origin);
    await expectFrozen(t.h, () => remove({ kind: "invalidation", target: t.r(t.f4), invalidation: { upstream: t.r(t.f3) } }));
    await expectFrozen(t.h, () => remove({ kind: "invalidation", target: t.r(t.f4), invalidation: { upstream: t.r(t.f3) } }, chat()));
    // Positive control: an open-block relation is removable.
    ok(await remove({ kind: "invalidation", target: t.r(t.o2), invalidation: { upstream: t.r(t.o1) } }));
  });

  it("rejected definition attempts and allowed answers leave every frozen definition byte-identical", async () => {
    const t = await frozen();
    const frozenIds = [t.f1, t.f2, t.f3, t.f4];
    const pick = async () => {
      const session = await t.h.sessionOf(t.s);
      return frozenIds.map((id) => definitionOf(session, id)).join("\n");
    };
    const before = await pick();
    ok(await t.h.commands.questionAnswer(t.h.open, { ...(await t.h.at()), ...t.r(t.f1), optionId: "a" }, UI_ORIGIN));
    expect(err(await t.h.commands.questionUpdate(t.h.open, { ...(await t.h.at()), ...t.r(t.f2), patch: { context: "x" } }, UI_ORIGIN)).code).toBe("block_frozen");
    ok(await t.h.commands.questionDiscuss(t.h.open, { ...(await t.h.at()), ...t.r(t.f3), text: "x" }, chat()));
    // An allowed edit in the open block does not touch the frozen questions either.
    ok(await t.h.commands.questionAnswer(t.h.open, { ...(await t.h.at()), ...t.r(t.o3), optionId: "b" }, UI_ORIGIN));
    expect(await pick()).toBe(before);
  });
});

describe("legacy sessions", () => {
  it("effectiveBlocks: an active legacy session is one open block, a closed one is one accepted block; nothing is stored", async () => {
    const h = await setup();
    const s = await h.newSession("Legacy");
    await h.createId(s, "Legacy Q1");
    const active = await h.sessionOf(s);
    const before = canonicalJson(active);
    const blocks = effectiveBlocks(active);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].state).toBe("open");
    expect(canonicalJson(active)).toBe(before);
    expect(active).not.toHaveProperty("blocks");

    const closed = { ...active, status: "closed" };
    const closedBlocks = effectiveBlocks(closed);
    expect(closedBlocks).toHaveLength(1);
    expect(closedBlocks[0].state).toBe("accepted");
    expect(await h.sessionOf(s)).not.toHaveProperty("blocks");
  });

  it("effectiveBlocks of a blocked session are its stored blocks", async () => {
    const h = await setup();
    const s = await h.newSession();
    await h.createId(s, "Q1", { blockId: "b1" });
    ok(await h.accept(s, "b1"));
    const session = await h.sessionOf(s);
    expect(effectiveBlocks(session)).toEqual(session.blocks);
  });

  it("a closed legacy session is not frozen by the block rule (today's behaviour)", async () => {
    const h = await setup();
    const s = await h.newSession("Legacy");
    const q1 = await h.createId(s, "Legacy Q1");
    const store = await h.open(P);
    await store.transact(await h.revision(), (d) => {
      d.sessions.find((x) => x.id === s)!.status = "closed";
    });
    const out = await h.commands.questionAnswer(h.open, { ...(await h.at()), sessionId: s, questionId: q1, optionId: "a" }, UI_ORIGIN);
    if (!out.ok) expect(out.error.code).not.toBe("block_frozen");
    expect(out.ok).toBe(true);
    ok(await h.commands.questionDiscuss(h.open, { ...(await h.at()), sessionId: s, questionId: q1, text: "Note" }, chat()));
    const session = await h.sessionOf(s);
    expect(session.status).toBe("closed");
    expect(session).not.toHaveProperty("blocks");
  });

  it("the legacy fixture: blockId is rejected on its sessions, and unrelated block writes change its files only by the backfilled question numbers", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dr-blocks-")));
    roots.push(root);
    await cp(fileURLToPath(new URL("./fixtures/v1-store/", import.meta.url)), join(root, ".decisions"), { recursive: true });
    const FIXTURE_PID = "prj_2d93f94da090e78c";
    const GEN_26 = join(root, ".decisions", "generations", "g-0000000026-01M5FQB4DD1W73S39XF2DVX7V5");
    const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
    const open: StoreOpener = async () => openStore({ storeRoot: root, projectId: FIXTURE_PID, ...storeOptions });
    const commands = createRoadmapCommands({ directory: () => fakeDirectory({ projects: [] }), now: fixedClock, newId: nextId, storeOptions });
    const h = helpers(commands, open, FIXTURE_PID);

    const legacyIds: string[] = (await h.data()).meta.sessionIds;
    const legacyFiles = Object.fromEntries(
      await Promise.all(
        [...legacyIds.map((id) => `sessions/${id}.json`), "plans/01M5FQ20Z7N3GGWZZP76ZEFV79.json"].map(
          async (rel) => [rel, await readFile(join(GEN_26, rel), "utf8")] as const,
        ),
      ),
    );

    const fixtureSession = legacyIds[0];
    const rejected = await h.create(fixtureSession, "Block question", { blockId: "b1" });
    expect(err(rejected).code).toBe("invalid_input");

    const s = await h.newSession("New blocked session");
    await h.createId(s, "Q1", { blockId: "b1" });
    ok(await h.accept(s, "b1"));

    const manifest = JSON.parse(await readFile(join(root, ".decisions", "manifest.json"), "utf8"));
    const current = join(root, ".decisions", "generations", manifest.generation);
    // The first write backfills `number = order + 1` on every question of every session; nothing
    // else in a legacy session file may change, and the plan file keeps its bytes.
    for (const [rel, bytes] of Object.entries(legacyFiles)) {
      const written = await readFile(join(current, rel), "utf8");
      if (!rel.startsWith("sessions/")) {
        expect(written, rel).toBe(bytes);
        continue;
      }
      const session: Json = JSON.parse(written);
      for (const q of session.questions) {
        expect(q.number, `${rel} ${q.id}`).toBe(q.order + 1);
        delete q.number;
      }
      expect(canonicalJson(session), rel).toBe(bytes);
    }
    for (const id of legacyIds) {
      const legacy = (await h.data()).sessions.find((x) => x.id === id)!;
      expect(legacy).not.toHaveProperty("blocks");
      expect(effectiveBlocks(legacy)).toHaveLength(1);
    }
  });
});

describe("views and contracts", () => {
  it("session.get through the commands layer carries the session's blocks and question blockIds", async () => {
    const h = await setup();
    const s = await h.newSession();
    const q1 = await h.createId(s, "Q1", { blockId: "b1" });
    ok(await h.accept(s, "b1"));
    const view = ok(await h.commands.sessionGet(h.open, { projectId: P, sessionId: s }, UI_ORIGIN)) as Json;
    expect(view.session.blocks).toEqual((await h.sessionOf(s)).blocks);
    expect(view.questions.find((x: Json) => x.question.id === q1).question.blockId).toBe("b1");
  });

  it("BlockAccept is the UI contract block.accept { projectId, sessionId, blockId, expectedRevision } → { revision, blockId, nextBlockId }", async () => {
    const { BlockAccept } = await import("../shared/rpc-blocks");
    expect(BlockAccept.name).toBe("block.accept");
    const input = { projectId: P, sessionId: "s1", blockId: "b1", expectedRevision: 3 };
    expect(BlockAccept.input.parse(input)).toEqual(input);
    for (const key of Object.keys(input)) {
      const { [key]: _drop, ...missing } = input as Record<string, unknown>;
      expect(BlockAccept.input.safeParse(missing).success, key).toBe(false);
    }
    expect(BlockAccept.input.safeParse({ ...input, expectedRevision: 0 }).success).toBe(false);
    expect(BlockAccept.input.safeParse({ ...input, blockId: "" }).success).toBe(false);
    const value = { revision: 4, blockId: "b1", nextBlockId: "b2" };
    expect(BlockAccept.output.parse({ ok: true, value })).toEqual({ ok: true, value });
    expect(BlockAccept.output.safeParse({ ok: true, value: { revision: 4, blockId: "b1" } }).success).toBe(false);
    expect(BlockAccept.output.parse({ ok: false, error: { code: "block_frozen", message: "m" } }).ok).toBe(false);
  });

  it("QuestionCreateV2Input is the shipped question.create input plus an optional blockId", async () => {
    const { QuestionCreateV2Input } = await import("../shared/rpc-blocks");
    const shipped = {
      projectId: P,
      expectedRevision: 2,
      sessionId: "s1",
      title: "Q1",
      context: "",
      options: ab,
      allowFreeText: false,
      activatedBy: [],
      invalidatedBy: [],
    };
    expect(QuestionCreate.input.safeParse(shipped).success, "shipped input control").toBe(true);
    expect(QuestionCreateV2Input.parse(shipped)).toEqual(QuestionCreate.input.parse(shipped));
    expect(QuestionCreateV2Input.parse({ ...shipped, blockId: "b1" })).toEqual({ ...QuestionCreate.input.parse(shipped), blockId: "b1" });
    expect(QuestionCreateV2Input.safeParse({ ...shipped, blockId: "" }).success).toBe(false);
    const { title: _t, ...noTitle } = shipped;
    expect(QuestionCreateV2Input.safeParse(noTitle).success).toBe(false);
  });
});

// Owner clarification 2026-10-26 (`.sdd/ui-mockups/r0-4-staleness-disposition.md`, card §5): frozen
// means the accepted content of a question, not its derived validity. An outside upstream change
// may mark a frozen dependent stale through the existing propagation; everything else stays
// byte-identical, and direct definition mutations stay frozen.
describe("derived staleness of frozen questions", () => {
  /** Accepted content of a question: everything except the derived `validity` and `stale`. */
  const content = (q: Json) => {
    const { validity: _v, stale: _s, ...rest } = q;
    return canonicalJson(rest);
  };
  const question = async (h: H, r: Ref): Promise<Json> => (await h.sessionOf(r.sessionId)).questions.find((q: Json) => q.id === r.questionId);
  const blocksOf = async (h: H, sessionId: string) => canonicalJson((await h.sessionOf(sessionId)).blocks.filter((b: Json) => b.state === "accepted"));
  const answer = async (h: H, r: Ref, optionId: string, origin: WriteOrigin = UI_ORIGIN) =>
    h.commands.questionAnswer(h.open, { ...(await h.at()), ...r, optionId }, origin);

  /**
   * Blocked session S: f (block b1, answered a) invalidated by upstream u in another session T,
   * where T is itself blocked and u sits in T's open block. b1 is accepted after f is answered.
   */
  async function crossSession() {
    const h = await setup();
    const T = await h.newSession("Upstream session");
    const u = h.ref(T, await h.createId(T, "U", { blockId: "t1" }));
    ok(await answer(h, u, "a"));
    const S = await h.newSession("Frozen session");
    const f = h.ref(S, await h.createId(S, "F", { blockId: "b1", invalidatedBy: [{ upstream: u }] }));
    ok(await answer(h, f, "a"));
    const next = ok(await h.accept(S, "b1")).nextBlockId;
    const o = h.ref(S, await h.createId(S, "O", { blockId: next }));
    return { h, S, T, u, f, o, next };
  }

  it("a cross-session upstream re-answer succeeds and marks the frozen dependent stale; its content stays identical", async () => {
    const t = await crossSession();
    const before = await question(t.h, t.f);
    expect(before.validity).toBe("valid");
    const blocksBefore = await blocksOf(t.h, t.S);

    const out = ok(await answer(t.h, t.u, "b"));
    expect(out.staleMarked).toContainEqual(t.f);
    const after = await question(t.h, t.f);
    expect(after.validity).toBe("stale");
    expect(after.stale).toEqual({ causeSessionId: t.T, causeQuestionId: t.u.questionId, causeRev: 2, at: NOW_ISO });
    expect(content(after)).toBe(content(before));
    expect(after.answer).toEqual(before.answer);
    expect(after.revisions).toEqual(before.revisions);
    expect(await blocksOf(t.h, t.S)).toBe(blocksBefore);
  });

  it("an open upstream in a later block of the same session: re-answer succeeds and stales the frozen dependent", async () => {
    // No command can relate a frozen question to a later one (both relation ends are frozen), so the
    // relation is written directly into a graph-valid store state, as an import or hand edit could.
    const h = await setup();
    const S = await h.newSession();
    const f = h.ref(S, await h.createId(S, "F", { blockId: "b1" }));
    ok(await answer(h, f, "a"));
    const next = ok(await h.accept(S, "b1")).nextBlockId;
    const u = h.ref(S, await h.createId(S, "U", { blockId: next }));
    ok(await answer(h, u, "a"));
    await (await h.open(P)).transact(await h.revision(), (d) => {
      d.sessions.find((s) => s.id === S)!.questions.find((q) => q.id === f.questionId)!.invalidatedBy.push({ upstream: u });
    });
    const before = await question(h, f);
    const blocksBefore = await blocksOf(h, S);

    const out = ok(await answer(h, u, "b"));
    expect(out.staleMarked).toContainEqual(f);
    const after = await question(h, f);
    expect(after.validity).toBe("stale");
    expect(after.stale).toEqual({ causeSessionId: S, causeQuestionId: u.questionId, causeRev: 2, at: NOW_ISO });
    expect(content(after)).toBe(content(before));
    expect(await blocksOf(h, S)).toBe(blocksBefore);
  });

  it("an upstream definition update succeeds and leaves the frozen dependent's content identical", async () => {
    // The shipped updateDefinition stales only the redefined question itself (when its own answer no
    // longer fits); it does not propagate downstream. The dependent's validity and stale metadata are
    // pinned as current behaviour preserved by the R0.4 correction, not as a ban on a separately
    // approved propagation rule.
    const t = await crossSession();
    const before = await question(t.h, t.f);
    const out = ok(await t.h.commands.questionUpdate(t.h.open, { ...(await t.h.at()), ...t.u, patch: { options: [opt("b"), opt("c")] } }, UI_ORIGIN));
    // question.update reports the strict ref { sessionId, questionId } of the redefined question.
    expect(out.staleMarked).toContainEqual(t.u);
    const after = await question(t.h, t.f);
    expect(content(after)).toBe(content(before));
    expect(before.validity).toBe("valid");
    expect(after.validity).toBe(before.validity);
    expect("stale" in after).toBe("stale" in before);
    expect(after.stale).toEqual(before.stale);
    expect((await question(t.h, t.u)).validity).toBe("stale");
  });

  it("a later unrelated write keeps the frozen content and the recorded stale cause unchanged", async () => {
    const t = await crossSession();
    ok(await answer(t.h, t.u, "b"));
    const stale = await question(t.h, t.f);
    ok(await answer(t.h, t.o, "a"));
    ok(await t.h.commands.questionDiscuss(t.h.open, { ...(await t.h.at()), ...t.o, text: "Unrelated" }, UI_ORIGIN));
    await t.h.newSession("Unrelated");
    expect(canonicalJson(await question(t.h, t.f))).toBe(canonicalJson(stale));
  });

  // Answers on accepted blocks: the owner reviews the now-stale frozen question directly; its
  // definition stays as accepted while a definition edit is still block_frozen.
  it("the now-stale frozen question can be confirmed; its definition stays frozen", async () => {
    const t = await crossSession();
    ok(await answer(t.h, t.u, "b"));
    const definition = definitionOf({ questions: [await question(t.h, t.f)] }, t.f.questionId);
    ok(await t.h.commands.questionConfirm(t.h.open, { ...(await t.h.at()), ...t.f }, chat("Keep it")));
    expect((await question(t.h, t.f)).validity).toBe("valid");
    expect(err(await t.h.commands.questionUpdate(t.h.open, { ...(await t.h.at()), ...t.f, patch: { title: "x" } }, UI_ORIGIN)).code).toBe("block_frozen");
    expect(definitionOf({ questions: [await question(t.h, t.f)] }, t.f.questionId)).toBe(definition);
  });

  it("session.get shows the frozen question stale with its cause", async () => {
    const t = await crossSession();
    ok(await answer(t.h, t.u, "b"));
    const view = ok(await t.h.commands.sessionGet(t.h.open, { projectId: P, sessionId: t.S }, UI_ORIGIN)) as Json;
    const qv = view.questions.find((x: Json) => x.question.id === t.f.questionId);
    expect(qv.status).toBe("stale");
    expect(qv.question.validity).toBe("stale");
    expect(qv.question.stale).toMatchObject({ causeSessionId: t.T, causeQuestionId: t.u.questionId, causeRev: 2 });
    expect(qv.question.blockId).toBe("b1");
  });

  it("next-block questions may depend on a frozen parent: created, answerable, and the parent stays unchanged", async () => {
    const t = await crossSession();
    const parent = canonicalJson(await question(t.h, t.f));
    const activated = h2(t, await t.h.createId(t.S, "Activated by F", { blockId: t.next, activatedBy: [{ parent: t.f, optionIds: ["a"] }] }));
    const invalidated = h2(t, await t.h.createId(t.S, "Invalidated by F", { blockId: t.next, invalidatedBy: [{ upstream: t.f }] }));
    ok(await answer(t.h, activated, "b"));
    ok(await answer(t.h, invalidated, "b"));
    expect((await question(t.h, activated)).answer.optionId).toBe("b");
    expect((await question(t.h, invalidated)).answer.optionId).toBe("b");
    expect(canonicalJson(await question(t.h, t.f))).toBe(parent);
  });
  const h2 = (t: { S: string }, questionId: string): Ref => ({ sessionId: t.S, questionId });

  it("legacy sessions: a closed session's dependent is staled by an upstream change exactly as today", async () => {
    const h = await setup();
    const L = await h.newSession("Legacy");
    const u = h.ref(L, await h.createId(L, "U"));
    const d = h.ref(L, await h.createId(L, "D", { invalidatedBy: [{ upstream: u }] }));
    ok(await answer(h, u, "a"));
    ok(await answer(h, d, "a"));
    await (await h.open(P)).transact(await h.revision(), (draft) => {
      draft.sessions.find((s) => s.id === L)!.status = "closed";
    });
    const out = ok(await answer(h, u, "b"));
    expect(out.staleMarked).toContainEqual(d);
    expect((await question(h, d)).stale).toEqual({ causeSessionId: L, causeQuestionId: u.questionId, causeRev: 2, at: NOW_ISO });
    expect(await h.sessionOf(L)).not.toHaveProperty("blocks");
  });
});

// Redesign Stage R0.6 (task card §7.2/§7.3, §9 items 12 and 14): block-scoped batches (the MCP
// roadmap_ask path) share questionCreate's placement and errors and stay atomic; legacy effective
// blocks are flagged as derived and carry no fabricated timestamps or acceptor.
describe("block-scoped batches", () => {
  const q = (title: string, extra: Record<string, unknown> = {}) => ({
    title,
    context: "",
    options: ab,
    allowFreeText: false,
    activatedBy: [],
    invalidatedBy: [],
    ...extra,
  });
  const batch = async (h: H, sessionId: string, questions: Json[], blockId?: string, origin: WriteOrigin = UI_ORIGIN) =>
    h.commands.questionCreateBatch(
      h.open,
      { projectId: h.projectId, expectedRevision: await h.revision(), sessionId, questions, ...(blockId !== undefined ? { blockId } : {}) } as Json,
      origin,
    );

  it("a batch with blockId converts an empty session; every question joins that block", async () => {
    const h = await setup();
    const s = await h.newSession();
    const out = ok(await batch(h, s, [q("Q1"), q("Q2", { activatedBy: [{ parent: { batchIndex: 0 }, optionIds: ["a"] }] })], "b1"));
    expect(out.questionIds).toHaveLength(2);
    const session = await h.sessionOf(s);
    expect(session.blocks).toEqual([{ id: "b1", order: 0, state: "open", openedAt: NOW_ISO }]);
    expect(session.questions.map((x: Json) => x.blockId)).toEqual(["b1", "b1"]);
    expect(Session.safeParse(session).success).toBe(true);
  });

  it("a batch joins the open block of a blocked session", async () => {
    const h = await setup();
    const s = await h.newSession();
    await h.createId(s, "Q0", { blockId: "b1" });
    const next = ok(await h.accept(s, "b1")).nextBlockId;
    const out = ok(await batch(h, s, [q("Q1"), q("Q2")], next));
    const session = await h.sessionOf(s);
    for (const id of out.questionIds) expect(session.questions.find((x: Json) => x.id === id).blockId).toBe(next);
    expect(session.blocks.map((b: Json) => b.id)).toEqual(["b1", next]);
  });

  it("is atomic: an invalid later question writes nothing, not even the conversion", async () => {
    const h = await setup();
    const s = await h.newSession();
    const before = await snapshot(h);
    const result = await batch(h, s, [q("Q1"), q("Q2", { activatedBy: [{ parent: { batchIndex: 5 }, optionIds: ["a"] }] })], "b1");
    await rejectedWithoutWrite(h, before, result);
    expect(await h.sessionOf(s)).not.toHaveProperty("blocks");
  });

  it("shares questionCreate's placement errors, each without a write", async () => {
    const h = await setup();
    const legacy = await h.newSession("Legacy");
    await h.createId(legacy, "Legacy Q");
    const s = await h.newSession();
    await h.createId(s, "Q0", { blockId: "b1" });
    const next = ok(await h.accept(s, "b1")).nextBlockId;
    const cases: Array<[string, string, string | undefined, string]> = [
      ["blockId on a session with legacy questions", legacy, "b1", "invalid_input"],
      ["no blockId on a blocked session", s, undefined, "invalid_input"],
      ["an unknown block", s, "b9", "invalid_input"],
      ["an accepted block", s, "b1", "block_frozen"],
    ];
    for (const [name, sessionId, blockId, code] of cases) {
      const before = await snapshot(h);
      const result = await batch(h, sessionId, [q("X")], blockId);
      expect(err(result).code, name).toBe(code);
      await rejectedWithoutWrite(h, before, result);
    }
    // Positive control: the open block takes the same batch.
    ok(await batch(h, s, [q("X")], next));
  });

  it("a legacy batch without blockId behaves as before", async () => {
    const h = await setup();
    const s = await h.newSession("Legacy");
    const out = ok(await batch(h, s, [q("Q1"), q("Q2")]));
    const session = await h.sessionOf(s);
    expect(session).not.toHaveProperty("blocks");
    expect(session.questions.map((x: Json) => x.id)).toEqual(out.questionIds);
    for (const x of session.questions) expect(x).not.toHaveProperty("blockId");
  });

  it("MCP roadmap_ask with blockId reaches the same placement, and without it is refused on a blocked session", async () => {
    const h = await setup();
    const s = await h.newSession();
    const ask = buildTools(h.commands).find((t) => t.name === "roadmap_ask")!;
    const run = async (args: Record<string, unknown>) => {
      const parsed = ask.input.safeParse({ expectedRevision: await h.revision(), sessionId: s, questions: [q("Asked")], ...args });
      if (!parsed.success) throw new Error(`roadmap_ask rejected its input: ${parsed.error.message}`);
      return ask.run(parsed.data, { open: h.open, projectId: h.projectId, origin: chat() }) as Promise<Json>;
    };
    ok(await run({ blockId: "b1" }));
    const session = await h.sessionOf(s);
    expect(session.blocks.map((b: Json) => b.id)).toEqual(["b1"]);
    expect(session.questions[0].blockId).toBe("b1");
    const before = await snapshot(h);
    const refused = await run({});
    expect(err(refused).code).toBe("invalid_input");
    await rejectedWithoutWrite(h, before, refused);
  });
});

describe("truthful legacy effective blocks", () => {
  it("a legacy entry is flagged legacy and carries no openedAt, acceptedAt or acceptedBy", async () => {
    const h = await setup();
    const s = await h.newSession("Legacy");
    await h.createId(s, "Legacy Q1");
    const active = await h.sessionOf(s);
    const [open] = effectiveBlocks(active) as Json[];
    expect(open).toEqual({ id: s, order: 0, state: "open", legacy: true });
    const [closed] = effectiveBlocks({ ...active, status: "closed" }) as Json[];
    expect(closed).toEqual({ id: s, order: 0, state: "accepted", legacy: true });
    for (const entry of [open, closed]) for (const key of ["openedAt", "acceptedAt", "acceptedBy"]) expect(entry).not.toHaveProperty(key);
    expect(await h.sessionOf(s)).not.toHaveProperty("blocks");
  });

  it("stored blocks are returned unchanged, without a legacy flag", async () => {
    const h = await setup();
    const s = await h.newSession();
    await h.createId(s, "Q1", { blockId: "b1" });
    ok(await h.accept(s, "b1"));
    const session = await h.sessionOf(s);
    const blocks = effectiveBlocks(session) as Json[];
    expect(blocks).toEqual(session.blocks);
    for (const b of blocks) expect(b).not.toHaveProperty("legacy");
  });
});

// Stage R1.3a (task card §4.1.2, §4.1.3): a cancelled decision is read-only. Each guarded command
// on a cancelled open-block or legacy question is decision_cancelled with no write; on a cancelled
// frozen question block_frozen comes first for definition and relation edits. Every refusal has an uncancelled control of the same
// shape. Allowed operations around a cancelled question leave its content (all fields except the
// derived validity and stale) byte-identical.
describe("R1.3a cancelled decisions are read-only", () => {
  const content = (q: Json) => {
    const { validity: _v, stale: _s, ...rest } = q;
    return canonicalJson(rest);
  };
  /**
   * Blocked session S: f in accepted block b1; open block with upstream u and, for each of x
   * (cancelled) and y (control): answered, then made stale by re-answering u. w (cancelled) and z
   * (control) are unanswered. Legacy session L: lu, lx (cancelled) and ly (control) the same way.
   */
  async function cancelled() {
    const h = await setup();
    const S = await h.newSession("Blocked");
    const r = (id: string) => h.ref(S, id);
    const answer = async (ref: Ref, optionId: string) => ok(await h.commands.questionAnswer(h.open, { ...(await h.at()), ...ref, optionId }, UI_ORIGIN));
    const f = r(await h.createId(S, "F", { blockId: "b1" }));
    await answer(f, "a");
    const next = ok(await h.accept(S, "b1")).nextBlockId;
    const u = r(await h.createId(S, "U", { blockId: next }));
    const x = r(await h.createId(S, "X", { blockId: next, invalidatedBy: [{ upstream: u }] }));
    const y = r(await h.createId(S, "Y", { blockId: next, invalidatedBy: [{ upstream: u }] }));
    const w = r(await h.createId(S, "W", { blockId: next }));
    const z = r(await h.createId(S, "Z", { blockId: next }));
    await answer(u, "a");
    await answer(x, "a");
    await answer(y, "a");
    await answer(u, "b");
    const L = await h.newSession("Legacy");
    const lu = h.ref(L, await h.createId(L, "LU"));
    const lx = h.ref(L, await h.createId(L, "LX", { invalidatedBy: [{ upstream: lu }] }));
    const ly = h.ref(L, await h.createId(L, "LY", { invalidatedBy: [{ upstream: lu }] }));
    await answer(lu, "a");
    await answer(lx, "a");
    await answer(ly, "a");
    await answer(lu, "b");
    const cancel = async (ref: Ref, reason = "No longer needed") =>
      ok(await h.commands.decisionCancel(h.open, { ...(await h.at()), ...ref, reason } as Json, UI_ORIGIN));
    for (const ref of [f, x, w, lx]) await cancel(ref);
    for (const ref of [x, y, lx, ly]) expect((await question(h, ref)).validity).toBe("stale");
    return { h, S, L, f, u, x, y, w, z, lu, lx, ly, answer };
  }
  const question = async (h: H, ref: Ref): Promise<Json> => (await h.sessionOf(ref.sessionId)).questions.find((q: Json) => q.id === ref.questionId);
  async function expectCode(h: H, code: string, attempt: () => Promise<{ ok: boolean }>) {
    const before = await snapshot(h);
    const result = (await attempt()) as Json;
    expect(err(result).code).toBe(code);
    await rejectedWithoutWrite(h, before, result);
  }

  it("question.update, answer and discuss: decision_cancelled on cancelled open and legacy questions, from the UI and chat; controls succeed", async () => {
    const t = await cancelled();
    const update = async (ref: Ref) => t.h.commands.questionUpdate(t.h.open, { ...(await t.h.at()), ...ref, patch: { title: "Edited" } }, UI_ORIGIN);
    const answerOf = async (ref: Ref, origin: WriteOrigin) => t.h.commands.questionAnswer(t.h.open, { ...(await t.h.at()), ...ref, optionId: "b" }, origin);
    const discuss = async (ref: Ref, origin: WriteOrigin) => t.h.commands.questionDiscuss(t.h.open, { ...(await t.h.at()), ...ref, text: "Note" }, origin);
    for (const target of [t.x, t.lx]) {
      await expectCode(t.h, "decision_cancelled", () => update(target));
      await expectCode(t.h, "decision_cancelled", () => answerOf(target, UI_ORIGIN));
      await expectCode(t.h, "decision_cancelled", () => answerOf(target, chat()));
      await expectCode(t.h, "decision_cancelled", () => discuss(target, UI_ORIGIN));
      await expectCode(t.h, "decision_cancelled", () => discuss(target, chat()));
    }
    for (const control of [t.y, t.ly]) {
      ok(await discuss(control, chat()));
      ok(await update(control));
      ok(await answerOf(control, UI_ORIGIN));
    }
  });

  it("question.confirm of a stale cancelled answer and question.skip of a cancelled unanswered question are decision_cancelled; controls succeed", async () => {
    const t = await cancelled();
    const confirm = async (ref: Ref) => t.h.commands.questionConfirm(t.h.open, { ...(await t.h.at()), ...ref }, UI_ORIGIN);
    const skip = async (ref: Ref) => t.h.commands.questionSkip(t.h.open, { ...(await t.h.at()), ...ref }, UI_ORIGIN);
    await expectCode(t.h, "decision_cancelled", () => confirm(t.x));
    await expectCode(t.h, "decision_cancelled", () => confirm(t.lx));
    await expectCode(t.h, "decision_cancelled", () => skip(t.w));
    ok(await confirm(t.y));
    ok(await confirm(t.ly));
    ok(await skip(t.z));
  });

  it("relation.add and relation.remove with a cancelled target are decision_cancelled; the same on an uncancelled target succeed", async () => {
    const t = await cancelled();
    const add = async (relation: Json) => t.h.commands.relationAdd(t.h.open, { ...(await t.h.at()), relation }, UI_ORIGIN);
    const remove = async (relation: Json) => t.h.commands.relationRemove(t.h.open, { ...(await t.h.at()), relation }, UI_ORIGIN);
    await expectCode(t.h, "decision_cancelled", () => add({ kind: "activation", target: t.w, activation: { parent: t.z, optionIds: ["a"] } }));
    await expectCode(t.h, "decision_cancelled", () => remove({ kind: "invalidation", target: t.x, invalidation: { upstream: t.u } }));
    await expectCode(t.h, "decision_cancelled", () => remove({ kind: "invalidation", target: t.lx, invalidation: { upstream: t.lu } }));
    ok(await add({ kind: "activation", target: t.z, activation: { parent: t.u, optionIds: ["a"] } }));
    ok(await remove({ kind: "invalidation", target: t.y, invalidation: { upstream: t.u } }));
  });

  // Answers on accepted blocks: on a frozen cancelled question, definition and relation edits are
  // still block_frozen first; answers, notes, skips and confirmations, which a frozen question now
  // allows, are refused because the decision is cancelled.
  it("a frozen cancelled question: block_frozen for definition and relation edits, decision_cancelled for the answer commands", async () => {
    const t = await cancelled();
    const at = async () => ({ ...(await t.h.at()), ...t.f });
    await expectCode(t.h, "block_frozen", async () => t.h.commands.questionUpdate(t.h.open, { ...(await at()), patch: { title: "x" } }, UI_ORIGIN));
    await expectCode(t.h, "decision_cancelled", async () => t.h.commands.questionAnswer(t.h.open, { ...(await at()), optionId: "b" }, UI_ORIGIN));
    await expectCode(t.h, "decision_cancelled", async () => t.h.commands.questionDiscuss(t.h.open, { ...(await at()), text: "x" }, chat()));
    await expectCode(t.h, "decision_cancelled", async () => t.h.commands.questionSkip(t.h.open, { ...(await at()) }, UI_ORIGIN));
    await expectCode(t.h, "decision_cancelled", async () => t.h.commands.questionConfirm(t.h.open, { ...(await at()) }, UI_ORIGIN));
    await expectCode(t.h, "block_frozen", async () =>
      t.h.commands.relationAdd(t.h.open, { ...(await t.h.at()), relation: { kind: "activation", target: t.f, activation: { parent: t.u, optionIds: ["a"] } } }, UI_ORIGIN),
    );
    await expectCode(t.h, "block_frozen", async () =>
      t.h.commands.relationRemove(t.h.open, { ...(await t.h.at()), relation: { kind: "invalidation", target: t.f, invalidation: { upstream: t.u } } }, UI_ORIGIN),
    );
  });

  it("allowed around a cancelled question: an open target with a cancelled upstream, a dependent create, a supersedes link and an upstream re-answer; cancelled content stays byte-identical", async () => {
    const t = await cancelled();
    const watched = [t.x, t.w, t.lx, t.f];
    const contents = async () => Promise.all(watched.map(async (ref) => content(await question(t.h, ref))));
    const before = await contents();
    const cancellations = canonicalJson((await t.h.data()).meta.cancellations);
    // Open target whose upstream is cancelled.
    ok(await t.h.commands.relationAdd(t.h.open, { ...(await t.h.at()), relation: { kind: "invalidation", target: t.z, invalidation: { upstream: t.x } } }, UI_ORIGIN));
    // A new question depending on a cancelled one.
    const next = (await t.h.sessionOf(t.S)).blocks.find((b: Json) => b.state === "open").id;
    ok(await t.h.create(t.S, "Dependent", { blockId: next, activatedBy: [{ parent: t.x, optionIds: ["a"] }] }));
    // A replacement decision linked by supersedes.
    const replacement = t.h.ref(t.S, await t.h.createId(t.S, "Replacement", { blockId: next }));
    ok(await t.h.commands.linkCreate(t.h.open, { ...(await t.h.at()), kind: "supersedes", from: replacement, to: t.x }, UI_ORIGIN));
    // An upstream re-answer may stale the cancelled question (derived fields only).
    await t.answer(t.u, "a");
    await t.answer(t.lu, "a");
    expect(await contents()).toEqual(before);
    expect(canonicalJson((await t.h.data()).meta.cancellations)).toBe(cancellations);
  });
});
