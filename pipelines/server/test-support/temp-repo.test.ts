import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempRepo } from "./temp-repo";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("ignores inherited GIT_DIR and GIT_WORK_TREE", async () => {
  const other = await mkdtemp(join(tmpdir(), "fp-other-"));
  try {
    execFileSync("git", ["init", "-q", other], { env: { PATH: process.env.PATH } });
    vi.stubEnv("GIT_DIR", join(other, ".git"));
    vi.stubEnv("GIT_WORK_TREE", other);
    const repo = await createTempRepo();
    try {
      await writeFile(join(repo.dir, "file.txt"), "x\n");
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", "inside");
      expect(repo.git("log", "--format=%s").trim()).toBe("inside");
      const otherCommits = execFileSync("git", ["-C", other, "rev-list", "--all", "--count"], { env: { PATH: process.env.PATH }, encoding: "utf8" }).trim();
      expect(otherCommits).toBe("0");
    } finally {
      await repo.dispose();
    }
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});
