import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, gitEnv, withTempIndex, type GitPort } from "./worktree-identity";

export type ScratchCopyResult = { ok: true; dir: string } | { ok: false; reason: string };

/**
 * Materialises a tree as a plain directory: read into a temporary index, then checked out with a
 * prefix. File modes and symbolic links survive; there is no `.git` and nothing is registered
 * with Git. Any failure removes the partial copy.
 */
export async function createScratchCopy(port: GitPort, x: { repoDir: string; contentTree: string; targetDir: string }): Promise<ScratchCopyResult> {
  try {
    await mkdir(dirname(x.targetDir), { recursive: true, mode: 0o700 });
    await mkdir(x.targetDir, { mode: 0o700 });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "copy directory unavailable" };
  }
  try {
    await withTempIndex(async (indexFile) => {
      const env = gitEnv(indexFile);
      await git(port, x.repoDir, ["read-tree", x.contentTree], env);
      await git(port, x.repoDir, ["checkout-index", "--all", "--force", `--prefix=${x.targetDir}/`], env);
    });
    return { ok: true, dir: x.targetDir };
  } catch (error) {
    await removeScratchCopy(x.targetDir).catch(() => undefined);
    return { ok: false, reason: error instanceof Error ? error.message : "copy failed" };
  }
}

async function makeWritable(dir: string): Promise<void> {
  let entries: string[];
  try {
    await chmod(dir, 0o700);
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    const info = await lstat(path).catch(() => null);
    if (info?.isDirectory()) await makeWritable(path);
  }
}

/** Removes a scratch copy, also when a check left read-only directories behind. */
export async function removeScratchCopy(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    await makeWritable(dir);
    await rm(dir, { recursive: true, force: true });
  }
}
