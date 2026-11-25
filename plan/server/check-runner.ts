// DoD checks (Stage R3.3): each `- [check] <command>` line of the approved DoD runs as
// `/bin/sh -c <command>` in the feature worktree, between two identity readings. Only this runner
// produces check evidence; agent reports never do.
import type { Evidence, ResultBinding } from "../shared/model";
import { sameIdentity, worktreeIdentity } from "./evidence";
import { ulid } from "./ids";
import type { ProcessPort } from "./process-port";

type Clock = { now?: () => Date; newId?: () => string };
export type CheckOutcome = {
  /** One per check item, at the binding (`kind: "check"`, `itemIndex` = the item's DodItem.index). */
  evidence: Evidence[];
  /** Results that drifted during the command (`lateReason: "worktree_drift"`). */
  late: Evidence[];
  /** pass iff every item passed and nothing is late. */
  result: "pass" | "fail";
};

export async function runChecks(
  port: ProcessPort,
  x: Clock & { worktree: string; binding: ResultBinding; items: Array<{ index: number; command: string }>; excluded: string[]; timeoutMs: number; maxBuffer: number; signal?: AbortSignal },
): Promise<CheckOutcome> {
  const now = x.now ?? (() => new Date());
  const newId = x.newId ?? (() => ulid());
  const evidence: Evidence[] = [];
  const late: Evidence[] = [];
  const make = (index: number, result: "pass" | "fail", extra: { exitCode?: number; reason?: string; lateReason?: string } = {}): Evidence => ({
    id: newId(),
    kind: "check",
    taskId: x.binding.taskId,
    binding: x.binding,
    at: now().toISOString(),
    result,
    itemIndex: index,
    ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra.lateReason !== undefined ? { lateReason: extra.lateReason } : {}),
  });

  for (const item of x.items) {
    const before = await worktreeIdentity(port, x.worktree, x.excluded);
    if ("notReady" in before) {
      evidence.push(make(item.index, "fail", { reason: "evidence_not_ready: unmerged index entries" }));
      continue;
    }
    if (!sameIdentity(before, x.binding.worktree)) {
      evidence.push(make(item.index, "fail", { reason: "the worktree does not match the binding" }));
      continue;
    }
    const r = await port.spawn("/bin/sh", ["-c", item.command], { cwd: x.worktree, env: { ...process.env }, maxBuffer: x.maxBuffer, timeoutMs: x.timeoutMs, ...(x.signal ? { signal: x.signal } : {}) }).result;
    const after = await worktreeIdentity(port, x.worktree, x.excluded);
    const exitCode = r.exitCode ?? undefined;
    const clean = r.error === undefined && !r.truncated && r.exitCode === 0;
    const reason = r.error ?? (r.truncated ? "output truncated" : r.exitCode !== 0 ? `exit ${r.exitCode ?? "none"}` : undefined);
    if ("notReady" in after || !sameIdentity(after, x.binding.worktree)) {
      // The worktree changed while the command ran: the result is late and never a pass.
      late.push(make(item.index, clean ? "pass" : "fail", { ...(exitCode !== undefined ? { exitCode } : {}), lateReason: "worktree_drift" }));
      evidence.push(make(item.index, "fail", { ...(exitCode !== undefined ? { exitCode } : {}), reason: "worktree_drift" }));
      continue;
    }
    evidence.push(make(item.index, clean ? "pass" : "fail", { ...(exitCode !== undefined ? { exitCode } : {}), ...(reason !== undefined ? { reason } : {}) }));
  }
  const result = late.length === 0 && evidence.every((e) => e.result === "pass") ? "pass" : "fail";
  return { evidence, late, result };
}
