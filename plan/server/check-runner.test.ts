// Stage R3.3 (task card 2026-10-29 R3 §4.2, §4.3): DoD checks. `runChecks(port, { worktree,
// binding, items, timeoutMs, maxBuffer, signal })` runs each `- [check] <command>` item as
// `/bin/sh -c <command>` (the human-approved shell line) with the worktree identity taken before and
// after. An item passes only with exit 0, no spawn error, no truncation, and before = after = the
// task run's binding; a drift is recorded as late evidence (`lateReason: "worktree_drift"`). A fake
// port answers git and the shell (no real git, shell or process). `./check-runner` is new in R3.3.
// Card §4.2a fixes the result: CheckOutcome { evidence (one per check item, at the binding), late
// (drift or off-binding, lateReason "worktree_drift"), result: "pass" iff every item passes and late
// is empty }; `excluded` is a required parameter passed to worktreeIdentity.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResultBinding } from "../shared/model";
import { isJsonObject } from "./test-support/build";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

type Shell = { exitCode: number | null; stdout?: string; error?: string; truncated?: boolean; after?: (repo: Repo) => void };
type Repo = { head: string };
const p = (s: string) => Buffer.from(s, "utf8");

/** Git answers from `repo` (HEAD only varies); `/bin/sh -c <cmd>` answers from `shell[cmd]`, which may mutate `repo`. */
function fakePort(repo: Repo, shell: Record<string, Shell>) {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const done = (r: { exitCode: number | null; stdout?: Buffer; error?: string; truncated?: boolean }) => ({
    write: () => undefined, end: () => undefined, terminate: async () => undefined,
    result: Promise.resolve({ exitCode: r.exitCode, signal: null, stdout: r.stdout ?? Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: r.truncated ?? false, ...(r.error ? { error: r.error } : {}) }),
  });
  const port = {
    spawn: (command: string, args: string[], opts: { cwd: string }) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (command === "git") {
        if (args[0] === "rev-parse") return done({ exitCode: 0, stdout: p(`${repo.head}\n`) });
        if (args[0] === "ls-files" && args.includes("--stage")) return done({ exitCode: 0, stdout: Buffer.concat([p(`100644 ${"b".repeat(40)} 0\tsrc/app.ts`), Buffer.from([0])]) });
        if (args[0] === "ls-files") return done({ exitCode: 0, stdout: Buffer.alloc(0) });
        if (args[0] === "diff") return done({ exitCode: 0, stdout: p("") });
      }
      if (command === "/bin/sh" && args[0] === "-c") {
        const s = shell[args[1]];
        if (!s) throw new Error(`unscripted shell line ${args[1]}`);
        s.after?.(repo);
        return done({ exitCode: s.exitCode, stdout: p(s.stdout ?? ""), ...(s.error ? { error: s.error } : {}), ...(s.truncated ? { truncated: true } : {}) });
      }
      throw new Error(`unexpected spawn ${command} ${args.join(" ")}`);
    },
  };
  return { port, calls };
}

const load = async () => {
  const mod: Record<string, unknown> = await import("./check-runner");
  expect(typeof mod.runChecks, "server/check-runner exports runChecks").toBe("function");
  const ev: Record<string, unknown> = await import("./evidence");
  expect(typeof ev.worktreeIdentity, "server/evidence exports worktreeIdentity").toBe("function");
  return { checks: await import("./check-runner"), evidence: await import("./evidence") };
};

/** Every evidence-like object of the given kind anywhere in the result. */
type Evidence = { kind: string; result: string; itemIndex?: number; binding?: unknown; lateReason?: string; exitCode?: number };
/** Every typed field of the evidence shape holds its declared type (absent optionals are fine). */
const isEvidence = (o: Record<string, unknown>): o is Record<string, unknown> & Evidence =>
  typeof o.kind === "string" && typeof o.result === "string" &&
  (o.itemIndex === undefined || typeof o.itemIndex === "number") &&
  (o.lateReason === undefined || typeof o.lateReason === "string") &&
  (o.exitCode === undefined || typeof o.exitCode === "number");
function evidenceOf(out: unknown, kind: string): Evidence[] {
  const found: Evidence[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isJsonObject(v)) return;
    const o = v;
    if (o.kind === kind && typeof o.result === "string") {
      // A matching object with a mistyped field fails loudly instead of being dropped.
      if (!isEvidence(o)) throw new Error(`malformed ${kind} evidence: ${JSON.stringify(o)}`);
      found.push(o);
    }
    Object.values(o).forEach(walk);
  };
  walk(out);
  return found;
}

const items = (commands: string[]) => [
  { index: 0, kind: "criterion" as const, text: "Docs are updated" },
  ...commands.map((command, i) => ({ index: i + 1, kind: "check" as const, text: command, command })),
];

async function setup(shell: Record<string, Shell>, headForBinding?: string) {
  const dir = await mkdtemp(join(tmpdir(), "dr-r33-chk-"));
  temps.push(dir);
  await writeFile(join(dir, "README.md"), "synthetic");
  const repo: Repo = { head: "a".repeat(40) };
  const m = await load();
  const identity = await m.evidence.worktreeIdentity(fakePort({ head: headForBinding ?? repo.head }, {}).port, dir, [".decisions"]);
  if ("notReady" in identity) throw new Error("unexpected notReady");
  const binding: ResultBinding = { taskId: "t1", planId: "plan-1", planRev: 1, contentHash: "c".repeat(64), runToken: "tok-1", worktree: identity };
  const f = fakePort(repo, shell);
  const checkItems = items(Object.keys(shell)).flatMap((i) => (i.kind === "check" ? [{ index: i.index, command: i.command }] : []));
  const run = () => m.checks.runChecks(f.port, { worktree: dir, binding, items: checkItems, excluded: [".decisions"], timeoutMs: 60_000, maxBuffer: 1 << 20 });
  return { dir, repo, binding, f, run };
}

describe("R3.3 runChecks", () => {
  it("runs each check line through /bin/sh -c in the worktree (criteria are not run); exit 0 with a stable identity passes at the binding", async () => {
    const s = await setup({ "npm test": { exitCode: 0 }, "npm run lint": { exitCode: 0 } });
    const out = await s.run();
    const shells = s.f.calls.filter((c) => c.command === "/bin/sh");
    expect(shells.map((c) => c.args)).toEqual([["-c", "npm test"], ["-c", "npm run lint"]]);
    for (const c of shells) expect(c.cwd).toBe(s.dir);
    expect(out.result).toBe("pass");
    expect(out.late).toEqual([]);
    expect(out.evidence.map((e) => [e.kind, e.itemIndex, e.result, e.taskId])).toEqual([["check", 1, "pass", "t1"], ["check", 2, "pass", "t1"]]);
    const ev = evidenceOf(out, "check");
    expect(ev.map((e) => [e.itemIndex, e.result]).sort()).toEqual([[1, "pass"], [2, "pass"]]);
    for (const e of ev) {
      expect(e.binding).toEqual(s.binding);
      expect(e.lateReason).toBeUndefined();
    }
  });

  it("a non-zero exit, a spawn error or truncated output never passes", async () => {
    const s = await setup({ "npm test": { exitCode: 1 }, "missing-tool": { exitCode: null, error: "spawn /bin/sh ENOENT" }, "noisy": { exitCode: 0, truncated: true } });
    const out = await s.run();
    expect(out.result).toBe("fail");
    const ev = evidenceOf(out.evidence, "check");
    expect(ev.length).toBe(3);
    for (const index of [1, 2, 3]) {
      const mine = ev.filter((e) => e.itemIndex === index);
      expect(mine.length, `item ${index} has evidence`).toBeGreaterThan(0);
      expect(mine.every((e) => e.result === "fail"), `item ${index} fails`).toBe(true);
    }
    expect(ev.find((e) => e.itemIndex === 1)?.exitCode).toBe(1);
  });

  it("a worktree drift during the command is late evidence (worktree_drift) and does not pass", async () => {
    const s = await setup({ "npm test": { exitCode: 0, after: (repo) => (repo.head = "d".repeat(40)) } });
    const out = await s.run();
    expect(out.result).toBe("fail");
    expect(out.evidence.some((e) => e.result === "pass")).toBe(false);
    expect(out.late.length).toBeGreaterThan(0);
    expect(out.late.every((e) => e.lateReason === "worktree_drift")).toBe(true);
  });

  it("an identity before the command that differs from the binding never passes", async () => {
    const s = await setup({ "npm test": { exitCode: 0 } }, "e".repeat(40));
    const out = await s.run();
    expect(out.result).toBe("fail");
    expect(out.evidence.some((e) => e.result === "pass")).toBe(false);
  });
});
