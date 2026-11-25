// Explicit decision cancellation (redesign Stage R1.3a, task card §4.1, encoding B), over real temp
// stores. decision.cancel is UI-only and appends one record to meta.cancellations; it never edits the
// question, its block or its links. Every refusal leaves the store byte-identical and has an accepted
// control. Q33 is answered (Q33=1): a cancelled basis decision makes approval not current. That plan
// effect is covered by the plan-hash, plan-rules, plans, tracker/sync and plan-tools tests, not here.
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import type { Ref } from "../shared/model";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, NOW_ISO, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent" }, quoted: "cancel it" };
type Json = any; // stored records read back from the store, kept loose for byte comparisons

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup() {
  project = await makeProject();
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string, e?: unknown) => void project!.logs.push([m, e]) };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const data = async (): Promise<Json> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const at = async () => ({ projectId: P, expectedRevision: await revision() });
  const newSession = async (title: string) => ok(await commands.sessionCreate(open, { ...(await at()), title }, UI_ORIGIN)).sessionId;
  const create = async (sessionId: string, title: string, extra: Record<string, unknown> = {}): Promise<Ref> => ({
    sessionId,
    questionId: ok(
      await commands.questionCreate(open, { ...(await at()), sessionId, title, context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], ...extra }, UI_ORIGIN),
    ).questionId,
  });
  const cancel = async (ref: Ref, reason: string, origin: WriteOrigin = UI_ORIGIN, expectedRevision?: number) =>
    commands.decisionCancel(open, { projectId: P, expectedRevision: expectedRevision ?? (await revision()), ...ref, reason }, origin);
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  const noWrite = async (code: string, attempt: () => Promise<Json>) => {
    const before = await snapshot();
    expect(err(await attempt()).code).toBe(code);
    expect(await snapshot()).toEqual(before);
  };
  /** A blocked session (accepted b1 with f, open block with o) and a legacy session with l. */
  async function world() {
    const S = await newSession("Blocked");
    const f = await create(S, "F", { blockId: "b1" });
    ok(await commands.questionAnswer(open, { ...(await at()), ...f, optionId: "a" }, UI_ORIGIN));
    const next = ok(await commands.blockAccept(open, { ...(await at()), sessionId: S, blockId: "b1" }, UI_ORIGIN)).nextBlockId;
    const o = await create(S, "O", { blockId: next });
    const L = await newSession("Legacy");
    const l = await create(L, "L");
    return { S, L, f, o, l };
  }
  return { commands, open, revision, data, at, newSession, create, cancel, snapshot, noWrite, world };
}

describe("decision.cancel (§4.1.2)", () => {
  it("UI cancel of an open, a frozen and a legacy question records exactly one entry each, with a trimmed reason and a human actor", async () => {
    const h = await setup();
    const w = await h.world();
    expect("cancellations" in (await h.data()).meta).toBe(false);
    const ids: string[] = [];
    for (const [ref, reason] of [[w.o, "  Dropped from scope  "], [w.f, "Replaced"], [w.l, "Obsolete"]] as const) {
      const before = await h.revision();
      const out = ok(await h.cancel(ref, reason));
      expect(out.revision).toBe(before + 1);
      expect(typeof out.cancellationId).toBe("string");
      ids.push(out.cancellationId);
    }
    const records = (await h.data()).meta.cancellations;
    expect(records).toEqual([
      { id: ids[0], ref: w.o, reason: "Dropped from scope", at: NOW_ISO, actor: { kind: "human" } },
      { id: ids[1], ref: w.f, reason: "Replaced", at: NOW_ISO, actor: { kind: "human" } },
      { id: ids[2], ref: w.l, reason: "Obsolete", at: NOW_ISO, actor: { kind: "human" } },
    ]);
    expect(new Set(ids).size).toBe(3);
  });

  it("the chat origin is invalid_input with no write (positive control: the UI cancel)", async () => {
    const h = await setup();
    const w = await h.world();
    await h.noWrite("invalid_input", () => h.cancel(w.o, "Not needed", CHAT));
    ok(await h.cancel(w.o, "Not needed"));
  });

  it("an empty or whitespace-only reason is invalid_input; a missing question is not_found; both write nothing", async () => {
    const h = await setup();
    const w = await h.world();
    await h.noWrite("invalid_input", () => h.cancel(w.o, ""));
    await h.noWrite("invalid_input", () => h.cancel(w.o, "   \n\t "));
    await h.noWrite("not_found", () => h.cancel({ sessionId: w.S, questionId: "missing" }, "Gone"));
    await h.noWrite("not_found", () => h.cancel({ sessionId: "missing", questionId: w.o.questionId }, "Gone"));
    ok(await h.cancel(w.o, "Gone"));
  });

  it("a second cancel of the same decision is decision_cancelled, also for a frozen one, with no write", async () => {
    const h = await setup();
    const w = await h.world();
    ok(await h.cancel(w.o, "First"));
    ok(await h.cancel(w.f, "First"));
    await h.noWrite("decision_cancelled", () => h.cancel(w.o, "Again"));
    await h.noWrite("decision_cancelled", () => h.cancel(w.f, "Again"));
    expect((await h.data()).meta.cancellations.length).toBe(2);
  });

  it("a stale revision is revision_conflict with no write, before the reason and the question are checked", async () => {
    const h = await setup();
    const w = await h.world();
    const stale = (await h.revision()) - 1;
    await h.noWrite("revision_conflict", () => h.cancel(w.o, "Late", UI_ORIGIN, stale));
    await h.noWrite("revision_conflict", () => h.cancel(w.o, "  ", UI_ORIGIN, stale));
    await h.noWrite("revision_conflict", () => h.cancel({ sessionId: w.S, questionId: "missing" }, "Late", UI_ORIGIN, stale));
  });

  it("question, block and link bytes are unchanged by a cancel; only meta.cancellations grows", async () => {
    const h = await setup();
    const w = await h.world();
    const replacement = await h.create(w.S, "Replacement", { blockId: (await h.data()).sessions.find((s: Json) => s.id === w.S).blocks.find((b: Json) => b.state === "open").id });
    ok(await h.commands.linkCreate(h.open, { ...(await h.at()), kind: "supersedes", from: replacement, to: w.f }, UI_ORIGIN));
    const before = await h.data();
    ok(await h.cancel(w.f, "Replaced"));
    ok(await h.cancel(w.l, "Obsolete"));
    const after = await h.data();
    expect(canonicalJson(after.sessions)).toBe(canonicalJson(before.sessions));
    expect(canonicalJson(after.meta.links)).toBe(canonicalJson(before.meta.links));
    const { cancellations: _c, ...restAfter } = after.meta;
    const { cancellations: _b, ...restBefore } = before.meta;
    expect(canonicalJson(restAfter)).toBe(canonicalJson(restBefore));
    expect(canonicalJson(after.plans)).toBe(canonicalJson(before.plans));
  });

  it("link.delete with a cancellation id is not_found and the cancellation stays; an unrelated write keeps the records", async () => {
    const h = await setup();
    const w = await h.world();
    const id = ok(await h.cancel(w.o, "Dropped")).cancellationId;
    const records = canonicalJson((await h.data()).meta.cancellations);
    await h.noWrite("not_found", async () => h.commands.linkDelete(h.open, { ...(await h.at()), linkId: id }, UI_ORIGIN));
    // Positive control: a real link is deletable; the cancellation is not affected.
    const other = await h.create(w.L, "Other");
    const linkId = ok(await h.commands.linkCreate(h.open, { ...(await h.at()), kind: "informs", from: other, to: w.l }, UI_ORIGIN)).linkId;
    ok(await h.commands.linkDelete(h.open, { ...(await h.at()), linkId }, UI_ORIGIN));
    // An unrelated write keeps the append-only records.
    ok(await h.commands.questionAnswer(h.open, { ...(await h.at()), ...w.l, optionId: "a" }, UI_ORIGIN));
    expect(canonicalJson((await h.data()).meta.cancellations)).toBe(records);
  });
});

// Stage R1.5 (task card §8.4 item 6): the cancellation changes plan basis and currency only. The
// graph is unchanged: for every question, visibility, validity and stale marks are identical before
// and after cancelling a basis decision (with dependants) and an unrelated one. Control: passes
// before and after R1.5.
describe("R1.5 graph unchanged by a cancellation", () => {
  it("visibility, validity and stale marks are identical before and after cancelling a parent decision and an unrelated one", async () => {
    const h = await setup();
    const w = await h.world();
    const answer = async (ref: Ref, optionId: string) => ok(await h.commands.questionAnswer(h.open, { ...(await h.at()), ...ref, optionId }, UI_ORIGIN));
    await answer(w.l, "a");
    const active = await h.create(w.L, "Active child", { activatedBy: [{ parent: w.l, optionIds: ["a"] }] });
    await h.create(w.L, "Inactive child", { activatedBy: [{ parent: w.l, optionIds: ["b"] }] });
    const dependant = await h.create(w.L, "Dependant", { invalidatedBy: [{ upstream: w.l }] });
    await answer(active, "a");
    await answer(dependant, "b");
    const graph = async () => {
      const out: Record<string, unknown> = {};
      for (const sessionId of [w.S, w.L]) {
        const view = ok(await h.commands.sessionGet(h.open, { projectId: P, sessionId }, UI_ORIGIN));
        for (const qv of view.questions) {
          out[`${sessionId}/${qv.question.id}`] = { visibility: qv.visibility, status: qv.status, validity: qv.question.validity, stale: qv.question.stale ?? null };
        }
      }
      return out;
    };
    const before = await graph();
    expect(Object.values(before).some((x: any) => x.visibility === "inactive")).toBe(true);
    ok(await h.cancel(w.l, "Basis decision dropped"));
    ok(await h.cancel(w.o, "Unrelated"));
    expect(await graph()).toEqual(before);
  });
});
