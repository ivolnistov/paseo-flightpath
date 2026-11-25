import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import { applyAnswer, findQuestion } from "../shared/graph";
import { GEN_RE, Manifest, Plan, RoadmapMetaV1, RoadmapMetaV2, type RoadmapData } from "../shared/model";
import { nodeStoreFs, type StoreFs } from "./fs-port";
import { openStore, type StoreOptions } from "./store";
import { act, fixedClock, jsonString, loadBranching, nextId, pick, q, r, readJsonObject, session } from "./test-support/build";
import { rejectsCode } from "./test-support/expect-error";
import { MUTATING_OPS, faultFs, recordingFs } from "./test-support/fault-fs";

const PID = "proj-test";
// Tests doing dozens of real fsync-backed commits on tmpdir; 2-3 s locally, close to the
// 5 s default on slower disks. Timeout only; assertions unchanged.
const FILE_HEAVY_TIMEOUT_MS = 15_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dr-store-")));
  roots.push(root);
  return root;
}

const open = (root: string, extra: Partial<StoreOptions> = {}) =>
  openStore({ storeRoot: root, projectId: PID, now: fixedClock, newId: nextId, ...extra });

const decisions = (root: string) => join(root, ".decisions");
const manifestPath = (root: string) => join(decisions(root), "manifest.json");
const generationsDir = (root: string) => join(decisions(root), "generations");
// Every key is kept: the corruption cases below spread the manifest back to disk unchanged.
const readManifest = async (root: string) => readJsonObject(await readFile(manifestPath(root), "utf8"));
const generations = async (root: string) => (await readdir(generationsDir(root))).sort();
const currentGen = async (root: string) => join(generationsDir(root), jsonString(await readManifest(root), "generation"));

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

const syntheticPlan = () =>
  Plan.parse({
    id: "p1",
    title: "Synthetic plan",
    sessionIds: ["s1"],
    revisions: [],
    approvals: [],
    taskStates: [],
    intents: [],
    tickets: [],
  });

/** init + one commit holding the branching fixture (revision 2). */
async function seeded(root: string, withPlan = false) {
  const store = open(root);
  await store.init();
  await store.transact(1, (d: RoadmapData) => {
    d.sessions.push(...loadBranching());
    if (withPlan) d.plans.push(syntheticPlan());
  });
  return store;
}

const answerQ1 = (optionId: string, source: "ui" | "chat" = "ui") => (d: RoadmapData) => {
  const change = applyAnswer(d.sessions, r("s1", "q1"), pick(optionId, source));
  d.sessions.splice(0, d.sessions.length, ...change.sessions);
  return change.rev;
};

describe("init, commit and reload", () => {
  it("init on an empty root creates a revision-1 manifest and one generation; a second init is a no-op", async () => {
    const root = await newRoot();
    const store = open(root);
    expect(await store.version()).toMatchObject({ exists: false, status: "missing" });
    expect(await store.read()).toEqual({ status: "missing" });
    expect(await store.init()).toEqual({ created: true, revision: 1 });

    const manifest = await readManifest(root);
    expect(manifest).toMatchObject({ version: 1, projectId: PID, revision: 1 });
    expect(manifest.generation).toMatch(GEN_RE);
    expect(typeof manifest.changeToken).toBe("string");
    expect(jsonString(manifest, "changeToken").length).toBeGreaterThan(0);
    expect(await generations(root)).toEqual([manifest.generation]);
    await stat(join(generationsDir(root), jsonString(manifest, "generation"), "roadmap.json"));

    const bytes = await readFile(manifestPath(root), "utf8");
    expect(await open(root).init()).toMatchObject({ created: false, revision: 1 });
    expect(await readFile(manifestPath(root), "utf8")).toBe(bytes);
    const read = await store.read();
    expect(read).toMatchObject({ status: "ok", revision: 1, disabled: false });
    if (read.status === "ok") {
      expect(read.data.sessions).toEqual([]);
      expect(read.data.plans).toEqual([]);
      expect(read.data.meta.projectId).toBe(PID);
    }
  });

  it("transact returns the new revision and a fresh store on the same root reads it back", async () => {
    const root = await newRoot();
    const store = open(root);
    await store.init();
    const s9 = session("s9", [q("only")]);
    const out = await store.transact(1, (d) => {
      d.sessions.push(s9);
      return "done";
    });
    expect(out).toEqual({ result: "done", revision: 2 });

    const read = await open(root).read();
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.revision).toBe(2);
    expect(read.data.sessions).toEqual([s9]);
    expect(read.data.meta.sessionIds).toEqual(["s9"]);
    expect(read.changeToken).toBe((await readManifest(root)).changeToken);
    expect(await open(root).version()).toEqual({ exists: true, revision: 2, status: "ok", schemaVersion: 2 });
  });

  it("transact with a stale expectedRevision throws revision_conflict and leaves the manifest bytes", async () => {
    const root = await newRoot();
    const store = await seeded(root);
    const bytes = await readFile(manifestPath(root), "utf8");
    let called = false;
    const err = await rejectsCode(
      store.transact(1, () => {
        called = true;
      }),
      "revision_conflict",
    );
    expect(err.details).toEqual({ expected: 1, actual: 2 });
    expect(called).toBe(false);
    expect(await readFile(manifestPath(root), "utf8")).toBe(bytes);
  });

  it("chat vs UI race on one revision: exactly one answer lands, the other gets revision_conflict", async () => {
    const root = await newRoot();
    await seeded(root);
    const ui = open(root);
    const chat = open(root);
    const results = await Promise.allSettled([
      ui.transact(2, answerQ1("a", "ui")),
      chat.transact(2, answerQ1("b", "chat")),
    ]);
    const fulfilled = results.filter((x) => x.status === "fulfilled");
    const rejected = results.filter((x) => x.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<{ revision: number }>).value.revision).toBe(3);
    await rejectsCode(Promise.reject((rejected[0]).reason), "revision_conflict");

    const read = await open(root).read();
    if (read.status !== "ok") throw new Error(`expected ok, got ${read.status}`);
    expect(read.revision).toBe(3);
    const q1 = findQuestion(read.data.sessions, r("s1", "q1"));
    expect(q1.revisions).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? "ui" : "chat";
    expect(q1.answer?.source).toBe(winner);
  });

  it("20 concurrent read-version-then-transact writers lose no update", async () => {
    const root = await newRoot();
    const stores = [open(root), open(root)];
    await stores[0].init();
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const store = stores[i % 2];
        for (let attempt = 0; attempt < 100; attempt++) {
          const { revision } = await store.version();
          try {
            await store.transact(revision!, (d) => {
              d.sessions.push(session(`c${i}`, [q("only")]));
            });
            return;
          } catch (e) {
            if (!(e instanceof Error && "code" in e && e.code === "revision_conflict")) throw e;
          }
        }
        throw new Error(`writer ${i} never committed`);
      }),
    );
    const read = await open(root).read();
    if (read.status !== "ok") throw new Error(`expected ok, got ${read.status}`);
    expect(read.revision).toBe(21);
    expect(read.data.sessions.map((s) => s.id).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `c${i}`).sort(),
    );
  }, FILE_HEAVY_TIMEOUT_MS);

  it("a throwing fn propagates its error and writes nothing", async () => {
    const root = await newRoot();
    const store = await seeded(root);
    const before = await tree(decisions(root));
    const boom = new Error("caller failure");
    await expect(
      store.transact(2, (d) => {
        d.sessions.length = 0;
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect((await store.version()).revision).toBe(2);
    expect(await tree(decisions(root))).toEqual(before);
  });

  it("a draft that creates a relation cycle is rejected with invalid_input and nothing is written", async () => {
    const root = await newRoot();
    const store = await seeded(root);
    const before = await tree(decisions(root));
    await rejectsCode(
      store.transact(2, (d) => {
        findQuestion(d.sessions, r("s1", "q1")).activatedBy.push(act(r("s1", "q2"), "yes"));
      }),
      "invalid_input",
    );
    expect(await tree(decisions(root))).toEqual(before);
  });

  it("a schema-invalid draft is rejected with invalid_input and nothing is written", async () => {
    const root = await newRoot();
    const store = await seeded(root);
    const before = await tree(decisions(root));
    await rejectsCode(
      store.transact(2, (d) => {
        findQuestion(d.sessions, r("s1", "q3")).title = "";
      }),
      "invalid_input",
    );
    expect(await tree(decisions(root))).toEqual(before);
  });
});

describe("crash safety and pruning", () => {
  /** Template at revision 2; every attempt copies it to a fresh root. */
  async function template() {
    const root = await newRoot();
    await seeded(root);
    const read = await open(root).read();
    if (read.status !== "ok") throw new Error("template not ok");
    return { root, data: canonicalJson(read.data) };
  }

  async function copyOf(src: string) {
    const root = await newRoot();
    await cp(decisions(src), decisions(root), { recursive: true });
    return root;
  }

  /** Records one full successful commit and returns the call indices of crash points. */
  async function crashPoints(src: string) {
    const root = await copyOf(src);
    const rec = recordingFs(nodeStoreFs);
    await open(root, { fs: rec.fs }).transact(2, answerQ1("a"));
    const mutating = rec.calls.filter((c) => MUTATING_OPS.has(c.op));
    const swap = mutating.find((c) => c.op === "rename" && c.to === manifestPath(root));
    expect(swap, "commit must rename a temp file onto manifest.json").toBeDefined();
    expect(mutating.some((c) => c.op === "writeFileDurable")).toBe(true);
    return {
      before: mutating.filter((c) => c.n <= swap!.n).map((c) => c.n),
      after: mutating.filter((c) => c.n > swap!.n).map((c) => c.n),
    };
  }

  const failingAt = (n: number): StoreFs => faultFs(nodeStoreFs, { failOn: (_op, _path, k) => k === n });

  it("a crash at every step up to the manifest swap keeps the previous revision; the next commit prunes the orphan", async () => {
    const tpl = await template();
    const { before } = await crashPoints(tpl.root);
    expect(before.length).toBeGreaterThan(3);
    for (const n of before) {
      const root = await copyOf(tpl.root);
      const previousGen = (await readManifest(root)).generation;
      await expect(open(root, { fs: failingAt(n) }).transact(2, answerQ1("a")), `crash at call ${n}`).rejects.toThrow();

      const read = await open(root).read();
      expect(read.status, `crash at call ${n}`).toBe("ok");
      if (read.status !== "ok") continue;
      expect(read.revision).toBe(2);
      expect(canonicalJson(read.data)).toBe(tpl.data);

      const next = await open(root).transact(2, answerQ1("b"));
      expect(next.revision).toBe(3);
      const manifest = await readManifest(root);
      expect(await generations(root), `prune after crash at call ${n}`).toEqual([previousGen, manifest.generation].sort());
      expect((await readdir(decisions(root))).filter((f) => f.startsWith("manifest.json.tmp-"))).toEqual([]);
    }
  }, FILE_HEAVY_TIMEOUT_MS);

  it("a crash after the manifest swap but before prune leaves the new revision current", async () => {
    const tpl = await template();
    const { after } = await crashPoints(tpl.root);
    for (const n of after) {
      const root = await copyOf(tpl.root);
      await Promise.allSettled([open(root, { fs: failingAt(n) }).transact(2, answerQ1("a"))]);
      const read = await open(root).read();
      expect(read.status, `crash at call ${n}`).toBe("ok");
      if (read.status !== "ok") continue;
      expect(read.revision).toBe(3);
      expect(findQuestion(read.data.sessions, r("s1", "q1")).answer?.optionId).toBe("a");
    }
  });

  it("after 5 commits exactly the current and previous generations remain", async () => {
    const root = await newRoot();
    const store = open(root);
    await store.init();
    for (let rev = 1; rev <= 5; rev++) {
      await store.transact(rev, (d) => {
        d.sessions.push(session(`p${rev}`, [q("only")]));
      });
    }
    const gens = await generations(root);
    expect(gens).toHaveLength(2);
    expect(gens[0]).toMatch(/^g-0000000005-/);
    expect(gens[1]).toMatch(/^g-0000000006-/);
    expect(gens[1]).toBe((await readManifest(root)).generation);
  });
});

describe("external changes and malformed stores", () => {
  it("picks up a valid generation swapped in by hand (e.g. git checkout)", async () => {
    const root = await newRoot();
    const store = open(root);
    await store.init();

    const other = await newRoot();
    const otherStore = open(other);
    await otherStore.init();
    const sx = session("sx", [q("only")]);
    await otherStore.transact(1, (d) => {
      d.sessions.push(sx);
    });
    const otherManifest = await readManifest(other);
    await cp(join(generationsDir(other), jsonString(otherManifest, "generation")), join(generationsDir(root), jsonString(otherManifest, "generation")), {
      recursive: true,
    });
    await writeFile(manifestPath(root), JSON.stringify(otherManifest));

    const read = await store.read();
    if (read.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(read)}`);
    expect(read.revision).toBe(2);
    expect(read.data.sessions).toEqual([sx]);
  });

  async function expectInvalidUntouched(root: string) {
    const before = await tree(decisions(root));
    const store = open(root);
    const read = await store.read();
    expect(read.status).toBe("invalid");
    if (read.status === "invalid") {
      expect(typeof read.error.message).toBe("string");
      expect(read.error.message.length).toBeGreaterThan(0);
    }
    expect((await store.version()).status).toBe("invalid");
    await rejectsCode(store.transact(2, () => undefined), "store_invalid");
    expect(await tree(decisions(root))).toEqual(before);
  }

  it("a truncated session file makes the store invalid and read-only", async () => {
    const root = await newRoot();
    await seeded(root, true);
    const file = join(await currentGen(root), "sessions", "s1.json");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.slice(0, Math.floor(text.length / 2)));
    await expectInvalidUntouched(root);
  });

  it("a session whose id differs from its filename makes the store invalid", async () => {
    const root = await newRoot();
    await seeded(root, true);
    const file = join(await currentGen(root), "sessions", "s2.json");
    const data = readJsonObject(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...data, id: "s3" }));
    await expectInvalidUntouched(root);
  });

  it("a deleted listed plan file makes the store invalid", async () => {
    const root = await newRoot();
    await seeded(root, true);
    await rm(join(await currentGen(root), "plans", "p1.json"));
    await expectInvalidUntouched(root);
  });

  it("an extra unlisted file in the generation is ignored", async () => {
    const root = await newRoot();
    await seeded(root, true);
    await writeFile(join(await currentGen(root), "stray.txt"), "not part of the snapshot");
    const read = await open(root).read();
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.data.plans.map((p) => p.id)).toEqual(["p1"]);
  });

  it("a schema-valid hand edit that breaks the changeToken makes the store invalid", async () => {
    const root = await newRoot();
    await seeded(root, true);
    const file = join(await currentGen(root), "sessions", "s1.json");
    const data = readJsonObject(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...data, title: "Edited by hand" }));
    await expectInvalidUntouched(root);
  });

  it("a manifest generation outside generations/ or not matching GEN_RE makes the store invalid", async () => {
    for (const generation of ["../../etc", "g-1-bad", "generation"]) {
      const root = await newRoot();
      await seeded(root);
      const manifest = await readManifest(root);
      await writeFile(manifestPath(root), JSON.stringify({ ...manifest, generation }));
      await expectInvalidUntouched(root);
    }
  });

  it("a store opened with another projectId throws project_mismatch on read and transact", async () => {
    const root = await newRoot();
    await seeded(root);
    const bytes = await readFile(manifestPath(root), "utf8");
    const foreign = open(root, { projectId: "proj-other" });
    await rejectsCode(foreign.read(), "project_mismatch");
    await rejectsCode(foreign.transact(2, () => undefined), "project_mismatch");
    await rejectsCode(foreign.init(), "project_mismatch");
    expect(await readFile(manifestPath(root), "utf8")).toBe(bytes);
  });

  it("disabled: true is surfaced by read and does not block transact", async () => {
    const root = await newRoot();
    const store = await seeded(root);
    const manifest = await readManifest(root);
    await writeFile(manifestPath(root), JSON.stringify({ ...manifest, disabled: true }));
    const read = await store.read();
    expect(read).toMatchObject({ status: "ok", revision: 2, disabled: true });
    expect((await store.transact(2, answerQ1("a"))).revision).toBe(3);
  });
});

// Redesign Stage R0.2 (task card §3): init() creates a v2 store; version() reports schemaVersion.
describe("schema v2 init and version", () => {
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

  it("init creates a v2 generation: v2 meta, empty features/ and runs/, delegations.json [], manifest version 1", async () => {
    const root = await newRoot();
    const store = open(root);
    expect(await store.init()).toEqual({ created: true, revision: 1 });
    const manifest = await readManifest(root);
    expect(Manifest.safeParse(manifest).success).toBe(true);
    expect(manifest.version).toBe(1);

    const gen = await currentGen(root);
    const metaText = await readFile(join(gen, "roadmap.json"), "utf8");
    const meta: unknown = JSON.parse(metaText);
    expect(meta).toEqual({
      version: 2,
      projectId: PID,
      createdAt: fixedClock().toISOString(),
      links: [],
      sessionIds: [],
      planIds: [],
      featureIds: [],
      runIds: [],
      settings: {},
    });
    expect(metaText).toBe(canonicalJson(meta));
    expect(RoadmapMetaV2.safeParse(meta).success).toBe(true);
    expect(RoadmapMetaV1.safeParse(meta).success, "a v1-only plugin must not read a v2 generation").toBe(false);
    expect(JSON.parse(await readFile(join(gen, "delegations.json"), "utf8"))).toEqual([]);
    for (const sub of ["features", "runs", "sessions", "plans"]) expect((await stat(join(gen, sub))).isDirectory(), sub).toBe(true);

    const read = await store.read();
    expect(read).toMatchObject({ status: "ok", revision: 1, schemaVersion: 2 });
    if (read.status !== "ok") return;
    expect(read.data).toEqual({ meta, sessions: [], plans: [], features: [], runs: [], delegations: [] });
    expect(manifest.changeToken).toBe(sha(canonicalJson(read.data)));
  });

  it("version() reports schemaVersion null when missing and 2 after init and commits", async () => {
    const root = await newRoot();
    const store = open(root);
    expect(await store.version()).toEqual({ exists: false, revision: null, status: "missing", schemaVersion: null });
    await store.init();
    expect(await store.version()).toEqual({ exists: true, revision: 1, status: "ok", schemaVersion: 2 });
    await store.transact(1, (d) => {
      d.sessions.push(session("s9", [q("only")]));
    });
    expect(await store.version()).toEqual({ exists: true, revision: 2, status: "ok", schemaVersion: 2 });
  });
});
