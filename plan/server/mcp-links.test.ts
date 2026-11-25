// Question and answer links through MCP over real temp stores, with the tool table run directly.
// roadmap_get_session and roadmap_ask expose each question's number and links; roadmap_resolve_link
// is read-only, resolves an answer link to the answer that is current at resolution time (the same
// link lands on the new revision after an edit), reports a revision-pinned link as not current,
// and refuses malformed links, unknown targets and links of another project.
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Answer } from "../shared/model";
import { SessionView } from "../shared/rpc";
import { buildTools, TOOL_NAMES, type McpToolTable } from "./mcp-tools";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openStore } from "./store";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const OTHER = "prj_other";
const FIXTURE = fileURLToPath(new URL("./fixtures/v1-store/", import.meta.url));
const FIXTURE_PID = "prj_2d93f94da090e78c";
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: "agent-links" } };
const ab = [opt("a"), opt("b")];

const Links = z.object({ question: z.string(), answer: z.string() }).strict();
const Asked = z.looseObject({ questionIds: z.array(z.string()), numbers: z.array(z.number().int()), links: z.array(Links) });
const Resolved = z.looseObject({
  kind: z.enum(["question", "answer"]),
  sessionId: z.string(),
  questionId: z.string(),
  number: z.number().int(),
  title: z.string(),
  status: z.string(),
  answer: Answer.optional(),
  currentRev: z.number().int().optional(),
  pinnedRev: z.number().int().optional(),
  current: z.boolean(),
});

let project: TestProject | undefined;
const roots: string[] = [];
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** Two initialised projects (prj_test and prj_other) behind one directory, and the tool table. */
async function setup() {
  project = await makeProject();
  const otherRoot = await tempRoot("dr-links-other-");
  const dir = fakeDirectory({
    projects: [
      { projectId: P, projectRootPath: project.root, projectKind: "git" },
      { projectId: OTHER, projectRootPath: otherRoot, projectKind: "git" },
    ],
  });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  ok(await commands.init(open, { projectId: OTHER }, UI_ORIGIN));
  return { ...harness(commands, open, buildTools(commands)) };
}

function harness(commands: ReturnType<typeof createRoadmapCommands>, open: StoreOpener, tools: McpToolTable) {
  const tool = (name: string) => {
    const found = tools.find((x) => x.name === name);
    if (found === undefined) throw new Error(`tool ${name} missing`);
    return found;
  };
  const ctx = (projectId: string = P) => ({ open, projectId, origin: CHAT });
  const revision = async (projectId: string = P) => ok(await commands.version(open, { projectId }, UI_ORIGIN)).revision!;
  const newSession = async (projectId: string = P, title = "Links") =>
    ok(await commands.sessionCreate(open, { projectId, expectedRevision: await revision(projectId), title }, UI_ORIGIN)).sessionId;
  const ask = async (sessionId: string, questions: unknown[], projectId: string = P) =>
    Asked.parse(ok(await tool("roadmap_ask").run({ expectedRevision: await revision(projectId), sessionId, blockId: "blk-1", questions }, ctx(projectId))));
  const resolve = (link: string, projectId: string = P) => tool("roadmap_resolve_link").run({ link }, ctx(projectId));
  const resolved = async (link: string, projectId: string = P) => Resolved.parse(ok(await resolve(link, projectId)));
  const getSession = async (sessionId: string, projectId: string = P) =>
    SessionView.parse(ok(await tool("roadmap_get_session").run({ sessionId }, ctx(projectId))));
  const answer = async (sessionId: string, questionId: string, optionId: string, projectId: string = P) =>
    ok(await commands.questionAnswer(open, { projectId, expectedRevision: await revision(projectId), sessionId, questionId, optionId }, UI_ORIGIN));
  return { commands, open, tools, tool, ctx, revision, newSession, ask, resolve, resolved, getSession, answer };
}

const question = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  context: "",
  options: ab,
  allowFreeText: false,
  activatedBy: [],
  invalidatedBy: [],
  ...extra,
});

describe("the tool table", () => {
  it("lists roadmap_resolve_link with a strict { link } input", async () => {
    const t = await setup();
    expect(TOOL_NAMES).toContain("roadmap_resolve_link");
    const input = t.tool("roadmap_resolve_link").input;
    expect(input.safeParse({ link: "roadmap://prj_test/s/S/q/1" }).success).toBe(true);
    expect(input.safeParse({}).success).toBe(false);
    expect(input.safeParse({ link: "" }).success).toBe(false);
    expect(input.safeParse({ link: "roadmap://prj_test/s/S/q/1", projectId: OTHER }).success).toBe(false);
  });
});

describe("numbers and links in roadmap_ask and roadmap_get_session", () => {
  it("roadmap_ask returns the numbers and canonical links of the questions it created, continuing the session's sequence", async () => {
    const t = await setup();
    const s = await t.newSession();
    const first = await t.ask(s, [question("A"), question("B")]);
    expect(first.numbers).toEqual([1, 2]);
    expect(first.links).toEqual([
      { question: `roadmap://${P}/s/${s}/q/1`, answer: `roadmap://${P}/s/${s}/q/1/answer` },
      { question: `roadmap://${P}/s/${s}/q/2`, answer: `roadmap://${P}/s/${s}/q/2/answer` },
    ]);
    const second = await t.ask(s, [question("C")]);
    expect(second.numbers).toEqual([3]);
    expect(second.links).toEqual([{ question: `roadmap://${P}/s/${s}/q/3`, answer: `roadmap://${P}/s/${s}/q/3/answer` }]);
  });

  it("roadmap_get_session gives every question its number and links, matching what roadmap_ask returned", async () => {
    const t = await setup();
    const s = await t.newSession();
    const asked = await t.ask(s, [question("A"), question("B")]);
    const view = await t.getSession(s);
    expect(view.questions.map((q) => q.question.id)).toEqual(asked.questionIds);
    expect(view.questions.map((q) => q.number)).toEqual(asked.numbers);
    expect(view.questions.map((q) => q.links)).toEqual(asked.links);
  });

  it("a legacy session without blocks gains numbers and links like any other", async () => {
    const t = await setup();
    const s = await t.newSession();
    const created = ok(
      await t.commands.questionCreate(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId: s, ...question("Legacy") }, UI_ORIGIN),
    );
    const view = await t.getSession(s);
    expect(view.session.blocks).toBeUndefined();
    expect(view.questions[0]).toMatchObject({ question: { id: created.questionId }, number: 1, links: { question: `roadmap://${P}/s/${s}/q/1` } });
  });
});

describe("roadmap_resolve_link", () => {
  it("an answer link resolves to the current answer; after an edit the same link resolves to the new revision", async () => {
    const t = await setup();
    const s = await t.newSession();
    const asked = await t.ask(s, [question("A")]);
    const [qid] = asked.questionIds;
    const link = asked.links[0].answer;

    await t.answer(s, qid, "a");
    const first = await t.resolved(link);
    expect(first).toMatchObject({ kind: "answer", sessionId: s, questionId: qid, number: 1, title: "A", status: "answered", currentRev: 1, current: true });
    expect(first.answer).toMatchObject({ rev: 1, optionId: "a" });
    expect(first.pinnedRev).toBeUndefined();

    await t.answer(s, qid, "b");
    const second = await t.resolved(link);
    expect(second).toMatchObject({ kind: "answer", questionId: qid, currentRev: 2, current: true });
    expect(second.answer).toMatchObject({ rev: 2, optionId: "b" });
    // History is kept; the link is a stable reference, not a snapshot.
    expect((await t.getSession(s)).questions[0].question.revisions.map((r) => r.optionId)).toEqual(["a", "b"]);
  });

  it("a revision-pinned answer link returns that revision and reports whether it is current", async () => {
    const t = await setup();
    const s = await t.newSession();
    const asked = await t.ask(s, [question("A")]);
    const [qid] = asked.questionIds;
    await t.answer(s, qid, "a");
    await t.answer(s, qid, "b");
    const old = await t.resolved(`${asked.links[0].answer}/r1`);
    expect(old).toMatchObject({ kind: "answer", questionId: qid, pinnedRev: 1, currentRev: 2, current: false });
    expect(old.answer).toMatchObject({ rev: 1, optionId: "a" });
    const latest = await t.resolved(`${asked.links[0].answer}/r2`);
    expect(latest).toMatchObject({ pinnedRev: 2, currentRev: 2, current: true });
    expect(latest.answer).toMatchObject({ rev: 2, optionId: "b" });
    expect(err(await t.resolve(`${asked.links[0].answer}/r3`)).code).toBe("not_found");
  });

  it("a question link resolves to the question with its status", async () => {
    const t = await setup();
    const s = await t.newSession();
    const asked = await t.ask(s, [question("A"), question("B")]);
    const q2 = await t.resolved(asked.links[1].question);
    expect(q2).toMatchObject({ kind: "question", sessionId: s, questionId: asked.questionIds[1], number: 2, title: "B", status: "open" });
  });

  it("an answer link of an unanswered question carries no answer", async () => {
    const t = await setup();
    const s = await t.newSession();
    const asked = await t.ask(s, [question("A")]);
    const out = await t.resolved(asked.links[0].answer);
    expect(out).toMatchObject({ kind: "answer", questionId: asked.questionIds[0], number: 1, status: "open" });
    expect(out.answer).toBeUndefined();
    expect(out.currentRev).toBeUndefined();
  });

  it("a link to a hidden (inactive) question still resolves, with status inactive", async () => {
    const t = await setup();
    const s = await t.newSession();
    const asked = await t.ask(s, [question("Parent"), question("Child", { activatedBy: [{ parent: { batchIndex: 0 }, optionIds: ["b"] }] })]);
    const child = await t.resolved(asked.links[1].question);
    expect(child).toMatchObject({ kind: "question", questionId: asked.questionIds[1], number: 2, status: "inactive" });
  });

  it("is read-only: resolving never moves the store revision", async () => {
    const t = await setup();
    const s = await t.newSession();
    const asked = await t.ask(s, [question("A")]);
    await t.answer(s, asked.questionIds[0], "a");
    const before = await t.revision();
    await t.resolved(asked.links[0].question);
    await t.resolved(asked.links[0].answer);
    await t.resolved(`${asked.links[0].answer}/r1`);
    expect(await t.revision()).toBe(before);
  });

  it.each([
    ["plain text", "not a link"],
    ["another scheme", "https://example.com/s/S/q/1"],
    ["number 0", `roadmap://${P}/s/S/q/0`],
    ["revision 0", `roadmap://${P}/s/S/q/1/answer/r0`],
    ["a short reference", "Q1"],
  ])("refuses a malformed link (%s) with invalid_input", async (_label, link) => {
    const t = await setup();
    expect(err(await t.resolve(link)).code).toBe("invalid_input");
  });

  it("refuses an unknown number or session with not_found", async () => {
    const t = await setup();
    const s = await t.newSession();
    await t.ask(s, [question("A")]);
    expect(err(await t.resolve(`roadmap://${P}/s/${s}/q/99`)).code).toBe("not_found");
    expect(err(await t.resolve(`roadmap://${P}/s/${s}/q/99/answer`)).code).toBe("not_found");
    expect(err(await t.resolve(`roadmap://${P}/s/no-such-session/q/1`)).code).toBe("not_found");
  });

  it("refuses a link of another project with project_mismatch, even where that project holds the target", async () => {
    const t = await setup();
    const own = await t.newSession(P);
    await t.ask(own, [question("Mine")]);
    const foreign = await t.newSession(OTHER, "Foreign");
    const asked = await t.ask(foreign, [question("Theirs")], OTHER);
    // Resolved within its own project, the link works.
    expect(await t.resolved(asked.links[0].question, OTHER)).toMatchObject({ sessionId: foreign, number: 1, title: "Theirs" });
    // Through prj_test's grant it is refused, for both forms.
    expect(err(await t.resolve(asked.links[0].question, P)).code).toBe("project_mismatch");
    expect(err(await t.resolve(asked.links[0].answer, P)).code).toBe("project_mismatch");
    // A prj_test session id under another project's prefix is refused too, not silently rescoped.
    expect(err(await t.resolve(`roadmap://${OTHER}/s/${own}/q/1`, P)).code).toBe("project_mismatch");
  });
});

describe("legacy stores", () => {
  it("the v1 fixture: questions read with derived numbers and links resolve, without writing", async () => {
    const root = await tempRoot("dr-links-v1-");
    await cp(FIXTURE, join(root, ".decisions"), { recursive: true });
    const open: StoreOpener = async () => openStore({ storeRoot: root, projectId: FIXTURE_PID, now: fixedClock, newId: nextId, log: () => undefined });
    const commands = createRoadmapCommands({ directory: () => fakeDirectory({ projects: [] }), now: fixedClock, newId: nextId });
    const t = harness(commands, open, buildTools(commands));
    const before = await (await open(FIXTURE_PID)).read();
    expect(before).toMatchObject({ status: "ok", schemaVersion: 1 });
    if (before.status !== "ok") throw new Error("fixture not ok");
    const legacy = before.data.sessions.find((s) => s.questions.length === 2)!;

    const view = await t.getSession(legacy.id, FIXTURE_PID);
    expect(view.questions.map((q) => q.number)).toEqual([1, 2]);
    expect(view.questions.map((q) => q.links.question)).toEqual([
      `roadmap://${FIXTURE_PID}/s/${legacy.id}/q/1`,
      `roadmap://${FIXTURE_PID}/s/${legacy.id}/q/2`,
    ]);
    const answered = view.questions.find((q) => q.question.answer !== undefined)!;
    const out = await t.resolved(answered.links.answer, FIXTURE_PID);
    expect(out).toMatchObject({ kind: "answer", questionId: answered.question.id, number: answered.number, current: true, currentRev: answered.question.answer!.rev });

    // Reading is not a write: the v1 generation stays current.
    expect(await (await open(FIXTURE_PID)).read()).toMatchObject({ status: "ok", schemaVersion: 1, revision: before.revision });
  });
});
