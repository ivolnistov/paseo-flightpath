// The process port (Stage R3.3): bounded child processes with byte-exact output, for git plumbing,
// DoD checks and the review command. `execCommand` is not used for bytes: its output is a string.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";

export type ProcessResult = { exitCode: number | null; signal: string | null; stdout: Buffer; stderr: Buffer; truncated: boolean; error?: string };
export interface RunningProcess {
  write(b: string | Buffer): void;
  end(): void;
  terminate(): Promise<void>;
  /**
   * Settles exactly once: on `close`, on `error` (for example ENOENT), or fail-closed at most
   * `TERMINATE_GRACE_MS` after a termination when `close` never comes (a descendant holds the pipes).
   */
  result: Promise<ProcessResult>;
}
export type SpawnOptions = { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; timeoutMs: number; signal?: AbortSignal };
export interface ProcessPort {
  spawn(command: string, args: string[], opts: SpawnOptions): RunningProcess;
}

/** After a termination, the longest wait for `close` before the result settles fail-closed. */
export const TERMINATE_GRACE_MS = 1500;

/** The installed spawnProcess/terminateProcess with Buffer collection, a byte limit, a timeout and abort. */
export function nodeProcessPort(): ProcessPort {
  return {
    spawn(command, args, opts) {
      const child: ChildProcessWithoutNullStreams = spawnProcess(command, args, { cwd: opts.cwd, env: opts.env, stdio: "pipe" });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let stopped: "timeout" | "aborted" | undefined;
      let terminating: Promise<void> | undefined;
      let settle!: (r: ProcessResult) => void;
      let settled = false;
      const result = new Promise<ProcessResult>((resolve) => (settle = resolve));

      let grace: ReturnType<typeof setTimeout> | undefined;
      const terminate = () => {
        if (terminating) return terminating;
        // A terminated child whose descendants keep the pipes open never emits `close`: settle
        // fail-closed after a bounded grace instead of waiting forever.
        grace = setTimeout(() => finish({ exitCode: null, signal: null, error: stopped ?? "terminated" }), TERMINATE_GRACE_MS);
        return (terminating = terminateProcess(child).catch(() => undefined));
      };
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        if (truncated) return;
        const room = opts.maxBuffer - size;
        if (chunk.length > room) {
          if (room > 0) into.push(chunk.subarray(0, room));
          size = opts.maxBuffer;
          truncated = true;
          void terminate();
          return;
        }
        into.push(chunk);
        size += chunk.length;
      };
      const timer = setTimeout(() => {
        stopped ??= "timeout";
        void terminate();
      }, opts.timeoutMs);
      const onAbort = () => {
        stopped ??= "aborted";
        void terminate();
      };
      const finish = (r: Omit<ProcessResult, "stdout" | "stderr" | "truncated">) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace !== undefined) clearTimeout(grace);
        opts.signal?.removeEventListener("abort", onAbort);
        child.stdout.removeAllListeners("data");
        child.stderr.removeAllListeners("data");
        // A timed-out or aborted child never reports a clean exit.
        const forced = stopped !== undefined ? { exitCode: null, error: r.error ?? stopped } : {};
        settle({ ...r, ...forced, stdout: Buffer.concat(out), stderr: Buffer.concat(err), truncated });
      };

      child.stdout.on("data", collect(out));
      child.stderr.on("data", collect(err));
      child.stdin.on("error", () => undefined);
      child.once("error", (e: Error) => finish({ exitCode: null, signal: null, error: e.message }));
      child.once("close", (code: number | null, signal: string | null) => finish({ exitCode: code, signal }));
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });

      return {
        write: (b) => void child.stdin.write(b),
        end: () => void child.stdin.end(),
        terminate,
        result,
      };
    },
  };
}

/** `git <args>` in `cwd`: stdout bytes on exit 0; otherwise throws. Read-only plumbing only. */
export async function gitBytes(port: ProcessPort, cwd: string, args: string[]): Promise<Buffer> {
  const r = await port.spawn("git", args, { cwd, env: { ...process.env }, maxBuffer: 256 * 1024 * 1024, timeoutMs: 120_000 }).result;
  if (r.error !== undefined || r.exitCode !== 0 || r.truncated) {
    throw new Error(`git ${args[0] ?? ""} failed${r.error !== undefined ? `: ${r.error}` : r.exitCode !== null ? ` with exit ${r.exitCode}` : ""}`);
  }
  return r.stdout;
}
