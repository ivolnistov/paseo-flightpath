// Stage R3.3 (task card 2026-10-29 R3 §4.2, §4.3): the review. `runReview(port, { command, worktree,
// request, timeoutMs, maxBuffer, signal })` splits `reviewCommand` into argv (quotes respected, no
// shell), writes the ReviewRequest JSON to stdin, then end(), and parses a ReviewVerdict from stdout.
// It passes only for a verdict at the request's binding that covers every DoD item; a spawn error,
// timeout, truncation, unparsable or mismatched verdict or a missing item fails. Review always runs
// (an empty DoD included); without a review command the task stays review_pending with
// unresolved "no review command configured". Fake port only: no real process.
// Card §4.2a fixes the result: ReviewOutcome { status: pass | fail | pending (pending only without a
// command), evidence (one kind "review" entry per item plus one overall entry without itemIndex),
// late, reason? }; `excluded` is a required parameter.
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { isJsonObject } from "./test-support/build";

const ITEMS = [{ index: 0, kind: "criterion" as const, text: "Docs updated" }, { index: 1, kind: "check" as const, text: "npm test", command: "npm test" }];
const b = (s: string) => Buffer.from(s, "utf8");
type Repo = { head: string };
/** The binding's worktree identity is computed from the same fake git state (R3.3 verification: the review re-reads identity before and after). */
let binding: { taskId: string; planId: string; planRev: number; contentHash: string; runToken: string; worktree: { headCommit: string; indexTreeHash: string; worktreeTreeHash: string; untrackedHash: string } };
const request = (items = ITEMS) => ({ binding, dod: { items }, taskTitle: "Build", taskDescription: "do" });
const verdict = (over: Record<string, unknown> = {}) => ({
  binding, verdict: "pass", items: [{ index: 0, verdict: "pass", note: "ok" }, { index: 1, verdict: "pass", note: "ran" }], summary: "fine", ...over,
});

/** git answers from `repo` (HEAD varies); every other command is the review command answering `reply`, which may mutate `repo` (a drift during the review). */
function fakePort(reply: { stdout?: string; exitCode?: number | null; error?: string; truncated?: boolean; during?: (repo: Repo) => void }, repo: Repo = { head: "a".repeat(40) }) {
  const calls: Array<{ command: string; args: string[]; stdin: string; ended: boolean }> = [];
  const settled = (exitCode: number | null, stdout: Buffer, extra: { error?: string; truncated?: boolean } = {}) =>
    Promise.resolve({ exitCode, signal: null, stdout, stderr: Buffer.alloc(0), truncated: extra.truncated ?? false, ...(extra.error ? { error: extra.error } : {}) });
  const port = {
    spawn: (command: string, args: string[]) => {
      const call = { command, args, stdin: "", ended: false };
      calls.push(call);
      if (command === "git") {
        const out = args[0] === "rev-parse" ? b(`${repo.head}\n`) : args[0] === "ls-files" && args.includes("--stage") ? Buffer.concat([b(`100644 ${"b".repeat(40)} 0\tsrc/app.ts`), Buffer.from([0])]) : Buffer.alloc(0);
        return { write: () => undefined, end: () => undefined, terminate: async () => undefined, result: settled(0, out) };
      }
      reply.during?.(repo);
      return {
        write: (x: string | Buffer) => void (call.stdin += x.toString()),
        end: () => void (call.ended = true),
        terminate: async () => undefined,
        result: settled(reply.exitCode === undefined ? 0 : reply.exitCode, b(reply.stdout ?? ""), { ...(reply.error ? { error: reply.error } : {}), ...(reply.truncated ? { truncated: true } : {}) }),
      };
    },
  };
  return { port, calls, reviews: () => calls.filter((c) => c.command !== "git"), repo };
}

beforeAll(async () => {
  const ev: Record<string, unknown> = await import("./evidence").catch(() => ({}));
  const identity =
    typeof ev.worktreeIdentity === "function"
      ? await (await import("./evidence")).worktreeIdentity(fakePort({}).port, "/synthetic/wt", [".decisions"])
      : { headCommit: "a".repeat(40), indexTreeHash: "x", worktreeTreeHash: "x", untrackedHash: "x" };
  if ("notReady" in identity) throw new Error("unexpected notReady");
  binding = { taskId: "t1", planId: "plan-1", planRev: 1, contentHash: "e".repeat(64), runToken: "tok-1", worktree: identity };
});

const load = async () => {
  const mod: Record<string, unknown> = await import("./review-runner");
  expect(typeof mod.runReview, "server/review-runner exports runReview").toBe("function");
  return import("./review-runner");
};

/** "pass" | "fail" | "pending" from review evidence or a top-level result/state. */
function outcome(out: unknown): string {
  const results: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isJsonObject(v)) return;
    const o = v;
    if (o.kind === "review" && typeof o.result === "string") results.push(o.result);
    Object.values(o).forEach(walk);
  };
  walk(out);
  if (results.length > 0) return results.every((r) => r === "pass") ? "pass" : "fail";
  const o: Record<string, unknown> = isJsonObject(out) ? out : {};
  for (const k of ["result", "state", "status"]) if (typeof o[k] === "string") return o[k];
  return "unknown";
}

const COMMAND = `review-bot --model "big model" 'two words' plain`;

describe("R3.3 runReview", () => {
  it("splits the command into argv without a shell, writes the request JSON to stdin, ends it, and passes a covering verdict", async () => {
    const r = await load();
    const f = fakePort({ stdout: JSON.stringify(verdict()) });
    const out = await r.runReview(f.port, { command: COMMAND, worktree: "/synthetic/wt", request: request(), excluded: [".decisions"], timeoutMs: 60_000, maxBuffer: 1 << 20 });
    // R3.3 verification: only the review command is counted; git identity reads around it are allowed.
    expect(f.reviews()).toHaveLength(1);
    expect(f.reviews()[0].command).toBe("review-bot");
    expect(f.reviews()[0].args).toEqual(["--model", "big model", "two words", "plain"]);
    expect(JSON.parse(f.reviews()[0].stdin)).toEqual(request());
    expect(f.reviews()[0].ended).toBe(true);
    expect(out.status).toBe("pass");
    expect(out.evidence.map((e) => [e.kind, e.itemIndex ?? "overall", e.result]).sort()).toEqual([["review", 0, "pass"], ["review", 1, "pass"], ["review", "overall", "pass"]]);
    for (const e of out.evidence) expect(e.binding).toEqual(binding);
    expect(outcome(out)).toBe("pass");
  });

  it("an empty DoD still runs the review", async () => {
    const r = await load();
    const f = fakePort({ stdout: JSON.stringify(verdict({ items: [] })) });
    const out = await r.runReview(f.port, { command: "review-bot", worktree: "/synthetic/wt", request: request([]), excluded: [".decisions"], timeoutMs: 60_000, maxBuffer: 1 << 20 });
    expect(f.reviews()).toHaveLength(1);
    expect(z.object({ dod: z.object({ items: z.array(z.unknown()) }) }).parse(JSON.parse(f.reviews()[0].stdin)).dod.items).toEqual([]);
    expect(out.status).toBe("pass");
    expect(out.evidence.filter((e) => e.itemIndex === undefined).map((e) => e.result), "one overall pass").toEqual(["pass"]);
  });

  it("fails on a fail verdict, a failed item, a missing item, a mismatched binding, unparsable output, a spawn error, a non-zero exit or truncation", async () => {
    const r = await load();
    const cases: Array<[string, Parameters<typeof fakePort>[0]]> = [
      ["verdict fail", { stdout: JSON.stringify(verdict({ verdict: "fail" })) }],
      ["item fail", { stdout: JSON.stringify(verdict({ items: [{ index: 0, verdict: "pass", note: "ok" }, { index: 1, verdict: "fail", note: "broken" }] })) }],
      ["missing item", { stdout: JSON.stringify(verdict({ items: [{ index: 0, verdict: "pass", note: "ok" }] })) }],
      ["binding mismatch", { stdout: JSON.stringify(verdict({ binding: { ...binding, runToken: "tok-other" } })) }],
      ["unparsable", { stdout: "LGTM!" }],
      ["spawn error", { exitCode: null, error: "spawn review-bot ENOENT" }],
      ["non-zero exit", { stdout: JSON.stringify(verdict()), exitCode: 2 }],
      ["truncated", { stdout: JSON.stringify(verdict()), truncated: true }],
    ];
    for (const [label, reply] of cases) {
      const out = await r.runReview(fakePort(reply).port, { command: "review-bot", worktree: "/synthetic/wt", request: request(), excluded: [".decisions"], timeoutMs: 60_000, maxBuffer: 1 << 20 });
      expect(out.status, label).toBe("fail");
      expect(outcome(out), label).toBe("fail");
    }
  });

  it("without a review command nothing is spawned and the task stays review_pending with 'no review command configured'", async () => {
    const r = await load();
    const f = fakePort({ stdout: JSON.stringify(verdict()) });
    for (const command of [undefined, ""]) {
      const out = await r.runReview(f.port, { command, worktree: "/synthetic/wt", request: request(), excluded: [".decisions"], timeoutMs: 60_000, maxBuffer: 1 << 20 });
      expect(out.status, String(command)).toBe("pending");
      expect(out.reason).toBe("no review command configured");
      expect(out.evidence.some((e) => e.result === "pass")).toBe(false);
    }
    expect(f.reviews()).toEqual([]);
  });
});

// R3.3 verification (root, settled card §4.2a d17271a8: `excluded` is passed to worktreeIdentity for
// the before and after identities of the runners). A review must be bound to the reviewed tree: an
// identity before the review that differs from the binding never passes, and a worktree change while
// the reviewer runs is late evidence (worktree_drift), even if the tree is restored before recording.
describe("R3.3 runReview worktree identity", () => {
  it("reads the identity through git before and after the review command", async () => {
    const r = await load();
    const f = fakePort({ stdout: JSON.stringify(verdict()) });
    await r.runReview(f.port, { command: "review-bot", worktree: "/synthetic/wt", request: request(), excluded: [".decisions"], timeoutMs: 60_000, maxBuffer: 1 << 20 });
    const order = f.calls.map((c) => (c.command === "git" ? `git:${c.args[0]}` : "review"));
    const at = order.indexOf("review");
    expect(order.slice(0, at), "identity before the review").toContain("git:rev-parse");
    expect(order.slice(at + 1), "identity after the review").toContain("git:rev-parse");
  });

  it("an identity before the review that differs from the binding never passes", async () => {
    const r = await load();
    const f = fakePort({ stdout: JSON.stringify(verdict()) }, { head: "e".repeat(40) });
    const out = await r.runReview(f.port, { command: "review-bot", worktree: "/synthetic/wt", request: request(), excluded: [".decisions"], timeoutMs: 60_000, maxBuffer: 1 << 20 });
    expect(out.status).not.toBe("pass");
    expect(out.evidence.some((e) => e.result === "pass" && e.itemIndex === undefined)).toBe(false);
  });

  it("a drift while the reviewer runs is late worktree_drift evidence and not a pass, even if the tree is restored afterwards", async () => {
    const r = await load();
    const f = fakePort({ stdout: JSON.stringify(verdict()), during: (repo) => (repo.head = "d".repeat(40)) });
    const out = await r.runReview(f.port, { command: "review-bot", worktree: "/synthetic/wt", request: request(), excluded: [".decisions"], timeoutMs: 60_000, maxBuffer: 1 << 20 });
    f.repo.head = "a".repeat(40); // restored before any later record: the review still saw another tree
    expect(out.status).not.toBe("pass");
    expect(out.evidence.some((e) => e.result === "pass")).toBe(false);
    expect(out.late.length).toBeGreaterThan(0);
    expect(out.late.every((e) => e.lateReason === "worktree_drift")).toBe(true);
  });
});
