// Trusted evidence (Stage R3.3): the worktree identity a result is bound to, and the completion
// predicate. Git is read through the process port only (read-only plumbing, no index or object
// writes); paths are handled as bytes, never decoded.
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { canonicalJson } from "../shared/canonical";
import type { DodItem } from "../shared/dod";
import type { Evidence, ResultBinding, TaskDefinitionV2, WorktreeIdentity } from "../shared/model";
import { gitBytes, type ProcessPort } from "./process-port";

const NUL = 0x00;
const TAB = 0x09;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** NUL-terminated entries of a `-z` listing, as raw bytes. */
function splitNul(b: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== NUL) continue;
    if (i > start) out.push(b.subarray(start, i));
    start = i + 1;
  }
  if (start < b.length) out.push(b.subarray(start));
  return out;
}

/** Whether a path (bytes) is an excluded directory or lies inside one. */
function isExcluded(path: Buffer, excluded: readonly Buffer[]): boolean {
  return excluded.some((e) => path.equals(e) || (path.length > e.length && path.subarray(0, e.length).equals(e) && path[e.length] === 0x2f));
}

async function untrackedEntry(worktree: string, path: Buffer): Promise<Buffer> {
  const full = Buffer.concat([Buffer.from(`${worktree}/`, "utf8"), path]);
  let kind: string;
  let content: string;
  try {
    const st = await lstat(full);
    if (st.isSymbolicLink()) {
      kind = "symlink";
      content = sha(await readlink(full, { encoding: "buffer" }));
    } else if (st.isFile()) {
      kind = "file";
      content = sha(await readFile(full));
    } else {
      kind = st.isDirectory() ? "dir" : "other";
      content = "";
    }
  } catch {
    kind = "missing";
    content = "";
  }
  return Buffer.concat([path, Buffer.from([NUL]), Buffer.from(`${kind}\0${content}\0`, "utf8")]);
}

/**
 * The worktree's identity: HEAD (never filtered), and digests of the index listing, `diff HEAD` and
 * the untracked files (path, type, content), all three without `excluded` paths. Any unmerged index
 * entry makes it not ready.
 */
export async function worktreeIdentity(port: ProcessPort, worktree: string, excluded: string[]): Promise<WorktreeIdentity | { notReady: "unmerged" }> {
  const ex = excluded.map((e) => Buffer.from(e.replace(/\/+$/, ""), "utf8"));
  const headCommit = (await gitBytes(port, worktree, ["rev-parse", "HEAD"])).toString("latin1").trim();

  const stage: Buffer[] = [];
  for (const entry of splitNul(await gitBytes(port, worktree, ["ls-files", "--stage", "-z"]))) {
    const tab = entry.indexOf(TAB);
    if (tab < 0) continue;
    const header = entry.subarray(0, tab).toString("latin1").split(" ");
    if (header[2] !== undefined && header[2] !== "0") return { notReady: "unmerged" };
    if (!isExcluded(entry.subarray(tab + 1), ex)) stage.push(entry, Buffer.from([NUL]));
  }

  const diff = await gitBytes(port, worktree, ["diff", "HEAD", "--binary", "--no-color", "--", ".", ...excluded.map((e) => `:(exclude)${e}`)]);

  const untracked = splitNul(await gitBytes(port, worktree, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .filter((p) => !isExcluded(p, ex))
    .sort(Buffer.compare);
  const entries: Buffer[] = [];
  for (const p of untracked) entries.push(await untrackedEntry(worktree, p));

  return { headCommit, indexTreeHash: sha(Buffer.concat(stage)), worktreeTreeHash: sha(diff), untrackedHash: sha(Buffer.concat(entries)) };
}

export const sameIdentity = (a: WorktreeIdentity, b: WorktreeIdentity): boolean => canonicalJson(a) === canonicalJson(b);
export const sameBinding = (a: ResultBinding, b: ResultBinding): boolean => canonicalJson(a) === canonicalJson(b);

export type Verdict = "verified" | "pending" | "failed";

/**
 * The completion predicate (design §3.5). Only evidence of the task at exactly `binding` counts, and
 * the latest entry per key decides: every check item, every criterion (review item), the overall
 * review, and for human completion an acceptance appended after the latest overall review pass.
 */
export function predicate(x: { task: TaskDefinitionV2; items: DodItem[]; binding: ResultBinding; evidence: Evidence[] }): Verdict {
  // Late results never count, even if one is passed in.
  const own = x.evidence.filter((e) => e.taskId === x.task.id && e.lateReason === undefined && sameBinding(e.binding, x.binding));
  const latest = (kind: Evidence["kind"], itemIndex: number | undefined): { e: Evidence; at: number } | undefined => {
    for (let i = own.length - 1; i >= 0; i--) if (own[i].kind === kind && own[i].itemIndex === itemIndex) return { e: own[i], at: i };
    return undefined;
  };
  const keys: Array<ReturnType<typeof latest>> = [
    ...x.items.filter((i) => i.kind === "check").map((i) => latest("check", i.index)),
    ...x.items.filter((i) => i.kind === "criterion").map((i) => latest("review", i.index)),
  ];
  const overall = latest("review", undefined);
  keys.push(overall);
  if (keys.some((k) => k?.e.result === "fail")) return "failed";
  if (keys.some((k) => k === undefined)) return "pending";
  if (x.task.completion === "human") {
    const accepted = latest("acceptance", undefined);
    if (!accepted || accepted.e.result !== "pass" || accepted.at < (overall?.at ?? Infinity)) return "pending";
  }
  return "verified";
}
