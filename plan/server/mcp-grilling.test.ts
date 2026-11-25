// Automatic grilling S2/G3 (task card §4.2 MCP, TR5, TR11, TR13): roadmap_ask reads the calling
// agent's pause support before the command (only when the grant has an agent) and returns the
// command's grilling value with no extra text; roadmap_pause_instructions is read-only;
// roadmap_grill_complete takes expectedRevision and is planner-only. Tool table run directly over
// real temp stores; the support reader is a recorded test double of the injected dependency.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Session } from "../shared/model";
import { buildTools, TOOL_NAMES, type McpToolTable } from "./mcp-tools";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { binding, BLK_OPEN, continuationIn, OP, OTHER_AGENT, PLANNER, seedGrilling } from "./test-support/grilling";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const NOT_PLANNER = "This session's planner is another chat; do not pause.";
const unsupportedText = (reason: string) => `This chat cannot pause natively (${reason}); do not pause; the owner continues manually.`;
const chat = (agentId?: string): WriteOrigin => ({ source: "chat", actor: agentId !== undefined ? { kind: "agent", agentId } : { kind: "agent" } });
const Grilling = z.object({ grilling: z.object({ operationId: z.string().optional(), state: z.string().optional(), instructions: z.string() }).strict() });

type Support = { kind: "supported" } | { kind: "unsupported"; reason: string } | { kind: "unknown" };

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup(support?: (agentId: string) => Support) {
  project = await makeProject();
  const proj = project;
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: proj.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string, e?: unknown) => void proj.logs.push([m, e]) };
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const supportCalls: string[] = [];
  const tools: McpToolTable = buildTools(commands, [], support === undefined ? undefined : { support: async (agentId: string) => (supportCalls.push(agentId), support(agentId)) });
  const tool = (name: string) => {
    const found = tools.find((x) => x.name === name);
    if (found === undefined) throw new Error(`tool ${name} missing`);
    return found;
  };
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const sessionOf = async (sessionId: string): Promise<Session> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    return read.data.sessions.find((x) => x.id === sessionId)!;
  };
  const newSession = async () => ok(await commands.sessionCreate(open, { projectId: P, expectedRevision: await revision(), title: "Grilling" }, UI_ORIGIN)).sessionId;
  const ctx = (agentId?: string) => ({ open, projectId: P, origin: chat(agentId), ...(agentId !== undefined ? { agentId, workspaceId: "ws-1" } : {}) });
  const ask = async (sessionId: string, agentId?: string) =>
    tool("roadmap_ask").run(
      { expectedRevision: await revision(), sessionId, blockId: BLK_OPEN, questions: [{ title: "Q", context: "", options: [opt("a"), opt("b")], allowFreeText: false, activatedBy: [], invalidatedBy: [] }] },
      ctx(agentId),
    );
  return { commands, open, tools, tool, revision, sessionOf, newSession, ctx, ask, supportCalls };
}

describe("tool table", () => {
  it("TOOL_NAMES holds roadmap_pause_instructions and roadmap_grill_complete, and buildTools exposes them", async () => {
    const t = await setup();
    expect(TOOL_NAMES).toContain("roadmap_pause_instructions");
    expect(TOOL_NAMES).toContain("roadmap_grill_complete");
    expect(t.tools.map((x) => x.name)).toEqual(expect.arrayContaining(["roadmap_pause_instructions", "roadmap_grill_complete"]));
  });

  it("the new tools take strict inputs: { sessionId } and { expectedRevision, sessionId, operationId }", async () => {
    const t = await setup();
    const instructions = t.tool("roadmap_pause_instructions").input;
    expect(instructions.safeParse({ sessionId: "s1" }).success).toBe(true);
    expect(instructions.safeParse({ sessionId: "s1", projectId: "prj_other" }).success).toBe(false);
    const complete = t.tool("roadmap_grill_complete").input;
    expect(complete.safeParse({ expectedRevision: 3, sessionId: "s1", operationId: "op-1" }).success).toBe(true);
    expect(complete.safeParse({ sessionId: "s1", operationId: "op-1" }).success).toBe(false);
    expect(complete.safeParse({ expectedRevision: 3, sessionId: "s1", operationId: "op-1", agentId: "x" }).success).toBe(false);
  });
});

describe("roadmap_ask reads the caller's pause support", () => {
  it("an unsupported first caller binds and its operation is unsupported with the reason; the value says do not pause", async () => {
    const t = await setup(() => ({ kind: "unsupported", reason: "codex default mode" }));
    const sid = await t.newSession();
    const out = ok(await t.ask(sid, PLANNER));
    expect(t.supportCalls).toEqual([PLANNER]);
    const c = (await t.sessionOf(sid)).continuation;
    expect(c).toMatchObject({ state: "unsupported", reason: "codex default mode", target: { agentId: PLANNER, epoch: 1 }, attempts: 0 });
    expect(Grilling.parse(out).grilling).toEqual({ operationId: c?.operationId, state: "unsupported", instructions: unsupportedText("codex default mode") });
  });

  it("unsupported support of a caller that is not the planner never makes the operation unsupported", async () => {
    const t = await setup((agentId) => (agentId === OTHER_AGENT ? { kind: "unsupported", reason: "codex default mode" } : { kind: "supported" }));
    const sid2 = await t.newSession();
    ok(await t.commands.questionCreateBatch(t.open, { projectId: P, expectedRevision: await t.revision(), sessionId: sid2, blockId: BLK_OPEN, questions: [{ title: "Q", context: "", options: [opt("a")], allowFreeText: false, activatedBy: [], invalidatedBy: [] }] }, chat()));
    await seedGrilling(t.open, P, sid2, { planner: binding() });
    const out = ok(await t.ask(sid2, OTHER_AGENT));
    expect(t.supportCalls).toEqual([OTHER_AGENT]);
    expect((await t.sessionOf(sid2)).continuation).toMatchObject({ state: "awaiting_pause", target: { agentId: PLANNER, epoch: 1 } });
    expect(Grilling.parse(out).grilling.instructions).toBe(NOT_PLANNER);
  });

  it("unknown support (or no support reader at all) is awaiting_pause with the pause contract", async () => {
    for (const support of [() => ({ kind: "unknown" as const }), undefined]) {
      const t = await setup(support);
      const sid = await t.newSession();
      const out = ok(await t.ask(sid, PLANNER));
      expect((await t.sessionOf(sid)).continuation?.state).toBe("awaiting_pause");
      const g = Grilling.parse(out).grilling;
      expect(g.state).toBe("awaiting_pause");
      expect(g.instructions).toContain("DR-OP-");
      await project?.cleanup();
      project = undefined;
    }
  });

  it("a grant without an agent never calls the support reader", async () => {
    const t = await setup(() => ({ kind: "supported" }));
    const sid = await t.newSession();
    ok(await t.ask(sid));
    expect(t.supportCalls).toEqual([]);
  });

  it("the value is the command's value: no other text is added", async () => {
    const t = await setup(() => ({ kind: "supported" }));
    const sid = await t.newSession();
    // numbers and links are part of the command's value (stable question numbers and links).
    const Links = z.object({ question: z.string(), answer: z.string() }).strict();
    const out = z
      .object({ revision: z.number(), questionIds: z.array(z.string()), numbers: z.array(z.number()), links: z.array(Links), visibilityChanged: z.array(z.unknown()), grilling: z.unknown() })
      .strict()
      .safeParse(ok(await t.ask(sid, PLANNER)));
    expect(out.success, out.success ? "" : JSON.stringify(out.error.issues)).toBe(true);
  });
});

describe("roadmap_pause_instructions", () => {
  it("returns the current operation's grilling object for the calling agent and writes nothing", async () => {
    const t = await setup();
    const sid = await t.newSession();
    const asked = Grilling.parse(ok(await t.ask(sid, PLANNER))).grilling;
    const before = await t.revision();
    const mine = ok(await t.tool("roadmap_pause_instructions").run({ sessionId: sid }, t.ctx(PLANNER)));
    expect(mine).toEqual(asked);
    const theirs = ok(await t.tool("roadmap_pause_instructions").run({ sessionId: sid }, t.ctx(OTHER_AGENT)));
    expect(theirs).toEqual({ operationId: asked.operationId, state: "awaiting_pause", instructions: NOT_PLANNER });
    expect(await t.revision()).toBe(before);
  });
});

describe("roadmap_grill_complete", () => {
  it("the planner completes the current operation and the session closes", async () => {
    const t = await setup();
    const sid = await t.newSession();
    ok(await t.ask(sid));
    await seedGrilling(t.open, P, sid, { planner: binding(), continuation: continuationIn("awaiting_pause") });
    const before = await t.revision();
    expect(ok(await t.tool("roadmap_grill_complete").run({ expectedRevision: before, sessionId: sid, operationId: OP }, t.ctx(PLANNER)))).toEqual({
      revision: before + 1,
      state: "complete",
    });
    const s = await t.sessionOf(sid);
    expect(s.status).toBe("closed");
    expect(s.continuation?.state).toBe("complete");
  });

  it("a grant without an agent, or another agent, gets planner_bound and nothing is written", async () => {
    const t = await setup();
    const sid = await t.newSession();
    ok(await t.ask(sid));
    await seedGrilling(t.open, P, sid, { planner: binding(), continuation: continuationIn("awaiting_pause") });
    const before = await t.revision();
    expect(err(await t.tool("roadmap_grill_complete").run({ expectedRevision: before, sessionId: sid, operationId: OP }, t.ctx())).code).toBe("planner_bound");
    expect(err(await t.tool("roadmap_grill_complete").run({ expectedRevision: before, sessionId: sid, operationId: OP }, t.ctx(OTHER_AGENT))).code).toBe("planner_bound");
    expect(await t.revision()).toBe(before);
  });
});

// S2 successor KensAI review (session 01a198e0): c57.
describe("S2 successor KensAI c57", () => {
  it("c57: when the planner's own batch reads its support as unsupported, a kept awaiting operation becomes unsupported instead of returning the pause contract", async () => {
    let support: Support = { kind: "supported" };
    const t = await setup(() => support);
    const sid = await t.newSession();
    ok(await t.ask(sid, PLANNER));
    expect((await t.sessionOf(sid)).continuation?.state).toBe("awaiting_pause");
    support = { kind: "unsupported", reason: "codex default mode" };
    const out = ok(await t.ask(sid, PLANNER));
    expect((await t.sessionOf(sid)).continuation).toMatchObject({ state: "unsupported", reason: "codex default mode" });
    expect(Grilling.parse(out).grilling.instructions).toBe(unsupportedText("codex default mode"));
  });
});

// S2 corrected KensAI review (session 01a19904): c78.
describe("S2 corrected KensAI c78", () => {
  it("c78 (guard): a bound roadmap_ask reports (agentId, projectId) to the engine index; an unbound grant reports nothing", async () => {
    const t = await setup();
    const remembered: Array<[string, string]> = [];
    const ask = buildTools(t.commands, [], { remember: (agentId: string, projectId: string) => void remembered.push([agentId, projectId]) }).find((x) => x.name === "roadmap_ask");
    if (ask === undefined) throw new Error("roadmap_ask missing");
    const args = async (sessionId: string) => ({
      expectedRevision: await t.revision(),
      sessionId,
      blockId: BLK_OPEN,
      questions: [{ title: "Q", context: "", options: [opt("a")], allowFreeText: false, activatedBy: [], invalidatedBy: [] }],
    });
    const unbound = await t.newSession();
    ok(await ask.run(await args(unbound), t.ctx()));
    expect(remembered).toEqual([]);
    const bound = await t.newSession();
    ok(await ask.run(await args(bound), t.ctx(PLANNER)));
    expect(remembered).toEqual([[PLANNER, P]]);
  });
});

// S2 final KensAI review (session 01a19929): c105 (TR5 ordering).
describe("S2 final KensAI c105", () => {
  it("c105 (guard): roadmap_ask reads support before its own store transaction: while the read is pending an independent command commits, and the ask writes only after the read resolves", async () => {
    const t = await setup();
    let release: (s: Support) => void = () => undefined;
    const pendingSupport = new Promise<Support>((r) => {
      release = r;
    });
    let reads = 0;
    const ask = buildTools(t.commands, [], {
      support: async () => {
        reads += 1;
        return pendingSupport;
      },
    }).find((x) => x.name === "roadmap_ask");
    if (ask === undefined) throw new Error("roadmap_ask missing");
    const sid = await t.newSession();
    const before = await t.revision();
    const asked = ask.run(
      { expectedRevision: before, sessionId: sid, blockId: BLK_OPEN, questions: [{ title: "Q", context: "", options: [opt("a")], allowFreeText: false, activatedBy: [], invalidatedBy: [] }] },
      t.ctx(PLANNER),
    );
    expect(reads, "the support read started with the call").toBe(1);
    // The store is free while the host read is pending: an independent command commits.
    const independent = ok(await t.commands.sessionCreate(t.open, { projectId: P, expectedRevision: before, title: "Independent" }, UI_ORIGIN));
    expect(independent.revision).toBe(before + 1);
    expect((await t.sessionOf(sid)).questions, "the ask has written nothing yet").toHaveLength(0);
    release({ kind: "supported" });
    // The ask's own transaction starts only now, after the independent commit, so its revision is stale.
    expect(err(await asked).code).toBe("revision_conflict");
    expect((await t.sessionOf(sid)).questions).toHaveLength(0);
  });
});
