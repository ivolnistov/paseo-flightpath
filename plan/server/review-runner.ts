// The independent review (Stage R3.3): the configured review command (deployment setting) gets a
// ReviewRequest on stdin and must answer with a ReviewVerdict on stdout. Argv is parsed without a
// shell. The worktree identity is read before and after the command (as for checks); a review that
// did not see the bound tree never passes, and a change while it ran makes its result late.
import type { Evidence } from "../shared/model";
import { ReviewVerdict, type ReviewRequest } from "../shared/review-contract";
import { sameBinding, sameIdentity, worktreeIdentity } from "./evidence";
import { ulid } from "./ids";
import type { ProcessPort } from "./process-port";

type Clock = { now?: () => Date; newId?: () => string };
export type ReviewOutcome = {
  /** pending only when no review command is configured. */
  status: "pass" | "fail" | "pending";
  /** One review entry per DoD item (`itemIndex`), plus one overall entry without `itemIndex`. */
  evidence: Evidence[];
  late: Evidence[];
  reason?: string;
};

/** Splits a command line into argv: whitespace separates, single and double quotes group, backslash escapes. */
export function splitArgv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < line.length && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur !== "") out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur !== "") out.push(cur);
  return out;
}

export async function runReview(
  port: ProcessPort,
  x: Clock & { command: string | undefined; worktree: string; request: ReviewRequest; excluded: string[]; timeoutMs: number; maxBuffer: number; signal?: AbortSignal },
): Promise<ReviewOutcome> {
  const now = x.now ?? (() => new Date());
  const newId = x.newId ?? (() => ulid());
  const argv = x.command === undefined ? [] : splitArgv(x.command.trim());
  if (argv.length === 0) return { status: "pending", evidence: [], late: [], reason: "no review command configured" };

  const make = (result: "pass" | "fail", itemIndex?: number, reason?: string): Evidence => ({
    id: newId(),
    kind: "review",
    taskId: x.request.binding.taskId,
    binding: x.request.binding,
    at: now().toISOString(),
    result,
    ...(itemIndex !== undefined ? { itemIndex } : {}),
    ...(reason !== undefined ? { reason } : {}),
  });
  const failAll = (reason: string): ReviewOutcome => ({
    status: "fail",
    evidence: [...x.request.dod.items.map((i) => make("fail", i.index, reason)), make("fail", undefined, reason)],
    late: [],
    reason,
  });

  const matches = async () => {
    try {
      const id = await worktreeIdentity(port, x.worktree, x.excluded);
      return !("notReady" in id) && sameIdentity(id, x.request.binding.worktree);
    } catch {
      return false;
    }
  };
  if (!(await matches())) return failAll("the worktree does not match the binding");
  const outcome = await review();
  if (await matches()) return outcome;
  // The tree changed while the reviewer ran: its result is late and never a pass.
  return { ...failAll("worktree_drift"), late: outcome.evidence.map((e) => ({ ...e, lateReason: "worktree_drift" })) };

  async function review(): Promise<ReviewOutcome> {
    const child = port.spawn(argv[0], argv.slice(1), { cwd: x.worktree, env: { ...process.env }, maxBuffer: x.maxBuffer, timeoutMs: x.timeoutMs, ...(x.signal ? { signal: x.signal } : {}) });
    child.write(JSON.stringify(x.request));
    child.end();
    const r = await child.result;
    if (r.error !== undefined) return failAll(`review command failed: ${r.error}`);
    if (r.truncated) return failAll("review output truncated");
    if (r.exitCode !== 0) return failAll(`review command exit ${r.exitCode ?? "none"}`);
    let parsed: ReviewVerdict;
    try {
      const verdict = ReviewVerdict.safeParse(JSON.parse(r.stdout.toString("utf8")));
      if (!verdict.success) return failAll("the review verdict does not match the contract");
      parsed = verdict.data;
    } catch {
      return failAll("the review output is not JSON");
    }
    if (!sameBinding(parsed.binding, x.request.binding)) return failAll("the review verdict is for another binding");
    const wanted = new Set(x.request.dod.items.map((i) => i.index));
    const seen = new Map<number, number>();
    for (const it of parsed.items) seen.set(it.index, (seen.get(it.index) ?? 0) + 1);
    if (parsed.items.some((it) => !wanted.has(it.index)) || [...seen.values()].some((n) => n > 1)) {
      return failAll("the review verdict has unknown or duplicate items");
    }
    const evidence = x.request.dod.items.map((i) => {
      const it = parsed.items.find((v) => v.index === i.index);
      return it === undefined ? make("fail", i.index, "no verdict for this item") : make(it.verdict, i.index, it.note);
    });
    const pass = parsed.verdict === "pass" && evidence.every((e) => e.result === "pass");
    evidence.push(make(pass ? "pass" : "fail", undefined, parsed.summary));
    return { status: pass ? "pass" : "fail", evidence, late: [] };
  }
}
