import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cut, jobChanges } from "./changes";
import { createProcessPort } from "./process-port";
import { applyBodies, initialState } from "./run-engine";
import { snapshotOf } from "./run-test-kit";
import { createTempRepo, type TempRepo } from "./test-support/temp-repo";
import { worktreeIdentity } from "./worktree-identity";

const port = createProcessPort();
let repo: TempRepo;

beforeEach(async () => {
  repo = await createTempRepo();
  await writeFile(join(repo.dir, "a.txt"), "one\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "init");
});

afterEach(async () => {
  await repo.dispose();
});

describe("jobChanges", () => {
  it("diffs the worktree content against the base commit, bounded, with the files of each attempt", async () => {
    const base = repo.git("rev-parse", "HEAD").trim();
    const before = await worktreeIdentity(port, repo.dir);
    await writeFile(join(repo.dir, "a.txt"), "two\n");
    await writeFile(join(repo.dir, "new.txt"), `${"x".repeat(2_000)}\n`);
    const after = await worktreeIdentity(port, repo.dir);
    const snapshot = snapshotOf("name: C\njobs:\n  build: { uses: agent, with: { prompt: p, agent: { model: p/m } } }\n");
    const { state } = applyBodies(
      initialState(snapshot),
      [
        { kind: "workspace.intent", branchName: "flightpath/run-run1" },
        { kind: "workspace.bound", workspaceId: "w", directory: repo.dir, baseCommit: base },
        { kind: "cycle.opened", cycleId: "finish/c1", attemptId: null, identity: before },
        { kind: "attempt.started", jobId: "build", attemptId: "build#1", n: 1, cause: "first", target: "primary" },
        { kind: "agent.intent", attemptId: "build#1", role: "worker", creationKey: "run1:build#1:worker", settings: { provider: "p", model: "m" }, target: "primary" },
        { kind: "attempt.agent_bound", attemptId: "build#1", role: "worker", agentId: "a1" },
        { kind: "attempt.outputs_accepted", attemptId: "build#1", role: "worker", agentId: "a1", outputs: {}, summary: "s" },
        { kind: "cycle.opened", cycleId: "build#1/c1", attemptId: "build#1", identity: after },
      ],
      "2026-11-21T00:00:00.000Z",
    );
    const full = await jobChanges(port, { directory: repo.dir, baseCommit: base, state, jobId: "build" });
    expect(full.truncated).toBe(false);
    expect(full.diff).toContain("+two");
    expect(full.stat).toContain("new.txt");
    expect(full.attempts).toEqual([{ attemptId: "build#1", files: ["a.txt", "new.txt"] }]);
    const cut = await jobChanges(port, { directory: repo.dir, baseCommit: base, state, jobId: "build", maxBytes: 200 });
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.diff)).toBeLessThanOrEqual(200);
    expect(repo.git("status", "--porcelain")).toContain("?? new.txt");
  });
});

describe("cut", () => {
  it("never splits a multibyte character or exceeds the byte bound", () => {
    for (let maxBytes = 0; maxBytes <= 9; maxBytes += 1) {
      const result = cut("aé€😀", maxBytes);
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(maxBytes);
      expect(result.text).not.toContain("\uFFFD");
      expect("aé€😀".startsWith(result.text)).toBe(true);
    }
    expect(cut("aé", 2)).toEqual({ text: "a", truncated: true });
    expect(cut("aé", 3)).toEqual({ text: "aé", truncated: false });
  });
});
