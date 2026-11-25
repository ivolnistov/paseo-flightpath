import type { CheckMode, Evidence, ProcessRecord, WorktreeIdentity } from "../shared/run";
import type { ResolvedCommand } from "./commands";
import type { GatedProcess, ProcessPort } from "./process-port";
import { sameIdentity } from "./run-engine";
import { worktreeIdentity } from "./worktree-identity";

export const OUTPUT_TAIL_CHARS = 4_000;

export type RunChecksInput = {
  canonicalDir: string;
  attemptId: string;
  cycleId: string;
  /** The identity the cycle captured. */
  identity: WorktreeIdentity;
  mode: CheckMode;
  /** The scratch copy an isolated batch runs in. */
  copyDir?: string;
  commands: ResolvedCommand[];
  timeoutMs: number;
  maxBytes: number;
  /** Durably records a launch; called after the spawn and before the release. */
  record(launch: { index: number; process: ProcessRecord }): Promise<void>;
  now?: () => Date;
};

export type CheckBatch = {
  /** Evidence of every command that finished; a cancelled batch resolves with what it had. */
  done: Promise<Evidence[]>;
  /** Stops the batch between or during commands; resolves on an observed exit or `exited: false`. */
  cancel(): Promise<{ exited: boolean }>;
};

/** A command's process group was still seen after the final kill; its evidence is not published. */
export class ChecksUnconfirmedError extends Error {
  constructor(readonly records: ProcessRecord[]) {
    super("A check's process group exit was not observed.");
    this.name = "ChecksUnconfirmedError";
  }
}

/**
 * Final evidence of a drained isolated group: unchanged when the canonical identity still equals
 * the group identity, otherwise every result is `late` with the observed identity.
 */
export function settleIsolatedGroup(evidence: readonly Evidence[], groupIdentity: WorktreeIdentity, canonical: WorktreeIdentity): Evidence[] {
  if (sameIdentity(canonical, groupIdentity)) return evidence.map((item) => ({ ...item }));
  return evidence.map((item) => ({ ...item, result: "late" as const, identity: canonical }));
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL_CHARS ? text : text.slice(text.length - OUTPUT_TAIL_CHARS);
}

/**
 * Runs a cycle's commands one after another. Exclusive commands run in the canonical worktree and
 * are bracketed by identity readings that must equal the cycle identity. Isolated commands run in
 * the scratch copy; their results are provisional until the whole group of overlapping isolated
 * batches drains and `settleIsolatedGroup` compares one fresh canonical reading.
 */
export function runChecks(port: ProcessPort, x: RunChecksInput): CheckBatch {
  const now = x.now ?? (() => new Date());
  let cancelled = false;
  let current: GatedProcess | null = null;
  let cancelling: Promise<{ exited: boolean }> | null = null;
  let stoppedAll = true;
  if (x.mode === "isolated" && x.copyDir === undefined) throw new Error("An isolated batch needs a scratch copy.");
  const cwd = x.mode === "isolated" && x.copyDir !== undefined ? x.copyDir : x.canonicalDir;

  const evidence = (index: number, result: Evidence["result"], identity: WorktreeIdentity, exitCode: number | null, outputTail: string | null): Evidence => ({
    id: `${x.cycleId}:check:${index}`,
    attemptId: x.attemptId,
    cycleId: x.cycleId,
    kind: "check",
    item: index,
    result,
    mode: x.mode,
    exitCode,
    outputTail,
    identity,
    at: now().toISOString(),
  });

  const run = async (): Promise<Evidence[]> => {
    const out: Evidence[] = [];
    let reading: WorktreeIdentity | null = x.mode === "exclusive" ? await worktreeIdentity(port, x.canonicalDir) : x.identity;
    for (const [index, command] of x.commands.entries()) {
      if (cancelled) return out;
      if (x.mode === "exclusive" && !sameIdentity(reading, x.identity)) {
        out.push(evidence(index, "late", reading ?? x.identity, null, "The worktree changed before the command ran."));
        return out;
      }
      const gated = await port.spawnGated(command, { cwd, maxBytes: x.maxBytes });
      current = gated;
      try {
        await x.record({ index, process: gated.record });
      } catch (error) {
        await gated.abort();
        throw error;
      }
      if (cancelled) {
        if (!(await gated.abort()).exited) stoppedAll = false;
        return out;
      }
      gated.release(x.timeoutMs);
      const result = await gated.done;
      current = null;
      if (!result.groupExited) {
        if (cancelled) stoppedAll = false;
        throw new ChecksUnconfirmedError([gated.record]);
      }
      if (cancelled) return out;
      const text = result.timedOut ? `[timed out after ${x.timeoutMs} ms]\n${tail(result.output)}` : tail(result.output);
      if (x.mode === "exclusive") {
        reading = await worktreeIdentity(port, x.canonicalDir);
        const drift = !sameIdentity(reading, x.identity);
        out.push(evidence(index, drift ? "late" : result.exitCode === 0 && !result.timedOut ? "pass" : "fail", reading, result.exitCode, tail(text)));
        if (drift) return out;
      } else {
        out.push(evidence(index, result.exitCode === 0 && !result.timedOut ? "pass" : "fail", x.identity, result.exitCode, tail(text)));
      }
    }
    return out;
  };

  const done = run();
  return {
    done,
    cancel() {
      cancelling ??= (async () => {
        cancelled = true;
        const active: GatedProcess | null = current;
        if (active && !(await active.cancel()).exited) stoppedAll = false;
        await done.catch(() => undefined);
        return { exited: stoppedAll };
      })();
      return cancelling;
    },
  };
}
