// Task U2 (plan 2026-11-09 rev 2, §2.2, §4 U2, §6 D1): the owner's acknowledgement of the
// no-translation notice is stored on the session per language, written only by the owner's Got it
// press through the UI-only RPC `session.language_notice.ack`, revision-checked and idempotent for
// the same language. It changes nothing else: no question, block, approval input or other field.
// The current Session schema and the strict wire view accept it; the legacy strict SessionV1 and
// RoadmapDataV1 still reject it, so stores that never acknowledged a notice stay readable by older
// plugin versions.
//
// Real temp store and the real handler registration (the RPC is reached by its contract name, as the
// host routes it). No model or live host.
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { RoadmapData, RoadmapDataV1, Session, SessionV1 } from "../shared/model";
import { canonicalJson } from "../shared/canonical";
import { SessionViewSession } from "../shared/rpc";
import { SessionLanguageNoticeAck } from "../shared/rpc-grilling";
import { registerHandlers } from "./handlers";
import { buildTools } from "./mcp-tools";
import { createRoadmapCommands, createRoadmapService, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openProjectStore } from "./store-root";
import { NOW, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { manualFinish } from "./test-support/finish";
import { BLK_OPEN } from "./test-support/grilling";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ACK = "session.language_notice.ack";

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** The stored or viewed acknowledgement, read without depending on the field's production type. */
const ackOf = (session: unknown): unknown => z.looseObject({ languageNoticeAck: z.unknown().optional() }).parse(session).languageNoticeAck;
const Res = z.union([z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: z.looseObject({ code: z.string() }) })]);

async function setup() {
  project = await makeProject();
  const proj = project;
  let clock = new Date(NOW);
  const now = () => clock;
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: proj.root, projectKind: "git" }] });
  const storeOptions = { now, newId: nextId, log: () => undefined };
  const service = createRoadmapService({ directory: () => dir, now, newId: nextId, storeOptions });
  const commands = createRoadmapCommands({ directory: () => dir, now, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  const paseo = proj.paseo;
  // The handlers as the host registers them, keyed by contract name.
  const handlers = new Map<string, (input: unknown, ctx: { paseo: PaseoApi }) => Promise<unknown>>();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a synthetic registration surface: only `handle` exists
  registerHandlers({ handle: (contract: { name: string }, fn: (input: unknown, ctx: { paseo: PaseoApi }) => Promise<unknown>) => void handlers.set(contract.name, fn) } as never, service);
  ok(await service.init(paseo, { projectId: P }));
  const revision = async () => ok(await service.version(paseo, { projectId: P })).revision!;
  const sessionId = ok(await service.sessionCreate(paseo, { projectId: P, expectedRevision: await revision(), title: "[feature] Login" })).sessionId;
  ok(await commands.questionCreateBatch(open, { projectId: P, expectedRevision: await revision(), sessionId, blockId: BLK_OPEN, questions: [{ title: "Q1", context: "", options: [opt("a")], allowFreeText: false, activatedBy: [], invalidatedBy: [] }] }, { source: "chat", actor: { kind: "agent" } }));
  const stored = async () => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected an ok store, got ${read.status}`);
    return read.data.sessions.find((s) => s.id === sessionId)!;
  };
  const ack = async (language: string, expectedRevision?: number) => {
    const handler = handlers.get(ACK);
    if (handler === undefined) throw new Error(`no handler registered for ${ACK}`);
    return Res.parse(await handler({ projectId: P, expectedRevision: expectedRevision ?? (await revision()), sessionId, language }, { paseo }));
  };
  return { service, commands, open, paseo, revision, sessionId, stored, ack, later: (ms: number) => (clock = new Date(NOW.getTime() + ms)) };
}

describe("session.language_notice.ack", () => {
  it("stores the acknowledged language with its time, and nothing else on the session changes", async () => {
    const t = await setup();
    const before = await t.stored();
    expect(before).not.toHaveProperty("languageNoticeAck");
    const out = await t.ack("Русский");
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const after = await t.stored();
    expect(ackOf(after)).toEqual({ language: "Русский", at: NOW.toISOString() });
    expect(Object.fromEntries(Object.entries(after).filter(([k]) => k !== "languageNoticeAck"))).toEqual(before);
  });

  it("is revision-checked: a stale revision is refused and writes nothing", async () => {
    const t = await setup();
    const stale = (await t.revision()) - 1;
    const out = await t.ack("Русский", stale);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("revision_conflict");
    expect(await t.stored()).not.toHaveProperty("languageNoticeAck");
  });

  it("is idempotent for the same language and records a different label anew", async () => {
    const t = await setup();
    expect((await t.ack("Русский")).ok).toBe(true);
    t.later(60_000);
    expect((await t.ack("Русский")).ok).toBe(true);
    expect(ackOf(await t.stored())).toEqual({ language: "Русский", at: NOW.toISOString() });
    expect((await t.ack("Deutsch")).ok).toBe(true);
    expect(ackOf(await t.stored())).toEqual({ language: "Deutsch", at: new Date(NOW.getTime() + 60_000).toISOString() });
  });

  it("the session view carries the stored acknowledgement verbatim, and omits it when absent", async () => {
    const t = await setup();
    expect(ok(await t.service.sessionGet(t.paseo, { projectId: P, sessionId: t.sessionId })).session).not.toHaveProperty("languageNoticeAck");
    expect((await t.ack("Русский")).ok).toBe(true);
    expect(ackOf(ok(await t.service.sessionGet(t.paseo, { projectId: P, sessionId: t.sessionId })).session)).toEqual({ language: "Русский", at: NOW.toISOString() });
  });

  it("no chat tool writes it and other commands leave it as it is", async () => {
    const t = await setup();
    const names = buildTools(t.commands).map((tool) => tool.name);
    expect(names.filter((n) => /language/i.test(n))).toEqual([]);
    expect((await t.ack("Русский")).ok).toBe(true);
    const [q] = (await t.stored()).questions;
    ok(await t.commands.questionAnswer(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, questionId: q.id, optionId: "a" }, UI_ORIGIN));
    ok(await t.commands.sessionFinish(t.open, manualFinish(P, await t.revision(), t.sessionId), UI_ORIGIN));
    ok(await t.commands.sessionReopen(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId }, UI_ORIGIN));
    expect(ackOf(await t.stored())).toEqual({ language: "Русский", at: NOW.toISOString() });
  });
});

describe("the acknowledgement in the schemas", () => {
  const base = { id: "S", title: "S", createdAt: NOW.toISOString(), status: "active" as const, questions: [] };
  const ackValue = { language: "Русский", at: NOW.toISOString() };

  it("the current Session accepts it with language and time; a session without it reads as not acknowledged", () => {
    expect(Session.safeParse({ ...base, languageNoticeAck: ackValue }).success).toBe(true);
    expect(Session.safeParse({ ...base, languageNoticeAck: { language: "Русский" } }).success).toBe(false);
    expect(Session.parse(base)).not.toHaveProperty("languageNoticeAck");
  });

  it("the strict legacy SessionV1 and RoadmapDataV1 still reject it", () => {
    expect(SessionV1.safeParse({ ...base, languageNoticeAck: ackValue }).success).toBe(false);
    expect(SessionV1.safeParse(base).success).toBe(true);
    const v1 = (sessions: unknown[]) => ({ meta: { version: 1, projectId: P, createdAt: NOW.toISOString(), links: [], sessionIds: ["S"], planIds: [] }, sessions, plans: [] });
    expect(RoadmapDataV1.safeParse(v1([base])).success).toBe(true);
    expect(RoadmapDataV1.safeParse(v1([{ ...base, languageNoticeAck: ackValue }])).success).toBe(false);
  });

  it("the strict wire view accepts it and still rejects an unknown sibling", () => {
    const view = { id: "S", title: "S", createdAt: NOW.toISOString(), status: "active" as const };
    expect(SessionViewSession.parse({ ...view, languageNoticeAck: ackValue })).toEqual({ ...view, languageNoticeAck: ackValue });
    expect(SessionViewSession.parse(view)).toEqual(view);
    expect(SessionViewSession.safeParse({ ...view, languageNoticeAck: ackValue, languageNoticeAckedBy: "x" }).success).toBe(false);
  });
});

// Round trips: an acknowledged session is written to and read back from the store unchanged by a
// fresh store instance (the current schema re-parses its own output), and the view's session passes
// the strict wire schema verbatim.
describe("the acknowledgement round-trips", () => {
  it("through the store and a fresh read, and through the strict wire view", async () => {
    const t = await setup();
    expect((await t.ack("Русский")).ok).toBe(true);
    const read = await (await t.open(P)).read();
    if (read.status !== "ok") throw new Error(`expected an ok store, got ${read.status}`);
    expect(canonicalJson(RoadmapData.parse(read.data))).toBe(canonicalJson(read.data));
    const again = await (await t.open(P)).read();
    if (again.status !== "ok") throw new Error(`expected an ok store, got ${again.status}`);
    expect(canonicalJson(again.data)).toBe(canonicalJson(read.data));
    const view = ok(await t.service.sessionGet(t.paseo, { projectId: P, sessionId: t.sessionId }));
    expect(SessionViewSession.parse(view.session)).toEqual(view.session);
    expect(ackOf(view.session)).toEqual({ language: "Русский", at: NOW.toISOString() });
  });

  it("a store without any acknowledgement reads and re-parses unchanged", async () => {
    const t = await setup();
    const read = await (await t.open(P)).read();
    if (read.status !== "ok") throw new Error(`expected an ok store, got ${read.status}`);
    expect(JSON.stringify(read.data)).not.toContain("languageNoticeAck");
    expect(canonicalJson(RoadmapData.parse(read.data))).toBe(canonicalJson(read.data));
  });
});

// c294f12: an earlier session's effective language can be the free-text answer of its language
// question, longer than a configured label, so the acknowledgement takes any non-empty label; an
// empty label is never acknowledged.
describe("long and empty acknowledged labels", () => {
  const LONG = "Русский, с примерами на английском для технических терминов и названий компонентов";

  it("the RPC input and the stored and wire schemas take a long label and refuse an empty one", () => {
    const input = { projectId: P, expectedRevision: 3, sessionId: "S" };
    expect(LONG.length).toBeGreaterThan(40);
    expect(SessionLanguageNoticeAck.input.safeParse({ ...input, language: LONG }).success).toBe(true);
    expect(SessionLanguageNoticeAck.input.safeParse({ ...input, language: "" }).success).toBe(false);
    const base = { id: "S", title: "S", createdAt: NOW.toISOString(), status: "active" as const, questions: [] };
    expect(Session.safeParse({ ...base, languageNoticeAck: { language: LONG, at: NOW.toISOString() } }).success).toBe(true);
    expect(Session.safeParse({ ...base, languageNoticeAck: { language: "", at: NOW.toISOString() } }).success).toBe(false);
    const view = { id: "S", title: "S", createdAt: NOW.toISOString(), status: "active" as const };
    expect(SessionViewSession.safeParse({ ...view, languageNoticeAck: { language: LONG, at: NOW.toISOString() } }).success).toBe(true);
  });

  it("the command stores a long label verbatim and the view carries it", async () => {
    const t = await setup();
    expect((await t.ack(LONG)).ok).toBe(true);
    expect(ackOf(await t.stored())).toEqual({ language: LONG, at: NOW.toISOString() });
    expect(ackOf(ok(await t.service.sessionGet(t.paseo, { projectId: P, sessionId: t.sessionId })).session)).toEqual({ language: LONG, at: NOW.toISOString() });
  });
});

// Only the Paseo UI acknowledges the notice; a chat origin is refused and writes nothing.
describe("the acknowledgement is UI-only", () => {
  it("a chat origin is refused with invalid_input and nothing is stored", async () => {
    const t = await setup();
    const out = await t.commands.sessionLanguageNoticeAck(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId: t.sessionId, language: "Русский" }, { source: "chat", actor: { kind: "agent" } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("invalid_input");
    expect(ackOf(await t.stored())).toBeUndefined();
    expect((await t.ack("Русский")).ok, "the UI route still acknowledges").toBe(true);
  });
});
