import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessRecord } from "../shared/run";
import { ChecksUnconfirmedError, runChecks, settleIsolatedGroup } from "./check-runner";
import { createProcessPort, type ProcessPort } from "./process-port";
import { createScratchCopy } from "./scratch-copy";
import { createTempRepo, type TempRepo } from "./test-support/temp-repo";
import { worktreeIdentity } from "./worktree-identity";

const port = createProcessPort({ graceMs: 300, exitWaitMs: 3_000, pollMs: 10 });
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

const base = { attemptId: "lint#1", cycleId: "lint#1/c1", timeoutMs: 10_000, maxBytes: 64 * 1024 };

function recorder(): { launches: Array<{ index: number; process: ProcessRecord }>; record: (launch: { index: number; process: ProcessRecord }) => Promise<void> } {
  const launches: Array<{ index: number; process: ProcessRecord }> = [];
  return {
    launches,
    record: (launch) => {
      launches.push(launch);
      return Promise.resolve();
    },
  };
}

async function copyOf(name: string): Promise<{ identity: Awaited<ReturnType<typeof worktreeIdentity>>; copyDir: string }> {
  const identity = await worktreeIdentity(port, repo.dir);
  const copyDir = join(repo.root, "copies", name);
  const result = await createScratchCopy(port, { repoDir: repo.dir, contentTree: identity.contentTree, targetDir: copyDir });
  if (!result.ok) throw new Error(result.reason);
  return { identity, copyDir };
}

describe("runChecks", () => {
  it("an isolated command that writes a relative file passes and leaves the canonical identity unchanged", async () => {
    const { identity, copyDir } = await copyOf("c1");
    const rec = recorder();
    const batch = runChecks(port, { ...base, canonicalDir: repo.dir, identity, mode: "isolated", copyDir, commands: [{ shell: "echo built > out.txt && cat a.txt" }], record: rec.record });
    const evidence = await batch.done;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ result: "pass", mode: "isolated", exitCode: 0, identity });
    expect(evidence[0]?.outputTail).toContain("one");
    expect(rec.launches.map((launch) => launch.index)).toEqual([0]);
    expect(existsSync(join(copyDir, "out.txt"))).toBe(true);
    expect(existsSync(join(repo.dir, "out.txt"))).toBe(false);
    expect(await worktreeIdentity(port, repo.dir)).toEqual(identity);
  });

  it("an isolated command that writes into the canonical worktree by absolute path is late once the group settles", async () => {
    const { identity, copyDir } = await copyOf("c2");
    const escape = join(repo.dir, "escaped.txt");
    const provisional = await runChecks(port, { ...base, canonicalDir: repo.dir, identity, mode: "isolated", copyDir, commands: [{ argv: ["/usr/bin/touch", escape] }], record: recorder().record }).done;
    expect(provisional.map((item) => [item.result, item.identity])).toEqual([["pass", identity]]);
    const canonical = await worktreeIdentity(port, repo.dir);
    const [only] = settleIsolatedGroup(provisional, identity, canonical);
    expect(only?.result).toBe("late");
    expect(only?.identity).toEqual(canonical);
    expect(settleIsolatedGroup(provisional, identity, identity)).toEqual(provisional);
  });

  it("brackets an exclusive command with identity readings and marks drift late", async () => {
    const identity = await worktreeIdentity(port, repo.dir);
    const clean = await runChecks(port, { ...base, canonicalDir: repo.dir, identity, mode: "exclusive", commands: [{ shell: "true" }, { shell: "exit 4" }], record: recorder().record }).done;
    expect(clean.map((item) => [item.result, item.exitCode, item.mode])).toEqual([
      ["pass", 0, "exclusive"],
      ["fail", 4, "exclusive"],
    ]);
    const drift = await runChecks(port, { ...base, cycleId: "lint#1/c2", canonicalDir: repo.dir, identity, mode: "exclusive", commands: [{ shell: "echo two > a.txt" }, { shell: "true" }], record: recorder().record }).done;
    expect(drift).toHaveLength(1);
    expect(drift[0]?.result).toBe("late");
  });

  it("refuses to run an exclusive command when the worktree already drifted", async () => {
    const identity = await worktreeIdentity(port, repo.dir);
    await writeFile(join(repo.dir, "a.txt"), "changed\n");
    const rec = recorder();
    const evidence = await runChecks(port, { ...base, canonicalDir: repo.dir, identity, mode: "exclusive", commands: [{ shell: "touch ran" }], record: rec.record }).done;
    expect(evidence).toEqual([expect.objectContaining({ result: "late", exitCode: null })]);
    expect(rec.launches).toHaveLength(0);
    expect(existsSync(join(repo.dir, "ran"))).toBe(false);
  });

  it("passes an argv value as one byte-identical argument", async () => {
    const identity = await worktreeIdentity(port, repo.dir);
    const value = `a 'b' "c" $(touch ${join(repo.root, "shell")}) \`touch ${join(repo.root, "tick")}\``;
    const out = join(repo.root, "args.json");
    const evidence = await runChecks(port, {
      ...base,
      canonicalDir: repo.dir,
      identity,
      mode: "exclusive",
      commands: [{ argv: [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))", out, value] }],
      record: recorder().record,
    }).done;
    expect(evidence[0]?.result).toBe("pass");
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual([value]);
    expect(existsSync(join(repo.root, "shell"))).toBe(false);
    expect(existsSync(join(repo.root, "tick"))).toBe(false);
  });

  it("a rejected record aborts the launch: nothing runs and the shim exits", async () => {
    const identity = await worktreeIdentity(port, repo.dir);
    const marker = join(repo.root, "marker");
    let recorded: ProcessRecord | null = null;
    const batch = runChecks(port, {
      ...base,
      canonicalDir: repo.dir,
      identity,
      mode: "exclusive",
      commands: [{ argv: ["/usr/bin/touch", marker] }],
      record: (launch) => {
        recorded = launch.process;
        return Promise.reject(new Error("journal append failed"));
      },
    });
    await expect(batch.done).rejects.toThrow("journal append failed");
    expect(existsSync(marker)).toBe(false);
    expect(recorded).not.toBeNull();
    if (recorded) expect(await port.processAlive(recorded)).toBe(false);
  });

  it("cancel during a command that ignores the first signal resolves only after the observed exit", async () => {
    const identity = await worktreeIdentity(port, repo.dir);
    const rec = recorder();
    const ready = join(repo.root, "ready");
    const batch = runChecks(port, { ...base, canonicalDir: repo.dir, identity, mode: "exclusive", commands: [{ shell: `trap '' TERM; touch ${JSON.stringify(ready)}; while true; do sleep 0.05; done` }, { shell: "touch second" }], record: rec.record });
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("the command never installed its handler");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(rec.launches).toHaveLength(1);
    expect(await batch.cancel()).toEqual({ exited: true });
    const launched = rec.launches[0]?.process;
    expect(launched && (await port.processAlive(launched))).toBe(false);
    expect(await batch.done).toEqual([]);
    expect(existsSync(join(repo.dir, "second"))).toBe(false);
  });

  it("publishes no evidence when a command's group exit is not observed", async () => {
    const identity = await worktreeIdentity(port, repo.dir);
    const record = { pid: 4242, pgid: 4242, startedAt: "synthetic" };
    const fake: ProcessPort = {
      ...port,
      spawnGated: () =>
        Promise.resolve({
          record,
          release: () => undefined,
          abort: () => Promise.resolve({ exited: true }),
          cancel: () => Promise.resolve({ exited: false }),
          done: Promise.resolve({ ran: true, exitCode: 0, output: "", timedOut: false, cancelled: false, groupExited: false }),
        }),
    };
    const batch = runChecks(fake, { ...base, canonicalDir: repo.dir, identity, mode: "exclusive", commands: [{ shell: "true" }], record: recorder().record });
    const error: unknown = await batch.done.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChecksUnconfirmedError);
    if (error instanceof ChecksUnconfirmedError) expect(error.records).toEqual([record]);
  });
});
