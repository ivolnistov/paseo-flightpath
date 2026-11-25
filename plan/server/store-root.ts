import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { DomainError } from "../shared/errors";
import { nodeStoreFs, type StoreFs } from "./fs-port";
import { openStore, type Store, type StoreOptions } from "./store";

export interface ProjectDirectory {
  listProjects(): Promise<Array<{ projectId: string; projectRootPath: string; projectKind: string }>>;
  /** `directory` is the workspace checkout; absent when the registry does not report one. */
  listWorkspaces(): Promise<Array<{ id: string; projectId: string; directory?: string }>>;
}

export interface ResolvedProject {
  projectId: string;
  storeRoot: string;
  decisionsDir: string;
}

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const WORKSPACE_PAGE = 200;

/** Maps the daemon registry to the narrow port; no other SDK fields are trusted. */
export function projectDirectoryFromPaseo(paseo: PaseoApi): ProjectDirectory {
  return {
    async listProjects() {
      const { projects } = await paseo.projects.list();
      return projects.map((p) => ({
        projectId: p.projectId,
        projectRootPath: p.projectRootPath,
        projectKind: p.projectKind,
      }));
    },
    async listWorkspaces() {
      const out: Array<{ id: string; projectId: string; directory?: string }> = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await paseo.workspaces.list({ page: { limit: WORKSPACE_PAGE, ...(cursor ? { cursor } : {}) } });
        out.push(
          ...page.entries.map((w) => {
            const directory = (w as { workspaceDirectory?: unknown }).workspaceDirectory;
            return { id: w.id, projectId: w.projectId, ...(typeof directory === "string" ? { directory } : {}) };
          }),
        );
        const next = page.pageInfo?.hasMore ? page.pageInfo.nextCursor : null;
        if (!next || next === cursor) return out;
        cursor = next;
      }
    },
  };
}

const unsafe = (message: string, root: string, details?: Record<string, unknown>): never => {
  throw new DomainError("unsafe_root", message, { root, ...details });
};

export async function resolveProject(
  dir: ProjectDirectory,
  projectId: string,
  fs: StoreFs = nodeStoreFs,
): Promise<ResolvedProject> {
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    throw new DomainError("invalid_input", "invalid projectId", { projectId });
  }
  const matches = (await dir.listProjects()).filter((p) => p.projectId === projectId);
  if (matches.length !== 1) {
    throw new DomainError("unknown_project", `project ${projectId} is not registered exactly once`, {
      projectId,
      matches: matches.length,
    });
  }
  return { projectId, ...(await assertSafeRoot(matches[0].projectRootPath, fs)) };
}

/**
 * Absolute, normalised, not a symlink nor behind one, a directory; `.decisions`, if present, is a
 * real directory. `storeRoot` is the normalised realpath result.
 */
export async function assertSafeRoot(
  root: string,
  fs: StoreFs = nodeStoreFs,
): Promise<{ storeRoot: string; decisionsDir: string }> {
  if (typeof root !== "string" || !isAbsolute(root) || normalize(root) !== root || root.endsWith(sep)) {
    unsafe("project root must be an absolute normalised path", root);
  }
  let real: string;
  try {
    real = normalize(await fs.realpath(root));
  } catch {
    return unsafe("project root does not exist", root);
  }
  if (real !== root) {
    // Another spelling of the same path (e.g. case on APFS) is accepted only when no registered
    // component, leaf to just below `/`, is a symlink or a non-directory. Thrown lstat errors propagate.
    for (let cur = root; cur !== dirname(cur); cur = dirname(cur)) {
      const component = await fs.lstat(cur);
      if (!component || component.isSymbolicLink() || !component.isDirectory()) {
        unsafe("project root path must not contain a symlink", root, { real, component: cur });
      }
    }
  }
  const storeRoot = real;
  const stat = await fs.lstat(storeRoot);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) unsafe("project root is not a directory", storeRoot);
  const decisionsDir = join(storeRoot, ".decisions");
  const decisions = await fs.lstat(decisionsDir);
  if (decisions && (decisions.isSymbolicLink() || !decisions.isDirectory())) {
    unsafe(".decisions must be a real directory", decisionsDir);
  }
  return { storeRoot, decisionsDir };
}

const realOrNull = async (fs: StoreFs, path: string): Promise<string | null> => {
  try {
    return normalize(await fs.realpath(path));
  } catch {
    return null;
  }
};

/** True when `path` equals `root` or lies below it on a path-segment boundary. */
const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The project a working directory belongs to: 1) a workspace whose directory is that directory,
 * 2) else the registered project whose root is its longest path-segment prefix, 3) else null.
 * Ambiguity at a step gives null. Selects a project id only; callers still resolve and validate
 * the registered root through `resolveProject`. Never throws for an unknown directory.
 */
export async function projectForCwd(dir: ProjectDirectory, cwd: string, fs: StoreFs = nodeStoreFs): Promise<string | null> {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  const real = await realOrNull(fs, cwd);
  if (real === null) return null;

  const byWorkspace = new Set<string>();
  for (const w of await dir.listWorkspaces()) {
    if (typeof w.directory !== "string" || !isAbsolute(w.directory)) continue;
    if ((await realOrNull(fs, w.directory)) === real) byWorkspace.add(w.projectId);
  }
  if (byWorkspace.size === 1) return [...byWorkspace][0];
  if (byWorkspace.size > 1) return null;

  let best: { length: number; ids: Set<string> } | null = null;
  for (const p of await dir.listProjects()) {
    if (typeof p.projectRootPath !== "string" || !isAbsolute(p.projectRootPath)) continue;
    const root = await realOrNull(fs, p.projectRootPath);
    if (root === null || !within(real, root)) continue;
    if (!best || root.length > best.length) best = { length: root.length, ids: new Set([p.projectId]) };
    else if (root.length === best.length) best.ids.add(p.projectId);
  }
  return best && best.ids.size === 1 ? [...best.ids][0] : null;
}

export async function projectIdForWorkspace(dir: ProjectDirectory, workspaceId: string): Promise<string> {
  const matches = (await dir.listWorkspaces()).filter((w) => w.id === workspaceId);
  if (matches.length !== 1) {
    throw new DomainError("not_found", `workspace ${workspaceId} not found`, { workspaceId });
  }
  return matches[0].projectId;
}

export async function openProjectStore(
  dir: ProjectDirectory,
  projectId: string,
  opts: Omit<StoreOptions, "storeRoot" | "projectId"> = {},
): Promise<Store> {
  const { storeRoot } = await resolveProject(dir, projectId, opts.fs);
  return openStore({ ...opts, storeRoot, projectId });
}
