// Chat-consent block acceptance: roadmap_block_accept accepts the open block only for a bound agent
// that reports the human's explicit words in `quoted`, recorded as the acceptor's attribution. It is
// the same store transaction as the panel's Accept (summary snapshot, next block, continuation
// transition) followed by the same post-commit hook; a refused attempt never falls back to a human
// acceptor, writes nothing and wakes nothing. Stale revisions and a second acceptance are refused,
// and plan approval is untouched. Real temp stores; the tool table is run directly.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "../shared/canonical";
import type { RoadmapData } from "../shared/model";
import { buildTools, TOOL_NAMES } from "./mcp-tools";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { buildBlockSummary } from "./summary";
import { fixedClock, nextId, opt } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { binding, BLK_OPEN, continuationIn, OP, PLANNER, seedGrilling } from "./test-support/grilling";
import { makePlanProject, type PlanProject } from "./test-support/plans";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const ab = [opt("a"), opt("b")];
const QUOTE = "yes, accept this block";
type AfterAccept = { projectId: string; sessionId: string; operationId: string };

let project: TestProject | undefined;
let planProject: PlanProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
  await planProject?.cleanup();
  planProject = undefined;
});

async function setup() {
  project = await makeProject();
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const woken: AfterAccept[] = [];
  const commands = createRoadmapCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions, afterAccept: (x: AfterAccept) => void woken.push(x) });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const tools = buildTools(commands);
  const tool = (name: string) => {
    const found = tools.find((x) => x.name === name);
    if (found === undefined) throw new Error(`tool ${name} missing`);
    return found;
  };
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const at = async () => ({ projectId: P, expectedRevision: await revision() });
  const data = async (): Promise<RoadmapData> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const session = async (id: string) => (await data()).sessions.find((s) => s.id === id)!;
  /** A session with one answered question in its open block BLK_OPEN. */
  const blockSession = async (grilling = false) => {
    const sessionId = ok(await commands.sessionCreate(open, { ...(await at()), title: "Grilling" }, UI_ORIGIN)).sessionId;
    const [q1] = ok(
      await commands.questionCreateBatch(
        open,
        { ...(await at()), sessionId, blockId: BLK_OPEN, questions: [{ title: "Q1", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [] }] },
        { source: "chat", actor: { kind: "agent" } },
      ),
    ).questionIds;
    ok(await commands.questionAnswer(open, { ...(await at()), sessionId, questionId: q1, optionId: "a" }, UI_ORIGIN));
    if (grilling) await seedGrilling(open, P, sessionId, { planner: binding(), continuation: continuationIn("paused") });
    return { sessionId, q1 };
  };
  const boundCtx = (agentId = PLANNER) => ({ open, projectId: P, origin: { source: "chat", actor: { kind: "agent", agentId } } as WriteOrigin, agentId, workspaceId: "ws-1" });
  const chatAccept = async (sessionId: string, extra: { quoted?: string; expectedRevision?: number; blockId?: string; ctx?: ReturnType<typeof boundCtx> } = {}) =>
    tool("roadmap_block_accept").run(
      { expectedRevision: extra.expectedRevision ?? (await revision()), sessionId, blockId: extra.blockId ?? BLK_OPEN, quoted: extra.quoted ?? QUOTE },
      extra.ctx ?? boundCtx(),
    );
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  return { commands, open, tool, revision, at, data, session, blockSession, boundCtx, chatAccept, snapshot, woken };
}

describe("the tool", () => {
  it("is listed with a strict input that requires the human's quoted consent", async () => {
    const t = await setup();
    expect(TOOL_NAMES).toContain("roadmap_block_accept");
    const input = t.tool("roadmap_block_accept").input;
    const base = { expectedRevision: 2, sessionId: "s1", blockId: "b1", quoted: QUOTE };
    expect(input.safeParse(base).success).toBe(true);
    const { quoted: _q, ...unquoted } = base;
    expect(input.safeParse(unquoted).success).toBe(false);
    expect(input.safeParse({ ...base, quoted: "" }).success).toBe(false);
    const { expectedRevision: _e, ...noRevision } = base;
    expect(input.safeParse(noRevision).success).toBe(false);
    expect(input.safeParse({ ...base, projectId: "prj_other" }).success).toBe(false);
  });

  it("its description keeps the quoting rule and that no tool approves a plan", async () => {
    const t = await setup();
    const description = t.tool("roadmap_block_accept").description;
    expect(description).toContain("quoted");
    expect(description).toContain("no tool can approve");
  });
});

describe("accepting with quoted consent", () => {
  it("freezes the open block with the agent and the quoted words as acceptor, stores the summary snapshot and opens the next block", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession();
    const expected = buildBlockSummary(await t.data(), sessionId, BLK_OPEN);
    const before = await t.revision();
    const out = z.object({ revision: z.number(), blockId: z.string(), nextBlockId: z.string() }).parse(ok(await t.chatAccept(sessionId, { quoted: `  ${QUOTE}  ` })));
    expect(out).toMatchObject({ revision: before + 1, blockId: BLK_OPEN });
    const blocks = (await t.session(sessionId)).blocks!;
    expect(blocks.find((b) => b.id === BLK_OPEN)).toMatchObject({ state: "accepted", acceptedBy: { kind: "agent", agentId: PLANNER, quoted: QUOTE }, summary: expected });
    expect(blocks.filter((b) => b.state === "open").map((b) => b.id)).toEqual([out.nextBlockId]);
  });

  it("advances a waiting operation exactly as the panel's Accept and runs the post-commit hook once", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession(true);
    ok(await t.chatAccept(sessionId));
    const s = await t.session(sessionId);
    const accepted = s.blocks!.find((b) => b.id === BLK_OPEN);
    expect(s.continuation).toMatchObject({ state: "resolving", acceptedBlockId: BLK_OPEN });
    expect(s.continuation?.summary).toBe(accepted?.state === "accepted" ? accepted.summary : undefined);
    expect(t.woken).toEqual([{ projectId: P, sessionId, operationId: OP }]);
  });

  it("the panel's Accept still records a human acceptor", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession();
    ok(await t.commands.blockAccept(t.open, { ...(await t.at()), sessionId, blockId: BLK_OPEN }, UI_ORIGIN));
    expect((await t.session(sessionId)).blocks!.find((b) => b.id === BLK_OPEN)).toMatchObject({ acceptedBy: { kind: "human" } });
  });
});

describe("refusals write nothing, never downgrade to a human acceptor, and wake nothing", () => {
  it("a chat origin without a bound agent", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession(true);
    const before = await t.snapshot();
    const out = await t.tool("roadmap_block_accept").run(
      { expectedRevision: before.revision, sessionId, blockId: BLK_OPEN, quoted: QUOTE },
      { open: t.open, projectId: P, origin: { source: "chat", actor: { kind: "agent" } } },
    );
    expect(err(out).code).toBe("invalid_input");
    expect(await t.snapshot()).toEqual(before);
    expect(t.woken).toEqual([]);
  });

  it("a bound chat origin without quoted words, or with only whitespace", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession(true);
    const before = await t.snapshot();
    const agent: WriteOrigin = { source: "chat", actor: { kind: "agent", agentId: PLANNER } };
    expect(err(await t.commands.blockAccept(t.open, { ...(await t.at()), sessionId, blockId: BLK_OPEN }, agent)).code).toBe("invalid_input");
    expect(err(await t.commands.blockAccept(t.open, { ...(await t.at()), sessionId, blockId: BLK_OPEN }, { ...agent, quoted: "   " })).code).toBe("invalid_input");
    expect(err(await t.chatAccept(sessionId, { quoted: "   " })).code).toBe("invalid_input");
    expect(await t.snapshot()).toEqual(before);
    expect(t.woken).toEqual([]);
  });

  it("a stale revision is revision_conflict", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession(true);
    const before = await t.snapshot();
    expect(err(await t.chatAccept(sessionId, { expectedRevision: before.revision - 1 })).code).toBe("revision_conflict");
    expect(await t.snapshot()).toEqual(before);
    expect(t.woken).toEqual([]);
  });

  it("a second acceptance of the same block, or an unknown block, is invalid_input", async () => {
    const t = await setup();
    const { sessionId } = await t.blockSession(true);
    ok(await t.chatAccept(sessionId));
    const before = await t.snapshot();
    expect(err(await t.chatAccept(sessionId)).code).toBe("invalid_input");
    expect(err(await t.chatAccept(sessionId, { blockId: "no-such-block" })).code).toBe("invalid_input");
    expect(await t.snapshot()).toEqual(before);
    expect(t.woken).toHaveLength(1);
  });
});

describe("plan approval is untouched", () => {
  it("an approved plan stays current and gains no approval when its basis block is accepted from chat", async () => {
    planProject = await makePlanProject();
    const t = planProject;
    const { service, paseo } = t.project;
    const at = async () => ({ projectId: t.P, expectedRevision: await t.revision() });
    const s = ok(await service.sessionCreate(paseo, { ...(await at()), title: "Basis" })).sessionId;
    const q1 = ok(await service.questionCreate(paseo, { ...(await at()), sessionId: s, title: "Q1", context: "", options: ab, allowFreeText: false, activatedBy: [], invalidatedBy: [], blockId: "b1" })).questionId;
    ok(await service.questionAnswer(paseo, { ...(await at()), sessionId: s, questionId: q1, optionId: "a" }));
    const draft = ok(await t.plans.draft(t.open, { ...(await at()), title: "Rollout", sessionIds: [s], markdown: "# Rollout", tasks: [{ id: "t1", title: "Build", description: "do" }] }, UI_ORIGIN));
    ok(await t.plans.approve(t.open, { projectId: t.P, planId: draft.planId, rev: draft.rev, contentHash: draft.contentHash }, UI_ORIGIN));
    const receipts = async () => (await readdir(join(t.stateDir, "approvals", t.P, draft.planId)).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const before = await receipts();

    const commands = createRoadmapCommands({ directory: () => { throw new Error("unused"); }, now: fixedClock, newId: nextId });
    const tools = buildTools(commands);
    const accept = tools.find((x) => x.name === "roadmap_block_accept");
    expect(accept).toBeDefined();
    const out = await accept!.run({ expectedRevision: await t.revision(), sessionId: s, blockId: "b1", quoted: QUOTE }, { open: t.open, projectId: t.P, origin: { source: "chat", actor: { kind: "agent", agentId: PLANNER } }, agentId: PLANNER, workspaceId: "ws-1" });
    expect(out.ok).toBe(true);
    const view = ok(await t.plans.get(t.open, { projectId: t.P, planId: draft.planId }));
    expect(view.approval).toBe("current");
    expect(await receipts()).toEqual(before);
  });
});
