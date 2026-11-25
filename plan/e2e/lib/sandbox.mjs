// The isolated offline Paseo sandbox the E2E runs against (default /Users/example/WORK/dr-ui-test-0153,
// override E2E_SANDBOX). The harness never starts, stops, refreshes or reconfigures it: it only runs
// its read-only checks (`check`, `probe --read`) through the sandbox's own tool and reads app.json.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { insideDir, parseSafety, sdkCapabilities } from "./guards.mjs";
import { killRunningNow, runBounded } from "./proc.mjs";

export const SANDBOX = realpathSync.native(process.env.E2E_SANDBOX ?? "/Users/example/WORK/dr-ui-test-0153");
export const app = JSON.parse(readFileSync(path.join(SANDBOX, "app.json"), "utf8"));
export const PASEO_HOME = path.join(SANDBOX, "runtime", "paseo-home");
/** The exclusive E2E run lock of this sandbox's store (lib/lock.mjs). */
export const RUN_LOCK = path.join(SANDBOX, "runtime", "e2e-run.lock");
export const PROJECT = realpathSync.native(path.join(SANDBOX, "workspace", "synthetic-project"));
export const baseUrl = `http://127.0.0.1:${app.port}/`;
// Containment by real path, not by name: a symlinked runtime, home or project that leads out of
// the sandbox (to real Paseo data, say) stops the harness at import, before anything runs.
for (const [what, p] of [
  ["runtime", path.join(SANDBOX, "runtime")],
  ["PASEO_HOME", PASEO_HOME],
  ["the synthetic project", PROJECT],
]) {
  const real = realpathSync.native(p);
  if (!insideDir(real, SANDBOX)) throw new Error(`${what} resolves to ${real}, outside the sandbox ${SANDBOX}; refusing`);
}

/** What the sandbox's installed Paseo offers plugins (guards.sdkCapabilities over its plugin SDK), and its version. */
export function hostCapabilities() {
  const sdk = path.join(path.dirname(path.dirname(app.paseoCli)), "node_modules", "@getpaseo", "plugin");
  const read = (rel) => {
    try {
      return readFileSync(path.join(sdk, rel), "utf8");
    } catch {
      return "";
    }
  };
  let version = null;
  try {
    version = JSON.parse(read("package.json")).version ?? null;
  } catch {
    version = null;
  }
  return { version, ...sdkCapabilities(read(path.join("dist", "index.js")), read(path.join("dist", "client", "index.js"))) };
}

/** The sandbox's own environment for its tools (its PASEO_HOME, its PATH). */
export async function sandboxEnv() {
  const lib = await import(pathToFileURL(path.join(SANDBOX, "tools", "lib.mjs")).href);
  return lib.sandboxEnv();
}

// The sandbox tool runs bounded in its own process group (lib/proc.mjs): the run's watchdog and
// signal handlers stay live, a timeout or abort kills exactly that group (the tool and anything it
// started), and a grandchild holding the pipes cannot keep the run waiting.
function tool(args, timeoutMs = 240_000) {
  return runBounded(path.join(SANDBOX, "bin", "paseo-fd-test"), args, { timeoutMs });
}

/** Synchronous: kills the process group of every sandbox tool this process started that still runs. */
export function killToolsNow() {
  killRunningNow();
}

/**
 * The sandbox's runtime safety check and read-only probe, judged by guards.parseSafety: passed only
 * when the runtime check passed, exactly 0 agents (or, for a run that names the sandbox's inert
 * fixture, at most `inertMax` agents all on `inertProvider`), exactly 0 outbound sockets, and the
 * plugin answering is proven to run `rev`.
 */
export async function safety(rev, { inertProvider = null, inertMax = 0 } = {}) {
  const check = await tool(["check"]);
  const probe = await tool(["probe", "--read"]);
  const result = parseSafety({ checkText: check.text, checkStatus: check.status, probeText: probe.text, probeStatus: probe.status, stagedRev: app.source?.rev ?? null, rev, inertProvider, inertMax });
  // Why a check failed stays in the evidence: the tool's own errors and exit statuses.
  result.tools = { check: { status: check.status, error: check.error, lingering: check.lingering, ms: check.ms }, probe: { status: probe.status, error: probe.error, lingering: probe.lingering, ms: probe.ms } };
  return result;
}
