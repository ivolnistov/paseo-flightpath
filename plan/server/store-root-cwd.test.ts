import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeRoot, projectForCwd } from "./store-root";
import { rejectsCode } from "./test-support/expect-error";
import { fakeDirectory } from "./test-support/fake-dir";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function newRoot(): Promise<string> {
  // realpath: os.tmpdir() is behind a symlink on macOS (/var -> /private/var).
  const root = await realpath(await mkdtemp(join(tmpdir(), "dr-cwd-")));
  roots.push(root);
  return root;
}
const project = (projectId: string, projectRootPath: string) => ({ projectId, projectRootPath, projectKind: "git" });

/** base/prj_a_root (main checkout, with sub/deep), base/wt (worktree outside the root), base/prj_a_root-other, base/unreg. */
async function layout() {
  const base = await newRoot();
  const main = join(base, "prj_a_root");
  const worktree = join(base, "wt");
  const sibling = join(base, "prj_a_root-other");
  const unregistered = join(base, "unreg");
  for (const d of [join(main, "sub", "deep"), worktree, sibling, unregistered]) await mkdir(d, { recursive: true });
  const dir = fakeDirectory({
    projects: [project("prj_a", main)],
    workspaces: [
      { id: "w-main", projectId: "prj_a", directory: main },
      { id: "w-wt", projectId: "prj_a", directory: worktree },
      { id: "w-nodir", projectId: "prj_nodir" },
    ],
  });
  return { base, main, worktree, sibling, unregistered, dir };
}

describe("projectForCwd", () => {
  it("maps a registered worktree outside the project root to its project", async () => {
    const { dir, worktree } = await layout();
    expect(await projectForCwd(dir, worktree)).toBe("prj_a");
  });

  it("maps a main-checkout subdirectory by root prefix, on path-segment boundaries only", async () => {
    const { dir, main, sibling } = await layout();
    expect(await projectForCwd(dir, main)).toBe("prj_a");
    expect(await projectForCwd(dir, join(main, "sub", "deep"))).toBe("prj_a");
    expect(await projectForCwd(dir, sibling)).toBeNull();
  });

  it("prefers the longest root prefix", async () => {
    const { main } = await layout();
    const dir = fakeDirectory({ projects: [project("prj_a", main), project("prj_nested", join(main, "sub"))] });
    expect(await projectForCwd(dir, join(main, "sub", "deep"))).toBe("prj_nested");
    expect(await projectForCwd(dir, main)).toBe("prj_a");
  });

  it("returns null for unregistered, nonexistent and ambiguous directories without throwing", async () => {
    const { base, dir, unregistered } = await layout();
    expect(await projectForCwd(dir, unregistered)).toBeNull();
    expect(await projectForCwd(dir, join(base, "does-not-exist"))).toBeNull();

    const shared = join(base, "shared-ws");
    await mkdir(shared);
    const twoWorkspaces = fakeDirectory({
      projects: [],
      workspaces: [
        { id: "w1", projectId: "prj_a", directory: shared },
        { id: "w2", projectId: "prj_b", directory: shared },
      ],
    });
    expect(await projectForCwd(twoWorkspaces, shared)).toBeNull();

    const dupRoot = join(base, "dup");
    await mkdir(join(dupRoot, "child"), { recursive: true });
    const twoProjects = fakeDirectory({ projects: [project("prj_x", dupRoot), project("prj_y", dupRoot)] });
    expect(await projectForCwd(twoProjects, join(dupRoot, "child"))).toBeNull();
  });

  it("agreeing workspaces on one directory are not ambiguous", async () => {
    const { base } = await layout();
    const shared = join(base, "same");
    await mkdir(shared);
    const dir = fakeDirectory({
      projects: [],
      workspaces: [
        { id: "w1", projectId: "prj_a", directory: shared },
        { id: "w2", projectId: "prj_a", directory: shared },
      ],
    });
    expect(await projectForCwd(dir, shared)).toBe("prj_a");
  });

  it("resolves a symlinked cwd through realpath before matching", async () => {
    const { base, dir, main, worktree } = await layout();
    await symlink(worktree, join(base, "link-wt"));
    await symlink(join(main, "sub"), join(base, "link-sub"));
    expect(await projectForCwd(dir, join(base, "link-wt"))).toBe("prj_a");
    expect(await projectForCwd(dir, join(base, "link-sub", "deep"))).toBe("prj_a");
  });
});

describe("assertSafeRoot keeps the Stage 0 unsafe_root guards", () => {
  it("rejects relative, non-normalised, trailing-slash, symlinked and file roots", async () => {
    const base = await newRoot();
    await mkdir(join(base, "real", "sub"), { recursive: true });
    await symlink(join(base, "real"), join(base, "link"));
    await writeFile(join(base, "file"), "not a directory");
    for (const root of ["relative/root", `${base}/real/sub/../sub`, `${base}/real/`, join(base, "link"), join(base, "file")]) {
      await rejectsCode(assertSafeRoot(root), "unsafe_root");
    }
  });

  it("rejects a symlinked .decisions and accepts a real root", async () => {
    const root = await newRoot();
    const elsewhere = await newRoot();
    expect(await assertSafeRoot(root)).toEqual({ storeRoot: root, decisionsDir: join(root, ".decisions") });
    await mkdir(join(root, ".decisions"));
    expect(await assertSafeRoot(root)).toEqual({ storeRoot: root, decisionsDir: join(root, ".decisions") });

    const linked = await newRoot();
    await symlink(elsewhere, join(linked, ".decisions"));
    await rejectsCode(assertSafeRoot(linked), "unsafe_root");
  });
});
