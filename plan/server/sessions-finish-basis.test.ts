// The basis of a session finish: accepting the chat's open proposal and the owner's manual finish
// are recorded apart. Each close appends one closure { at, basis, proposalAt?, source, actor };
// the proposal standing at close time gets finishedAt and finishedBy; a proposal finished earlier is
// never touched again. Only session.reopen may stamp reopenedAt, once, on the last closure; any other
// change to the closures is refused and writes nothing. The revision check precedes every semantic
// check. Commands run over real temp stores with a settable clock.
//
// Inputs come from test-support functions so the new fields type-check before and after the
// contract changes; malformed inputs are made by deleting or overwriting fields at run time. New
// stored fields are read with matchers or `Reflect`, never through typed properties.
//
// The guard cases change the draft from inside the command: the commands' clock is read by the
// transaction after it has taken its guard snapshot and before the command runs, so a change made
// there is indistinguishable from one made by the command itself.
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import type { RoadmapData, Session } from "../shared/model";
import { SessionView, type Result } from "../shared/rpc";
import { buildTools } from "./mcp-tools";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import type { Store } from "./store";
import { openProjectStore } from "./store-root";
import { fixedClock, isJsonObject, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { manualFinish, proposalFinish } from "./test-support/finish";
import { binding, BLK_OPEN, continuationIn, OP, PLANNER, seedGrilling } from "./test-support/grilling";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const T_PROPOSE = "2026-11-09T10:00:00.000Z";
const T_FINISH = "2026-11-09T10:05:00.000Z";
const T_REOPEN = "2026-11-09T10:10:00.000Z";
const T_PROPOSE_2 = "2026-11-09T10:15:00.000Z";
const T_FINISH_2 = "2026-11-09T10:20:00.000Z";
const T_REOPEN_2 = "2026-11-09T10:25:00.000Z";
const T_LATER = "2026-11-09T10:30:00.000Z";
const SUMMARY = "Nothing left to ask.";
const HUMAN = { kind: "human" };

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

type Tamper = (draft: RoadmapData) => void;

async function setup() {
  project = await makeProject();
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };

  let clock = new Date(T_PROPOSE);
  let captured: RoadmapData | undefined;
  let tamper: Tamper | undefined;
  let tamperRan = false;
  const now = () => {
    const t = tamper;
    tamper = undefined;
    if (t !== undefined) {
      if (captured === undefined) throw new Error("the clock was read outside a transaction");
      t(captured);
      tamperRan = true;
    }
    return clock;
  };
  const wrap = (s: Store): Store => ({
    storeRoot: s.storeRoot,
    projectId: s.projectId,
    init: () => s.init(),
    read: () => s.read(),
    version: () => s.version(),
    transact: async <R>(expectedRevision: number, fn: (draft: RoadmapData) => R) => {
      try {
        return await s.transact(expectedRevision, (draft) => {
          captured = draft;
          return fn(draft);
        });
      } finally {
        captured = undefined;
      }
    },
  });
  const commands = createRoadmapCommands({ directory: () => dir, now, newId: nextId, storeOptions });
  const open: StoreOpener = async (projectId) => wrap(await openProjectStore(dir, projectId, storeOptions));
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const tools = buildTools(commands);
  const tool = (name: string) => {
    const found = tools.find((x) => x.name === name);
    if (found === undefined) throw new Error(`tool ${name} missing`);
    return found;
  };

  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const data = async (): Promise<RoadmapData> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  const stored = async (sessionId: string): Promise<Session> => {
    const s = (await data()).sessions.find((x) => x.id === sessionId);
    if (s === undefined) throw new Error(`session ${sessionId} not found`);
    return s;
  };
  /** The stored closures as plain objects; an empty list when the field is absent. */
  const closures = async (sessionId: string): Promise<Array<Record<string, unknown>>> => {
    const raw: unknown = Reflect.get(await stored(sessionId), "closures");
    return Array.isArray(raw) ? raw.filter(isJsonObject) : [];
  };
  const view = async (sessionId: string) => ok(await commands.sessionGet(open, { projectId: P, sessionId }, UI_ORIGIN));
  const at = (iso: string) => {
    clock = new Date(iso);
  };
  const arm = (t: Tamper) => {
    tamper = t;
    tamperRan = false;
  };
  const tampered = () => tamperRan;

  /** A session with one block and a bound planner. */
  const plannerSession = async () => {
    const sessionId = ok(await commands.sessionCreate(open, { projectId: P, expectedRevision: await revision(), title: "Discussion" }, UI_ORIGIN)).sessionId;
    const questionId = ok(
      await commands.questionCreate(
        open,
        { projectId: P, expectedRevision: await revision(), sessionId, title: "Which store?", context: "", options: [opt("a"), opt("b")], allowFreeText: false, activatedBy: [], invalidatedBy: [], blockId: BLK_OPEN },
        UI_ORIGIN,
      ),
    ).questionId;
    await seedGrilling(open, P, sessionId, { planner: binding() });
    return { sessionId, questionId };
  };
  const propose = async (sessionId: string, when: string, summary = SUMMARY) => {
    at(when);
    const chat: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: PLANNER } };
    return tool("roadmap_grill_propose_finish").run({ expectedRevision: await revision(), sessionId, summary }, { open, projectId: P, origin: chat, agentId: PLANNER, workspaceId: "ws-1" });
  };
  const finishManual = async (sessionId: string, when: string, origin: WriteOrigin = UI_ORIGIN, expectedRevision?: number) => {
    at(when);
    return commands.sessionFinish(open, manualFinish(P, expectedRevision ?? (await revision()), sessionId), origin);
  };
  const finishProposal = async (sessionId: string, proposalAt: string, when: string, origin: WriteOrigin = UI_ORIGIN, expectedRevision?: number) => {
    at(when);
    return commands.sessionFinish(open, proposalFinish(P, expectedRevision ?? (await revision()), sessionId, proposalAt), origin);
  };
  const reopen = async (sessionId: string, when: string, expectedRevision?: number) => {
    at(when);
    return commands.sessionReopen(open, { projectId: P, expectedRevision: expectedRevision ?? (await revision()), sessionId }, UI_ORIGIN);
  };
  const answer = async (sessionId: string, questionId: string, optionId: string, when: string) => {
    at(when);
    return commands.questionAnswer(open, { projectId: P, expectedRevision: await revision(), sessionId, questionId, optionId }, UI_ORIGIN);
  };
  /** Writes session fields directly, for states no command produces (an earlier version's close). */
  const seedSession = async (sessionId: string, patch: Partial<Session>) => {
    const store = await open(P);
    await store.transact(await revision(), (draft) => {
      const s = draft.sessions.find((x) => x.id === sessionId)!;
      Object.assign(s, patch);
    });
  };
  return {
    commands, open, tool, revision, data, snapshot, stored, closures, view, at, arm, tampered,
    plannerSession, propose, finishManual, finishProposal, reopen, answer, seedSession,
  };
}

type T = Awaited<ReturnType<typeof setup>>;

async function expectRefusedWithoutWrite(t: T, before: { revision: number; text: string }, res: Result<unknown>, code: string) {
  expect(err(res).code).toBe(code);
  expect(await t.snapshot()).toEqual(before);
}

const isObjectList = (v: unknown): v is Array<Record<string, unknown>> => Array.isArray(v) && v.every(isJsonObject);

/**
 * The draft session's own closure array, not a copy, so removing or appending entries changes the
 * draft; throws when there is none to change or an entry is not an object.
 */
function draftClosures(draft: RoadmapData, sessionId: string): Array<Record<string, unknown>> {
  const s = draft.sessions.find((x) => x.id === sessionId);
  const raw: unknown = s === undefined ? undefined : Reflect.get(s, "closures");
  if (!isObjectList(raw) || raw.length === 0) throw new Error("no closures to tamper with");
  return raw;
}

describe("session.finish re-validates its input at the command", () => {
  it("a missing or unknown basis, a proposal basis without proposalAt and a manual basis with proposalAt are invalid_input and write nothing (no manual fallback)", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE));
    const before = await t.snapshot();
    t.at(T_FINISH);

    const missingBasis = manualFinish(P, before.revision, sessionId);
    Reflect.deleteProperty(missingBasis, "basis");
    const unknownBasis = Object.assign(manualFinish(P, before.revision, sessionId), { basis: "automatic" });
    const proposalWithoutAt = proposalFinish(P, before.revision, sessionId, T_PROPOSE);
    Reflect.deleteProperty(proposalWithoutAt, "proposalAt");
    const manualWithAt = Object.assign(manualFinish(P, before.revision, sessionId), { proposalAt: T_PROPOSE });
    const badProposalAt = proposalFinish(P, before.revision, sessionId, "yesterday");

    for (const [label, input] of [
      ["missing basis", missingBasis],
      ["unknown basis", unknownBasis],
      ["proposal without proposalAt", proposalWithoutAt],
      ["manual with proposalAt", manualWithAt],
      ["proposalAt not an ISO time", badProposalAt],
    ] as const) {
      const res = await t.commands.sessionFinish(t.open, input, UI_ORIGIN);
      expect(res.ok, label).toBe(false);
      expect(err(res).code, label).toBe("invalid_input");
    }
    expect(await t.snapshot()).toEqual(before);
    expect((await t.stored(sessionId)).status).toBe("active");
  });
});

describe("accepting the chat's proposal", () => {
  it("closes the session, marks the open proposal finishedAt and finishedBy proposal, and appends one proposal closure from the UI and the human actor", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE));
    const before = await t.revision();
    ok(await t.finishProposal(sessionId, T_PROPOSE, T_FINISH));
    expect(await t.revision()).toBe(before + 1);

    const s = await t.stored(sessionId);
    expect(s.status).toBe("closed");
    expect(s.finishProposal).toMatchObject({ at: T_PROPOSE, summary: SUMMARY, finishedAt: T_FINISH, finishedBy: "proposal" });
    expect(await t.closures(sessionId)).toEqual([{ at: T_FINISH, basis: "proposal", proposalAt: T_PROPOSE, source: "ui", actor: HUMAN }]);
    expect(JSON.stringify(await t.closures(sessionId))).not.toContain("hostClientId");

    const v = await t.view(sessionId);
    expect(v.grilling?.finishProposal).toBeUndefined();
    expect(v.session).toMatchObject({ closures: [{ at: T_FINISH, basis: "proposal", proposalAt: T_PROPOSE }] });
    expect(SessionView.safeParse(v).success).toBe(true);
  });
});

describe("semantic refusals at the current revision, revision_conflict at a stale one", () => {
  it("a proposal basis whose proposalAt is not the open proposal's is invalid_input naming the changed proposal, and writes nothing", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE, "First"));
    ok(await t.propose(sessionId, T_PROPOSE_2, "Replacement"));
    const before = await t.snapshot();
    const res = await t.finishProposal(sessionId, T_PROPOSE, T_FINISH);
    expect(err(res).message).toMatch(/proposal changed/i);
    await expectRefusedWithoutWrite(t, before, res, "invalid_input");
  });

  it("a proposal basis without any proposal, or after the proposal was already finished, is invalid_input and writes nothing", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    let before = await t.snapshot();
    await expectRefusedWithoutWrite(t, before, await t.finishProposal(sessionId, T_PROPOSE, T_FINISH), "invalid_input");

    ok(await t.propose(sessionId, T_PROPOSE));
    ok(await t.finishProposal(sessionId, T_PROPOSE, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    before = await t.snapshot();
    await expectRefusedWithoutWrite(t, before, await t.finishProposal(sessionId, T_PROPOSE, T_LATER), "invalid_input");
  });

  it("a manual finish of an already closed session is invalid_input saying it is already closed, and writes nothing", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.finishManual(sessionId, T_FINISH));
    const before = await t.snapshot();
    const res = await t.finishManual(sessionId, T_LATER);
    expect(err(res).message).toMatch(/already closed/i);
    await expectRefusedWithoutWrite(t, before, res, "invalid_input");
  });

  it("a proposal finish of an already closed session is invalid_input saying it is already closed, and writes nothing", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE));
    ok(await t.finishManual(sessionId, T_FINISH));
    const before = await t.snapshot();
    const res = await t.finishProposal(sessionId, T_PROPOSE, T_LATER);
    expect(err(res).message).toMatch(/already closed/i);
    await expectRefusedWithoutWrite(t, before, res, "invalid_input");
  });

  it("at a stale revision the same inputs are revision_conflict before any semantic check, and write nothing", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE));
    ok(await t.propose(sessionId, T_PROPOSE_2));
    const stale = (await t.revision()) - 1;
    let before = await t.snapshot();
    await expectRefusedWithoutWrite(t, before, await t.finishProposal(sessionId, T_PROPOSE, T_FINISH, UI_ORIGIN, stale), "revision_conflict");
    await expectRefusedWithoutWrite(t, before, await t.finishProposal(sessionId, T_PROPOSE_2, T_FINISH, UI_ORIGIN, stale), "revision_conflict");

    ok(await t.finishManual(sessionId, T_FINISH));
    const staleClosed = (await t.revision()) - 1;
    before = await t.snapshot();
    await expectRefusedWithoutWrite(t, before, await t.finishManual(sessionId, T_LATER, UI_ORIGIN, staleClosed), "revision_conflict");
    await expectRefusedWithoutWrite(t, before, await t.finishProposal(sessionId, T_PROPOSE_2, T_LATER, UI_ORIGIN, staleClosed), "revision_conflict");
  });
});

describe("the owner's manual finish", () => {
  it("closes the session, marks the open proposal finishedAt and finishedBy manual, and appends a manual closure without proposalAt", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE));
    ok(await t.finishManual(sessionId, T_FINISH));
    const s = await t.stored(sessionId);
    expect(s.status).toBe("closed");
    expect(s.finishProposal).toMatchObject({ at: T_PROPOSE, finishedAt: T_FINISH, finishedBy: "manual" });
    expect(await t.closures(sessionId)).toEqual([{ at: T_FINISH, basis: "manual", source: "ui", actor: HUMAN }]);
  });

  it("without a proposal it appends the manual closure only", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.finishManual(sessionId, T_FINISH));
    const s = await t.stored(sessionId);
    expect(s.status).toBe("closed");
    expect(s).not.toHaveProperty("finishProposal");
    expect(await t.closures(sessionId)).toEqual([{ at: T_FINISH, basis: "manual", source: "ui", actor: HUMAN }]);
  });

  it("a chat origin is refused for either basis, with no write", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE));
    const before = await t.snapshot();
    const agent: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: PLANNER } };
    for (const origin of [agent, { ...agent, quoted: "finish it" }, { source: "chat", actor: { kind: "agent" } } satisfies WriteOrigin]) {
      expect(err(await t.finishManual(sessionId, T_FINISH, origin)).code).toBe("invalid_input");
      expect(err(await t.finishProposal(sessionId, T_PROPOSE, T_FINISH, origin)).code).toBe("invalid_input");
    }
    expect(await t.snapshot()).toEqual(before);
  });
});

describe("provenance survives later closes", () => {
  it("accept, reopen, manual close: the proposal keeps finishedBy proposal and its first finishedAt; a manual closure is appended", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE));
    ok(await t.finishProposal(sessionId, T_PROPOSE, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    ok(await t.finishManual(sessionId, T_FINISH_2));
    const s = await t.stored(sessionId);
    expect(s.finishProposal).toMatchObject({ at: T_PROPOSE, finishedAt: T_FINISH, finishedBy: "proposal" });
    expect(await t.closures(sessionId)).toEqual([
      { at: T_FINISH, basis: "proposal", proposalAt: T_PROPOSE, source: "ui", actor: HUMAN, reopenedAt: T_REOPEN },
      { at: T_FINISH_2, basis: "manual", source: "ui", actor: HUMAN },
    ]);
  });

  it("a proposal finished by an earlier version (finishedAt without finishedBy), reopen, manual close: the proposal is left untouched", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE));
    const proposal = (await t.stored(sessionId)).finishProposal!;
    await t.seedSession(sessionId, { status: "closed", finishProposal: { ...proposal, finishedAt: T_FINISH } });
    const legacy = canonicalJson((await t.stored(sessionId)).finishProposal);

    ok(await t.reopen(sessionId, T_REOPEN));
    expect(await t.closures(sessionId), "an earlier close has no closure; reopen writes none").toEqual([]);
    ok(await t.finishManual(sessionId, T_FINISH_2));
    const s = await t.stored(sessionId);
    expect(canonicalJson(s.finishProposal)).toBe(legacy);
    expect(s.finishProposal).not.toHaveProperty("finishedBy");
    expect(await t.closures(sessionId)).toEqual([{ at: T_FINISH_2, basis: "manual", source: "ui", actor: HUMAN }]);
  });

  it("a replacement after a manually finished proposal moves it to finishHistory with finishedAt and finishedBy intact", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE, "First"));
    ok(await t.finishManual(sessionId, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    ok(await t.propose(sessionId, T_PROPOSE_2, "Second"));
    const s = await t.stored(sessionId);
    expect(s.finishHistory).toHaveLength(1);
    expect(s.finishHistory?.[0]).toMatchObject({ at: T_PROPOSE, summary: "First", finishedAt: T_FINISH, finishedBy: "manual" });
    expect(s.finishProposal).toMatchObject({ at: T_PROPOSE_2, summary: "Second" });
    expect(s.finishProposal).not.toHaveProperty("finishedAt");
    expect(s.finishProposal).not.toHaveProperty("finishedBy");
    expect((await t.view(sessionId)).grilling?.finishProposal).toMatchObject({ at: T_PROPOSE_2, summary: "Second" });
  });
});

describe("reopen", () => {
  it("stamps reopenedAt on the last closure only, keeps finishedAt and finishedBy, and the grilling view omits the finished proposal", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE));
    ok(await t.finishManual(sessionId, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    let s = await t.stored(sessionId);
    expect(s.status).toBe("active");
    expect(s.finishProposal).toMatchObject({ finishedAt: T_FINISH, finishedBy: "manual" });
    expect(await t.closures(sessionId)).toEqual([{ at: T_FINISH, basis: "manual", source: "ui", actor: HUMAN, reopenedAt: T_REOPEN }]);
    const v = await t.view(sessionId);
    expect(v.grilling?.finishProposal).toBeUndefined();
    expect(v.session).toMatchObject({ closures: [{ reopenedAt: T_REOPEN }] });

    ok(await t.finishManual(sessionId, T_FINISH_2));
    ok(await t.reopen(sessionId, T_REOPEN_2));
    s = await t.stored(sessionId);
    expect(await t.closures(sessionId)).toEqual([
      { at: T_FINISH, basis: "manual", source: "ui", actor: HUMAN, reopenedAt: T_REOPEN },
      { at: T_FINISH_2, basis: "manual", source: "ui", actor: HUMAN, reopenedAt: T_REOPEN_2 },
    ]);
    expect(s.finishProposal).toMatchObject({ finishedAt: T_FINISH, finishedBy: "manual" });
  });

  it("a second reopen of the now active session is refused and writes nothing", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.finishManual(sessionId, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    const before = await t.snapshot();
    await expectRefusedWithoutWrite(t, before, await t.reopen(sessionId, T_LATER), "invalid_input");
    expect(await t.closures(sessionId)).toEqual([{ at: T_FINISH, basis: "manual", source: "ui", actor: HUMAN, reopenedAt: T_REOPEN }]);
  });

  it("a session closed by an earlier version (no closures) reopens as before without writing a closure (positive control)", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    await t.seedSession(sessionId, { status: "closed" });
    ok(await t.reopen(sessionId, T_REOPEN));
    const s = await t.stored(sessionId);
    expect(s.status).toBe("active");
    expect(s).not.toHaveProperty("closures");
  });
});

describe("the closures guard", () => {
  /** finish, reopen, finish: two closures, the first reopened, the last open; the session is closed. */
  const twoClosures = async (t: T) => {
    const ids = await t.plannerSession();
    ok(await t.finishManual(ids.sessionId, T_FINISH));
    ok(await t.reopen(ids.sessionId, T_REOPEN));
    ok(await t.finishManual(ids.sessionId, T_FINISH_2));
    expect(await t.closures(ids.sessionId), "precondition: two stored closures").toHaveLength(2);
    return ids;
  };

  it("a command other than reopen that edits an earlier closure, edits the last one, drops one or stamps reopenedAt is invalid_input and writes nothing", async () => {
    const edits: Array<[string, (c: Array<Record<string, unknown>>) => void]> = [
      ["edit an earlier closure", (c) => void (c[0].basis = "proposal")],
      ["edit the last closure", (c) => void (c[1].at = T_LATER)],
      ["drop a closure", (c) => void c.splice(0, 1)],
      ["stamp reopenedAt", (c) => void (c[1].reopenedAt = T_LATER)],
    ];
    for (const [label, edit] of edits) {
      const t = await setup();
      const { sessionId, questionId } = await twoClosures(t);
      const before = await t.snapshot();
      t.arm((draft) => edit(draftClosures(draft, sessionId)));
      const res = await t.answer(sessionId, questionId, "a", T_LATER);
      expect(t.tampered(), label).toBe(true);
      expect(res.ok, label).toBe(false);
      expect(err(res).code, label).toBe("invalid_input");
      expect(await t.snapshot(), label).toEqual(before);
      await project?.cleanup();
      project = undefined;
    }
  });

  it("the same command without the edit succeeds (positive control)", async () => {
    const t = await setup();
    const { sessionId, questionId } = await twoClosures(t);
    ok(await t.answer(sessionId, questionId, "a", T_LATER));
    expect(await t.closures(sessionId)).toHaveLength(2);
  });

  it("reopen that also edits the last closure beyond reopenedAt, or an earlier closure, is refused and the session stays closed (rollback)", async () => {
    const edits: Array<[string, (c: Array<Record<string, unknown>>) => void]> = [
      ["edit the last closure's basis", (c) => void (c[1].basis = "proposal")],
      ["edit an earlier closure's reopenedAt", (c) => void (c[0].reopenedAt = T_LATER)],
      ["append a closure", (c) => void c.push({ at: T_LATER, basis: "manual", source: "ui", actor: HUMAN })],
    ];
    for (const [label, edit] of edits) {
      const t = await setup();
      const { sessionId } = await twoClosures(t);
      const before = await t.snapshot();
      t.arm((draft) => edit(draftClosures(draft, sessionId)));
      const res = await t.reopen(sessionId, T_REOPEN_2);
      expect(t.tampered(), label).toBe(true);
      expect(res.ok, label).toBe(false);
      expect(err(res).code, label).toBe("invalid_input");
      expect(await t.snapshot(), label).toEqual(before);
      expect((await t.stored(sessionId)).status, label).toBe("closed");
      await project?.cleanup();
      project = undefined;
    }
  });

  it("finish that also edits an earlier closure is refused and writes nothing", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.finishManual(sessionId, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    expect(await t.closures(sessionId), "precondition: one stored closure").toHaveLength(1);
    const before = await t.snapshot();
    t.arm((draft) => void (draftClosures(draft, sessionId)[0].at = T_LATER));
    const res = await t.finishManual(sessionId, T_FINISH_2);
    expect(t.tampered()).toBe(true);
    await expectRefusedWithoutWrite(t, before, res, "invalid_input");
  });
});

describe("roadmap_grill_complete keeps its rule", () => {
  it("still refuses while a finished proposal exists (positive control)", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.propose(sessionId, T_PROPOSE));
    ok(await t.finishProposal(sessionId, T_PROPOSE, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    await seedGrilling(t.open, P, sessionId, { continuation: continuationIn("awaiting_pause") });
    const chat: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: PLANNER } };
    const res = await t.tool("roadmap_grill_complete").run(
      { expectedRevision: await t.revision(), sessionId, operationId: OP },
      { open: t.open, projectId: P, origin: chat, agentId: PLANNER, workspaceId: "ws-1" },
    );
    expect(err(res).code).toBe("invalid_input");
    expect((await t.stored(sessionId)).status).toBe("active");
  });
});

// A chat completion (roadmap_grill_complete) closes without a finish basis and adds no closure.
// After an earlier manual finish and reopen, the stored closures therefore describe only that
// earlier close: the last one already carries its reopenedAt, which tells a reader that the
// current close is not recorded there.
describe("a chat completion after a manual finish and reopen", () => {
  const completeByChat = async (t: T, sessionId: string, when: string) => {
    await seedGrilling(t.open, P, sessionId, { continuation: continuationIn("awaiting_pause") });
    t.at(when);
    const chat: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: PLANNER } };
    return t.tool("roadmap_grill_complete").run(
      { expectedRevision: await t.revision(), sessionId, operationId: OP },
      { open: t.open, projectId: P, origin: chat, agentId: PLANNER, workspaceId: "ws-1" },
    );
  };
  const earlierClose = { at: T_FINISH, basis: "manual", source: "ui", actor: HUMAN, reopenedAt: T_REOPEN };

  it("adds no closure and leaves the earlier manual closure and its reopenedAt as they were", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.finishManual(sessionId, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    ok(await completeByChat(t, sessionId, T_FINISH_2));

    const s = await t.stored(sessionId);
    expect(s.status).toBe("closed");
    expect(await t.closures(sessionId)).toEqual([earlierClose]);

    const v = await t.view(sessionId);
    expect(v.session.status).toBe("closed");
    expect(v.session).toMatchObject({ closures: [earlierClose] });
    expect(SessionView.safeParse(v).success).toBe(true);
  });

  it("then reopens normally without stamping or rewriting the earlier closure, and a later manual finish appends as usual", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.finishManual(sessionId, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    ok(await completeByChat(t, sessionId, T_FINISH_2));

    ok(await t.reopen(sessionId, T_REOPEN_2));
    expect((await t.stored(sessionId)).status).toBe("active");
    expect(await t.closures(sessionId)).toEqual([earlierClose]);

    ok(await t.finishManual(sessionId, T_LATER));
    expect((await t.stored(sessionId)).status).toBe("closed");
    expect(await t.closures(sessionId)).toEqual([earlierClose, { at: T_LATER, basis: "manual", source: "ui", actor: HUMAN }]);
  });

  // DeepSeek Flash review 01a1c6ee c0011. Manual finish T0, reopen T1, the chat's completion T2,
  // reopen T3: the owner decided that a chat completion adds no closure, so the closures still end
  // with the T0 close reopened at T1. The session header's closure line ("Reopened <at> · previously
  // closed <at> (<basis>)", client/grilling-header.ts closureLine) must not present T1 as the latest
  // reopen or the T0 close as the close just undone: the latest close was the chat's at T2, and it was
  // reopened later. The stored session still says so: its continuation is "complete" at T2, after the
  // last closure's reopenedAt (the view passes the session through). T3 itself is not stored.
  it("the closure line after manual finish, reopen, chat completion and reopen does not name the first reopen as the latest", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.finishManual(sessionId, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    ok(await completeByChat(t, sessionId, T_FINISH_2));
    const { closureLine } = await import("../client/grilling-header");
    const minute = (iso: string) => iso.replace("T", " ").slice(0, 16);
    // While closed by the chat: the line says the basis is not recorded (positive control).
    expect(closureLine(await t.view(sessionId))).toBe("Closed (basis not recorded)");
    ok(await t.reopen(sessionId, T_REOPEN_2));
    const v = await t.view(sessionId);
    expect(v.session.status).toBe("active");
    expect(v.session).toMatchObject({ closures: [earlierClose], continuation: { state: "complete", at: T_FINISH_2 } });
    const line = closureLine(v);
    expect(line ?? "", `closure line: ${String(line)}`).not.toContain(`Reopened ${minute(T_REOPEN)}`);
    expect(line ?? "", "the T0 manual close is not the close that was undone").not.toMatch(new RegExp(`previously closed ${minute(T_FINISH)}`));
    // DeepSeek Flash review 01a1c8d3 c0151: the line itself, not only what it must not say (a null line
    // would pass the two checks above).
    expect(line, "the chat's close, with no reopen time").toBe(`Reopened (time not recorded) · previously closed ${minute(T_FINISH_2)} by the chat completing grilling`);
  });

  // Guard for the case above: a chat completion EARLIER than the last recorded close and reopen does
  // not change the line, which names that last reopen and its close.
  it("a chat completion before a later manual finish and reopen leaves the line naming that last reopen", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await completeByChat(t, sessionId, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    ok(await t.finishManual(sessionId, T_FINISH_2));
    ok(await t.reopen(sessionId, T_REOPEN_2));
    const v = await t.view(sessionId);
    expect(v.session).toMatchObject({ closures: [{ at: T_FINISH_2, basis: "manual", reopenedAt: T_REOPEN_2 }] });
    const { closureLine } = await import("../client/grilling-header");
    const minute = (iso: string) => iso.replace("T", " ").slice(0, 16);
    expect(closureLine(v)).toBe(`Reopened ${minute(T_REOPEN_2)} · previously closed ${minute(T_FINISH_2)} (manually)`);
  });

  // Audit of ac68d90: the chat's completion is the latest close only until the owner closes again.
  it("after the chat's close and a reopen, a later owner Finish and reopen: the line names that Finish and its reopen, not the chat's close", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.finishManual(sessionId, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    ok(await completeByChat(t, sessionId, T_FINISH_2));
    ok(await t.reopen(sessionId, T_REOPEN_2));
    const { closureLine } = await import("../client/grilling-header");
    const minute = (iso: string) => iso.replace("T", " ").slice(0, 16);
    const T_FINISH_3 = "2026-11-09T10:40:00.000Z";
    const T_REOPEN_3 = "2026-11-09T10:45:00.000Z";
    ok(await t.finishManual(sessionId, T_FINISH_3));
    expect(closureLine(await t.view(sessionId)), "closed by the owner").toBe(`Closed ${minute(T_FINISH_3)} · manually`);
    ok(await t.reopen(sessionId, T_REOPEN_3));
    expect(closureLine(await t.view(sessionId)), "reopened after the owner's close").toBe(`Reopened ${minute(T_REOPEN_3)} · previously closed ${minute(T_FINISH_3)} (manually)`);
  });

  it("a session closed only by the chat (no closures) and reopened: the line names the chat's close and gives no reopen time", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await completeByChat(t, sessionId, T_FINISH));
    const { closureLine } = await import("../client/grilling-header");
    const minute = (iso: string) => iso.replace("T", " ").slice(0, 16);
    expect(closureLine(await t.view(sessionId)), "while closed by the chat").toBe("Closed (basis not recorded)");
    ok(await t.reopen(sessionId, T_REOPEN));
    const v = await t.view(sessionId);
    expect(v.session).not.toHaveProperty("closures");
    const line = closureLine(v);
    expect(line).toContain(minute(T_FINISH));
    expect(line).not.toContain(minute(T_REOPEN));
  });

  // The same, after the planner's next batch: mintOrKeep (server/sessions.ts) moves the completed
  // continuation into session.continuations and starts a new one, so the later chat close is then
  // recorded only in the history. The line must still not name the first reopen as the latest.
  it("the same after the planner's next batch has archived the completed continuation", async () => {
    const t = await setup();
    const { sessionId } = await t.plannerSession();
    ok(await t.finishManual(sessionId, T_FINISH));
    ok(await t.reopen(sessionId, T_REOPEN));
    ok(await completeByChat(t, sessionId, T_FINISH_2));
    ok(await t.reopen(sessionId, T_REOPEN_2));
    t.at(T_LATER);
    const chat: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: PLANNER } };
    const q = { title: "Which cache?", context: "", options: [opt("a"), opt("b")], allowFreeText: false, activatedBy: [], invalidatedBy: [] };
    ok(
      await t.tool("roadmap_ask").run(
        { expectedRevision: await t.revision(), sessionId, blockId: BLK_OPEN, questions: [q] },
        { open: t.open, projectId: P, origin: chat, agentId: PLANNER, workspaceId: "ws-1" },
      ),
    );
    const v = await t.view(sessionId);
    const stored = await t.stored(sessionId);
    expect(stored.continuations?.map((c) => [c.state, c.at]), "the completed continuation is in the history").toContainEqual(["complete", T_FINISH_2]);
    expect(stored.continuation?.state, "a new continuation was started").not.toBe("complete");
    expect(v.session).toMatchObject({ closures: [earlierClose] });
    const { closureLine } = await import("../client/grilling-header");
    const minute = (iso: string) => iso.replace("T", " ").slice(0, 16);
    const line = closureLine(v);
    expect(line ?? "", `closure line: ${String(line)}`).not.toContain(`Reopened ${minute(T_REOPEN)}`);
    // DeepSeek Flash review 01a1c8d3 c0151: from the archived continuation, the same exact line.
    expect(line, "the chat's close, with no reopen time").toBe(`Reopened (time not recorded) · previously closed ${minute(T_FINISH_2)} by the chat completing grilling`);
  });
});
