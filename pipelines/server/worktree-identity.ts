import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { WorktreeIdentity } from "../shared/run";
import type { ProcessPort } from "./process-port";

export type GitPort = Pick<ProcessPort, "exec">;

/** Git environment that can only touch the given temporary index, never the real one. */
export function gitEnv(indexFile: string): Record<string, string | undefined> {
  return { GIT_INDEX_FILE: indexFile, GIT_OPTIONAL_LOCKS: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

export async function git(port: GitPort, cwd: string, args: string[], env: Record<string, string | undefined> = { GIT_OPTIONAL_LOCKS: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined, LC_ALL: "C" }, maxBytes?: number): Promise<string> {
  const result = await port.exec("git", args, { cwd, env, ...(maxBytes === undefined ? {} : { maxBytes }) });
  if (result.code !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr.trim().slice(0, 500)}`);
  return result.stdout;
}

/** Runs `work` with a private index path in a fresh temporary directory, removed afterwards. */
export async function withTempIndex<T>(work: (indexFile: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "flightpath-index-"));
  try {
    return await work(join(dir, "index"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `{ headCommit, indexTree, contentTree }` of a worktree. The index tree is written from a copy of
 * the real index. The content tree starts from a fresh index read from that tree, so no cached
 * stat data or assume-unchanged and skip-worktree flags can hide a change, and then adds every
 * tracked and untracked file that is not ignored. Only objects are written: the real index, refs
 * and worktree files stay untouched.
 */
export async function worktreeIdentity(port: GitPort, dir: string): Promise<WorktreeIdentity> {
  const headCommit = (await git(port, dir, ["rev-parse", "--verify", "HEAD"])).trim();
  const indexPathRaw = (await git(port, dir, ["rev-parse", "--git-path", "index"])).trim();
  const realIndex = isAbsolute(indexPathRaw) ? indexPathRaw : join(dir, indexPathRaw);
  const indexTree = await withTempIndex(async (indexFile) => {
    try {
      await copyFile(realIndex, indexFile);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    }
    return (await git(port, dir, ["write-tree"], gitEnv(indexFile))).trim();
  });
  const contentTree = await withTempIndex(async (indexFile) => {
    const env = gitEnv(indexFile);
    await git(port, dir, ["read-tree", indexTree], env);
    await git(port, dir, ["add", "-A", "--", "."], env);
    return (await git(port, dir, ["write-tree"], env)).trim();
  });
  return { headCommit, indexTree, contentTree };
}
