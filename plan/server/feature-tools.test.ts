// Feature MCP tools (redesign Stage R0.5, task card §6, design §6): agents may only create and update
// feature cards and their dependencies. No tool deletes, reorders or sets a status, and no input
// carries project, path or authority fields. Tools are exercised exactly as the MCP endpoint calls
// them (`tool.input.safeParse`, then `run` with the grant's projectId and the chat origin), over a
// real temp store and without any network.
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import type { Result, ValueOf } from "../shared/rpc";
import type { FeatureCreate, FeatureList } from "../shared/rpc-features";
import type { McpToolTable } from "./mcp-tools";
import { TOOL_NAMES } from "./mcp-tools";
import { buildPlanTools, STAGE3_TOOL_NAMES } from "./plan-tools";
import { createApprovalStore } from "./approvals";
import { buildTools } from "./mcp-tools";
import { createPlanCommands } from "./plans";
import { createFeatureCommands } from "./features";
import { buildFeatureTools, FEATURE_TOOL_NAMES } from "./feature-tools";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
// The origin the MCP endpoint passes to every tool (server/mcp-endpoint.ts CHAT_ORIGIN).
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent" } };

type Json = any; // tool arguments and stored records

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup() {
  project = await makeProject();
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const deps = { directory: () => dir, now: fixedClock, newId: nextId, storeOptions };
  const sessions = createRoadmapCommands(deps);
  const features = createFeatureCommands(deps);
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await sessions.init(open, { projectId: P }, UI_ORIGIN));
  const tools: McpToolTable = buildFeatureTools(features);
  const tool = (name: string) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  /** Validates with the tool's own schema, as the endpoint does, then runs it for project P. */
  const call = async (name: string, args: unknown): Promise<Json> => {
    const parsed = tool(name).input.safeParse(args);
    if (!parsed.success) return { rejected: true, issues: parsed.error.issues };
    return tool(name).run(parsed.data, { open, projectId: P, origin: CHAT });
  };
  const revision = async () => ok(await sessions.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const data = async (): Promise<Json> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const snapshot = async () => canonicalJson(await data());
  // Typed by the feature.create contract: the dynamic tool table returns Result<unknown>.
  const createViaTool = async (title: string, extra: Record<string, unknown> = {}): Promise<Result<ValueOf<typeof FeatureCreate>>> =>
    call("roadmap_feature_create", { expectedRevision: await revision(), title, description: `About ${title}`, kind: "feature", ...extra });
  return { tools, tool, call, revision, data, snapshot, createViaTool, features, open };
}

describe("feature tool table", () => {
  it("has exactly roadmap_feature_create, roadmap_feature_list and roadmap_feature_update; nothing deletes, reorders or sets status", async () => {
    const s = await setup();
    expect([...FEATURE_TOOL_NAMES].sort()).toEqual(["roadmap_feature_create", "roadmap_feature_list", "roadmap_feature_update"]);
    expect(s.tools.map((t) => t.name).sort()).toEqual([...FEATURE_TOOL_NAMES].sort());
    // Only the feature tools are checked by name: the shipped read-only roadmap_plan_status is fine.
    for (const name of FEATURE_TOOL_NAMES) expect(name, name).not.toMatch(/delete|reorder|status|defer|cancel|start|approve/);
    for (const name of [...TOOL_NAMES, ...STAGE3_TOOL_NAMES]) expect(name, name).not.toMatch(/^roadmap_feature_/);
    for (const name of FEATURE_TOOL_NAMES) {
      expect(TOOL_NAMES as readonly string[], name).not.toContain(name);
      expect(STAGE3_TOOL_NAMES as readonly string[], name).not.toContain(name);
    }
  });
});

describe("roadmap_feature_create", () => {
  it("appends a created card attributed to agent unknown", async () => {
    const s = await setup();
    const first = ok(await s.createViaTool("Plugin system"));
    const second = ok(await s.createViaTool("Email channel", { kind: "bug", dependsOn: [first.featureId] }));
    expect(typeof second.revision).toBe("number");
    const d = await s.data();
    expect(d.features.map((f: Json) => f.id)).toEqual([first.featureId, second.featureId]);
    expect(d.features[1]).toMatchObject({
      title: "Email channel",
      kind: "bug",
      status: "created",
      everStarted: false,
      dependsOn: [first.featureId],
      createdBy: { kind: "agent", agentId: "unknown" },
    });
    expect(d.features[1].events).toHaveLength(1);
    expect(d.features[1].events[0]).toMatchObject({ kind: "created", actor: { kind: "agent", agentId: "unknown" } });
  });

  it("rejects authority, history and scope fields in its input; nothing is written", async () => {
    const s = await setup();
    const valid = { expectedRevision: await s.revision(), title: "T", description: "", kind: "feature" };
    expect(s.tool("roadmap_feature_create").input.safeParse(valid).success, "positive control").toBe(true);
    const before = await s.snapshot();
    const malicious: Array<Record<string, unknown>> = [
      { status: "executing" },
      { status: "done" },
      { everStarted: true },
      { createdBy: { kind: "human" } },
      { events: [] },
      { id: "f-chosen" },
      { statusBeforeDefer: "planned" },
      { coordinator: { agentId: "a", workspaceId: "w", boundAt: "2026-10-26T10:00:00.000Z", profileRef: "p" } },
      { order: 0 },
      { projectId: "prj_other" },
      { storeRoot: "/tmp" },
      { relatedTo: [] },
    ];
    for (const extra of malicious) {
      const out = await s.call("roadmap_feature_create", { ...valid, ...extra });
      expect(out.rejected, JSON.stringify(extra)).toBe(true);
    }
    expect(await s.snapshot()).toBe(before);
  });

  it("an unknown dependency is not_found and a stale expectedRevision is revision_conflict, without a write", async () => {
    const s = await setup();
    await s.createViaTool("A");
    const before = await s.snapshot();
    const missing = await s.createViaTool("B", { dependsOn: ["missing"] });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error.code).toBe("not_found");
    const stale = await s.call("roadmap_feature_create", { expectedRevision: (await s.revision()) - 1, title: "C", description: "", kind: "feature" });
    expect(stale.ok).toBe(false);
    expect(stale.error.code).toBe("revision_conflict");
    expect(await s.snapshot()).toBe(before);
  });

  it("writes only to the grant's project: the tool context, never the input, chooses the store", async () => {
    const s = await setup();
    const out = ok(await s.createViaTool("Scoped"));
    expect((await s.data()).features.map((f: Json) => f.id)).toEqual([out.featureId]);
    expect(s.tool("roadmap_feature_create").input.safeParse({ expectedRevision: 1, title: "T", description: "", kind: "feature", projectId: P }).success).toBe(false);
    expect(s.tool("roadmap_feature_update").input.safeParse({ expectedRevision: 1, featureId: "f", patch: { title: "T" }, projectId: P }).success).toBe(false);
  });
});

describe("roadmap_feature_update", () => {
  it("edits card fields and appends an updated event attributed to agent unknown", async () => {
    const s = await setup();
    const { featureId } = ok(await s.createViaTool("A"));
    ok(await s.call("roadmap_feature_update", { expectedRevision: await s.revision(), featureId, patch: { title: "A2", description: "Edited" } }));
    const f = (await s.data()).features[0];
    expect(f).toMatchObject({ title: "A2", description: "Edited", status: "created", createdBy: { kind: "agent", agentId: "unknown" } });
    expect(f.events.map((e: Json) => e.kind)).toEqual(["created", "updated"]);
    expect(f.events[1].actor).toEqual({ kind: "agent", agentId: "unknown" });
  });

  it("sets dependencies; unknown is not_found and a cycle is relation_cycle", async () => {
    const s = await setup();
    const a = ok(await s.createViaTool("A")).featureId;
    const b = ok(await s.createViaTool("B")).featureId;
    ok(await s.call("roadmap_feature_update", { expectedRevision: await s.revision(), featureId: b, dependsOn: [a] }));
    expect((await s.data()).features.find((f: Json) => f.id === b).dependsOn).toEqual([a]);
    const before = await s.snapshot();
    const unknown = await s.call("roadmap_feature_update", { expectedRevision: await s.revision(), featureId: a, dependsOn: ["missing"] });
    expect(unknown.error.code).toBe("not_found");
    const cycle = await s.call("roadmap_feature_update", { expectedRevision: await s.revision(), featureId: a, dependsOn: [b] });
    expect(cycle.error.code).toBe("relation_cycle");
    const self = await s.call("roadmap_feature_update", { expectedRevision: await s.revision(), featureId: a, dependsOn: [a] });
    expect(self.error.code).toBe("relation_cycle");
    expect(await s.snapshot()).toBe(before);
  });

  it("cannot set status, delete, reorder, start or rewrite history; such fields are rejected and nothing changes", async () => {
    const s = await setup();
    const { featureId } = ok(await s.createViaTool("A"));
    const valid = { expectedRevision: await s.revision(), featureId, patch: { title: "OK" } };
    expect(s.tool("roadmap_feature_update").input.safeParse(valid).success, "positive control").toBe(true);
    const before = await s.snapshot();
    const malicious: Array<Record<string, unknown>> = [
      { status: "cancelled" },
      { delete: true },
      { order: [featureId] },
      { everStarted: true },
      { events: [] },
      { createdBy: { kind: "human" } },
      { patch: { status: "done" } },
      { patch: { everStarted: true } },
      { patch: { events: [] } },
      { patch: { statusBeforeDefer: "planned" } },
      { patch: { createdBy: { kind: "human" } } },
      { patch: { coordinator: { agentId: "a", workspaceId: "w", boundAt: "2026-10-26T10:00:00.000Z", profileRef: "p" } } },
    ];
    for (const extra of malicious) {
      const out = await s.call("roadmap_feature_update", { ...valid, ...extra });
      expect(out.rejected, JSON.stringify(extra)).toBe(true);
    }
    expect(await s.snapshot()).toBe(before);
  });

  it("an unknown feature is not_found; a stale expectedRevision is revision_conflict", async () => {
    const s = await setup();
    const { featureId } = ok(await s.createViaTool("A"));
    const before = await s.snapshot();
    const unknown = await s.call("roadmap_feature_update", { expectedRevision: await s.revision(), featureId: "missing", patch: { title: "X" } });
    expect(unknown.error.code).toBe("not_found");
    const stale = await s.call("roadmap_feature_update", { expectedRevision: (await s.revision()) - 1, featureId, patch: { title: "X" } });
    expect(stale.error.code).toBe("revision_conflict");
    expect(await s.snapshot()).toBe(before);
  });

  it("tool writes never start execution", async () => {
    const s = await setup();
    const a = ok(await s.createViaTool("A")).featureId;
    const b = ok(await s.createViaTool("B", { dependsOn: [a] })).featureId;
    ok(await s.call("roadmap_feature_update", { expectedRevision: await s.revision(), featureId: b, patch: { description: "More" } }));
    const d = await s.data();
    expect(d.runs).toEqual([]);
    expect(d.delegations).toEqual([]);
    for (const f of d.features) expect(f).toMatchObject({ status: "created", everStarted: false });
  });
});

// Redesign Stage R0.6 (task card §7.2/§7.3): the full MCP table as index.server.ts builds it.
describe("combined MCP tool table", () => {
  it("holds exactly the Stage 2, Stage 3 and feature tools, unique, with no accepting, approving or UI-only tool", async () => {
    const s = await setup();
    const deps = { directory: () => fakeDirectory({ projects: [] }), now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } };
    const planCommands = createPlanCommands({ ...deps, approvals: createApprovalStore({ stateDir: join(project!.parent, "state"), log: () => undefined }) });
    const table = buildTools(createRoadmapCommands(deps), [...buildPlanTools(planCommands), ...buildFeatureTools(s.features)]);
    const names = table.map((t) => t.name);
    expect([...names].sort()).toEqual([...TOOL_NAMES, ...STAGE3_TOOL_NAMES, ...FEATURE_TOOL_NAMES].sort());
    expect(new Set(names).size).toBe(names.length);
    // roadmap_block_accept (quoted chat consent) is the only accepting tool; nothing approves,
    // deletes, reorders or sets status.
    for (const n of names.filter((x) => x !== "roadmap_block_accept")) expect(n, n).not.toMatch(/accept|approve|delete|reorder|status_set/);
    expect(names.filter((x) => /accept/.test(x))).toEqual(["roadmap_block_accept"]);
  });
});

// R0 review c0051: the MCP endpoint converts every tool input with
// `z.toJSONSchema(input, { io: "input", unrepresentable: "any" })` at startup
// (server/mcp-endpoint.ts). Refinements (the update tool's "patch or dependsOn" rule and the
// non-empty patch) are not representable in JSON Schema and are enforced by the server's own parse;
// these tests check only that the conversion succeeds, the published properties and strictness.
describe("feature tool input JSON schemas", () => {
  const FORBIDDEN = ["projectId", "storeRoot", "path", "root", "cwd", "status", "everStarted", "events", "createdBy", "order", "delete", "coordinator", "statusBeforeDefer"];
  const keysOf = (schema: unknown, out: string[] = []): string[] => {
    if (Array.isArray(schema)) schema.forEach((x) => keysOf(x, out));
    else if (schema && typeof schema === "object") {
      const o = schema as Record<string, unknown>;
      if (o.properties && typeof o.properties === "object") out.push(...Object.keys(o.properties));
      Object.values(o).forEach((v) => keysOf(v, out));
    }
    return out;
  };
  const convert = async (name: string) => {
    const s = await setup();
    return z.toJSONSchema(s.tool(name).input, { io: "input", unrepresentable: "any" }) as Record<string, any>;
  };

  it("roadmap_feature_create converts to a strict object with exactly its card fields", async () => {
    const schema = await convert("roadmap_feature_create");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(["dependsOn", "description", "expectedRevision", "kind", "title"]);
    expect([...schema.required].sort()).toEqual(["description", "expectedRevision", "kind", "title"]);
    expect(keysOf(schema).filter((k) => FORBIDDEN.includes(k))).toEqual([]);
  });

  it("roadmap_feature_update converts to a strict object whose patch is a strict object of card fields", async () => {
    const schema = await convert("roadmap_feature_update");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(["dependsOn", "expectedRevision", "featureId", "patch"]);
    expect([...schema.required].sort()).toEqual(["expectedRevision", "featureId"]);
    const patch = schema.properties.patch;
    expect(patch.type).toBe("object");
    expect(patch.additionalProperties).toBe(false);
    expect(Object.keys(patch.properties).sort()).toEqual(["description", "title"]);
    expect(keysOf(schema).filter((k) => FORBIDDEN.includes(k))).toEqual([]);
  });
});

// Final review correction (card §11, DeepSeek c0090): a read-only roadmap_feature_list lets an
// agent discover feature ids it did not create. Strict empty input; the project comes only from
// the grant context; it returns the existing feature.list value and writes nothing.
describe("roadmap_feature_list", () => {
  // Typed by the feature.list contract: the dynamic tool table returns Result<unknown>.
  const list = (s: Awaited<ReturnType<typeof setup>>, args: unknown = {}): Promise<Result<ValueOf<typeof FeatureList>>> => s.call("roadmap_feature_list", args);
  const uiCreate = async (s: Awaited<ReturnType<typeof setup>>, title: string) =>
    ok(await s.features.create(s.open, { projectId: P, expectedRevision: await s.revision(), title, description: "", kind: "feature" }, UI_ORIGIN)).featureId;

  it("discovers a card created outside the tools, and its id drives update and dependencies", async () => {
    const s = await setup();
    const a = await uiCreate(s, "Plugin system");
    const b = await uiCreate(s, "Email channel");
    const listed = ok(await list(s));
    expect(listed.features.map((f: Json) => f.id)).toEqual([a, b]);
    expect(listed.features[0]).toMatchObject({ id: a, title: "Plugin system", createdBy: { kind: "human" } });
    const discovered = listed.features[1].id;
    ok(await s.call("roadmap_feature_update", { expectedRevision: await s.revision(), featureId: discovered, patch: { title: "Email channel v2" } }));
    ok(await s.call("roadmap_feature_update", { expectedRevision: await s.revision(), featureId: discovered, dependsOn: [listed.features[0].id] }));
    const after = (await s.data()).features.find((f: Json) => f.id === b);
    expect(after).toMatchObject({ title: "Email channel v2", dependsOn: [a] });
  });

  it("returns the roadmap order and the current store revision", async () => {
    const s = await setup();
    const [a, b, c] = [await uiCreate(s, "A"), await uiCreate(s, "B"), await uiCreate(s, "C")];
    ok(await s.features.reorder(s.open, { projectId: P, expectedRevision: await s.revision(), order: [c, a, b] }, UI_ORIGIN));
    const listed = ok(await list(s));
    expect(listed.features.map((f: Json) => f.id)).toEqual([c, a, b]);
    expect(listed.revision).toBe(await s.revision());
    expect(listed.features).toEqual((await s.data()).features);
  });

  it("takes a strict empty input: projectId and any other key are rejected", async () => {
    const s = await setup();
    const input = s.tool("roadmap_feature_list").input;
    expect(input.safeParse({}).success, "positive control").toBe(true);
    for (const extra of [{ projectId: P }, { projectId: "prj_other" }, { storeRoot: "/tmp" }, { order: [] }, { status: "done" }, { x: 1 }]) {
      expect(input.safeParse(extra).success, JSON.stringify(extra)).toBe(false);
    }
    const schema = z.toJSONSchema(input, { io: "input", unrepresentable: "any" }) as Record<string, any>;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {})).toEqual([]);
  });

  it("writes nothing", async () => {
    const s = await setup();
    await uiCreate(s, "A");
    const before = await s.snapshot();
    const revision = await s.revision();
    ok(await list(s));
    ok(await list(s));
    expect(await s.snapshot()).toBe(before);
    expect(await s.revision()).toBe(revision);
  });

  it("is store_missing for a registered project whose store was never initialised", async () => {
    project = await makeProject();
    const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
    const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
    const tools = buildFeatureTools(createFeatureCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions }));
    const t = tools.find((x) => x.name === "roadmap_feature_list");
    expect(t, "roadmap_feature_list is in the table").toBeDefined();
    const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
    const out = (await t!.run(t!.input.parse({}), { open, projectId: P, origin: CHAT })) as Json;
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("store_missing");
  });
});
