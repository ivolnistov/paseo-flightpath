// Store schema v2 (redesign Stage R0.2, task card §3, plan Task R0.2): the synthetic v1 store is
// read strictly and verified on its raw form before projection; every commit writes v2 while legacy
// session and plan files keep their bytes; a v2 generation is listed and verified strictly; a crash
// at any write of the migrating commit leaves the v1 store current and readable.
//
// Every store lives in a fresh temp root holding a copy of `server/fixtures/v1-store/`. Expected
// tokens are computed here with node:crypto over canonical JSON. The v2 read tests hand-build their
// generations, so they do not depend on the production write path.
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import { isLegacyPlan, Manifest, RoadmapDataV1, RoadmapDataV2, RoadmapMetaV1, RoadmapMetaV2 } from "../shared/model";
import { nodeStoreFs, type StoreFs } from "./fs-port";
import { contentHash, contentHashFor } from "./plan-hash";
import { openStore, type StoreOptions } from "./store";
import { fixedClock, nextId } from "./test-support/build";
import { rejectsCode } from "./test-support/expect-error";
import { MUTATING_OPS, faultFs, recordingFs } from "./test-support/fault-fs";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const FIXTURE = fileURLToPath(new URL("./fixtures/v1-store/", import.meta.url));
const PID = "prj_2d93f94da090e78c";
const GEN_26 = "g-0000000026-01M5FQB4DD1W73S39XF2DVX7V5";
const TOKEN_26 = "3bdc6330cd6a760a243085879621d6f97e02bcb5d4abf455da97929a6b0908e3";
const PLAN_ID = "01M5FQ20Z7N3GGWZZP76ZEFV79";
const T0 = "2026-10-26T10:00:00.000Z";
// Tests doing many real fsync-backed commits on tmpdir; timeout only.
const FILE_HEAVY_TIMEOUT_MS = 30_000;

type Json = any; // raw store JSON; deliberately untyped so tests can tamper with it

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A fresh temp root whose `.decisions/` is a byte copy of the synthetic v1 fixture. */
async function fixtureRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dr-migrate-")));
  roots.push(root);
  await cp(FIXTURE, join(root, ".decisions"), { recursive: true });
  return root;
}

async function emptyRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dr-migrate-")));
  roots.push(root);
  return root;
}

const open = (root: string, extra: Partial<StoreOptions> = {}) =>
  openStore({ storeRoot: root, projectId: PID, now: fixedClock, newId: nextId, ...extra });

const decisions = (root: string) => join(root, ".decisions");
const manifestPath = (root: string) => join(decisions(root), "manifest.json");
const genDir = (root: string, gen: string) => join(decisions(root), "generations", gen);
const readManifest = async (root: string): Promise<Json> => JSON.parse(await readFile(manifestPath(root), "utf8"));
const readJson = async (path: string): Promise<Json> => JSON.parse(await readFile(path, "utf8"));
const isDir = async (path: string) => (await stat(path).catch(() => null))?.isDirectory() === true;

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const name of await readdir(d)) {
      const full = join(d, name);
      if ((await stat(full)).isDirectory()) await walk(full);
      else out[relative(dir, full)] = await readFile(full, "utf8");
    }
  };
  await walk(dir);
  return out;
}

/** Raw v1 objects of a generation, in meta id order (exactly what the store loads). */
async function rawV1(root: string, gen = GEN_26): Promise<Json> {
  const dir = genDir(root, gen);
  const meta = await readJson(join(dir, "roadmap.json"));
  return {
    meta,
    sessions: await Promise.all(meta.sessionIds.map((id: string) => readJson(join(dir, "sessions", `${id}.json`)))),
    plans: await Promise.all(meta.planIds.map((id: string) => readJson(join(dir, "plans", `${id}.json`)))),
  };
}

/** The v2 view the card defines for a v1 payload; computed here, not by production code. */
const expectedProjection = (v1: Json): Json => ({
  meta: { ...v1.meta, version: 2, featureIds: [], runIds: [], settings: {} },
  sessions: v1.sessions,
  plans: v1.plans,
  features: [],
  runs: [],
  delegations: [],
});

/** Rewrites the manifest token so the raw v1 objects on disk verify again. */
async function resealV1(root: string): Promise<void> {
  const manifest = await readManifest(root);
  await writeFile(manifestPath(root), JSON.stringify({ ...manifest, changeToken: sha(canonicalJson(await rawV1(root))) }));
}

async function expectInvalidUntouched(root: string, expectedRevision: number) {
  const before = await tree(decisions(root));
  const store = open(root);
  const read = await store.read();
  expect(read.status).toBe("invalid");
  if (read.status === "invalid") expect(read.error.message.length).toBeGreaterThan(0);
  expect((await store.version()).status).toBe("invalid");
  await rejectsCode(store.transact(expectedRevision, () => undefined), "store_invalid");
  expect(await tree(decisions(root))).toEqual(before);
}

// ---------------------------------------------------------------------------------------------
// Synthetic v2 records (plain JSON).

const feature = (id: string, partial: Record<string, unknown> = {}): Json => ({
  id,
  title: `Feature ${id}`,
  description: "Synthetic feature",
  kind: "feature",
  status: "created",
  dependsOn: [],
  relatedTo: [],
  everStarted: false,
  createdAt: T0,
  createdBy: { kind: "human", hostClientId: "client-1" },
  coordinatorHistory: [],
  events: [{ at: T0, actor: { kind: "human" }, kind: "created" }],
  ...partial,
});

const run = (id: string, featureId: string): Json => ({
  id,
  featureId,
  planId: PLAN_ID,
  planRev: 3,
  runToken: `token-${id}`,
  state: "paused",
  pauseReason: "owner",
  startAuth: { kind: "ui", at: T0, hostClientId: "client-1" },
  tasks: [{ taskId: "qa-t1", state: "todo", failedCycles: 0, extraBudget: 0, unresolved: [] }],
  acks: [],
  events: [{ at: T0, kind: "started" }],
  lateEvidence: [],
});

const delegation = (id: string, featureId: string): Json => ({
  id,
  scope: "feature",
  featureId,
  provenance: { agentId: "agent-1", seqStart: 4, timestamp: T0, quoted: "start it" },
  grantedAt: T0,
});

const GEN_27 = "g-0000000027-00000000000000000000000027";

/**
 * Hand-builds generation 27 as a v2 generation over the fixture's sessions and plans, with the given
 * records, and points a resealed manifest at it. Returns the generation directory.
 */
async function writeV2Generation(
  root: string,
  records: { features?: Json[]; runs?: Json[]; delegations?: Json[] } = {},
): Promise<{ dir: string; data: Json }> {
  const v1 = await rawV1(root);
  const features = records.features ?? [feature("f1")];
  const runs = records.runs ?? [run("r1", "f1")];
  const delegations = records.delegations ?? [delegation("d1", "f1")];
  const meta = { ...v1.meta, version: 2, featureIds: features.map((f) => f.id), runIds: runs.map((r) => r.id), settings: {} };
  const data = { meta, sessions: v1.sessions, plans: v1.plans, features, runs, delegations };
  const dir = genDir(root, GEN_27);
  for (const sub of ["sessions", "plans", "features", "runs"]) await mkdir(join(dir, sub), { recursive: true });
  await writeFile(join(dir, "roadmap.json"), canonicalJson(meta));
  for (const s of v1.sessions) await writeFile(join(dir, "sessions", `${s.id}.json`), canonicalJson(s));
  for (const p of v1.plans) await writeFile(join(dir, "plans", `${p.id}.json`), canonicalJson(p));
  for (const f of features) await writeFile(join(dir, "features", `${f.id}.json`), canonicalJson(f));
  for (const r of runs) await writeFile(join(dir, "runs", `${r.id}.json`), canonicalJson(r));
  await writeFile(join(dir, "delegations.json"), canonicalJson(delegations));
  const manifest = await readManifest(root);
  await writeFile(manifestPath(root), JSON.stringify({ ...manifest, revision: 27, generation: GEN_27, changeToken: sha(canonicalJson(data)) }));
  return { dir, data };
}

/** Recomputes the v2 manifest token over the generation-27 files currently on disk. */
async function resealV2(root: string): Promise<void> {
  const dir = genDir(root, GEN_27);
  const meta = await readJson(join(dir, "roadmap.json"));
  const load = (sub: string, ids: string[]) => Promise.all(ids.map((id) => readJson(join(dir, sub, `${id}.json`))));
  const data = {
    meta,
    sessions: await load("sessions", meta.sessionIds),
    plans: await load("plans", meta.planIds),
    features: await load("features", meta.featureIds),
    runs: await load("runs", meta.runIds),
    delegations: await readJson(join(dir, "delegations.json")),
  };
  const manifest = await readManifest(root);
  await writeFile(manifestPath(root), JSON.stringify({ ...manifest, changeToken: sha(canonicalJson(data)) }));
}

// ---------------------------------------------------------------------------------------------

describe("projectV1 (pure legacy projection)", () => {
  const load = async () => (await import("./legacy-projection")).projectV1;

  it("builds the v2 view: v2 meta with empty new collections; sessions and plans unchanged", async () => {
    const projectV1 = await load();
    const v1 = RoadmapDataV1.parse(await rawV1(await fixtureRoot()));
    const projected = projectV1(v1);
    expect(projected).toEqual(expectedProjection(v1));
    expect(canonicalJson(projected.sessions)).toBe(canonicalJson(v1.sessions));
    expect(canonicalJson(projected.plans)).toBe(canonicalJson(v1.plans));
    expect(canonicalJson(RoadmapDataV2.parse(projected))).toBe(canonicalJson(projected));
  });

  it("adds no legacy marker or v2 field to sessions, questions, plans or revisions", async () => {
    const projectV1 = await load();
    const projected: Json = projectV1(RoadmapDataV1.parse(await rawV1(await fixtureRoot())));
    for (const s of projected.sessions) {
      for (const key of ["legacyBlocks", "legacy", "blocks"]) expect(s).not.toHaveProperty(key);
      for (const q of s.questions) expect(q).not.toHaveProperty("blockId");
    }
    for (const p of projected.plans) {
      for (const key of ["legacy", "featureId"]) expect(p).not.toHaveProperty(key);
      expect(isLegacyPlan(p)).toBe(true);
      for (const rev of p.revisions) expect(rev).not.toHaveProperty("schema");
    }
    expect(Object.keys(projected).sort()).toEqual(["delegations", "features", "meta", "plans", "runs", "sessions"]);
  });

  it("does not mutate its input", async () => {
    const projectV1 = await load();
    const v1 = RoadmapDataV1.parse(await rawV1(await fixtureRoot()));
    const before = canonicalJson(v1);
    const projected: Json = projectV1(v1);
    expect(canonicalJson(v1)).toBe(before);
    projected.meta.featureIds.push("f9");
    projected.features.push(feature("f9"));
    expect(canonicalJson(v1)).toBe(before);
    expect(RoadmapMetaV1.safeParse(v1.meta).success).toBe(true);
  });

  it("keeps v1 links", async () => {
    const projectV1 = await load();
    const v1 = RoadmapDataV1.parse(await rawV1(await fixtureRoot()));
    const [s1, s2] = v1.sessions.map((s) => s.id);
    const link = { id: "l1", kind: "informs" as const, from: { sessionId: s1 }, to: { sessionId: s2 } };
    const projected = projectV1({ ...v1, meta: { ...v1.meta, links: [link] } });
    expect(projected.meta.links).toEqual([link]);
  });
});

describe("reading the v1 fixture", () => {
  it("is ok with schemaVersion 1, the fixture token, and the projected v2 data", async () => {
    const root = await fixtureRoot();
    const raw = await rawV1(root);
    const read = await open(root).read();
    expect(read).toMatchObject({ status: "ok", revision: 26, changeToken: TOKEN_26, disabled: false, schemaVersion: 1 });
    if (read.status !== "ok") return;
    expect(read.data).toEqual(expectedProjection(raw));
    expect(canonicalJson(RoadmapDataV2.parse(read.data))).toBe(canonicalJson(read.data));
  });

  it("version() reports schemaVersion 1", async () => {
    const root = await fixtureRoot();
    expect(await open(root).version()).toEqual({ exists: true, revision: 26, status: "ok", schemaVersion: 1 });
  });

  it("reading changes nothing on disk", async () => {
    const root = await fixtureRoot();
    const before = await tree(decisions(root));
    await open(root).read();
    await open(root).version();
    expect(await tree(decisions(root))).toEqual(before);
  });

  it("verifies changeToken on the raw v1 form: a schema-valid hand edit is invalid", async () => {
    const root = await fixtureRoot();
    const file = join(genDir(root, GEN_26), "sessions", "01M5FFQEMN42FTPT9C91CXNVV2.json");
    await writeFile(file, JSON.stringify({ ...(await readJson(file)), title: "Edited by hand" }));
    await expectInvalidUntouched(root, 26);
  });

  it("a manifest token computed over the projected v2 form is rejected", async () => {
    const root = await fixtureRoot();
    const projectedToken = sha(canonicalJson(expectedProjection(await rawV1(root))));
    expect(projectedToken).not.toBe(TOKEN_26);
    await writeFile(manifestPath(root), JSON.stringify({ ...(await readManifest(root)), changeToken: projectedToken }));
    await expectInvalidUntouched(root, 26);
  });

  const v2OnlyEdits: Array<[string, (dir: string) => Promise<void>]> = [
    [
      "a plan with featureId",
      async (dir) => {
        const f = join(dir, "plans", `${PLAN_ID}.json`);
        await writeFile(f, canonicalJson({ ...(await readJson(f)), featureId: "f1" }));
      },
    ],
    [
      "a revision with schema: 2",
      async (dir) => {
        const f = join(dir, "plans", `${PLAN_ID}.json`);
        const p = await readJson(f);
        p.revisions[2].schema = 2;
        await writeFile(f, canonicalJson(p));
      },
    ],
    [
      "a session with blocks: []",
      async (dir) => {
        const f = join(dir, "sessions", "01M5FFQEMN42FTPT9C91CXNVV2.json");
        await writeFile(f, canonicalJson({ ...(await readJson(f)), blocks: [] }));
      },
    ],
    [
      "a question with blockId",
      async (dir) => {
        const f = join(dir, "sessions", "01M5FFQEMN42FTPT9C91CXNVV2.json");
        const s = await readJson(f);
        s.questions[0].blockId = "b1";
        await writeFile(f, canonicalJson(s));
      },
    ],
    [
      "a version 1 meta with featureIds",
      async (dir) => {
        const f = join(dir, "roadmap.json");
        await writeFile(f, canonicalJson({ ...(await readJson(f)), featureIds: [] }));
      },
    ],
  ];
  for (const [name, edit] of v2OnlyEdits) {
    it(`rejects ${name} in a v1 generation even with a matching raw token`, async () => {
      const root = await fixtureRoot();
      await edit(genDir(root, GEN_26));
      await resealV1(root);
      await expectInvalidUntouched(root, 26);
    });
  }
});

// Every write backfills question numbers (number = order + 1) on every session. That is the only
// change a write may make to a legacy session: these helpers check each number and remove it, so the
// remaining session data, and plan files, are still compared exactly.
function withBackfilledNumbers(data: Json): Json {
  return { ...data, sessions: data.sessions.map((s: Json) => ({ ...s, questions: s.questions.map((q: Json) => ({ ...q, number: q.order + 1 })) })) };
}
function legacyBytes(rel: string, text: string): string {
  if (!rel.startsWith("sessions/")) return text;
  const session: Json = JSON.parse(text);
  for (const q of session.questions) {
    expect(q.number, `${rel} ${q.id}`).toBe(q.order + 1);
    delete q.number;
  }
  return canonicalJson(session);
}

describe("the first commit migrates the v1 store to v2", () => {
  async function migrated() {
    const root = await fixtureRoot();
    const raw = await rawV1(root);
    const oldGen = await tree(genDir(root, GEN_26));
    const exportBefore = await tree(join(decisions(root), "plans"));
    const out = await open(root).transact(26, () => undefined);
    const manifest = await readManifest(root);
    return { root, raw, oldGen, exportBefore, out, manifest, dir: genDir(root, manifest.generation) };
  }

  it("a no-op transact commits revision 27 as a v2 generation that reads back with schemaVersion 2", async () => {
    const { root, raw, out, manifest } = await migrated();
    expect(out).toEqual({ result: undefined, revision: 27 });
    expect(manifest.generation).not.toBe(GEN_26);
    const read = await open(root).read();
    expect(read).toMatchObject({ status: "ok", revision: 27, schemaVersion: 2 });
    if (read.status !== "ok") return;
    expect(read.data).toEqual(withBackfilledNumbers(expectedProjection(raw)));
    expect(read.changeToken).toBe(manifest.changeToken);
    expect(manifest.changeToken).toBe(sha(canonicalJson(read.data)));
    expect(await open(root).version()).toEqual({ exists: true, revision: 27, status: "ok", schemaVersion: 2 });
  });

  it("keeps the manifest at version 1 so old plugins still parse it, and the old strict meta rejects the new roadmap.json", async () => {
    const { manifest, dir } = await migrated();
    expect(Manifest.safeParse(manifest).success).toBe(true);
    expect(manifest.version).toBe(1);
    const meta = await readJson(join(dir, "roadmap.json"));
    expect(RoadmapMetaV1.safeParse(meta).success).toBe(false);
    expect(RoadmapDataV1.safeParse({ meta, sessions: [], plans: [] }).success).toBe(false);
  });

  it("writes roadmap.json as the canonical v2 meta, an empty delegations.json and features/ and runs/ directories", async () => {
    const { raw, dir } = await migrated();
    const metaText = await readFile(join(dir, "roadmap.json"), "utf8");
    const meta = JSON.parse(metaText);
    expect(meta).toEqual({ ...raw.meta, version: 2, featureIds: [], runIds: [], settings: {} });
    expect(metaText).toBe(canonicalJson(meta));
    expect(RoadmapMetaV2.safeParse(meta).success).toBe(true);
    expect(await readJson(join(dir, "delegations.json"))).toEqual([]);
    expect(await isDir(join(dir, "features"))).toBe(true);
    expect(await isDir(join(dir, "runs"))).toBe(true);
    expect((await readdir(join(dir, "features"))).filter((n) => n.endsWith(".json"))).toEqual([]);
    expect((await readdir(join(dir, "runs"))).filter((n) => n.endsWith(".json"))).toEqual([]);
  });

  it("every legacy plan file is byte-identical to its v1 file, and every session file differs only by the backfilled numbers", async () => {
    const { raw, oldGen, dir } = await migrated();
    const ids = [...raw.meta.sessionIds.map((id: string) => `sessions/${id}.json`), ...raw.meta.planIds.map((id: string) => `plans/${id}.json`)];
    expect(ids).toHaveLength(4);
    for (const rel of ids) expect(legacyBytes(rel, await readFile(join(dir, rel), "utf8")), rel).toBe(oldGen[rel]);
    expect((await readdir(join(dir, "sessions"))).sort()).toEqual(raw.meta.sessionIds.map((id: string) => `${id}.json`).sort());
    expect(await readdir(join(dir, "plans"))).toEqual([`${PLAN_ID}.json`]);
  });

  it("the previous generation and the plan export stay byte-identical", async () => {
    const { root, oldGen, exportBefore } = await migrated();
    expect(await tree(genDir(root, GEN_26))).toEqual(oldGen);
    expect(await tree(join(decisions(root), "plans"))).toEqual(exportBefore);
  });

  it("all three revision hashes and both approval receipts are unchanged", async () => {
    const { root, raw } = await migrated();
    const read = await open(root).read();
    if (read.status !== "ok") throw new Error(`expected ok, got ${read.status}`);
    const before = raw.plans[0];
    const after: Json = read.data.plans[0];
    expect(after.revisions.map((x: Json) => x.contentHash)).toEqual(before.revisions.map((x: Json) => x.contentHash));
    expect(after.revisions).toHaveLength(3);
    for (const rev of after.revisions) {
      expect(contentHash(rev)).toBe(rev.contentHash);
      expect(contentHashFor(rev)).toBe(rev.contentHash);
    }
    expect(after.approvals).toEqual(before.approvals);
    expect(after.approvals).toHaveLength(2);
    for (const receipt of after.approvals) {
      expect(receipt.contentHash).toBe(after.revisions.find((x: Json) => x.rev === receipt.planRev).contentHash);
    }
  });

  it("later commits keep v2 and leave untouched legacy files identical apart from the backfilled numbers", async () => {
    const { root, oldGen } = await migrated();
    const changed = "01M5FFQEMN42FTPT9C91CXNVV2";
    await open(root).transact(27, (d) => {
      const s = d.sessions.find((x) => x.id === changed)!;
      s.title = "Renamed synthetic session";
    });
    const manifest = await readManifest(root);
    expect(manifest.revision).toBe(28);
    const dir = genDir(root, manifest.generation);
    for (const rel of Object.keys(oldGen).filter((k) => (k.startsWith("sessions/") || k.startsWith("plans/")) && !k.includes(changed))) {
      expect(legacyBytes(rel, await readFile(join(dir, rel), "utf8")), rel).toBe(oldGen[rel]);
    }
    const read = await open(root).read();
    expect(read).toMatchObject({ status: "ok", revision: 28, schemaVersion: 2 });
  });
});

describe("v2 round trip through transact", () => {
  it("features, runs and delegations written in a transact read back unchanged; meta ids follow the arrays", async () => {
    const root = await fixtureRoot();
    const records = { features: [feature("f1"), feature("f2", { dependsOn: ["f1"] })], runs: [run("r1", "f1")], delegations: [delegation("d1", "f1")] };
    await open(root).transact(26, (d: Json) => {
      d.features.push(...records.features);
      d.runs.push(...records.runs);
      d.delegations.push(...records.delegations);
    });
    const read = await open(root).read();
    expect(read).toMatchObject({ status: "ok", revision: 27, schemaVersion: 2 });
    if (read.status !== "ok") return;
    expect(read.data.features).toEqual(records.features);
    expect(read.data.runs).toEqual(records.runs);
    expect(read.data.delegations).toEqual(records.delegations);
    expect(read.data.meta.featureIds).toEqual(["f1", "f2"]);
    expect(read.data.meta.runIds).toEqual(["r1"]);

    const dir = genDir(root, (await readManifest(root)).generation);
    expect(await readFile(join(dir, "features", "f1.json"), "utf8")).toBe(canonicalJson(records.features[0]));
    expect(await readFile(join(dir, "features", "f2.json"), "utf8")).toBe(canonicalJson(records.features[1]));
    expect(await readFile(join(dir, "runs", "r1.json"), "utf8")).toBe(canonicalJson(records.runs[0]));
    expect(await readJson(join(dir, "delegations.json"))).toEqual(records.delegations);
  });

  it("feature order is roadmap order and survives a reorder commit", async () => {
    const root = await fixtureRoot();
    await open(root).transact(26, (d: Json) => {
      d.features.push(feature("f1"), feature("f2"), feature("f3"));
    });
    await open(root).transact(27, (d: Json) => {
      d.features.reverse();
    });
    const read = await open(root).read();
    if (read.status !== "ok") throw new Error(`expected ok, got ${read.status}`);
    expect(read.data.features.map((f) => f.id)).toEqual(["f3", "f2", "f1"]);
    expect(read.data.meta.featureIds).toEqual(["f3", "f2", "f1"]);
  });

  const badDrafts: Array<[string, (d: Json) => void]> = [
    ["an invalid feature", (d) => d.features.push(feature("f1", { status: "built" }))],
    ["duplicate feature ids", (d) => d.features.push(feature("f1"), feature("f1"))],
    ["an unsafe feature id", (d) => d.features.push(feature("../f1"))],
    ["an unsafe run id", (d) => d.runs.push(run("r/1", "f1"))],
    ["an invalid delegation", (d) => d.delegations.push({ ...delegation("d1", "f1"), scope: "roadmap" })],
    ["an unknown top-level key", (d) => (d.extra = [])],
  ];
  for (const [name, edit] of badDrafts) {
    it(`a draft with ${name} is rejected with invalid_input and nothing is written`, async () => {
      const root = await fixtureRoot();
      const before = await tree(decisions(root));
      await rejectsCode(open(root).transact(26, edit), "invalid_input");
      expect(await tree(decisions(root))).toEqual(before);
    });
  }
});

describe("reading a v2 generation", () => {
  it("a hand-built v2 generation reads back exactly, with schemaVersion 2 and the full-object token", async () => {
    const root = await fixtureRoot();
    const { data } = await writeV2Generation(root);
    const read = await open(root).read();
    expect(read).toMatchObject({ status: "ok", revision: 27, schemaVersion: 2, changeToken: sha(canonicalJson(data)) });
    if (read.status === "ok") expect(read.data).toEqual(data);
    expect(await open(root).version()).toEqual({ exists: true, revision: 27, status: "ok", schemaVersion: 2 });
  });

  it("an empty delegations.json array is valid", async () => {
    const root = await fixtureRoot();
    const { data } = await writeV2Generation(root, { delegations: [] });
    const read = await open(root).read();
    expect(read).toMatchObject({ status: "ok", schemaVersion: 2 });
    if (read.status === "ok") expect(read.data.delegations).toEqual(data.delegations);
  });

  it("the token covers the v2 collections: a schema-valid feature edit is invalid", async () => {
    const root = await fixtureRoot();
    const { dir } = await writeV2Generation(root);
    expect((await open(root).read()).status, "positive control").toBe("ok");
    const f = join(dir, "features", "f1.json");
    await writeFile(f, canonicalJson({ ...(await readJson(f)), title: "Edited by hand" }));
    await expectInvalidUntouched(root, 27);
  });

  const tamper: Array<[string, (dir: string) => Promise<void>]> = [
    ["an unlisted features/ file exists", (dir) => writeFile(join(dir, "features", "f9.json"), canonicalJson(feature("f9")))],
    ["a listed features/ file is missing", (dir) => rm(join(dir, "features", "f1.json"))],
    ["an unlisted runs/ file exists", (dir) => writeFile(join(dir, "runs", "r9.json"), canonicalJson(run("r9", "f1")))],
    ["a listed runs/ file is missing", (dir) => rm(join(dir, "runs", "r1.json"))],
    [
      "a feature file holds another id",
      async (dir) => {
        await writeFile(join(dir, "features", "f1.json"), canonicalJson(feature("f2")));
      },
    ],
    ["a feature file is schema-invalid", (dir) => writeFile(join(dir, "features", "f1.json"), canonicalJson(feature("f1", { status: "built" })))],
    ["delegations.json is not an array", (dir) => writeFile(join(dir, "delegations.json"), canonicalJson({ d1: delegation("d1", "f1") }))],
    ["delegations.json is schema-invalid", (dir) => writeFile(join(dir, "delegations.json"), canonicalJson([{ ...delegation("d1", "f1"), featureId: undefined }]))],
    [
      "roadmap.json lacks settings",
      async (dir) => {
        const { settings: _s, ...meta } = await readJson(join(dir, "roadmap.json"));
        await writeFile(join(dir, "roadmap.json"), canonicalJson(meta));
      },
    ],
    [
      "roadmap.json lists a duplicate feature id",
      async (dir) => {
        const meta = await readJson(join(dir, "roadmap.json"));
        await writeFile(join(dir, "roadmap.json"), canonicalJson({ ...meta, featureIds: ["f1", "f1"] }));
      },
    ],
  ];
  it("is invalid and read-only when delegations.json is missing, even though its sealed content was []", async () => {
    // Sealed with delegations: [], so a loader that defaulted a missing file to [] would verify.
    const root = await fixtureRoot();
    const { dir } = await writeV2Generation(root, { delegations: [] });
    expect((await open(root).read()).status, "positive control").toBe("ok");
    await rm(join(dir, "delegations.json"));
    await expectInvalidUntouched(root, 27);
  });

  for (const [name, edit] of tamper) {
    it(`is invalid and read-only when ${name}, even with a resealed token`, async () => {
      const root = await fixtureRoot();
      const { dir } = await writeV2Generation(root);
      expect((await open(root).read()).status, "positive control").toBe("ok");
      await edit(dir);
      await resealV2(root).catch(() => undefined); // a missing file cannot be resealed; the tamper stands
      await expectInvalidUntouched(root, 27);
    });
  }
});

describe("crash safety of the migrating commit", () => {
  const failingAt = (n: number): StoreFs => faultFs(nodeStoreFs, { failOn: (_op, _path, k) => k === n });

  /** Records one successful migrating commit on a fixture copy; returns crash points around the manifest swap. */
  async function crashPoints() {
    const root = await fixtureRoot();
    const rec = recordingFs(nodeStoreFs);
    await open(root, { fs: rec.fs }).transact(26, () => undefined);
    const newGen = join(genDir(root, (await readManifest(root)).generation));
    const mutating = rec.calls.filter((c) => MUTATING_OPS.has(c.op));
    const swap = mutating.find((c) => c.op === "rename" && c.to === manifestPath(root));
    expect(swap, "commit must rename a temp file onto manifest.json").toBeDefined();
    const before = mutating.filter((c) => c.n <= swap!.n);
    const inNewGen = (p: string) => p === newGen || p.startsWith(newGen + sep);
    const rel = (p: string) => relative(newGen, p);
    const v2Writes = before.filter(
      (c) =>
        inNewGen(c.path) &&
        (basename(c.path) === "delegations.json" ||
          basename(c.path) === "roadmap.json" ||
          rel(c.path) === "features" ||
          rel(c.path) === "runs" ||
          rel(c.path).startsWith(`features${sep}`) ||
          rel(c.path).startsWith(`runs${sep}`)),
    );
    return {
      before: before.map((c) => c.n),
      after: mutating.filter((c) => c.n > swap!.n).map((c) => c.n),
      v2Writes: v2Writes.map((c) => ({ op: c.op, rel: rel(c.path), n: c.n })),
    };
  }

  it("the migrating commit performs the v2 writes before the manifest swap", async () => {
    const { v2Writes } = await crashPoints();
    const has = (op: string, rel: string) => v2Writes.some((w) => w.op === op && w.rel === rel);
    expect(has("writeFileDurable", "roadmap.json")).toBe(true);
    expect(has("writeFileDurable", "delegations.json")).toBe(true);
    expect(v2Writes.some((w) => w.op === "mkdir" && (w.rel === "features" || w.rel.startsWith(`features${sep}`)))).toBe(true);
    expect(v2Writes.some((w) => w.op === "mkdir" && (w.rel === "runs" || w.rel.startsWith(`runs${sep}`)))).toBe(true);
  }, FILE_HEAVY_TIMEOUT_MS);

  it("a crash at every write up to the manifest swap keeps the v1 store current, byte-identical and readable", async () => {
    const { before, v2Writes } = await crashPoints();
    expect(v2Writes.length).toBeGreaterThanOrEqual(4);
    for (const n of before) {
      const root = await fixtureRoot();
      const manifestBytes = await readFile(manifestPath(root), "utf8");
      const oldGen = await tree(genDir(root, GEN_26));
      const raw = await rawV1(root);
      await expect(open(root, { fs: failingAt(n) }).transact(26, () => undefined), `crash at call ${n}`).rejects.toThrow();

      expect(await readFile(manifestPath(root), "utf8"), `manifest after crash at call ${n}`).toBe(manifestBytes);
      expect(await tree(genDir(root, GEN_26)), `old generation after crash at call ${n}`).toEqual(oldGen);
      const read = await open(root).read();
      expect(read, `crash at call ${n}`).toMatchObject({ status: "ok", revision: 26, changeToken: TOKEN_26, schemaVersion: 1 });
      if (read.status === "ok") expect(read.data).toEqual(expectedProjection(raw));

      const next = await open(root).transact(26, () => undefined);
      expect(next.revision, `recovery after crash at call ${n}`).toBe(27);
      expect(await open(root).read(), `recovery after crash at call ${n}`).toMatchObject({ status: "ok", revision: 27, schemaVersion: 2 });
    }
  }, FILE_HEAVY_TIMEOUT_MS);

  it("a crash after the manifest swap leaves the v2 revision current", async () => {
    const { after } = await crashPoints();
    for (const n of after) {
      const root = await fixtureRoot();
      await Promise.allSettled([open(root, { fs: failingAt(n) }).transact(26, () => undefined)]);
      expect(await open(root).read(), `crash at call ${n}`).toMatchObject({ status: "ok", revision: 27, schemaVersion: 2 });
    }
  }, FILE_HEAVY_TIMEOUT_MS);
});

describe("init and missing stores", () => {
  it("version() of a missing store reports schemaVersion null", async () => {
    const root = await emptyRoot();
    expect(await open(root).version()).toEqual({ exists: false, revision: null, status: "missing", schemaVersion: null });
  });
});

// R0 review c0045: the one-open-block invariant is enforced on read and on write.
describe("block invariant in v2 generations", () => {
  const openBlock = (id: string, order: number) => ({ id, order, state: "open", openedAt: T0 });

  /** Rewrites the first fixture session of generation 27 as a blocked session with `blocks`. */
  async function blockedSession(root: string, blocks: Json[]) {
    const dir = genDir(root, GEN_27);
    const id = (await readJson(join(dir, "roadmap.json"))).sessionIds[0];
    const f = join(dir, "sessions", `${id}.json`);
    const s = await readJson(f);
    await writeFile(f, canonicalJson({ ...s, blocks, questions: s.questions.map((q: Json) => ({ ...q, blockId: blocks[blocks.length - 1].id })) }));
    await resealV2(root);
  }

  it("a hand-built v2 generation whose session has two open blocks is invalid and read-only, with a correct token", async () => {
    const root = await fixtureRoot();
    await writeV2Generation(root);
    await blockedSession(root, [openBlock("b1", 0)]);
    expect((await open(root).read()).status, "positive control: one open block").toBe("ok");
    await blockedSession(root, [openBlock("b1", 0), openBlock("b2", 1)]);
    await expectInvalidUntouched(root, 27);
  });

  it("a transact that leaves a session with two open blocks is invalid_input and writes nothing", async () => {
    const root = await fixtureRoot();
    const session = (blocks: Json[]) => ({ id: "s-blocked", title: "Blocked", createdAt: T0, status: "active", questions: [], blocks });
    const before = await tree(decisions(root));
    await rejectsCode(
      open(root).transact(26, (d: Json) => {
        d.sessions.push(session([openBlock("b1", 0), openBlock("b2", 1)]));
      }),
      "invalid_input",
    );
    expect(await tree(decisions(root))).toEqual(before);
    // Positive control: one open block commits.
    expect((await open(root).transact(26, (d: Json) => void d.sessions.push(session([openBlock("b1", 0)])))).revision).toBe(27);
  });
});

// Stage R1.3a (task card §4.1.2, §4.1.3): meta.cancellations lives in v2 meta only. Hand-built
// generation 27 is resealed with a correct token, so an invalid read is caused by the record itself
// (untrimmed reason, duplicate ref, dangling ref), never by the token. The v1 fixture is unchanged.
describe("R1.3a cancellations on read", () => {
  async function withCancellations(cancellations: Json[]) {
    const root = await fixtureRoot();
    const { dir } = await writeV2Generation(root);
    const metaFile = join(dir, "roadmap.json");
    await writeFile(metaFile, canonicalJson({ ...(await readJson(metaFile)), cancellations }));
    await resealV2(root);
    return { root, dir };
  }
  const firstRef = async (root: string) => {
    const v1 = await rawV1(root);
    return { sessionId: v1.sessions[0].id, questionId: v1.sessions[0].questions[0].id };
  };
  const record = (ref: Json, partial: Record<string, unknown> = {}): Json => ({ id: "c1", ref, reason: "Dropped", at: T0, actor: { kind: "human" }, ...partial });

  it("the v1 fixture carries no cancellations key and still reads ok with its own token (unchanged)", async () => {
    const root = await fixtureRoot();
    const v1 = await rawV1(root);
    expect("cancellations" in v1.meta).toBe(false);
    const read = await open(root).read();
    expect(read).toMatchObject({ status: "ok", schemaVersion: 1 });
    if (read.status === "ok") expect("cancellations" in read.data.meta).toBe(false);
  });

  it("a v1 generation hand-edited to carry cancellations, resealed, is invalid (strict v1)", async () => {
    const root = await fixtureRoot();
    const metaFile = join(genDir(root, GEN_26), "roadmap.json");
    const meta = await readJson(metaFile);
    await writeFile(metaFile, canonicalJson({ ...meta, cancellations: [record(await firstRef(root))] }));
    await resealV1(root);
    await expectInvalidUntouched(root, 26);
  });

  it("a v2 generation with a valid cancellation reads back exactly (positive control)", async () => {
    const ref = await firstRef(await fixtureRoot());
    const { root } = await withCancellations([record(ref)]);
    const read = await open(root).read();
    expect(read).toMatchObject({ status: "ok", schemaVersion: 2, revision: 27 });
    if (read.status === "ok") expect((read.data.meta as Json).cancellations).toEqual([record(ref)]);
  });

  it("an untrimmed reason, a duplicate ref or a dangling ref in a correctly sealed v2 generation is invalid", async () => {
    const probe = await fixtureRoot();
    const ref = await firstRef(probe);
    const v1 = await rawV1(probe);
    const other = { sessionId: v1.sessions[0].id, questionId: v1.sessions[0].questions[1]?.id ?? v1.sessions[1].questions[0].id };
    const bad: Array<[string, Json[]]> = [
      ["untrimmed reason", [record(ref, { reason: " Dropped " })]],
      ["empty reason", [record(ref, { reason: "" })]],
      ["duplicate ref", [record(ref), record(ref, { id: "c2" })]],
      ["duplicate id", [record(ref), record(other)]],
      ["dangling ref", [record({ ...ref, questionId: "no-such-question" })]],
    ];
    for (const [label, cancellations] of bad) {
      const { root } = await withCancellations(cancellations);
      const read = await open(root).read();
      expect(read.status, label).toBe("invalid");
      await expectInvalidUntouched(root, 27);
    }
    // Positive control with two distinct valid records.
    const { root } = await withCancellations([record(ref), record(other, { id: "c2" })]);
    expect((await open(root).read()).status).toBe("ok");
  });
});

// R1 exact-review c0041 (card §9.7): the generic store write contract rejects a cancellation whose ref
// names no question with invalid_input and writes nothing; a valid record commits (control).
describe("R1 review c0041: dangling cancellation on write", () => {
  it("a transact appending a dangling cancellation is invalid_input with the tree and revision unchanged; a valid one commits", async () => {
    const root = await fixtureRoot();
    await writeV2Generation(root);
    const v1 = await rawV1(root);
    const valid = { sessionId: v1.sessions[0].id, questionId: v1.sessions[0].questions[0].id };
    const record = (ref: Json) => ({ id: "c1", ref, reason: "Dropped", at: T0, actor: { kind: "human" } });
    const before = await tree(decisions(root));
    await rejectsCode(
      open(root).transact(27, (d: Json) => {
        d.meta.cancellations = [record({ ...valid, questionId: "no-such-question" })];
      }),
      "invalid_input",
    );
    expect(await tree(decisions(root))).toEqual(before);
    expect((await open(root).version()).revision).toBe(27);
    const committed = await open(root).transact(27, (d: Json) => {
      d.meta.cancellations = [record(valid)];
    });
    expect(committed.revision).toBe(28);
    const read = await open(root).read();
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect((read.data.meta as Json).cancellations).toEqual([record(valid)]);
  });
});

// Finish basis on read: stores holding the session closures and a finished proposal's finishedBy
// load exactly; stores without them load unchanged; reading rewrites nothing in either case.
describe("finish basis fields on read", () => {
  const T1 = "2026-10-26T11:00:00.000Z";
  const T2 = "2026-10-26T12:00:00.000Z";
  const finishFields = {
    status: "closed",
    finishProposal: { at: T0, agentId: "agent-1", summary: "Done", skipped: [], outOfScope: [], finishedAt: T2, finishedBy: "manual" },
    finishHistory: [{ at: T0, agentId: "agent-1", summary: "Earlier", skipped: [], outOfScope: [], finishedAt: T1, finishedBy: "proposal" }],
    closures: [
      { at: T1, basis: "proposal", proposalAt: T0, source: "ui", actor: { kind: "human" }, reopenedAt: T1 },
      { at: T2, basis: "manual", source: "ui", actor: { kind: "human" } },
    ],
  };

  async function withSessionPatch(patch: Json) {
    const root = await fixtureRoot();
    const { dir } = await writeV2Generation(root);
    const meta = await readJson(join(dir, "roadmap.json"));
    const file = join(dir, "sessions", `${meta.sessionIds[0]}.json`);
    const session = { ...(await readJson(file)), ...patch };
    await writeFile(file, canonicalJson(session));
    await resealV2(root);
    return { root, session };
  }

  it("a v2 generation whose session carries closures and finishedBy reads back exactly, and reading writes nothing", async () => {
    const { root, session } = await withSessionPatch(finishFields);
    const before = await tree(decisions(root));
    const read = await open(root).read();
    expect(read).toMatchObject({ status: "ok", schemaVersion: 2, revision: 27 });
    if (read.status === "ok") expect(read.data.sessions[0]).toEqual(session);
    expect(await tree(decisions(root))).toEqual(before);
  });

  it("a v2 generation with a legacy finished proposal and no closures reads back unchanged and gains neither field (positive control)", async () => {
    const legacyProposal = { ...finishFields.finishProposal };
    delete (legacyProposal as Json).finishedBy;
    const { root, session } = await withSessionPatch({ status: "closed", finishProposal: legacyProposal });
    const before = await tree(decisions(root));
    const read = await open(root).read();
    expect(read).toMatchObject({ status: "ok", schemaVersion: 2 });
    if (read.status === "ok") {
      expect(read.data.sessions[0]).toEqual(session);
      expect("closures" in read.data.sessions[0]).toBe(false);
      expect("finishedBy" in (read.data.sessions[0].finishProposal ?? {})).toBe(false);
    }
    expect(await tree(decisions(root))).toEqual(before);
  });

  it("a v1 generation hand-edited to carry closures, resealed, is invalid (strict v1)", async () => {
    const root = await fixtureRoot();
    const meta = await readJson(join(genDir(root, GEN_26), "roadmap.json"));
    const file = join(genDir(root, GEN_26), "sessions", `${meta.sessionIds[0]}.json`);
    await writeFile(file, canonicalJson({ ...(await readJson(file)), closures: finishFields.closures }));
    await resealV1(root);
    await expectInvalidUntouched(root, 26);
  });
});
