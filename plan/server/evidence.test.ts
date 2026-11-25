// Stage R3.3 (task card 2026-10-29 R3 §4.2, §4.3): worktree identity. `worktreeIdentity(port,
// worktree, excluded)` reads git only through the port (`rev-parse HEAD`, `ls-files --stage -z`,
// `diff HEAD --binary --no-color -- . ':(exclude)…'`, `ls-files --others --exclude-standard -z`) and
// never writes. HEAD is never path-filtered; the exclusions apply only to the three path digests; an
// unmerged entry (stage ≠ 0) is notReady. The git side is a scripted fake port (no real git);
// untracked file contents live in a real temp directory with synthetic data.
// `./evidence` is new in R3.3, so it is loaded from the module namespace.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const EXCLUDED = [".decisions", ".roadmap-evidence"];
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const load = async () => {
  const mod: Record<string, unknown> = await import("./evidence");
  expect(typeof mod.worktreeIdentity, "server/evidence exports worktreeIdentity").toBe("function");
  return import("./evidence");
};

type StageEntry = { mode: string; sha: string; stage: number; path: Buffer };
type Repo = { head: string; stage: StageEntry[]; diff: Buffer; untracked: Buffer[] };
const p = (s: string) => Buffer.from(s, "utf8");

/** A fake ProcessPort that answers the four read-only git commands from `repo`, and records every call. */
function gitPort(repo: Repo) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const out = (stdout: Buffer) => ({ write: () => undefined, end: () => undefined, terminate: async () => undefined, result: Promise.resolve({ exitCode: 0, signal: null, stdout, stderr: Buffer.alloc(0), truncated: false }) });
  const port = {
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command !== "git") throw new Error(`unexpected command ${command}`);
      if (args[0] === "rev-parse") return out(p(`${repo.head}\n`));
      if (args[0] === "ls-files" && args.includes("--stage")) {
        return out(Buffer.concat(repo.stage.flatMap((e) => [p(`${e.mode} ${e.sha} ${e.stage}\t`), e.path, Buffer.from([0])])));
      }
      if (args[0] === "ls-files" && args.includes("--others")) return out(Buffer.concat(repo.untracked.flatMap((x) => [x, Buffer.from([0])])));
      if (args[0] === "diff") return out(repo.diff);
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
  };
  return { port, calls };
}

async function worktree() {
  const dir = await mkdtemp(join(tmpdir(), "dr-r33-wt-"));
  temps.push(dir);
  await writeFile(join(dir, "notes.txt"), "draft one");
  const repo: Repo = {
    head: "a".repeat(40),
    stage: [{ mode: "100644", sha: "b".repeat(40), stage: 0, path: p("src/app.ts") }],
    diff: p("diff --git a/src/app.ts b/src/app.ts\n+change\n"),
    untracked: [p("notes.txt")],
  };
  return { dir, repo };
}

describe("R3.3 worktreeIdentity", () => {
  it("reads git through the port with the specified read-only commands; HEAD is unfiltered; the diff excludes .decisions and the evidence directory", async () => {
    const e = await load();
    const w = await worktree();
    const g = gitPort(w.repo);
    const id = await e.worktreeIdentity(g.port, w.dir, EXCLUDED);
    const anyString: unknown = expect.any(String); // the matcher is typed any; widened to unknown, matching unchanged
    expect(id).toMatchObject({ headCommit: anyString, indexTreeHash: anyString, worktreeTreeHash: anyString, untrackedHash: anyString });
    expect(JSON.stringify(id)).toContain("a".repeat(40));
    const argsOf = (first: string, flag?: string) => g.calls.find((c) => c.args[0] === first && (flag === undefined || c.args.includes(flag)))?.args;
    expect(argsOf("rev-parse")).toEqual(["rev-parse", "HEAD"]);
    expect(argsOf("ls-files", "--stage")).toEqual(expect.arrayContaining(["ls-files", "--stage", "-z"]));
    expect(argsOf("ls-files", "--others")).toEqual(expect.arrayContaining(["ls-files", "--others", "--exclude-standard", "-z"]));
    const diff = argsOf("diff")!;
    expect(diff).toEqual(expect.arrayContaining(["diff", "HEAD", "--binary", "--no-color", "--", ".", ":(exclude).decisions", ":(exclude).roadmap-evidence"]));
    for (const c of g.calls) {
      expect(c.command).toBe("git");
      expect(c.args.join(" ")).not.toMatch(/\b(add|commit|checkout|reset|stash|rm|update-index|write-tree)\b/);
    }
  });

  it("changes on untracked content, type, path or deletion, an index-only change, a worktree diff change and a HEAD move", async () => {
    const e = await load();
    const w = await worktree();
    const base = await e.worktreeIdentity(gitPort(w.repo).port, w.dir, EXCLUDED);
    const again = await e.worktreeIdentity(gitPort(w.repo).port, w.dir, EXCLUDED);
    expect(again, "control: stable for an unchanged worktree").toEqual(base);
    const variant = async (label: string, mutate: () => Promise<Repo> | Repo) => {
      const repo = await mutate();
      const id = await e.worktreeIdentity(gitPort(repo).port, w.dir, EXCLUDED);
      expect(id, label).not.toEqual(base);
      return id;
    };
    await variant("untracked content", async () => {
      await writeFile(join(w.dir, "notes.txt"), "draft two");
      return w.repo;
    });
    await writeFile(join(w.dir, "notes.txt"), "draft one");
    await variant("untracked path", async () => {
      await writeFile(join(w.dir, "notes-2.txt"), "draft one");
      return { ...w.repo, untracked: [p("notes-2.txt")] };
    });
    await variant("untracked deletion (listed but gone)", () => ({ ...w.repo, untracked: [p("notes.txt"), p("gone.txt")] }));
    await variant("untracked type (file → symlink)", async () => {
      await writeFile(join(w.dir, "target.txt"), "draft one");
      await symlink("target.txt", join(w.dir, "link.txt"));
      await mkdir(join(w.dir, "sub"), { recursive: true });
      return { ...w.repo, untracked: [p("notes.txt"), p("link.txt")] };
    });
    await variant("index only", () => ({ ...w.repo, stage: [{ ...w.repo.stage[0], sha: "c".repeat(40) }] }));
    await variant("worktree diff", () => ({ ...w.repo, diff: p("diff --git a/src/app.ts b/src/app.ts\n+other\n") }));
    await variant("HEAD move", () => ({ ...w.repo, head: "d".repeat(40) }));
  });

  it("is unchanged when only excluded paths change; HEAD still changes when only an excluded file is committed", async () => {
    const e = await load();
    const w = await worktree();
    const base = await e.worktreeIdentity(gitPort(w.repo).port, w.dir, EXCLUDED);
    await mkdir(join(w.dir, ".roadmap-evidence"), { recursive: true });
    await writeFile(join(w.dir, ".roadmap-evidence", "check-1.log"), "ok");
    const excludedOnly: Repo = {
      ...w.repo,
      stage: [...w.repo.stage, { mode: "100644", sha: "e".repeat(40), stage: 0, path: p(".decisions/roadmap.json") }],
      untracked: [...w.repo.untracked, p(".roadmap-evidence/check-1.log"), p(".decisions/tmp.json")],
    };
    expect(await e.worktreeIdentity(gitPort(excludedOnly).port, w.dir, EXCLUDED)).toEqual(base);
    const committed = await e.worktreeIdentity(gitPort({ ...excludedOnly, head: "f".repeat(40) }).port, w.dir, EXCLUDED);
    expect(committed).not.toEqual(base);
    expect(JSON.stringify(committed)).toContain("f".repeat(40));
  });

  it("an unmerged index entry (stage ≠ 0) is notReady", async () => {
    const e = await load();
    const w = await worktree();
    for (const stage of [1, 2, 3]) {
      const repo: Repo = { ...w.repo, stage: [...w.repo.stage, { mode: "100644", sha: "9".repeat(40), stage, path: p("src/conflict.ts") }] };
      expect(await e.worktreeIdentity(gitPort(repo).port, w.dir, EXCLUDED), `stage ${stage}`).toEqual({ notReady: "unmerged" });
    }
  });

  it("NUL-separated listings are split on the byte 0x00 and non-UTF-8 paths are hashed as bytes", async () => {
    const e = await load();
    const w = await worktree();
    const a = Buffer.from([0x66, 0xff, 0x2e, 0x74]);
    const b = Buffer.from([0x66, 0xfe, 0x2e, 0x74]);
    const withA = await e.worktreeIdentity(gitPort({ ...w.repo, untracked: [p("notes.txt"), a] }).port, w.dir, EXCLUDED);
    const withB = await e.worktreeIdentity(gitPort({ ...w.repo, untracked: [p("notes.txt"), b] }).port, w.dir, EXCLUDED);
    expect(withA).not.toEqual(withB);
    const stageA = await e.worktreeIdentity(gitPort({ ...w.repo, stage: [...w.repo.stage, { mode: "100644", sha: "1".repeat(40), stage: 0, path: a }] }).port, w.dir, EXCLUDED);
    const stageB = await e.worktreeIdentity(gitPort({ ...w.repo, stage: [...w.repo.stage, { mode: "100644", sha: "1".repeat(40), stage: 0, path: b }] }).port, w.dir, EXCLUDED);
    expect(stageA).not.toEqual(stageB);
    // A path containing a tab or newline survives the NUL split (one entry, not two).
    const odd = await e.worktreeIdentity(gitPort({ ...w.repo, untracked: [p("notes.txt"), p("a\nb.txt")] }).port, w.dir, EXCLUDED);
    const split = await e.worktreeIdentity(gitPort({ ...w.repo, untracked: [p("notes.txt"), p("a"), p("b.txt")] }).port, w.dir, EXCLUDED);
    expect(odd).not.toEqual(split);
  });
});

// Card §4.2a: predicate({ task, items, binding, evidence }) → "verified" | "pending" | "failed" (pure).
// Only evidence of task.id at exactly `binding` counts; the latest entry per key decides (check item
// indices, review item indices of criteria, the overall review, and for completion "human" the
// acceptance, which counts only after the latest overall review pass). An empty DoD still needs the
// overall review pass.
describe("R3.3 predicate", () => {
  type Ev = import("../shared/model").Evidence;
  type Task = import("../shared/model").TaskDefinitionV2;
  const identity = { headCommit: "a".repeat(40), indexTreeHash: "b".repeat(64), worktreeTreeHash: "c".repeat(64), untrackedHash: "d".repeat(64) };
  const binding = { taskId: "t1", planId: "plan-1", planRev: 1, contentHash: "e".repeat(64), runToken: "tok-1", worktree: identity };
  const other = { ...binding, worktree: { ...identity, headCommit: "f".repeat(40) } };
  const task = (dod: string, completion: "auto" | "human" = "auto"): Task => ({ id: "t1", title: "Build", description: "", dependsOn: [], parallel: false, completion, grill: false, dod });
  const DOD = "- [check] npm test\nDocs are updated";
  let n = 0;
  const ev = (kind: Ev["kind"], result: Ev["result"], itemIndex?: number, b = binding, taskId = "t1"): Ev => ({
    id: `ev-${++n}`, kind, taskId, binding: b, at: "2026-10-29T10:00:00.000Z", result, ...(itemIndex !== undefined ? { itemIndex } : {}),
  });
  const allPass = (): Ev[] => [ev("check", "pass", 0), ev("review", "pass", 1), ev("review", "pass")];
  const loadPredicate = async () => {
    const mod: Record<string, unknown> = await import("./evidence");
    expect(typeof mod.predicate, "server/evidence exports predicate").toBe("function");
    const { parseDod } = await import("../shared/dod");
    const { predicate } = await import("./evidence");
    return (t: Task, evidence: Ev[], b = binding) => predicate({ task: t, items: parseDod(t.dod).items, binding: b, evidence });
  };

  it("verified when every check, every criterion review item and the overall review pass at the binding", async () => {
    const pred = await loadPredicate();
    expect(pred(task(DOD), allPass())).toBe("verified");
  });

  it("missing keys are pending; any latest fail is failed", async () => {
    const pred = await loadPredicate();
    expect(pred(task(DOD), [])).toBe("pending");
    expect(pred(task(DOD), [ev("check", "pass", 0), ev("review", "pass", 1)]), "no overall review").toBe("pending");
    expect(pred(task(DOD), [ev("check", "pass", 0), ev("review", "pass")]), "a criterion item has no review").toBe("pending");
    expect(pred(task(DOD), [ev("review", "pass", 1), ev("review", "pass")]), "the check has no evidence").toBe("pending");
    expect(pred(task(DOD), [...allPass(), ev("check", "fail", 0)])).toBe("failed");
    expect(pred(task(DOD), [ev("check", "fail", 0)]), "a failure decides even with keys missing").toBe("failed");
  });

  it("only the latest entry per key counts: a later failure beats an old pass, and a later pass recovers", async () => {
    const pred = await loadPredicate();
    expect(pred(task(DOD), [...allPass(), ev("review", "fail")])).toBe("failed");
    expect(pred(task(DOD), [ev("check", "fail", 0), ev("review", "fail", 1), ev("review", "fail"), ...allPass()])).toBe("verified");
  });

  it("evidence at another binding or of another task is ignored", async () => {
    const pred = await loadPredicate();
    expect(pred(task(DOD), [ev("check", "pass", 0, other), ev("review", "pass", 1, other), ev("review", "pass", undefined, other)])).toBe("pending");
    expect(pred(task(DOD), [...allPass(), ev("check", "fail", 0, other)]), "an off-binding failure is ignored").toBe("verified");
    expect(pred(task(DOD), [...allPass(), ev("check", "fail", 0, binding, "t2")]), "another task's failure is ignored").toBe("verified");
  });

  // R3.3 verification (root): late evidence never counts, even when it carries the current binding.
  it("a pass carrying a lateReason at the current binding does not count", async () => {
    const pred = await loadPredicate();
    const [check, item, overall] = allPass();
    expect(pred(task(DOD), [{ ...check, lateReason: "worktree_drift" }, item, overall])).toBe("pending");
    expect(pred(task(DOD), [check, item, { ...overall, lateReason: "worktree_drift" }])).toBe("pending");
  });

  it("an empty DoD still needs the overall review pass", async () => {
    const pred = await loadPredicate();
    expect(pred(task(""), [])).toBe("pending");
    expect(pred(task(""), [ev("review", "pass")])).toBe("verified");
  });

  it("human completion waits for an acceptance appended after the latest overall review pass", async () => {
    const pred = await loadPredicate();
    expect(pred(task(DOD, "human"), allPass())).toBe("pending");
    expect(pred(task(DOD, "human"), [...allPass(), ev("acceptance", "pass")])).toBe("verified");
    expect(pred(task(DOD, "human"), [ev("acceptance", "pass"), ...allPass()]), "an acceptance before the review pass does not count").toBe("pending");
    expect(pred(task(DOD, "human"), [...allPass(), ev("acceptance", "pass"), ev("review", "pass")]), "a newer review pass needs a newer acceptance").toBe("pending");
  });
});
