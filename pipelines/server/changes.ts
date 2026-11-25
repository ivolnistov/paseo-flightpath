import type { RunState } from "./run-engine";
import { git, worktreeIdentity, type GitPort } from "./worktree-identity";

export const DEFAULT_CHANGES_BYTES = 256 * 1024;
const GIT_OUTPUT_CAP = 16 * 1024 * 1024;

export type JobChanges = {
  /** The worktree content against the base commit, cut at the byte bound. */
  diff: string;
  truncated: boolean;
  stat: string;
  /** Files changed by each attempt's worker, from the identity before it to the attempt's own cycle identity. */
  attempts: Array<{ attemptId: string; files: string[] | null }>;
};

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function cut(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  // A continuation byte (10xxxxxx) at the cut means the character starting before it is incomplete.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/** A bounded diff of the run's worktree against its base commit, and the files each attempt of the job changed. */
export async function jobChanges(port: GitPort, x: { directory: string; baseCommit: string; state: RunState; jobId: string; maxBytes?: number }): Promise<JobChanges> {
  const current = await worktreeIdentity(port, x.directory);
  const diffArgs = ["diff", "--no-color", "--no-ext-diff", "--no-renames", x.baseCommit, current.contentTree];
  const [patch, stat] = await Promise.all([git(port, x.directory, diffArgs, undefined, GIT_OUTPUT_CAP), git(port, x.directory, [...diffArgs.slice(0, 4), "--stat", ...diffArgs.slice(4)], undefined, GIT_OUTPUT_CAP)]);
  const bounded = cut(patch, x.maxBytes ?? 256 * 1024);

  const cycles = Object.values(x.state.cycles).sort((a, b) => a.openedSeq - b.openedSeq);
  const attempts: JobChanges["attempts"] = [];
  for (const attemptId of x.state.jobs[x.jobId]?.attempts ?? []) {
    const a = x.state.attempts[attemptId];
    const own = (a?.cycles ?? []).map((id) => x.state.cycles[id]).filter((c) => c !== undefined);
    const first = own[0];
    const last = own[own.length - 1];
    if (!first || !last) {
      attempts.push({ attemptId, files: null });
      continue;
    }
    const before = [...cycles].reverse().find((c) => c.openedSeq < first.openedSeq && c.attemptId !== attemptId);
    const from = before?.identity.contentTree ?? x.baseCommit;
    try {
      const names = await git(port, x.directory, ["diff", "--name-only", "--no-renames", from, last.identity.contentTree], undefined, GIT_OUTPUT_CAP);
      attempts.push({ attemptId, files: names.split("\n").filter((line) => line !== "") });
    } catch {
      attempts.push({ attemptId, files: null });
    }
  }
  return { diff: bounded.text, truncated: bounded.truncated, stat, attempts };
}
