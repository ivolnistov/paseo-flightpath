import { chmod, lstat, readdir, readFile, readlink, symlink, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessPort } from "./process-port";
import { createScratchCopy, removeScratchCopy } from "./scratch-copy";
import { createTempRepo, type TempRepo } from "./test-support/temp-repo";
import { worktreeIdentity } from "./worktree-identity";

const port = createProcessPort();
let repo: TempRepo;

beforeEach(async () => {
  repo = await createTempRepo();
  await writeFile(join(repo.dir, "a.txt"), "one\n");
  await mkdir(join(repo.dir, "bin"));
  await writeFile(join(repo.dir, "bin", "run.sh"), "#!/bin/sh\necho run\n");
  await chmod(join(repo.dir, "bin", "run.sh"), 0o755);
  await symlink("a.txt", join(repo.dir, "link"));
  await writeFile(join(repo.dir, ".gitignore"), "*.log\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "init");
  await writeFile(join(repo.dir, "untracked.txt"), "loose\n");
  await writeFile(join(repo.dir, "skip.log"), "ignored\n");
});

afterEach(async () => {
  await repo.dispose();
});

async function listTree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isDirectory()) out.push(...(await listTree(path, `${prefix}${name}/`)));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

describe("scratch copy", () => {
  it("equals the content tree with modes and links, has no .git and leaves the canonical worktree untouched", async () => {
    const identity = await worktreeIdentity(port, repo.dir);
    const before = await repo.fingerprint();
    const target = join(repo.root, "copies", "c1");

    const result = await createScratchCopy(port, { repoDir: repo.dir, contentTree: identity.contentTree, targetDir: target });
    expect(result).toEqual({ ok: true, dir: target });
    expect(await listTree(target)).toEqual([".gitignore", "a.txt", "bin/run.sh", "link", "untracked.txt"]);
    expect(existsSync(join(target, ".git"))).toBe(false);
    expect((await lstat(join(target, "bin", "run.sh"))).mode & 0o111).not.toBe(0);
    expect((await lstat(join(target, "link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(target, "link"))).toBe("a.txt");
    expect(await readFile(join(target, "untracked.txt"), "utf8")).toBe("loose\n");
    expect(await repo.fingerprint()).toEqual(before);
    expect(await worktreeIdentity(port, repo.dir)).toEqual(identity);

    await writeFile(join(target, "written-by-check.txt"), "relative write\n");
    expect(await worktreeIdentity(port, repo.dir)).toEqual(identity);

    await removeScratchCopy(target);
    expect(existsSync(target)).toBe(false);
    expect(await repo.fingerprint()).toEqual(before);
    expect(await worktreeIdentity(port, repo.dir)).toEqual(identity);
  });

  it("reports a failure for an unknown tree and leaves no partial copy", async () => {
    const target = join(repo.root, "copies", "bad");
    const result = await createScratchCopy(port, { repoDir: repo.dir, contentTree: "0".repeat(40), targetDir: target });
    expect(result.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("removes a copy whose check left a read-only directory", async () => {
    const identity = await worktreeIdentity(port, repo.dir);
    const target = join(repo.root, "copies", "ro");
    await createScratchCopy(port, { repoDir: repo.dir, contentTree: identity.contentTree, targetDir: target });
    await chmod(join(target, "bin"), 0o500);
    await removeScratchCopy(target);
    expect(existsSync(target)).toBe(false);
  });
});
