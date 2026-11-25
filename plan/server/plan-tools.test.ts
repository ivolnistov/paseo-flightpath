// Plan MCP tools (Stage 3 T3.6) through the official MCP SDK client over the real endpoint.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApprovalStore } from "./approvals";
import { TOOL_NAMES } from "./mcp-tools";
import { contentHashV2 } from "./plan-hash";
import { buildPlanTools, STAGE3_TOOL_NAMES } from "./plan-tools";
import { createPlanCommands, type PlanCommands } from "./plans";
import { UI_ORIGIN } from "./sessions";
import { openProjectStore, type ProjectDirectory } from "./store-root";
import { fixedClock, isJsonObject, nextId } from "./test-support/build";
import { callTool, sdkClient, startTestEndpoint, type TestEndpoint } from "./test-support/mcp";
import { ok } from "./test-support/service";

// Typed readers for the tool values these tests read (every accessed field is validated).
const Drafted = z.object({ planId: z.string(), rev: z.number(), contentHash: z.string() });
const Status = z.object({ approval: z.string() });
const StatusWithReasons = z.object({ approval: z.string(), notCurrentReasons: z.array(z.string()) });
const StatusList = z.object({ plans: z.array(z.object({ id: z.string(), approval: z.string() })) });

const FORBIDDEN_ARGS = new Set(["projectId", "storeRoot", "path", "root", "cwd"]);
const P = "prj_test";

beforeAll(async () => {
  await import("@modelcontextprotocol/sdk/client/index.js");
  await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
}, 60_000);

let t: TestEndpoint | undefined;
let closeClient: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeClient?.().catch(() => undefined);
  closeClient = undefined;
  await t?.stop();
  t = undefined;
});

// Plan commands take the opener from each call; their directory dependency is not used by them.
const unusedDirectory = (): ProjectDirectory => {
  throw new Error("plan commands must use the call's opener");
};
const planCommands = (stateDir: string): PlanCommands =>
  createPlanCommands({
    directory: unusedDirectory,
    now: fixedClock,
    newId: nextId,
    storeOptions: { now: fixedClock, newId: nextId },
    approvals: createApprovalStore({ stateDir, log: () => undefined }),
  });

function schemaKeys(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) schema.forEach((x) => schemaKeys(x, out));
  else if (isJsonObject(schema)) {
    const o = schema;
    if (o.properties && typeof o.properties === "object") out.push(...Object.keys(o.properties));
    Object.values(o).forEach((v) => schemaKeys(v, out));
  }
  return out;
}

async function setup() {
  t = await startTestEndpoint({ extraTools: (_commands, { stateDir }) => buildPlanTools(planCommands(stateDir)) });
  t.ready();
  const { url } = await t.grantFor();
  const client = await sdkClient(url);
  closeClient = () => client.close();
  const ui = planCommands(t.stateDir);
  const open = (projectId: string) => openProjectStore(t!.dir.directory, projectId, { now: fixedClock, newId: nextId });
  const version = async () => ok(await t!.project.service.version(t!.paseo, { projectId: P })).revision!;
  // One active, valid, answered question as the basis.
  const { service, paseo } = t.project;
  const sessionId = ok(await service.sessionCreate(paseo, { projectId: P, expectedRevision: await version(), title: "Basis" })).sessionId;
  const questionId = ok(
    await service.questionCreate(paseo, {
      projectId: P, expectedRevision: await version(), sessionId, title: "Q", context: "",
      options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [],
    }),
  ).questionId;
  ok(await service.questionAnswer(paseo, { projectId: P, expectedRevision: await version(), sessionId, questionId, optionId: "a" }));
  return { client, call: (name: string, args: Record<string, unknown>) => callTool(client, name, args), ui, open, version, sessionId };
}

describe("plan MCP tools", () => {
  it("lists the Stage 2 and Stage 3 tools, none approving, none taking a project or path argument", async () => {
    const s = await setup();
    const { tools } = await s.client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([...TOOL_NAMES, ...STAGE3_TOOL_NAMES].sort());
    expect([...STAGE3_TOOL_NAMES].sort()).toEqual(["roadmap_plan_draft", "roadmap_plan_status", "roadmap_task_update"]);
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/approve/);
      expect(schemaKeys(tool.inputSchema).filter((k) => FORBIDDEN_ARGS.has(k)), tool.name).toEqual([]);
    }
    const desc = Object.fromEntries(tools.map((x) => [x.name, x.description ?? ""]));
    for (const name of STAGE3_TOOL_NAMES) expect(desc[name], name).toContain("only in the Paseo UI");
    expect(desc.roadmap_task_update).toContain("never verified");
  });

  it("drafts from chat, reports status, and moves tasks only after a UI approval", async () => {
    const s = await setup();
    const drafted = await s.call("roadmap_plan_draft", {
      expectedRevision: await s.version(), title: "Chat plan", sessionIds: [s.sessionId], markdown: "# Chat plan", tasks: [{ id: "t1", title: "Do", description: "" }],
    });
    expect(drafted.isError, drafted.text).toBe(false);
    const draftedValue = Drafted.parse(drafted.value);
    expect(draftedValue.rev).toBe(1);
    const { planId, contentHash } = draftedValue;

    const view = ok(await s.ui.get(s.open, { projectId: P, planId }));
    expect(view.plan.title).toBe("Chat plan");
    expect(view.approval).toBe("unapproved");
    const status = await s.call("roadmap_plan_status", { planId });
    expect(status.isError, status.text).toBe(false);
    expect(Status.parse(status.value).approval).toBe("unapproved");
    expect(JSON.stringify(status.value)).toContain(contentHash);
    const list = await s.call("roadmap_plan_status", {});
    expect(list.isError, list.text).toBe(false);
    expect(JSON.stringify(list.value)).toContain(planId);

    const base = { expectedRevision: await s.version(), planId, taskId: "t1" };
    for (const missing of [{ contentHash, status: "in_progress" }, { planRev: 1, status: "in_progress" }]) {
      const out = await s.call("roadmap_task_update", { ...base, ...missing });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Invalid arguments");
    }
    const verified = await s.call("roadmap_task_update", { ...base, planRev: 1, contentHash, status: "verified" });
    expect(verified.isError).toBe(true);
    expect(verified.text).toContain("Invalid arguments");
    const early = await s.call("roadmap_task_update", { ...base, planRev: 1, contentHash, status: "in_progress" });
    expect(early.isError).toBe(true);
    expect(early.text.startsWith("plan_not_current:"), early.text).toBe(true);
    expect(await s.call("roadmap_plan_draft", { expectedRevision: 1, title: "x", sessionIds: [s.sessionId], markdown: "x", tasks: [], projectId: "prj_other" })).toMatchObject({ isError: true });

    ok(await s.ui.approve(s.open, { projectId: P, planId, rev: 1, contentHash }, UI_ORIGIN));
    const started = await s.call("roadmap_task_update", { ...base, expectedRevision: await s.version(), planRev: 1, contentHash, status: "in_progress" });
    expect(started.isError, started.text).toBe(false);
    const after = ok(await s.ui.get(s.open, { projectId: P, planId }));
    expect(after.approval).toBe("current");
    expect(after.plan.taskStates).toEqual([{ taskId: "t1", planRev: 1, status: "in_progress" }]);
  });
});

// Redesign Stage R0.6 (task card §7.3): the plan tool table built without an endpoint carries no
// approving, accepting or UI-only action; the combined index table is asserted in feature-tools.
describe("plan tool table (no network)", () => {
  it("holds exactly the Stage 3 tools, none matching accept, approve, delete, reorder or status_set", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateDir = await mkdtemp(join(tmpdir(), "dr-plan-tools-"));
    try {
      const names = buildPlanTools(planCommands(stateDir)).map((x) => x.name);
      expect([...names].sort()).toEqual([...STAGE3_TOOL_NAMES].sort());
      for (const n of names) expect(n).not.toMatch(/accept|approve|delete|reorder|status_set/);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

// Stage R1.0 (card §1.3, §1.6): roadmap_plan_draft reuses TaskInput and gains featureId?, so the MCP
// and the commands path produce the same revision from the same arguments; the strict schema still
// rejects projectId and unknown task keys; a v2-shaped draft without a feature binding is refused.
describe("R1.0 roadmap_plan_draft v2 parity", () => {
  async function withFeature() {
    const s = await setup();
    const { createFeatureCommands } = await import("./features");
    const features = createFeatureCommands({ directory: unusedDirectory, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } });
    const featureId = ok(
      await features.create(s.open, { projectId: P, expectedRevision: await s.version(), title: "F", description: "", kind: "feature" }, UI_ORIGIN),
    ).featureId;
    /** Another feature of the same shape (R2 corrective c0011: one plan per feature). */
    const otherFeature = async (title: string): Promise<string> =>
      ok(await features.create(s.open, { projectId: P, expectedRevision: await s.version(), title, description: "", kind: "feature" }, UI_ORIGIN)).featureId;
    return { ...s, featureId, otherFeature };
  }
  const tasks = [
    { id: "t1", title: "Build", description: "do", dod: "Tests pass" },
    { id: "t2", title: "Ship", description: "", dependsOn: ["t1"], parallel: true, completion: "human" as const, grill: true },
  ];
  const latestOf = async (s: Awaited<ReturnType<typeof withFeature>>, planId: string) => {
    const read = await (await s.open(P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    const plan = read.data.plans.find((p) => p.id === planId)!;
    const revision = plan.revisions.at(-1);
    // Narrows to the v2 revision these tests read; the schema assertion below stays the explicit check.
    if (!revision || !("schema" in revision) || revision.schema !== 2) throw new Error(`latest revision of ${planId} is not schema 2`);
    return { plan, revision };
  };

  it("the draft tool schema exposes featureId and the v2 task fields, and still no projectId", async () => {
    const s = await setup();
    const { tools } = await s.client.listTools();
    const draft = tools.find((x) => x.name === "roadmap_plan_draft")!;
    const keys = schemaKeys(draft.inputSchema);
    for (const k of ["featureId", "dependsOn", "parallel", "completion", "grill", "dod"]) expect(keys, k).toContain(k);
    expect(keys.filter((k) => FORBIDDEN_ARGS.has(k))).toEqual([]);
    expect(keys).not.toContain("grillSessionId");
  });

  it("the same arguments through MCP and through the commands yield the same schema 2 revision", async () => {
    const s = await withFeature();
    const args = { title: "Plan", sessionIds: [s.sessionId], markdown: "# Plan", tasks, featureId: s.featureId };
    const viaMcp = await s.call("roadmap_plan_draft", { expectedRevision: await s.version(), ...args });
    expect(viaMcp.isError, viaMcp.text).toBe(false);
    // R2 corrective c0011: one plan per feature, so the command draft binds an equivalent second feature.
    const featureB = await s.otherFeature("F2");
    const viaCmd = ok(await s.ui.draft(s.open, { projectId: P, expectedRevision: await s.version(), ...args, featureId: featureB }, UI_ORIGIN));
    const viaMcpValue = Drafted.parse(viaMcp.value);
    const a = await latestOf(s, viaMcpValue.planId);
    const b = await latestOf(s, viaCmd.planId);
    expect(a.revision.schema).toBe(2);
    // R2.2 (card §3.2): each draft creates its own server-owned session for the grill: true task t2,
    // so the revisions are equal except for that link, and each hash covers its own link.
    const linkA = a.revision.tasks[1].grillSessionId;
    const linkB = b.revision.tasks[1].grillSessionId;
    expect(typeof linkA, "MCP draft created a t2 session").toBe("string");
    expect(typeof linkB, "command draft created a t2 session").toBe("string");
    expect(linkA).not.toBe(linkB);
    // Structural comparison without the per-draft task links and the hash derived from them.
    const unlink = ({ contentHash: _h, ...r }: { contentHash: string; tasks: Array<{ grillSessionId?: string }> }) => ({
      ...r,
      tasks: r.tasks.map(({ grillSessionId: _g, ...rest }) => rest),
    });
    expect(unlink(a.revision)).toEqual(unlink(b.revision));
    expect("grillSessionId" in a.revision.tasks[0]).toBe(false);
    // Each hash is contentHashV2 of its own linked revision body, stored and returned.
    const ownHash = (r: Parameters<typeof contentHashV2>[0]) =>
      contentHashV2({ markdown: r.markdown, tasks: r.tasks, basedOn: r.basedOn, decisionSnapshotHash: r.decisionSnapshotHash });
    expect(a.revision.contentHash).toBe(ownHash(a.revision));
    expect(b.revision.contentHash).toBe(ownHash(b.revision));
    expect(viaMcpValue.contentHash).toBe(a.revision.contentHash);
    expect(viaCmd.contentHash).toBe(b.revision.contentHash);
    expect(viaMcpValue.contentHash, "different links, different hashes").not.toBe(viaCmd.contentHash);
    expect(a.plan.featureId).toBe(s.featureId);
    expect(b.plan.featureId).toBe(featureB);
  });

  it("the strict schema rejects projectId, grillSessionId and unknown task keys; a v2-shaped draft without featureId is invalid_input", async () => {
    const s = await withFeature();
    const base = { expectedRevision: await s.version(), title: "Plan", sessionIds: [s.sessionId], markdown: "# Plan" };
    const before = await s.version();
    for (const bad of [
      { ...base, tasks, featureId: s.featureId, projectId: P },
      { ...base, tasks: [{ title: "A", description: "", grillSessionId: "s1" }], featureId: s.featureId },
      { ...base, tasks: [{ title: "A", description: "", status: "done" }], featureId: s.featureId },
    ]) {
      const out = await s.call("roadmap_plan_draft", bad);
      expect(out.isError, JSON.stringify(bad)).toBe(true);
      expect(out.text).toContain("Invalid arguments");
    }
    const unbound = await s.call("roadmap_plan_draft", { ...base, tasks });
    expect(unbound.isError).toBe(true);
    expect(unbound.text.startsWith("invalid_input:"), unbound.text).toBe(true);
    expect(await s.version()).toBe(before);
    // Positive control: the same v2 draft with the binding succeeds.
    const bound = await s.call("roadmap_plan_draft", { ...base, tasks, featureId: s.featureId });
    expect(bound.isError, bound.text).toBe(false);
  });
});

// Stage R1.5 (task card §8.4 item 5; owner Q33=1): roadmap_plan_status goes through plan.get and
// plan.list, so a cancelled basis decision shows as not_current with the reason; an unrelated
// cancellation changes nothing.
describe("R1.5 roadmap_plan_status after a cancellation", () => {
  async function approved() {
    const s = await setup();
    const drafted = await s.call("roadmap_plan_draft", { expectedRevision: await s.version(), title: "Plan", sessionIds: [s.sessionId], markdown: "# Plan", tasks: [{ id: "t1", title: "Do", description: "" }] });
    expect(drafted.isError, drafted.text).toBe(false);
    const { planId, contentHash } = Drafted.parse(drafted.value);
    ok(await s.ui.approve(s.open, { projectId: P, planId, rev: 1, contentHash }, UI_ORIGIN));
    const read = await (await s.open(P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    const questionId = read.data.sessions.find((x) => x.id === s.sessionId)!.questions[0].id;
    const { service, paseo } = t!.project;
    const cancel = async (sessionId: string, qid: string) =>
      ok(await service.decisionCancel(paseo, { projectId: P, expectedRevision: await s.version(), sessionId, questionId: qid, reason: "Dropped" }));
    return { s, planId, questionId, cancel, service, paseo };
  }

  it("with planId: approval not_current and the '<ref> was cancelled' reason; without planId the list shows not_current", async () => {
    const a = await approved();
    await a.cancel(a.s.sessionId, a.questionId);
    const status = await a.s.call("roadmap_plan_status", { planId: a.planId });
    expect(status.isError, status.text).toBe(false);
    const statusValue = StatusWithReasons.parse(status.value);
    expect(statusValue.approval).toBe("not_current");
    expect(statusValue.notCurrentReasons).toContain(`${a.s.sessionId}/${a.questionId} was cancelled`);
    const list = await a.s.call("roadmap_plan_status", {});
    expect(list.isError, list.text).toBe(false);
    expect(StatusList.parse(list.value).plans.find((p) => p.id === a.planId)?.approval).toBe("not_current");
  });

  it("control: an unrelated cancellation keeps the plan current", async () => {
    const a = await approved();
    const other = ok(await a.service.sessionCreate(a.paseo, { projectId: P, expectedRevision: await a.s.version(), title: "Other" })).sessionId;
    const qid = ok(
      await a.service.questionCreate(a.paseo, { projectId: P, expectedRevision: await a.s.version(), sessionId: other, title: "Elsewhere", context: "", options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [] }),
    ).questionId;
    await a.cancel(other, qid);
    const status = await a.s.call("roadmap_plan_status", { planId: a.planId });
    const statusValue = StatusWithReasons.parse(status.value);
    expect(statusValue.approval).toBe("current");
    expect(statusValue.notCurrentReasons).toEqual([]);
  });
});

// R1 review c0002: the draft tool tells an MCP agent that explicitly cancelled decisions are excluded
// from the basis (they stay active but need no answer).
describe("R1 review c0002: roadmap_plan_draft description", () => {
  it("states that cancelled decisions are excluded from the basis; the existing answered-questions rule stays", async () => {
    const s = await setup();
    const { tools } = await s.client.listTools();
    const desc = tools.find((x) => x.name === "roadmap_plan_draft")?.description ?? "";
    expect(desc).toMatch(/answered/);
    expect(desc).toMatch(/cancel/i);
    expect(desc).toMatch(/cancel[a-z]*[^.]*(exclud|not (needed|required)|need no)/i);
  });
});

// R1 exact-review c0039 (card §9.6), updated for answers on accepted blocks: answering a cancelled
// decision fails with decision_cancelled, also for a question of an accepted block.
describe("R1 review c0039: frozen-first wording", () => {
  // Answers on accepted blocks: answering a cancelled frozen question is decision_cancelled, since
  // block_frozen now covers only definition and relation edits; the frozen-first order no longer
  // applies to answering.
  it("the draft description keeps the c0002 statements and names decision_cancelled for answering a cancelled decision", async () => {
    const s = await setup();
    const { tools } = await s.client.listTools();
    const desc = tools.find((x) => x.name === "roadmap_plan_draft")?.description ?? "";
    expect(desc).toMatch(/answered/);
    expect(desc).toMatch(/cancel[a-z]*[^.]*(exclud|not (needed|required)|need no)/i);
    expect(desc).toContain("decision_cancelled");
  });
});

// Stage R2.2 (task card 2026-10-29 §3.2, §3.3): roadmap_dod_template is defined behind an optional
// injected resolver, so the shipped one-argument buildPlanTools still lists exactly the Stage 3
// tools. With the resolver it returns the same { source, text } as dod.template.get for file,
// project, global and none; input {} only; it reads and never writes or applies a DoD. R2.4 makes
// the tool live in the server table; it is exercised here through the table without a network.
describe("R2.2 roadmap_dod_template tool definition", () => {
  const FILE_TEXT = "- [check] npm test\nFile criterion";
  const PROJECT_TEXT = "Project criterion";
  const GLOBAL_TEXT = "Global criterion";
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function withResolver(global?: string) {
    const { makeProject } = await import("./test-support/service");
    const { fakeDirectory } = await import("./test-support/fake-dir");
    const { createDodTemplateService } = await import("./dod-handlers");
    const { roadmapSettings } = await import("../shared/settings");
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const project = await makeProject();
    const stateDir = await mkdtemp(join(tmpdir(), "dr-dod-tool-"));
    cleanups.push(async () => {
      await project.cleanup();
      await rm(stateDir, { recursive: true, force: true });
    });
    const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
    const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
    const service = createDodTemplateService({
      directory: () => dir,
      storeOptions,
      settings: async () => roadmapSettings.schema.parse(global === undefined ? {} : { dodTemplate: global }),
      log: () => undefined,
    });
    ok(await project.service.init(project.paseo, { projectId: P }));
    const open = (projectId: string) => openProjectStore(dir, projectId, storeOptions);
    const resolver = (projectId: string) => service.get(project.paseo, { projectId });
    const commands = planCommands(stateDir);
    const tools = buildPlanTools(commands, resolver);
    const dodTool = tools.find((x) => x.name === "roadmap_dod_template");
    const run = async (args: unknown) => {
      expect(dodTool, "roadmap_dod_template is listed when the resolver is passed").toBeDefined();
      return dodTool!.run(dodTool!.input.parse(args), { open, projectId: P, origin: UI_ORIGIN });
    };
    const version = async () => (await (await open(P)).version()).revision;
    const setProjectText = async (text: string) => {
      const store = await open(P);
      await store.transact((await store.version()).revision!, (d) => {
        d.meta.settings.dodTemplate = text;
      });
    };
    const writeTemplateFile = (text: string) => writeFile(join(project.root, "dod template.md"), text);
    return { tools, dodTool, run, resolver, version, setProjectText, writeTemplateFile, commands, stateDir };
  }

  it("the one-argument call still lists exactly the three Stage 3 tools; the resolver adds only roadmap_dod_template", async () => {
    const s = await withResolver();
    expect(buildPlanTools(s.commands).map((x) => x.name).sort()).toEqual([...STAGE3_TOOL_NAMES].sort());
    expect(s.tools.map((x) => x.name).sort()).toEqual([...STAGE3_TOOL_NAMES, "roadmap_dod_template"].sort());
    for (const n of s.tools.map((x) => x.name)) expect(n).not.toMatch(/accept|approve|delete|reorder|status_set/);
  });

  it("returns the resolver's result for each source: file over project over global, else none", async () => {
    const s = await withResolver(GLOBAL_TEXT);
    expect(ok(await s.run({}))).toEqual({ source: "global", text: GLOBAL_TEXT });
    await s.setProjectText(PROJECT_TEXT);
    expect(ok(await s.run({}))).toEqual({ source: "project", text: PROJECT_TEXT });
    await s.writeTemplateFile(FILE_TEXT);
    const viaTool = await s.run({});
    expect(ok(viaTool)).toEqual({ source: "file", text: FILE_TEXT });
    expect(viaTool).toEqual(await s.resolver(P));
  });

  it("an empty template file still wins (explicit override); with no source the result is none", async () => {
    const s = await withResolver(GLOBAL_TEXT);
    await s.setProjectText(PROJECT_TEXT);
    await s.writeTemplateFile("");
    expect(ok(await s.run({}))).toEqual({ source: "file", text: "" });
    const none = await withResolver();
    expect(ok(await none.run({}))).toEqual({ source: "none", text: "" });
  });

  it("is read-only and takes no arguments: input {} only, no store write, and the description says it is guidance never applied", async () => {
    const s = await withResolver(GLOBAL_TEXT);
    expect(s.dodTool, "listed").toBeDefined();
    const input = s.dodTool!.input;
    expect(input.safeParse({}).success).toBe(true);
    for (const bad of [{ projectId: P }, { path: "/tmp" }, { text: "x" }]) expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    const before = await s.version();
    ok(await s.run({}));
    expect(await s.version()).toBe(before);
    const d = s.dodTool!.description;
    expect(d).toMatch(/guidance/i);
    expect(d).toMatch(/tailor/i);
    // The negation must govern the application clause: "never applied", "not automatically applied", ...
    expect(d).toMatch(/\b(never|not)(\s+\w+){0,3}\s+appl(y|ied|ies)\b/i);
  });
});

// Stage R2.3 (task card 2026-10-29 §4.2, §4.3): no MCP tool can rework, cancel or verify. The
// roadmap_task_update schema stays in_progress | done, so cancelled and verified are rejected by the
// schema (controls at R2.2 that must hold after TaskState gains cancelled).
describe("R2.3 MCP has no rework or cancel authority", () => {
  it("no tool is named for rework or cancel, with or without the DoD resolver", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateDir = await mkdtemp(join(tmpdir(), "dr-plan-tools-r23-"));
    try {
      const resolver = async () => ({ ok: true as const, value: { source: "none" as const, text: "" } });
      for (const tools of [buildPlanTools(planCommands(stateDir)), buildPlanTools(planCommands(stateDir), resolver)]) {
        for (const n of tools.map((x) => x.name)) expect(n).not.toMatch(/rework|cancel/);
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("roadmap_task_update rejects cancelled and verified through the strict schema (in_progress and done parse)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateDir = await mkdtemp(join(tmpdir(), "dr-plan-tools-r23-"));
    try {
      const update = buildPlanTools(planCommands(stateDir)).find((x) => x.name === "roadmap_task_update")!;
      const base = { expectedRevision: 1, planId: "p1", planRev: 1, contentHash: "a".repeat(64), taskId: "t1" };
      for (const status of ["in_progress", "done"]) expect(update.input.safeParse({ ...base, status }).success, status).toBe(true);
      for (const status of ["cancelled", "verified", "todo"]) expect(update.input.safeParse({ ...base, status }).success, status).toBe(false);
      expect(update.input.safeParse({ ...base, status: "cancelled", note: "x" }).success).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

// R2 corrective c0011 (task card 2026-10-29 §8.2, §8.7): roadmap_plan_draft inherits the producer's
// one-plan-per-feature guard: a second new plan for a bound feature is invalid_input with no write.
describe("R2 corrective c0011: roadmap_plan_draft refuses a second plan for a feature", () => {
  it("the first bound draft succeeds; a second new plan for the same feature is invalid_input (feature_has_plan) and writes nothing", async () => {
    const s = await setup();
    const { createFeatureCommands } = await import("./features");
    const features = createFeatureCommands({ directory: unusedDirectory, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } });
    const featureId = ok(await features.create(s.open, { projectId: P, expectedRevision: await s.version(), title: "F", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
    const args = { title: "Plan", sessionIds: [s.sessionId], markdown: "# Plan", tasks: [{ id: "t1", title: "Build", description: "do", dod: "x" }], featureId };
    const first = await s.call("roadmap_plan_draft", { expectedRevision: await s.version(), ...args });
    expect(first.isError, first.text).toBe(false);
    const before = await s.version();
    const second = await s.call("roadmap_plan_draft", { expectedRevision: before, ...args, title: "Another plan" });
    expect(second.isError, second.text).toBe(true);
    expect(second.text.startsWith("invalid_input:"), second.text).toBe(true);
    // MCP error text is "<code>: <message>" (details are not rendered); the card fixes the message.
    expect(second.text).toContain("the feature already has a plan");
    expect(await s.version()).toBe(before);
    // Control: a new revision of the same plan through planId still drafts.
    const again = await s.call("roadmap_plan_draft", { expectedRevision: before, ...args, planId: Drafted.parse(first.value).planId });
    expect(again.isError, again.text).toBe(false);
  });
});

// Stage R3.1 (task card 2026-10-29 R3 §2.2, §2.3): roadmap_plan_draft inherits the mid-run draft
// guard from the shared producer: running or paused → plan_not_current; an ended run does not block.
describe("R3.1 roadmap_plan_draft refuses a draft while the feature has a live run", () => {
  it("running and paused runs refuse the redraft with plan_not_current and no write; after the run ends it drafts", async () => {
    const s = await setup();
    const { createFeatureCommands } = await import("./features");
    const features = createFeatureCommands({ directory: unusedDirectory, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } });
    const featureId = ok(await features.create(s.open, { projectId: P, expectedRevision: await s.version(), title: "F", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
    const args = { title: "Plan", sessionIds: [s.sessionId], markdown: "# Plan", tasks: [{ id: "t1", title: "Build", description: "do", dod: "x" }], featureId };
    const first = await s.call("roadmap_plan_draft", { expectedRevision: await s.version(), ...args });
    expect(first.isError, first.text).toBe(false);
    const { planId } = Drafted.parse(first.value);
    const setRun = async (state: "running" | "paused" | "ended") =>
      (await s.open(P)).transact(await s.version(), (draft) => {
        draft.runs = [{
          id: "run-1", featureId, planId, planRev: 1, runToken: "tok", state,
          ...(state === "paused" ? { pauseReason: "owner" } : {}), ...(state === "ended" ? { endReason: "finished" } : {}),
          startAuth: { kind: "ui", at: "2026-10-29T10:00:00.000Z" }, tasks: [], acks: [], events: [{ at: "2026-10-29T10:00:00.000Z", kind: "started" }], lateEvidence: [],
        }];
      });
    for (const state of ["running", "paused"] as const) {
      await setRun(state);
      const before = await s.version();
      const out = await s.call("roadmap_plan_draft", { expectedRevision: before, ...args, planId, markdown: "# Again" });
      expect(out.isError, `${state}: ${out.text}`).toBe(true);
      expect(out.text.startsWith("plan_not_current:"), out.text).toBe(true);
      expect(out.text).toContain("revision is executing; stop and send for rework");
      expect(await s.version()).toBe(before);
    }
    await setRun("ended");
    const after = await s.call("roadmap_plan_draft", { expectedRevision: await s.version(), ...args, planId, markdown: "# After" });
    expect(after.isError, after.text).toBe(false);
    expect(Drafted.parse(after.value).rev).toBe(2);
  });
});
