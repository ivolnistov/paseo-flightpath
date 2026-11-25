import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessPort } from "./process-port";
import { createTempRepo, type TempRepo } from "./test-support/temp-repo";
import { worktreeIdentity } from "./worktree-identity";

const port = createProcessPort();
let repo: TempRepo;

beforeEach(async () => {
  repo = await createTempRepo();
  await writeFile(join(repo.dir, "a.txt"), "one\n");
  await writeFile(join(repo.dir, ".gitignore"), "*.log\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "init");
});

afterEach(async () => {
  await repo.dispose();
});

describe("worktreeIdentity", () => {
  it("changes for a tracked edit, a staged edit and an untracked file, not for an ignored file", async () => {
    const base = await worktreeIdentity(port, repo.dir);
    expect(base.headCommit).toBe(repo.git("rev-parse", "HEAD").trim());

    await writeFile(join(repo.dir, "debug.log"), "ignored\n");
    expect(await worktreeIdentity(port, repo.dir)).toEqual(base);

    await writeFile(join(repo.dir, "a.txt"), "two\n");
    const tracked = await worktreeIdentity(port, repo.dir);
    expect(tracked.contentTree).not.toBe(base.contentTree);
    expect(tracked.indexTree).toBe(base.indexTree);

    repo.git("add", "a.txt");
    const staged = await worktreeIdentity(port, repo.dir);
    expect(staged.indexTree).not.toBe(base.indexTree);
    expect(staged.contentTree).toBe(tracked.contentTree);

    await writeFile(join(repo.dir, "new.txt"), "fresh\n");
    const untracked = await worktreeIdentity(port, repo.dir);
    expect(untracked.contentTree).not.toBe(staged.contentTree);
    expect(untracked.indexTree).toBe(staged.indexTree);
  });

  it("sees a same-size rewrite right after the index was written", async () => {
    for (let round = 0; round < 5; round += 1) {
      await writeFile(join(repo.dir, "a.txt"), `v${round}\n`);
      repo.git("add", "a.txt");
      const before = await worktreeIdentity(port, repo.dir);
      await writeFile(join(repo.dir, "a.txt"), `w${round}\n`);
      const after = await worktreeIdentity(port, repo.dir);
      expect(after.indexTree).toBe(before.indexTree);
      expect(after.contentTree).not.toBe(before.contentTree);
    }
  });

  it("is not hidden by assume-unchanged or skip-worktree flags in the real index", async () => {
    const base = await worktreeIdentity(port, repo.dir);
    repo.git("update-index", "--assume-unchanged", "a.txt");
    await writeFile(join(repo.dir, "a.txt"), "two\n");
    const changed = await worktreeIdentity(port, repo.dir);
    expect(changed.contentTree).not.toBe(base.contentTree);
    repo.git("update-index", "--no-assume-unchanged", "a.txt");
    repo.git("update-index", "--skip-worktree", "a.txt");
    await writeFile(join(repo.dir, "a.txt"), "three\n");
    const skipped = await worktreeIdentity(port, repo.dir);
    expect(skipped.contentTree).not.toBe(changed.contentTree);
    expect(skipped.indexTree).toBe(base.indexTree);
  });

  it("never writes the real index, refs or worktree registrations", async () => {
    await writeFile(join(repo.dir, "a.txt"), "changed\n");
    await writeFile(join(repo.dir, "untracked.txt"), "x\n");
    const before = await repo.fingerprint();
    const status = repo.git("status", "--porcelain");
    await worktreeIdentity(port, repo.dir);
    await worktreeIdentity(port, repo.dir);
    expect(await repo.fingerprint()).toEqual(before);
    expect(repo.git("status", "--porcelain")).toBe(status);
  });
});
