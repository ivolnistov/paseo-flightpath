import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  openProjectStore,
  projectDirectoryFromPaseo,
  projectIdForWorkspace,
  resolveProject,
} from "./store-root";
import { fixedClock, nextId, q, session } from "./test-support/build";
import { rejectsCode } from "./test-support/expect-error";
import { fakeDirectory } from "./test-support/fake-dir";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(): Promise<string> {
  // realpath: os.tmpdir() is itself behind a symlink on macOS (/var -> /private/var).
  const root = await realpath(await mkdtemp(join(tmpdir(), "dr-root-")));
  roots.push(root);
  return root;
}

const project = (projectId: string, projectRootPath: string) => ({ projectId, projectRootPath, projectKind: "git" });
const storeOpts = { now: fixedClock, newId: nextId };

describe("project identity", () => {
  it("main checkout and worktree workspaces share one storeRoot and see each other's writes", async () => {
    const root = await newRoot();
    const dir = fakeDirectory({
      projects: [project("proj-a", root)],
      workspaces: [
        { id: "ws-main", projectId: "proj-a" },
        { id: "ws-worktree", projectId: "proj-a" },
      ],
    });
    const fromMain = await projectIdForWorkspace(dir, "ws-main");
    const fromWorktree = await projectIdForWorkspace(dir, "ws-worktree");
    expect(fromMain).toBe("proj-a");
    expect(fromWorktree).toBe("proj-a");

    const a = await resolveProject(dir, fromMain);
    const b = await resolveProject(dir, fromWorktree);
    expect(a).toEqual({ projectId: "proj-a", storeRoot: root, decisionsDir: join(root, ".decisions") });
    expect(b).toEqual(a);

    const main = await openProjectStore(dir, fromMain, storeOpts);
    const worktree = await openProjectStore(dir, fromWorktree, storeOpts);
    expect(main.storeRoot).toBe(root);
    expect(worktree.storeRoot).toBe(root);
    await main.init();
    const shared = session("shared", [q("only")]);
    await main.transact(1, (d) => {
      d.sessions.push(shared);
    });
    const read = await worktree.read();
    expect(read).toMatchObject({ status: "ok", revision: 2 });
    if (read.status === "ok") expect(read.data.sessions).toEqual([shared]);
  });

  it("an unknown workspace id throws not_found", async () => {
    const dir = fakeDirectory({ projects: [], workspaces: [{ id: "ws-1", projectId: "proj-a" }] });
    await rejectsCode(projectIdForWorkspace(dir, "ws-missing"), "not_found");
  });

  it("an unknown or duplicated projectId throws unknown_project", async () => {
    const root = await newRoot();
    const other = await newRoot();
    const dir = fakeDirectory({ projects: [project("proj-a", root), project("proj-dup", root), project("proj-dup", other)] });
    await rejectsCode(resolveProject(dir, "proj-missing"), "unknown_project");
    await rejectsCode(resolveProject(dir, "proj-dup"), "unknown_project");
    await rejectsCode(openProjectStore(dir, "proj-missing", storeOpts), "unknown_project");
  });

  it("a projectId with '/', '..' or empty throws invalid_input", async () => {
    const root = await newRoot();
    const dir = fakeDirectory({ projects: [project("a/b", root), project("..", root), project("", root)] });
    for (const id of ["a/b", "..", "", "../proj-a"]) {
      await rejectsCode(resolveProject(dir, id), "invalid_input");
    }
  });
});

describe("root safety", () => {
  it("relative, non-normalised, trailing-slash, symlinked and file roots throw unsafe_root", async () => {
    const base = await newRoot();
    await mkdir(join(base, "real", "sub"), { recursive: true });
    await symlink(join(base, "real"), join(base, "link"));
    await writeFile(join(base, "file"), "not a directory");
    const cases: Record<string, string> = {
      "proj-relative": "relative/root",
      "proj-dotdot": `${base}/real/sub/../sub`,
      "proj-trailing": `${base}/real/`,
      "proj-symlink": join(base, "link"),
      "proj-file": join(base, "file"),
    };
    const dir = fakeDirectory({ projects: Object.entries(cases).map(([id, path]) => project(id, path)) });
    for (const id of Object.keys(cases)) {
      await rejectsCode(resolveProject(dir, id), "unsafe_root");
      await rejectsCode(openProjectStore(dir, id, storeOpts), "unsafe_root");
    }
  });

  it("a .decisions directory that is a symlink throws unsafe_root", async () => {
    const root = await newRoot();
    const elsewhere = await newRoot();
    await symlink(elsewhere, join(root, ".decisions"));
    const dir = fakeDirectory({ projects: [project("proj-a", root)] });
    await rejectsCode(resolveProject(dir, "proj-a"), "unsafe_root");
  });

  it("a real .decisions directory is accepted", async () => {
    const root = await newRoot();
    await mkdir(join(root, ".decisions"));
    const dir = fakeDirectory({ projects: [project("proj-a", root)] });
    expect((await resolveProject(dir, "proj-a")).decisionsDir).toBe(join(root, ".decisions"));
  });
});

describe("projectDirectoryFromPaseo", () => {
  it("maps SDK project and workspace list results and drops every other field", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
    const stub = {
      projects: {
        list: async () => ({
          requestId: "req-1",
          projects: [
            {
              projectId: "proj-a",
              projectKey: "key-a",
              projectDisplayName: "Synthetic A",
              projectRootPath: "/synthetic/a",
              projectKind: "git",
              projectCustomName: null,
            },
          ],
        }),
      },
      workspaces: {
        list: async () => ({
          requestId: "req-2",
          entries: [
            { id: "ws-1", projectId: "proj-a", name: "main", workspaceDirectory: "/synthetic/a" },
            { id: "ws-2", projectId: "proj-a", name: "feature", workspaceDirectory: "/synthetic/wt" },
            { id: "ws-3", projectId: "proj-a", name: "no-directory" },
          ],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        }),
      },
    } as unknown as PaseoApi;
    const dir = projectDirectoryFromPaseo(stub);
    expect(await dir.listProjects()).toEqual([
      { projectId: "proj-a", projectRootPath: "/synthetic/a", projectKind: "git" },
    ]);
    const workspaces = await dir.listWorkspaces();
    expect(workspaces).toEqual([
      { id: "ws-1", projectId: "proj-a", directory: "/synthetic/a" },
      { id: "ws-2", projectId: "proj-a", directory: "/synthetic/wt" },
      { id: "ws-3", projectId: "proj-a" },
    ]);
    // toEqual ignores undefined-valued keys; the mapping must omit the key entirely.
    expect(Object.keys(workspaces[2]).sort()).toEqual(["id", "projectId"]);
  });
});
