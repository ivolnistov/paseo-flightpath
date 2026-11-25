// Feature records (redesign Stage R0.5, task card §6, design §2/§3.1/§6): ordered roadmap of feature
// cards, dependencies without cycles, manual status transitions, deletion only before the first
// start, append-only history. Commands run over real temp stores; UI-only writes are also refused
// for the chat origin. Records the server cannot reach before R3 (planned, executing, done,
// everStarted) are seeded directly through the store, never through a feature command.
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import { Feature, type FeatureStatus } from "../shared/model";
import type { ValueOf } from "../shared/rpc";
import {
  FeatureCreate,
  FeatureDelete,
  FeatureDependenciesSet,
  FeatureList,
  FeatureReorder,
  FeatureStatusSet,
  FeatureUpdate,
} from "../shared/rpc-features";
import { createFeatureCommands, createFeatureService, type FeatureCommands } from "./features";
import { registerFeatureHandlers } from "./feature-handlers";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener, type WriteOrigin } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, NOW_ISO, nextId } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const CHAT: WriteOrigin = { source: "chat", actor: { kind: "agent" } };

type Json = any; // stored records and command inputs, kept loose so tests can seed and tamper

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup() {
  project = await makeProject();
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: (m: string, e?: unknown) => void project!.logs.push([m, e]) };
  const deps = { directory: () => dir, now: fixedClock, newId: nextId, storeOptions };
  const sessions = createRoadmapCommands(deps);
  const features: FeatureCommands = createFeatureCommands(deps);
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await sessions.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => ok(await sessions.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const data = async (): Promise<Json> => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error(`expected ok store, got ${read.status}`);
    return read.data;
  };
  const at = async () => ({ projectId: P, expectedRevision: await revision() });
  const feature = async (id: string): Promise<Json> => (await data()).features.find((f: Json) => f.id === id);
  const create = async (title: string, extra: Record<string, unknown> = {}, origin: WriteOrigin = UI_ORIGIN) =>
    features.create(open, { ...(await at()), title, description: `About ${title}`, kind: "feature", ...extra } as Json, origin);
  const createId = async (title: string, extra: Record<string, unknown> = {}) => ok(await create(title, extra)).featureId;
  /** Seeds fields no R0.5 command may set (status reached through runs, everStarted). */
  const seed = async (id: string, fields: Record<string, unknown>) =>
    (await open(P)).transact(await revision(), (d: Json) => {
      const f = d.features.find((x: Json) => x.id === id);
      Object.assign(f, fields);
      for (const [k, v] of Object.entries(fields)) if (v === undefined) delete f[k];
    });
  const snapshot = async () => ({ revision: await revision(), text: canonicalJson(await data()) });
  return { project, dir, deps, features, open, revision, data, at, feature, create, createId, seed, snapshot };
}
type H = Awaited<ReturnType<typeof setup>>;

async function expectRejected(h: H, result: Json, code?: string) {
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (code !== undefined) expect(result.error.code).toBe(code);
}
/** Runs `attempt`; expects `code` (when given) and a store byte-identical to before. */
async function expectNoWrite(h: H, attempt: () => Promise<Json>, code?: string) {
  const before = await h.snapshot();
  await expectRejected(h, await attempt(), code);
  expect(await h.snapshot()).toEqual(before);
}

const status = async (h: H, featureId: string, to: FeatureStatus | string, origin: WriteOrigin = UI_ORIGIN) =>
  h.features.statusSet(h.open, { ...(await h.at()), featureId, status: to } as Json, origin);

// ---------------------------------------------------------------------------------------------

describe("contracts", () => {
  it("names the seven feature RPCs", () => {
    expect([FeatureList, FeatureCreate, FeatureUpdate, FeatureReorder, FeatureDependenciesSet, FeatureDelete, FeatureStatusSet].map((c) => c.name)).toEqual([
      "feature.list",
      "feature.create",
      "feature.update",
      "feature.reorder",
      "feature.dependencies.set",
      "feature.delete",
      "feature.status.set",
    ]);
  });

  it("every write contract requires expectedRevision; status values are the six feature statuses only", () => {
    for (const c of [FeatureCreate, FeatureUpdate, FeatureReorder, FeatureDependenciesSet, FeatureDelete, FeatureStatusSet]) {
      expect(Object.keys((c.input as Json).shape), c.name).toContain("expectedRevision");
    }
    const base = { projectId: P, expectedRevision: 1, featureId: "f1" };
    expect(FeatureStatusSet.input.safeParse({ ...base, status: "deferred" }).success).toBe(true);
    for (const s of ["built", "approved", "paused"]) expect(FeatureStatusSet.input.safeParse({ ...base, status: s }).success, s).toBe(false);
  });
});

describe("create and list", () => {
  it("create appends in order with status created, everStarted false, a human creator and one created event", async () => {
    const h = await setup();
    const a = await h.createId("Plugin system");
    const b = await h.createId("Email channel", { kind: "bug" });
    const d = await h.data();
    expect(d.features.map((f: Json) => f.id)).toEqual([a, b]);
    expect(d.meta.featureIds).toEqual([a, b]);
    const fa = d.features[0];
    expect(fa).toMatchObject({
      id: a,
      title: "Plugin system",
      description: "About Plugin system",
      kind: "feature",
      status: "created",
      dependsOn: [],
      relatedTo: [],
      everStarted: false,
      createdAt: NOW_ISO,
      createdBy: { kind: "human" },
      coordinatorHistory: [],
    });
    expect(fa).not.toHaveProperty("statusBeforeDefer");
    expect(fa).not.toHaveProperty("coordinator");
    expect(fa.events).toEqual([{ at: NOW_ISO, actor: { kind: "human" }, kind: "created" }]);
    expect(d.features[1].kind).toBe("bug");
    for (const f of d.features) expect(Feature.safeParse(f).success).toBe(true);
  });

  it("create with dependencies on existing features; an unknown dependency is not_found without a write", async () => {
    const h = await setup();
    const a = await h.createId("A");
    const b = await h.createId("B", { dependsOn: [a] });
    expect((await h.feature(b)).dependsOn).toEqual([a]);
    await expectNoWrite(h, () => h.create("C", { dependsOn: ["missing"] }), "not_found");
  });

  it("list returns the features in roadmap order with the store revision", async () => {
    const h = await setup();
    const a = await h.createId("A");
    const b = await h.createId("B");
    const out = ok(await h.features.list(h.open, { projectId: P }, UI_ORIGIN)) as Json;
    expect(out.revision).toBe(await h.revision());
    expect(out.features.map((f: Json) => f.id)).toEqual([a, b]);
    expect(out.features).toEqual((await h.data()).features);
  });

  it("a stale expectedRevision is a revision_conflict without a write", async () => {
    const h = await setup();
    await h.createId("A");
    const stale = (await h.revision()) - 1;
    await expectNoWrite(
      h,
      () => h.features.create(h.open, { projectId: P, expectedRevision: stale, title: "B", description: "", kind: "feature" } as Json, UI_ORIGIN),
      "revision_conflict",
    );
  });

  it("creating features never starts execution: no runs, no delegations, nothing started", async () => {
    const h = await setup();
    const a = await h.createId("A");
    await h.createId("B", { dependsOn: [a] });
    ok(await status(h, a, "deferred"));
    ok(await status(h, a, "created"));
    const d = await h.data();
    expect(d.runs).toEqual([]);
    expect(d.delegations).toEqual([]);
    expect(d.meta.runIds).toEqual([]);
    for (const f of d.features) expect(f.everStarted).toBe(false);
  });
});

describe("update", () => {
  it("edits card fields, appends an updated event and keeps everything else", async () => {
    const h = await setup();
    const a = await h.createId("A");
    const before = await h.feature(a);
    ok(await h.features.update(h.open, { ...(await h.at()), featureId: a, patch: { title: "A, renamed", description: "New text" } } as Json, UI_ORIGIN));
    const after = await h.feature(a);
    expect(after).toMatchObject({ title: "A, renamed", description: "New text", status: "created", createdBy: before.createdBy, createdAt: before.createdAt });
    expect(after.events.slice(0, before.events.length)).toEqual(before.events);
    expect(after.events.at(-1)).toMatchObject({ kind: "updated", actor: { kind: "human" }, at: NOW_ISO });
  });

  it("an unknown feature is not_found; status, history and start fields cannot be patched", async () => {
    const h = await setup();
    const a = await h.createId("A");
    await expectNoWrite(h, async () => h.features.update(h.open, { ...(await h.at()), featureId: "missing", patch: { title: "X" } } as Json, UI_ORIGIN), "not_found");
    for (const patch of [{ status: "done" }, { everStarted: true }, { events: [] }, { createdBy: { kind: "human" } }, { dependsOn: [] }]) {
      expect(FeatureUpdate.input.safeParse({ projectId: P, expectedRevision: 2, featureId: a, patch }).success, JSON.stringify(patch)).toBe(false);
    }
    expect(FeatureUpdate.input.safeParse({ projectId: P, expectedRevision: 2, featureId: a, patch: { title: "OK" } }).success).toBe(true);
  });
});

describe("reorder", () => {
  it("a permutation of all feature ids reorders the roadmap and meta.featureIds and records reordered", async () => {
    const h = await setup();
    const [a, b, c] = [await h.createId("A"), await h.createId("B"), await h.createId("C")];
    const before = (await h.data()).features;
    ok(await h.features.reorder(h.open, { ...(await h.at()), order: [c, a, b] } as Json, UI_ORIGIN));
    const d = await h.data();
    expect(d.features.map((f: Json) => f.id)).toEqual([c, a, b]);
    expect(d.meta.featureIds).toEqual([c, a, b]);
    let reordered = 0;
    for (const f of d.features) {
      const old = before.find((x: Json) => x.id === f.id);
      expect(f.events.slice(0, old.events.length)).toEqual(old.events);
      reordered += f.events.filter((e: Json) => e.kind === "reordered").length;
    }
    expect(reordered).toBeGreaterThan(0);
  });

  it("anything but a permutation of all ids is rejected without a write", async () => {
    const h = await setup();
    const [a, b, c] = [await h.createId("A"), await h.createId("B"), await h.createId("C")];
    for (const order of [[a, b], [a, b, c, c], [a, b, "missing"], [a, a, b], []]) {
      await expectNoWrite(h, async () => h.features.reorder(h.open, { ...(await h.at()), order } as Json, UI_ORIGIN));
    }
    ok(await h.features.reorder(h.open, { ...(await h.at()), order: [b, c, a] } as Json, UI_ORIGIN));
  });
});

describe("dependencies.set", () => {
  const deps = async (h: H, featureId: string, dependsOn: string[], origin: WriteOrigin = UI_ORIGIN) =>
    h.features.dependenciesSet(h.open, { ...(await h.at()), featureId, dependsOn } as Json, origin);

  it("sets a valid DAG and records a dependencies event", async () => {
    const h = await setup();
    const [a, b, c] = [await h.createId("A"), await h.createId("B"), await h.createId("C")];
    ok(await deps(h, b, [a]));
    ok(await deps(h, c, [a, b]));
    expect((await h.feature(c)).dependsOn).toEqual([a, b]);
    expect((await h.feature(c)).events.at(-1)).toMatchObject({ kind: "dependencies", actor: { kind: "human" } });
    ok(await deps(h, c, []));
    expect((await h.feature(c)).dependsOn).toEqual([]);
  });

  it("an unknown dependency or feature is not_found", async () => {
    const h = await setup();
    const a = await h.createId("A");
    await expectNoWrite(h, () => deps(h, a, ["missing"]), "not_found");
    await expectNoWrite(h, () => deps(h, "missing", [a]), "not_found");
  });

  it("a self dependency, a two-feature cycle and a three-feature cycle are relation_cycle", async () => {
    const h = await setup();
    const [a, b, c] = [await h.createId("A"), await h.createId("B"), await h.createId("C")];
    await expectNoWrite(h, () => deps(h, a, [a]), "relation_cycle");
    ok(await deps(h, b, [a]));
    await expectNoWrite(h, () => deps(h, a, [b]), "relation_cycle");
    ok(await deps(h, c, [b]));
    await expectNoWrite(h, () => deps(h, a, [c]), "relation_cycle");
    // Positive control: a non-cyclic edge between the same features is accepted.
    ok(await deps(h, c, [a, b]));
  });
});

describe("status.set: manual transitions", () => {
  /** A feature seeded into `from` (deferred also needs its prior status). */
  async function at(h: H, from: FeatureStatus, before?: "created" | "planned" | "executing") {
    const id = await h.createId(`From ${from}`);
    if (from !== "created") await h.seed(id, { status: from, ...(from === "deferred" ? { statusBeforeDefer: before ?? "planned" } : {}) });
    return id;
  }

  for (const from of ["created", "planned", "executing"] as const) {
    it(`${from} → deferred records statusBeforeDefer; undefer restores ${from}`, async () => {
      const h = await setup();
      const id = await at(h, from);
      ok(await status(h, id, "deferred"));
      expect(await h.feature(id)).toMatchObject({ status: "deferred", statusBeforeDefer: from });
      expect((await h.feature(id)).events.at(-1)).toMatchObject({ kind: "status", from, to: "deferred", actor: { kind: "human" } });
      ok(await status(h, id, from));
      const restored = await h.feature(id);
      expect(restored.status).toBe(from);
      expect(restored).not.toHaveProperty("statusBeforeDefer");
      expect(restored.events.at(-1)).toMatchObject({ kind: "status", from: "deferred", to: from });
      expect(Feature.safeParse(restored).success).toBe(true);
    });

    it(`${from} → cancelled`, async () => {
      const h = await setup();
      const id = await at(h, from);
      ok(await status(h, id, "cancelled"));
      expect((await h.feature(id)).status).toBe("cancelled");
    });
  }

  it("deferred → cancelled clears statusBeforeDefer", async () => {
    const h = await setup();
    const id = await at(h, "deferred", "executing");
    ok(await status(h, id, "cancelled"));
    const f = await h.feature(id);
    expect(f.status).toBe("cancelled");
    expect(f).not.toHaveProperty("statusBeforeDefer");
  });

  it("deferred can only return to the status it held before", async () => {
    const h = await setup();
    const id = await at(h, "deferred", "planned");
    for (const to of ["created", "executing", "done", "deferred"]) await expectNoWrite(h, () => status(h, id, to), "feature_transition");
    ok(await status(h, id, "planned"));
  });

  it("no manual move to planned, executing or done, and no same-status move", async () => {
    const h = await setup();
    const id = await at(h, "created");
    for (const to of ["planned", "executing", "done", "created"]) await expectNoWrite(h, () => status(h, id, to), "feature_transition");
    const planned = await at(h, "planned");
    for (const to of ["executing", "done", "created", "planned"]) await expectNoWrite(h, () => status(h, planned, to), "feature_transition");
    const executing = await at(h, "executing");
    for (const to of ["done", "planned", "created", "executing"]) await expectNoWrite(h, () => status(h, executing, to), "feature_transition");
  });

  it("done is never cancelled, deferred or moved; cancelled never leaves cancelled", async () => {
    const h = await setup();
    const done = await at(h, "done");
    for (const to of ["cancelled", "deferred", "created", "planned", "executing"]) await expectNoWrite(h, () => status(h, done, to), "feature_transition");
    const cancelled = await at(h, "cancelled");
    for (const to of ["created", "planned", "executing", "done", "deferred"]) await expectNoWrite(h, () => status(h, cancelled, to), "feature_transition");
    // Positive control in the same store: a created feature can still be cancelled.
    ok(await status(h, await at(h, "created"), "cancelled"));
  });

  it("an unknown feature is not_found; a status outside the six is rejected", async () => {
    const h = await setup();
    await h.createId("A");
    await expectNoWrite(h, () => status(h, "missing", "deferred"), "not_found");
    const a = (await h.data()).features[0].id;
    await expectNoWrite(h, () => status(h, a, "built"));
  });

  it("status changes never set everStarted", async () => {
    const h = await setup();
    const id = await at(h, "planned");
    ok(await status(h, id, "deferred"));
    ok(await status(h, id, "planned"));
    ok(await status(h, id, "cancelled"));
    expect((await h.feature(id)).everStarted).toBe(false);
  });
});

describe("delete", () => {
  const del = async (h: H, featureId: string, origin: WriteOrigin = UI_ORIGIN) =>
    h.features.delete(h.open, { ...(await h.at()), featureId } as Json, origin);

  it("deletes a never-started feature in any non-started status and removes it from the order", async () => {
    const h = await setup();
    const [a, b, c] = [await h.createId("A"), await h.createId("B"), await h.createId("C")];
    await h.seed(b, { status: "deferred", statusBeforeDefer: "planned" });
    ok(await del(h, a));
    ok(await del(h, b));
    const d = await h.data();
    expect(d.features.map((f: Json) => f.id)).toEqual([c]);
    expect(d.meta.featureIds).toEqual([c]);
  });

  it("a feature that ever started is never deleted, even when deferred or cancelled", async () => {
    const h = await setup();
    const a = await h.createId("A");
    await h.seed(a, { everStarted: true, status: "cancelled" });
    await expectNoWrite(h, () => del(h, a), "feature_transition");
    const b = await h.createId("B");
    await h.seed(b, { everStarted: true, status: "deferred", statusBeforeDefer: "executing" });
    await expectNoWrite(h, () => del(h, b), "feature_transition");
    // Positive control: a never-started sibling is deletable.
    ok(await del(h, await h.createId("C")));
  });

  it("a prerequisite of another feature is not deleted; after the dependency is cleared it is", async () => {
    const h = await setup();
    const a = await h.createId("A");
    const b = await h.createId("B", { dependsOn: [a] });
    await expectNoWrite(h, () => del(h, a), "feature_transition");
    ok(await h.features.dependenciesSet(h.open, { ...(await h.at()), featureId: b, dependsOn: [] } as Json, UI_ORIGIN));
    ok(await del(h, a));
  });

  it("an unknown feature is not_found", async () => {
    const h = await setup();
    await h.createId("A");
    await expectNoWrite(h, () => del(h, "missing"), "not_found");
  });
});

describe("history is append-only", () => {
  it("every change appends one event; earlier events are never removed or rewritten", async () => {
    const h = await setup();
    const a = await h.createId("A");
    const b = await h.createId("B");
    const steps: Array<() => Promise<Json>> = [
      async () => h.features.update(h.open, { ...(await h.at()), featureId: a, patch: { description: "x" } } as Json, UI_ORIGIN),
      async () => h.features.dependenciesSet(h.open, { ...(await h.at()), featureId: a, dependsOn: [b] } as Json, UI_ORIGIN),
      async () => status(h, a, "deferred"),
      async () => status(h, a, "created"),
      async () => h.features.reorder(h.open, { ...(await h.at()), order: [b, a] } as Json, UI_ORIGIN),
    ];
    let previous = (await h.feature(a)).events;
    for (const step of steps) {
      ok(await step());
      const events = (await h.feature(a)).events;
      expect(events.slice(0, previous.length)).toEqual(previous);
      expect(events.length).toBeGreaterThanOrEqual(previous.length);
      previous = events;
    }
    expect(previous.map((e: Json) => e.kind)).toEqual(["created", "updated", "dependencies", "status", "status", "reordered"]);
  });

  it("a rejected change appends nothing", async () => {
    const h = await setup();
    const a = await h.createId("A");
    const events = (await h.feature(a)).events;
    await status(h, a, "done");
    await h.features.dependenciesSet(h.open, { ...(await h.at()), featureId: a, dependsOn: [a] } as Json, UI_ORIGIN);
    expect((await h.feature(a)).events).toEqual(events);
  });
});

describe("origins", () => {
  it("the chat origin can create and update cards, recorded as agent unknown until grants bind agents", async () => {
    const h = await setup();
    const id = ok(await h.create("Agent card", {}, CHAT)).featureId;
    const f = await h.feature(id);
    expect(f.createdBy).toEqual({ kind: "agent", agentId: "unknown" });
    expect(f.events[0]).toEqual({ at: NOW_ISO, actor: { kind: "agent", agentId: "unknown" }, kind: "created" });
    ok(await h.features.update(h.open, { ...(await h.at()), featureId: id, patch: { title: "Edited by agent" } } as Json, CHAT));
    expect((await h.feature(id)).events.at(-1).actor).toEqual({ kind: "agent", agentId: "unknown" });
  });

  it("reorder, delete and status changes are UI-only: the chat origin is refused without a write", async () => {
    const h = await setup();
    const [a, b] = [await h.createId("A"), await h.createId("B")];
    await expectNoWrite(h, async () => h.features.reorder(h.open, { ...(await h.at()), order: [b, a] } as Json, CHAT), "invalid_input");
    await expectNoWrite(h, async () => h.features.delete(h.open, { ...(await h.at()), featureId: a } as Json, CHAT), "invalid_input");
    await expectNoWrite(h, () => status(h, a, "deferred", CHAT), "invalid_input");
    await expectNoWrite(h, () => status(h, a, "cancelled", CHAT), "invalid_input");
    // Positive controls: the same calls succeed from the UI.
    ok(await status(h, a, "deferred"));
    ok(await h.features.reorder(h.open, { ...(await h.at()), order: [b, a] } as Json, UI_ORIGIN));
    ok(await h.features.delete(h.open, { ...(await h.at()), featureId: b } as Json, UI_ORIGIN));
  });

  it("the RPC handlers route every feature contract through the UI origin", async () => {
    const h = await setup();
    const routes = new Map<string, (input: unknown, ctx: { paseo: PaseoApi }) => Promise<Json>>();
    const service = createFeatureService({ ...h.deps, directory: () => h.dir });
    registerFeatureHandlers({ handle: ((contract: { name: string }, fn: Json) => void routes.set(contract.name, fn)) as never }, service);
    expect([...routes.keys()].sort()).toEqual(
      ["feature.create", "feature.delete", "feature.dependencies.set", "feature.list", "feature.reorder", "feature.status.set", "feature.update"].sort(),
    );
    const paseo = h.project.paseo;
    const created = ok<ValueOf<typeof FeatureCreate>>(await routes.get("feature.create")!({ projectId: P, expectedRevision: await h.revision(), title: "Via RPC", description: "", kind: "feature" }, { paseo }));
    expect((await h.feature(created.featureId)).createdBy).toEqual({ kind: "human" });
    ok(await routes.get("feature.status.set")!({ projectId: P, expectedRevision: await h.revision(), featureId: created.featureId, status: "deferred" }, { paseo }));
    ok(await routes.get("feature.delete")!({ projectId: P, expectedRevision: await h.revision(), featureId: created.featureId }, { paseo }));
    expect((await h.data()).features).toEqual([]);
  });
});

// R0 review c0050: feature.list on a registered project whose store was never initialised.
describe("list without a store", () => {
  it("is store_missing", async () => {
    project = await makeProject();
    const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
    const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
    const features = createFeatureCommands({ directory: () => dir, now: fixedClock, newId: nextId, storeOptions });
    const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
    const out = await features.list(open, { projectId: P }, UI_ORIGIN);
    expect(err(out).code).toBe("store_missing");
  });
});

// Stage R1.0 (card §1.5, §1.6): `relatedTo` is a create-only, descriptive relation. Valid ids are
// stored as given; duplicates and unknown ids are refused without a write; absent means `[]`. The
// update contracts and the MCP tools keep rejecting it (no authority by schema reuse).
describe("R1.0 relatedTo on create", () => {
  it("the create contract accepts relatedTo; the update and dependencies contracts strip it and the patch rejects it", () => {
    const base = { projectId: P, expectedRevision: 1, title: "T", description: "", kind: "feature" };
    expect((FeatureCreate.input.parse({ ...base, relatedTo: ["f1", "f2"] }) as Json).relatedTo).toEqual(["f1", "f2"]);
    expect(FeatureCreate.input.safeParse({ ...base, relatedTo: [""] }).success).toBe(false);
    // Positive control: the same input without relatedTo is accepted.
    expect(FeatureCreate.input.safeParse(base).success).toBe(true);
    const ref = { projectId: P, expectedRevision: 1, featureId: "f1" };
    // The update contracts are non-strict at the top level (Mutation.extend): an extra relatedTo is
    // stripped, never carried; inside the strict FeaturePatch it is rejected.
    expect(FeatureUpdate.input.parse({ ...ref, patch: { title: "X" }, relatedTo: ["f2"] })).not.toHaveProperty("relatedTo");
    expect(FeatureUpdate.input.safeParse({ ...ref, patch: { relatedTo: ["f2"] } }).success).toBe(false);
    expect(FeatureDependenciesSet.input.parse({ ...ref, dependsOn: [], relatedTo: ["f2"] })).not.toHaveProperty("relatedTo");
    expect(FeatureUpdate.input.safeParse({ ...ref, patch: { title: "X" } }).success).toBe(true);
  });

  it("stores valid relatedTo ids as given, in order", async () => {
    const h = await setup();
    const a = await h.createId("A");
    const b = await h.createId("B");
    const c = ok(await h.create("C", { relatedTo: [b, a] })).featureId;
    expect((await h.feature(c)).relatedTo).toEqual([b, a]);
    expect(Feature.safeParse(await h.feature(c)).success).toBe(true);
  });

  it("absent relatedTo stores []", async () => {
    const h = await setup();
    const a = await h.createId("A");
    expect((await h.feature(a)).relatedTo).toEqual([]);
  });

  it("duplicate relatedTo ids are invalid_input with no write", async () => {
    const h = await setup();
    const a = await h.createId("A");
    await expectNoWrite(h, () => h.create("C", { relatedTo: [a, a] }), "invalid_input");
    // Positive control: the same create without the duplicate writes.
    ok(await h.create("C", { relatedTo: [a] }));
  });

  it("unknown relatedTo ids are not_found with no write", async () => {
    const h = await setup();
    const a = await h.createId("A");
    await expectNoWrite(h, () => h.create("C", { relatedTo: [a, "missing"] }), "not_found");
    ok(await h.create("C", { relatedTo: [a] }));
  });

  it("feature.update leaves relatedTo unchanged and adds no relatedTo history kind", async () => {
    const h = await setup();
    const a = await h.createId("A");
    const c = ok(await h.create("C", { relatedTo: [a] })).featureId;
    ok(await h.features.update(h.open, { ...(await h.at()), featureId: c, patch: { title: "C2" } } as Json, UI_ORIGIN));
    const after = await h.feature(c);
    expect(after.relatedTo).toEqual([a]);
    expect(after.events.map((e: Json) => e.kind)).not.toContain("relatedTo");
  });
});

// R1 exact-review c0040 (card §9.2): feature.delete refuses a feature that plans are bound to, after
// the existing everStarted and dependents checks; the refusal writes nothing.
describe("R1 review c0040: delete refuses a bound feature", () => {
  /** Seeds synthetic minimal plans (bound or unbound) directly through the store; revisions are not needed for the guard. */
  const seedPlans = async (h: H, plans: Array<{ id: string; featureId?: string }>) =>
    (await h.open(P)).transact(await h.revision(), (d: Json) => {
      for (const p of plans) {
        d.plans.push({ id: p.id, title: `Plan ${p.id}`, sessionIds: [], revisions: [], approvals: [], taskStates: [], intents: [], tickets: [], ...(p.featureId ? { featureId: p.featureId } : {}) });
      }
    });
  const del = async (h: H, featureId: string) => h.features.delete(h.open, { ...(await h.at()), featureId } as Json, UI_ORIGIN);

  it("a bound, unstarted feature with no dependents is feature_transition with { featureId, planIds } in store order and no write", async () => {
    const h = await setup();
    const a = await h.createId("A");
    await seedPlans(h, [{ id: "p2", featureId: a }, { id: "p1" }, { id: "p0", featureId: a }]);
    const before = await h.snapshot();
    const out = err(await del(h, a));
    expect(out.code).toBe("feature_transition");
    expect(out.details).toEqual({ featureId: a, planIds: ["p2", "p0"] });
    expect(await h.snapshot()).toEqual(before);
  });

  it("control: an unbound, unstarted feature is still deletable, also with other bound features present", async () => {
    const h = await setup();
    const a = await h.createId("A");
    const b = await h.createId("B");
    await seedPlans(h, [{ id: "p1", featureId: a }]);
    ok(await del(h, b));
    expect((await h.data()).features.map((f: Json) => f.id)).toEqual([a]);
  });

  it("control: everStarted and dependents keep precedence over the binding check", async () => {
    const h = await setup();
    const a = await h.createId("A");
    const started = await h.createId("S");
    await h.seed(started, { everStarted: true });
    ok(await h.create("Dependent", { dependsOn: [a] }));
    await seedPlans(h, [{ id: "p1", featureId: a }, { id: "p2", featureId: started }]);
    const dep = err(await del(h, a));
    expect(dep.details).toMatchObject({ featureId: a, dependents: expect.any(Array) });
    expect(dep.details).not.toHaveProperty("planIds");
    const st = err(await del(h, started));
    expect(st.message).toMatch(/started/);
  });
});

// R2 corrective c0004 (task card 2026-10-29 §8.3): statusReason describes the current status only.
// Every manual change (cancel, defer, undefer) clears it; undefer re-derives "plan in rework" iff
// the restored status is created and the feature's bound plan's latest revision is reworked.
// Status events and Plan.reworks are unchanged. Synthetic plans are written directly to the store.
describe("R2 corrective c0004: statusReason lifetime on manual status changes", () => {
  const REWORK = "plan in rework";
  const rev = (n: number) => ({ rev: n, createdAt: NOW_ISO, contentHash: "a".repeat(64), markdown: `# Rev ${n}`, tasks: [], basedOn: [], decisionSnapshotHash: "b".repeat(64) });
  /** A feature in rework: created, reason set, bound plan whose listed revisions are reworked as given. */
  const reworked = async (h: H, revs: number[], reworkedRevs: number[]) => {
    const a = await h.createId("A");
    await (await h.open(P)).transact(await h.revision(), (d: Json) => {
      const f = d.features.find((x: Json) => x.id === a);
      f.statusReason = REWORK;
      d.plans.push({
        id: "plan-a", title: "Plan A", sessionIds: [], revisions: revs.map(rev), approvals: [], taskStates: [], intents: [], tickets: [], featureId: a,
        ...(reworkedRevs.length > 0 ? { reworks: reworkedRevs.map((planRev) => ({ planRev, at: NOW_ISO, reason: "Scope changed", actor: { kind: "human" } })) } : {}),
      });
    });
    return a;
  };
  const reworksOf = async (h: H) => JSON.stringify((await h.data()).plans.find((p: Json) => p.id === "plan-a").reworks ?? null);

  it("cancel clears the reason; events are appended and reworks unchanged", async () => {
    const h = await setup();
    const a = await reworked(h, [1], [1]);
    const eventsBefore = (await h.feature(a)).events;
    const reworksBefore = await reworksOf(h);
    ok(await status(h, a, "cancelled"));
    const f = await h.feature(a);
    expect(f.status).toBe("cancelled");
    expect("statusReason" in f).toBe(false);
    expect(f.events.slice(0, eventsBefore.length)).toEqual(eventsBefore);
    expect(f.events).toHaveLength(eventsBefore.length + 1);
    expect(await reworksOf(h)).toBe(reworksBefore);
  });

  it("defer clears the reason; undefer of a reworked feature restores created with 'plan in rework'", async () => {
    const h = await setup();
    const a = await reworked(h, [1], [1]);
    const eventsBefore = (await h.feature(a)).events;
    const reworksBefore = await reworksOf(h);
    ok(await status(h, a, "deferred"));
    const deferred = await h.feature(a);
    expect(deferred.status).toBe("deferred");
    expect("statusReason" in deferred).toBe(false);
    ok(await status(h, a, "created"));
    const back = await h.feature(a);
    expect(back.status).toBe("created");
    expect(back.statusReason).toBe(REWORK);
    expect(back.events.filter((e: Json) => e.kind === "status").map((e: Json) => [e.from, e.to])).toEqual([["created", "deferred"], ["deferred", "created"]]);
    expect(back.events.slice(0, eventsBefore.length), "existing history is a byte-exact prefix").toEqual(eventsBefore);
    expect(await reworksOf(h)).toBe(reworksBefore);
  });

  it("control: undefer without a reworked plan, or with a newer unreworked latest revision, has no reason", async () => {
    for (const [revs, reworkedRevs] of [[[1], []], [[1, 2], [1]]] as Array<[number[], number[]]>) {
      const h = await setup();
      const a = await reworked(h, revs, reworkedRevs);
      ok(await status(h, a, "deferred"));
      ok(await status(h, a, "created"));
      const f = await h.feature(a);
      expect(f.status).toBe("created");
      expect("statusReason" in f, JSON.stringify({ revs, reworkedRevs })).toBe(false);
      await project?.cleanup();
      project = undefined;
    }
  });
});

// Stage R3.5 (card §6.2, §6.2a "Status and rework effects"): a feature status change applies the run
// effect inside the same store transaction and calls `afterRunEffect` after commit. Defer pauses the
// live run (deferred) and retires open cycles (run_paused); undefer keeps it paused with owner (a human
// resume is required); cancel ends it (cancelled_with_feature). Runs are seeded directly (synthetic).
describe("R3.5 feature status effects on a live run", () => {
  async function withRun() {
    const h = await setup();
    const effects: unknown[] = [];
    const features = createFeatureCommands({ ...h.deps, afterRunEffect: (x: unknown) => void effects.push(x) } as Json);
    const a = await h.createId("A");
    await (await h.open(P)).transact(await h.revision(), (d: Json) => {
      const f = d.features.find((x: Json) => x.id === a);
      f.status = "executing";
      f.everStarted = true;
      d.runs.push({
        id: "run-1", featureId: a, planId: "plan-a", planRev: 1, runToken: "tok-1", state: "running", startAuth: { kind: "ui", at: NOW_ISO },
        tasks: [{ taskId: "t1", state: "checks_pending", agentId: "agent-w", failedCycles: 0, extraBudget: 0, unresolved: [] }],
        acks: [], events: [{ at: NOW_ISO, kind: "started" }, { at: NOW_ISO, kind: "cycle_started", taskId: "t1", detail: "cyc-1" }], lateEvidence: [],
      });
    });
    const run = async () => (await h.data()).runs.find((r: Json) => r.id === "run-1");
    const set = async (to: string) => features.statusSet(h.open, { ...(await h.at()), featureId: a, status: to } as Json, UI_ORIGIN);
    return { ...h, a, effects, run, set };
  }

  it("defer pauses the run (deferred) and retires the open cycle in the same transaction; afterRunEffect gets the run", async () => {
    const h = await withRun();
    const before = await h.revision();
    ok(await h.set("deferred"));
    expect(await h.revision(), "one transaction").toBe(before + 1);
    const r = await h.run();
    expect(r).toMatchObject({ state: "paused", pauseReason: "deferred" });
    expect(r.events.filter((e: Json) => e.kind === "cycle_retired").map((e: Json) => e.detail)).toEqual(["cyc-1|run_paused"]);
    expect(r.tasks[0].state).toBe("in_progress");
    expect(h.effects).toEqual([expect.objectContaining({ projectId: P, runId: "run-1" })]);
  });

  it("undefer keeps the run paused with pauseReason owner (a human resume is required)", async () => {
    const h = await withRun();
    ok(await h.set("deferred"));
    ok(await h.set("executing"));
    expect(await h.run()).toMatchObject({ state: "paused", pauseReason: "owner" });
  });

  it("cancel ends the run (cancelled_with_feature); afterRunEffect gets the run", async () => {
    const h = await withRun();
    ok(await h.set("cancelled"));
    expect(await h.run()).toMatchObject({ state: "ended", endReason: "cancelled_with_feature" });
    expect(h.effects).toEqual([expect.objectContaining({ runId: "run-1" })]);
  });
});

// Stage R4.4 (task card §5.2 G2): feature.list output gains `delegations` — the stored array,
// unchanged shape, newest last, revoked ones included with `revokedAt`. Other fields unchanged.
describe("R4.4 feature.list delegations", () => {
  it("returns the stored delegations (revoked included) next to the unchanged features and revision", async () => {
    const h = await setup();
    const a = await h.createId("A");
    const D1 = { id: "d1", scope: "feature", featureId: a, grantedAt: "2026-10-29T10:00:00.000Z", provenance: { agentId: "agent-1", seqStart: 1, timestamp: "2026-10-29T10:00:00.000Z", quoted: "start A" } };
    const D2 = { id: "d2", scope: "roadmap", grantedAt: "2026-10-29T11:00:00.000Z", revokedAt: "2026-10-29T12:00:00.000Z", provenance: { agentId: "agent-1", seqStart: 3, timestamp: "2026-10-29T11:00:00.000Z", quoted: "start everything" } };
    const store = await h.open(P);
    await store.transact(await h.revision(), (draft: Json) => {
      draft.delegations.push(D1, D2); // MODELLED STATE (labelled)
    });
    const out = ok(await h.features.list(h.open, { projectId: P }, UI_ORIGIN)) as Json;
    expect(out.delegations).toEqual([D1, D2]);
    expect(out.revision).toBe(await h.revision());
    expect(out.features).toEqual((await h.data()).features);
  });
});
