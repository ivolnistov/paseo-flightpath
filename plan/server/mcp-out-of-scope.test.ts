// roadmap_out_of_scope: the agent records "out of scope" on the human's behalf only with the
// human's quoted words, attributed to the calling agent, as the same stored validity the UI sets.
// It records no answer revision and its description repeats that no tool can approve a plan.
import { afterEach, describe, expect, it } from "vitest";
import type { Question } from "../shared/model";
import { buildTools, TOOL_NAMES } from "./mcp-tools";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const AGENT = "agent-scope";
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: AGENT } };
const QUOTE = "drop the export question, that is out of scope for now";

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup() {
  project = await makeProject();
  const proj = project;
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: proj.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string, e?: unknown) => void proj.logs.push([m, e]) };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const tools = buildTools(commands);
  const tool = (name: string) => {
    const found = tools.find((x) => x.name === name);
    if (found === undefined) throw new Error(`tool ${name} missing`);
    return found;
  };
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const question = async (sessionId: string, questionId: string): Promise<Question> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data.sessions.find((s) => s.id === sessionId)!.questions.find((x) => x.id === questionId)!;
  };
  const sessionId = ok(await commands.sessionCreate(open, { projectId: P, expectedRevision: await revision(), title: "Scope" }, UI_ORIGIN)).sessionId;
  const questionId = ok(
    await commands.questionCreate(
      open,
      { projectId: P, expectedRevision: await revision(), sessionId, title: "Export", context: "", options: [opt("a"), opt("b")], allowFreeText: false, activatedBy: [], invalidatedBy: [] },
      UI_ORIGIN,
    ),
  ).questionId;
  const run = async (args: Record<string, unknown>) => tool("roadmap_out_of_scope").run(args, { open, projectId: P, origin: CHAT, agentId: AGENT, workspaceId: "ws-1" });
  return { commands, open, tool, revision, question, sessionId, questionId, run };
}

describe("roadmap_out_of_scope", () => {
  it("is listed, and its description forbids approval through tools", async () => {
    const t = await setup();
    expect(TOOL_NAMES).toContain("roadmap_out_of_scope");
    expect(t.tool("roadmap_out_of_scope").description).toMatch(/no tool can approve/);
  });

  it("takes a strict input that requires the human's quoted words", async () => {
    const t = await setup();
    const input = t.tool("roadmap_out_of_scope").input;
    const valid = { expectedRevision: 2, sessionId: "s1", questionId: "q1", quoted: "out of scope" };
    expect(input.safeParse(valid).success).toBe(true);
    const { quoted: _drop, ...unquoted } = valid;
    expect(input.safeParse(unquoted).success).toBe(false);
    expect(input.safeParse({ ...valid, quoted: "" }).success).toBe(false);
    expect(input.safeParse({ ...valid, projectId: "prj_other" }).success).toBe(false);
    expect(input.safeParse({ sessionId: "s1", questionId: "q1", quoted: "x" }).success).toBe(false);
  });

  it("records out_of_scope with a note quoting the human, attributed to the calling agent, and no answer revision", async () => {
    const t = await setup();
    const before = await t.revision();
    const out = await t.run({ expectedRevision: before, sessionId: t.sessionId, questionId: t.questionId, quoted: QUOTE });
    expect(out.ok).toBe(true);
    expect(await t.revision()).toBe(before + 1);
    const q = await t.question(t.sessionId, t.questionId);
    expect(q.validity).toBe("out_of_scope");
    expect(q.revisions).toEqual([]);
    expect(q.answer).toBeUndefined();
    expect(q.discussion).toHaveLength(1);
    expect(q.discussion[0].text).toContain(QUOTE);
    expect(q.discussion[0].actor).toEqual({ kind: "agent", agentId: AGENT });
  });

  it("checks the store revision like every write", async () => {
    const t = await setup();
    const stale = (await t.revision()) - 1;
    expect(err(await t.run({ expectedRevision: stale, sessionId: t.sessionId, questionId: t.questionId, quoted: QUOTE })).code).toBe("revision_conflict");
    expect((await t.question(t.sessionId, t.questionId)).validity).toBe("unanswered");
  });
});
