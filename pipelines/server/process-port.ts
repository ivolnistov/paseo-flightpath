import type { ChildProcess } from "node:child_process";
import { Writable } from "node:stream";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ProcessRecord } from "../shared/run";
import { RELEASE_TOKEN, SHIM_SOURCE, shimArgs } from "./check-shim";
import type { ResolvedCommand } from "./commands";

export type { ProcessRecord };

/** `groupExited` is false when a member of the group was still seen after the final kill. */
export type GatedResult = { ran: boolean; exitCode: number | null; output: string; timedOut: boolean; cancelled: boolean; groupExited: boolean };

/**
 * `alive`: the recorded leader runs with its recorded start time. `gone`: the pid is free and no
 * member of the group exists, or the pid now belongs to another process (a pid is never reused
 * while its group exists). `unknown`: anything that cannot be proved, such as a group whose
 * leader exited while members remain, or a failed reading.
 */
export type ProcessState = "alive" | "gone" | "unknown";

/** A shim started in its own process group and blocked until `release`. */
export type GatedProcess = {
  record: ProcessRecord;
  /** Lets the shim run its command; the timeout starts now. */
  release(timeoutMs: number): void;
  /** Closes the gate without a release and observes the shim's exit. */
  abort(): Promise<{ exited: boolean }>;
  /** Stops the group: a polite signal, then a kill after the grace period. Resolves on an observed exit or with `exited: false`. */
  cancel(): Promise<{ exited: boolean }>;
  done: Promise<GatedResult>;
};

export type ExecResult = { code: number | null; stdout: string; stderr: string };

export interface ProcessPort {
  spawnGated(command: ResolvedCommand, opts: { cwd: string; maxBytes: number; env?: Record<string, string> }): Promise<GatedProcess>;
  /** The OS start time of a live pid, or null when no such process exists; throws when it cannot be read. */
  startTime(pid: number): Promise<string | null>;
  processState(record: ProcessRecord): Promise<ProcessState>;
  /** False only when the record is proved gone; an unknown record counts as alive. */
  processAlive(record: ProcessRecord): Promise<boolean>;
  /**
   * Terminates a recorded group whose leader identity is proved and observes its exit. A gone
   * record is never signalled and counts as exited; an unknown one is never signalled and
   * reports `exited: false`.
   */
  terminateRecorded(record: ProcessRecord): Promise<{ exited: boolean }>;
  /** Runs a plumbing command without a shell. */
  exec(file: string, args: string[], opts: { cwd: string; env?: Record<string, string | undefined>; maxBytes?: number; input?: string }): Promise<ExecResult>;
}

export type ProcessPortOptions = {
  /** Time between the polite signal and the kill. */
  graceMs?: number;
  /** How long an exit is awaited after the kill. */
  exitWaitMs?: number;
  pollMs?: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

/** Whether any process of the group exists. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group may already be gone.
  }
}

async function waitFor(check: () => boolean, ms: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return check();
    await sleep(pollMs);
  }
}

function collect(child: ChildProcess, maxBytes: number): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  const push = (chunk: Buffer): void => {
    chunks.push(chunk);
    size += chunk.length;
    while (size > maxBytes && chunks.length > 0) {
      const first = chunks[0];
      if (!first) break;
      const excess = size - maxBytes;
      if (first.length <= excess) {
        chunks.shift();
        size -= first.length;
      } else {
        chunks[0] = first.subarray(excess);
        size -= excess;
      }
    }
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  return () => Buffer.concat(chunks).toString("utf8");
}

export function createProcessPort(options: ProcessPortOptions = {}): ProcessPort {
  const graceMs = options.graceMs ?? 2_000;
  const exitWaitMs = options.exitWaitMs ?? 5_000;
  const pollMs = options.pollMs ?? 25;

  const exec: ProcessPort["exec"] = (file, args, opts) =>
    new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const [key, value] of Object.entries(opts.env ?? {})) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      const child = spawnProcess(file, args, { cwd: opts.cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      const limit = opts.maxBytes ?? 64 * 1024 * 1024;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let overflow = false;
      const take = (target: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        target.push(chunk);
      };
      child.stdout?.on("data", take(out));
      child.stderr?.on("data", take(err));
      child.on("error", reject);
      child.on("close", (code) => {
        if (overflow) reject(new Error(`${file} produced more than ${limit} bytes.`));
        else resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
      child.stdin?.end(opts.input ?? "");
    });

  async function startTime(pid: number): Promise<string | null> {
    const result = await exec("ps", ["-o", "lstart=", "-p", String(pid)], { cwd: "/", env: { LC_ALL: "C", TZ: "UTC0" } });
    const value = result.stdout.trim();
    if (result.code === 0 && value !== "") return value;
    if (result.code === 1 && value === "") return null;
    throw new Error(`ps failed with ${String(result.code)}: ${result.stderr.trim()}`);
  }

  async function processState(record: ProcessRecord): Promise<ProcessState> {
    let started: string | null;
    try {
      started = await startTime(record.pid);
    } catch {
      return "unknown";
    }
    if (started === record.startedAt) return "alive";
    if (started !== null) return "gone";
    return groupAlive(record.pgid) ? "unknown" : "gone";
  }

  async function processAlive(record: ProcessRecord): Promise<boolean> {
    return (await processState(record)) !== "gone";
  }

  async function stopGroup(pgid: number): Promise<boolean> {
    if (!groupAlive(pgid)) return true;
    signalGroup(pgid, "SIGTERM");
    if (await waitFor(() => !groupAlive(pgid), graceMs, pollMs)) return true;
    signalGroup(pgid, "SIGKILL");
    return waitFor(() => !groupAlive(pgid), exitWaitMs, pollMs);
  }

  return {
    exec,
    processAlive,
    processState,
    startTime,

    async terminateRecorded(record) {
      const state = await processState(record);
      if (state === "gone") return { exited: true };
      if (state === "unknown") return { exited: false };
      return { exited: await stopGroup(record.pgid) };
    },

    async spawnGated(command, opts) {
      const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
      delete env.NODE_OPTIONS;
      const child = spawnProcess(process.execPath, ["-e", SHIM_SOURCE, "--", ...shimArgs(command)], {
        cwd: opts.cwd,
        env,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      const gate = child.stdio[3];
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      let exitedNow = false;
      void exited.then(() => {
        exitedNow = true;
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      const pid = child.pid;
      if (pid === undefined || !(gate instanceof Writable)) {
        await terminateProcess(child, "SIGKILL").catch(() => undefined);
        throw new Error("The check launcher did not start.");
      }
      gate.on("error", () => undefined);
      const startedAt = await startTime(pid).catch(() => null);
      if (startedAt === null) {
        gate.destroy();
        signalGroup(pid, "SIGKILL");
        throw new Error("The check launcher's start time could not be read.");
      }
      const output = collect(child, opts.maxBytes);
      let released = false;
      let cancelled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let stopping: Promise<boolean> | null = null;

      const waitExit = async (ms: number): Promise<boolean> => {
        await Promise.race([exited, sleep(ms)]);
        return exitedNow;
      };
      const stop = (): Promise<boolean> => {
        stopping ??= (async () => {
          const groupGone = await stopGroup(pid);
          return groupGone && (await waitExit(exitWaitMs));
        })();
        return stopping;
      };
      const abort = async (): Promise<{ exited: boolean }> => {
        if (released) return { exited: await stop() };
        gate.destroy();
        if (await waitExit(exitWaitMs)) return { exited: true };
        signalGroup(pid, "SIGKILL");
        return { exited: await waitExit(exitWaitMs) };
      };

      const done = exited.then(async ({ code, signal }) => {
        if (timer) clearTimeout(timer);
        // Leftover members of the group would still use the worktree.
        let groupExited = !groupAlive(pid);
        if (!groupExited) {
          signalGroup(pid, "SIGKILL");
          groupExited = await waitFor(() => !groupAlive(pid), exitWaitMs, pollMs);
        }
        const exitCode = code ?? (signal === null ? null : 128);
        return {
          ran: released,
          exitCode,
          output: output(),
          timedOut,
          cancelled,
          groupExited,
        };
      });

      return {
        record: { pid, pgid: pid, startedAt },
        release(timeoutMs) {
          if (released || exitedNow) return;
          released = true;
          gate.end(RELEASE_TOKEN);
          timer = setTimeout(() => {
            timedOut = true;
            void stop();
          }, timeoutMs);
        },
        abort,
        async cancel() {
          cancelled = true;
          if (exitedNow && !groupAlive(pid)) return { exited: true };
          return abort();
        },
        done,
      };
    },
  };
}
