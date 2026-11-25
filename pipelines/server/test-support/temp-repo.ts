import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway Git repository for tests; nothing outside the temporary directory is touched. */
export type TempRepo = {
  root: string;
  dir: string;
  git(...args: string[]): string;
  /** Hashes of the real index, refs and worktree registrations, to prove they stay unchanged. */
  fingerprint(): Promise<{ index: string; refs: string; worktrees: string }>;
  dispose(): Promise<void>;
};

export async function createTempRepo(): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), "fp-repo-"));
  const dir = join(root, "repo");
  // Inherited Git selectors such as GIT_DIR or GIT_WORK_TREE would redirect commands to another repository.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const env = { ...inherited, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const run = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  execFileSync("mkdir", ["-p", dir]);
  run(dir, ["init", "-q", "-b", "main"]);
  const repo: TempRepo = {
    root,
    dir,
    git: (...args) => run(dir, args),
    async fingerprint() {
      const index = await readFile(join(dir, ".git", "index")).catch(() => Buffer.alloc(0));
      return {
        index: createHash("sha256").update(index).digest("hex"),
        refs: run(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]),
        worktrees: run(dir, ["worktree", "list", "--porcelain"]),
      };
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
  return repo;
}
