// Bounded runs of a task-owned helper (the sandbox's own tool), with no other side effects so it can
// be checked with stand-in scripts (e2e/guards.test.mjs).
//
// - The helper runs in its own process group (detached), so it and anything it spawns can be
//   signalled together, and nothing else is.
// - A timeout or killRunningNow() SIGKILLs exactly that group.
// - The run settles on the helper's exit plus a short grace for its output, not on its pipes
//   closing: a grandchild still holding stdout or stderr cannot keep it waiting. Whatever of the
//   group outlives the helper is killed and reported as lingering.
import { spawn } from "node:child_process";

const running = new Set();

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * Runs `cmd args` and resolves (never rejects) with { status, error, text, lingering, ms } within
 * timeoutMs + graceMs. `status` is null when the run did not end by itself.
 */
export function runBounded(cmd, args, { timeoutMs = 240_000, graceMs = 500, env } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...(env ? { env } : {}) });
    } catch (e) {
      resolve({ status: null, error: e instanceof Error ? e.message : String(e), text: "", lingering: false, ms: Date.now() - t0 });
      return;
    }
    let text = "";
    let error = null;
    let status = null;
    let settled = false;
    let graceTimer = null;
    const entry = { pid: child.pid, kill: () => killGroup(child.pid) };
    running.add(entry);
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      // Anything of the group still alive (a grandchild holding the pipes, say) is the helper's own.
      const lingering = child.pid !== undefined && groupAlive(child.pid);
      if (lingering) killGroup(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      running.delete(entry);
      resolve({ status: error ? null : status, error, text, lingering, pid: child.pid, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => {
      error = `no result within ${timeoutMs} ms`;
      killGroup(child.pid);
      graceTimer = setTimeout(settle, graceMs);
    }, timeoutMs);
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    child.once("error", (e) => {
      error = e.message;
      settle();
    });
    child.once("exit", (code, signal) => {
      status = code ?? null;
      if (code === null && !error) error = `ended by ${signal}`;
      // Give the output a moment to drain, then settle whether or not the pipes have closed.
      if (!graceTimer) graceTimer = setTimeout(settle, graceMs);
    });
    child.once("close", settle);
  });
}

/** Synchronous: SIGKILLs the process group of every helper still running (abort, signal, exit). */
export function killRunningNow() {
  for (const entry of running) entry.kill();
}

/** How many helper runs have not settled yet. */
export function runningCount() {
  return running.size;
}
