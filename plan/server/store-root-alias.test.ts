// Root case-alias compatibility (plan 2026-10-22-root-case-compatibility, T-RC): a registered root
// whose realpath differs is accepted only when no registered-path component is a symlink or a
// non-directory, and the store then lives at the realpath result.
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RoadmapData } from "../shared/model";
import { nodeStoreFs, type StoreFs } from "./fs-port";
import { createGrantResolver } from "./mcp-grants";
import type { Grant } from "./mcp-state";
import { createPaseoHolder } from "./paseo-holder";
import { openStore } from "./store";
import { assertSafeRoot, openProjectStore, resolveProject } from "./store-root";
import { fixedClock, nextId, NOW_ISO, q, session } from "./test-support/build";
import { rejectsCode } from "./test-support/expect-error";
import { recordingFs } from "./test-support/fault-fs";
import { fakeDirectory } from "./test-support/fake-dir";

/** The `code` of a rejection reason (reasons are untyped); undefined when it has none. */
const codeOf = (reason: unknown): unknown => (typeof reason === "object" && reason !== null && "code" in reason ? reason.code : undefined);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function newRoot(): Promise<string> {
  // realpath: os.tmpdir() is behind a symlink on macOS (/var -> /private/var).
  const root = await realpath(await mkdtemp(join(tmpdir(), "dr-alias-")));
  roots.push(root);
  return root;
}
const project = (projectId: string, projectRootPath: string) => ({ projectId, projectRootPath, projectKind: "git" });

type Kind = "dir" | "symlink" | "file";

/**
 * Deterministic StoreFs: `realpaths` maps a path to its realpath (else ENOENT); `kinds` gives the
 * lstat answer per path (absent means missing, an Error is thrown as-is). Only realpath and lstat
 * are expected; every call is recorded.
 */
function stubFs(realpaths: Record<string, string>, kinds: Record<string, Kind | Error>) {
  const calls: Array<[string, string]> = [];
  const unexpected = (op: string) => async () => {
    throw new Error(`unexpected ${op}`);
  };
  const fs: StoreFs = {
    mkdir: unexpected("mkdir"),
    writeFileDurable: unexpected("writeFileDurable"),
    rename: unexpected("rename"),
    fsyncDir: unexpected("fsyncDir"),
    readFile: unexpected("readFile"),
    readdir: unexpected("readdir"),
    rm: unexpected("rm"),
    async realpath(path) {
      calls.push(["realpath", path]);
      const real = realpaths[path];
      if (real === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return real;
    },
    async lstat(path) {
      calls.push(["lstat", path]);
      const kind = kinds[path];
      if (kind === undefined) return null;
      if (kind instanceof Error) throw kind;
      const stat = { isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "symlink", isFile: () => kind === "file" };
      return stat;
    },
  };
  return { fs, calls };
}

/** Registered `/stub/work/proj`, on-disk spelling `/stub/WORK/proj`; every component a real directory. */
const REG = "/stub/work/proj";
const REAL = "/stub/WORK/proj";
const aliasLayout = (overrides: Record<string, Kind | Error | undefined> = {}) => {
  const kinds: Record<string, Kind | Error> = {
    "/": "dir",
    "/stub": "dir",
    "/stub/work": "dir",
    "/stub/work/proj": "dir",
    "/stub/WORK": "dir",
    "/stub/WORK/proj": "dir",
  };
  for (const [path, kind] of Object.entries(overrides)) {
    if (kind === undefined) delete kinds[path];
    else kinds[path] = kind;
  }
  return kinds;
};

async function rejectsWalk(fs: StoreFs, root: string, real: string, component: string) {
  const e = await rejectsCode(assertSafeRoot(root, fs), "unsafe_root");
  expect(e.message).toBe("project root path must not contain a symlink");
  expect(e.details).toEqual({ root, real, component });
}

/** nodeStoreFs that presents `alias` as another spelling of the existing directory `real`. */
function aliasFs(alias: string, real: string): StoreFs {
  const map = (p: string) => (p === alias || p.startsWith(alias + sep) ? real + p.slice(alias.length) : p);
  return { ...nodeStoreFs, realpath: (p) => nodeStoreFs.realpath(map(p)), lstat: (p) => nodeStoreFs.lstat(map(p)) };
}

describe("T-RC.1 alias accepted (stub fs)", () => {
  it("a registered spelling whose realpath differs, with every component a real directory, resolves to the realpath", async () => {
    const { fs, calls } = stubFs({ [REG]: REAL }, aliasLayout());
    expect(await assertSafeRoot(REG, fs)).toEqual({ storeRoot: REAL, decisionsDir: join(REAL, ".decisions") });
    // Leaf and .decisions checks run on storeRoot, not on the registered spelling.
    expect(calls).toContainEqual(["lstat", REAL]);
    expect(calls).toContainEqual(["lstat", join(REAL, ".decisions")]);
    expect(calls).not.toContainEqual(["lstat", join(REG, ".decisions")]);

    const dir = fakeDirectory({ projects: [project("prj_alias", REG)] });
    expect(await resolveProject(dir, "prj_alias", fs)).toEqual({
      projectId: "prj_alias",
      storeRoot: REAL,
      decisionsDir: join(REAL, ".decisions"),
    });
  });
});

describe("T-RC.2 alias walk (stub fs)", () => {
  it("rejects an ancestor symlink, a leaf symlink, a missing component and a file component", async () => {
    const elsewhere = "/stub/elsewhere/proj";
    const ancestorKinds = aliasLayout({ "/stub/work": "symlink", "/stub/elsewhere": "dir", [elsewhere]: "dir" });
    await rejectsWalk(stubFs({ [REG]: elsewhere }, ancestorKinds).fs, REG, elsewhere, "/stub/work");
    await rejectsWalk(stubFs({ [REG]: REAL }, aliasLayout({ [REG]: "symlink" })).fs, REG, REAL, REG);
    await rejectsWalk(stubFs({ [REG]: REAL }, aliasLayout({ "/stub/work": undefined })).fs, REG, REAL, "/stub/work");
    await rejectsWalk(stubFs({ [REG]: REAL }, aliasLayout({ "/stub/work": "file" })).fs, REG, REAL, "/stub/work");
  });

  it("rejects an ancestor symlink that points at a case-variant directory", async () => {
    // /stub/work -> /stub/WORK: realpath looks like a case-only alias, but the walk sees the link.
    await rejectsWalk(stubFs({ [REG]: REAL }, aliasLayout({ "/stub/work": "symlink" })).fs, REG, REAL, "/stub/work");
  });

  it("accepts an NFC/NFD alias under the same rule, without normalising the result", async () => {
    const nfc = "/stub/café/proj";
    const nfd = "/stub/café/proj";
    const { fs } = stubFs({ [nfc]: nfd }, {
      "/": "dir",
      "/stub": "dir",
      "/stub/café": "dir",
      [nfc]: "dir",
      "/stub/café": "dir",
      [nfd]: "dir",
    });
    const { storeRoot } = await assertSafeRoot(nfc, fs);
    expect(storeRoot).toBe(nfd);
    expect(storeRoot).not.toBe(storeRoot.normalize("NFC"));
  });

  it("checks .decisions under the realpath: missing or real accepted, symlink or file rejected", async () => {
    const decisions = join(REAL, ".decisions");
    const expected = { storeRoot: REAL, decisionsDir: decisions };
    expect(await assertSafeRoot(REG, stubFs({ [REG]: REAL }, aliasLayout()).fs)).toEqual(expected);
    expect(await assertSafeRoot(REG, stubFs({ [REG]: REAL }, aliasLayout({ [decisions]: "dir" })).fs)).toEqual(expected);
    for (const kind of ["symlink", "file"] as const) {
      const e = await rejectsCode(assertSafeRoot(REG, stubFs({ [REG]: REAL }, aliasLayout({ [decisions]: kind })).fs), "unsafe_root");
      expect(e.details).toEqual({ root: decisions });
    }
  });

  it("a thrown non-ENOENT lstat error during the walk propagates unchanged", async () => {
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const { fs } = stubFs({ [REG]: REAL }, aliasLayout({ "/stub/work": denied }));
    await expect(assertSafeRoot(REG, fs)).rejects.toBe(denied);
  });
});

describe("T-RC.3 fast path unchanged", () => {
  it("a root equal to its realpath issues exactly realpath, lstat(root), lstat(.decisions)", async () => {
    const root = await newRoot();
    const expectedCalls = [
      ["realpath", root],
      ["lstat", root],
      ["lstat", join(root, ".decisions")],
    ];
    for (const withDecisions of [false, true]) {
      if (withDecisions) await mkdir(join(root, ".decisions"));
      const { fs, calls } = recordingFs(nodeStoreFs);
      expect(await assertSafeRoot(root, fs)).toEqual({ storeRoot: root, decisionsDir: join(root, ".decisions") });
      expect(calls.map((c) => [c.op, c.path])).toEqual(expectedCalls);
    }
  });
});

const pushSession = (id: string) => (draft: RoadmapData) => {
  draft.sessions.push(session(id, [q("only")]));
};

describe("T-RC.4 one lock per directory across registry spellings", () => {
  it("stores opened through alias and real spellings share the root and serialise transactions", async () => {
    const base = await newRoot();
    const real = join(base, "real");
    const alias = join(base, "Alias-Spelling");
    await mkdir(real);
    const fs = aliasFs(alias, real);
    const id = "prj_alias";
    const viaAlias = fakeDirectory({ projects: [project(id, alias)] });
    const viaReal = fakeDirectory({ projects: [project(id, real)] });

    const resolvedAlias = await resolveProject(viaAlias, id, fs);
    expect(resolvedAlias).toEqual(await resolveProject(viaReal, id, fs));
    expect(resolvedAlias.storeRoot).toBe(real);

    const opts = { fs, now: fixedClock, newId: nextId, log: () => undefined };
    const a = await openProjectStore(viaAlias, id, opts);
    const b = await openProjectStore(viaReal, id, opts);
    expect(a.storeRoot).toBe(b.storeRoot);
    await a.init();

    // Issued in one tick, alternating stores: all succeed only if both share one lock.
    const ordered = await Promise.allSettled([
      a.transact(1, pushSession("s1")),
      b.transact(2, pushSession("s2")),
      a.transact(3, pushSession("s3")),
    ]);
    expect(ordered.map((r) => (r.status === "fulfilled" ? r.value.revision : codeOf(r.reason)))).toEqual([2, 3, 4]);

    const raced = await Promise.allSettled([a.transact(4, pushSession("s4")), b.transact(4, pushSession("s5"))]);
    const won = raced.filter((r) => r.status === "fulfilled");
    const lost = raced.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost.map((r) => codeOf(r.reason))).toEqual(["revision_conflict"]);

    const successes = 3 + won.length;
    for (const store of [a, b]) {
      const read = await store.read();
      expect(read).toMatchObject({ status: "ok", revision: 1 + successes });
      if (read.status === "ok") expect(read.data.sessions).toHaveLength(successes);
    }
  });
});

describe("T-RC.5 grant boundary (production createGrantResolver)", () => {
  async function setup() {
    const base = await newRoot();
    const real = join(base, "real");
    const moved = join(base, "moved");
    const alias = join(base, "Alias-Spelling");
    await mkdir(real);
    await mkdir(moved);
    const fs = aliasFs(alias, real);
    const id = "prj_alias";
    const storeOptions = { fs, now: fixedClock, newId: nextId, log: () => undefined };
    await openStore({ storeRoot: real, projectId: id, ...storeOptions }).init();
    const registry = { projects: [project(id, alias)] };
    const holder = createPaseoHolder();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    holder.set({} as PaseoApi);
    const resolve = createGrantResolver({ holder, directory: () => fakeDirectory(registry), log: () => undefined, storeOptions });
    /** Issues a grant the way injection does: through the currently registered spelling. */
    const issue = async (): Promise<Grant> => {
      const { storeRoot } = await resolveProject(fakeDirectory(registry), id, fs);
      return { grantId: "g-1", projectId: id, storeRoot, provider: "claude", cwd: storeRoot, port: 1, issuedAt: NOW_ISO, stale: false };
    };
    return { id, real, moved, alias, registry, resolve, issue };
  }

  it("a grant issued through the alias stays valid when the registry later reports the realpath", async () => {
    const { id, real, registry, resolve, issue } = await setup();
    const grant = await issue();
    expect(grant.storeRoot).toBe(real);
    registry.projects = [project(id, real)];
    const store = await (await resolve(grant))(id);
    expect(store.storeRoot).toBe(real);
    expect(await store.read()).toMatchObject({ status: "ok", revision: 1 });
  });

  it("a root that genuinely moves still gives project_mismatch (grant issued through the alias)", async () => {
    const { id, moved, registry, resolve, issue } = await setup();
    const grant = await issue();
    registry.projects = [project(id, moved)];
    await rejectsCode(resolve(grant), "project_mismatch");
  });

  it("a root that genuinely moves still gives project_mismatch (grant issued through the real spelling)", async () => {
    const { id, real, moved, registry, resolve, issue } = await setup();
    registry.projects = [project(id, real)];
    const grant = await issue();
    registry.projects = [project(id, moved)];
    await rejectsCode(resolve(grant), "project_mismatch");
  });
});

describe("T-RC.6 real filesystem", () => {
  it("rejects an ancestor symlink and a leaf symlink, naming the link component", async () => {
    const base = await newRoot();
    await mkdir(join(base, "real", "sub"), { recursive: true });
    await symlink(join(base, "real"), join(base, "link"));
    const ancestor = await rejectsCode(assertSafeRoot(join(base, "link", "sub")), "unsafe_root");
    expect(ancestor.details).toEqual({ root: join(base, "link", "sub"), real: join(base, "real", "sub"), component: join(base, "link") });
    const leaf = await rejectsCode(assertSafeRoot(join(base, "link")), "unsafe_root");
    expect(leaf.details).toEqual({ root: join(base, "link"), real: join(base, "real"), component: join(base, "link") });
  });

  it("case-only aliases of the leaf and of an ancestor: accepted with the native spelling on a case-insensitive volume, unsafe_root otherwise", async () => {
    const base = await newRoot();
    await mkdir(join(base, "leafdir"));
    await mkdir(join(base, "ancdir", "leaf"), { recursive: true });
    const cases = [
      { alias: join(base, "LEAFDIR"), native: join(base, "leafdir") },
      { alias: join(base, "ANCDIR", "leaf"), native: join(base, "ancdir", "leaf") },
    ];
    const insensitive = await lstat(cases[0].alias).then(
      () => true,
      (e: { code?: string }) => {
        if (e.code === "ENOENT") return false;
        throw e;
      },
    );
    for (const { alias, native } of cases) {
      if (insensitive) {
        expect(await assertSafeRoot(alias)).toEqual({ storeRoot: native, decisionsDir: join(native, ".decisions") });
      } else {
        await rejectsCode(assertSafeRoot(alias), "unsafe_root");
      }
    }
  });
});
