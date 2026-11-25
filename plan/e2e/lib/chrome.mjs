// Starts and stops the harness's own browser (guards.chromeLaunchPlan): the Chrome for Testing
// headless shell (guards.HEADLESS_SHELL, or E2E_CHROME naming another headless shell; never branded
// Chrome; the run fails closed when it is missing), a fresh profile, a HOME the run owns, a mocked
// keychain, DevTools on 127.0.0.1 only, and a proxy that sends every connection except to the
// sandbox origin into the harness's own sink, which drops and counts it. The browser runs in its
// own process group; only that group is ever signalled.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { sleep } from "./cdp.mjs";
import { checkBrowserPath, chromeLaunchPlan, endpointMatches, HEADLESS_SHELL, HEADLESS_SHELL_MANIFEST, manifestProblems, parseDevToolsActivePort, parseDevToolsListening } from "./guards.mjs";
import { createDropLedger, handleSinkSocket } from "./sink.mjs";

function readOrNull(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

/** What a browser directory holds, for guards.manifestProblems: entries by type, regular files hashed. */
export function browserTree(dir) {
  // A null-prototype map: an entry named "__proto__" (or "constructor") is an own key like any other.
  const out = Object.create(null);
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path.join(dir, r));
      if (st.isSymbolicLink()) out[r] = { type: "symlink" };
      else if (st.isDirectory()) walk(r);
      else if (st.isFile()) out[r] = { type: "file", size: st.size, sha256: sha256File(path.join(dir, r)) };
      else out[r] = { type: "other" };
    }
  };
  walk("");
  return out;
}

function sha256File(file) {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * The configured headless shell, or a thrown refusal (never a fallback to another browser): the
 * path must be a chrome-headless-shell, and its whole directory must match the pinned manifest
 * (guards.HEADLESS_SHELL_MANIFEST), wherever it lives, so a renamed or modified executable is
 * refused. `manifest` is injectable for the checks only.
 */
export function browserBinary({ manifest = HEADLESS_SHELL_MANIFEST } = {}) {
  const binary = checkBrowserPath(process.env.E2E_CHROME ?? HEADLESS_SHELL);
  let problems;
  try {
    if (!lstatSync(binary).isFile()) throw new Error("not a regular file");
    accessSync(binary, constants.X_OK);
    problems = manifestProblems(manifest, browserTree(path.dirname(binary)));
  } catch (e) {
    throw new Error(`the headless shell ${binary} is unavailable (${e instanceof Error ? e.message : String(e)}); not falling back to another browser`);
  }
  if (problems.length > 0) throw new Error(`the headless shell at ${binary} is not the pinned build: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`);
  return binary;
}

async function listening(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** A loopback listener that accepts and immediately drops every connection, counting them. */
async function startSink() {
  // Every accepted connection is recorded exactly once in the ledger (lib/sink.mjs).
  const ledger = createDropLedger();
  const sink = {
    ledger,
    server: net.createServer((socket) => handleSinkSocket(socket, ledger)),
    port: 0,
    get attempts() {
      return ledger.attempts;
    },
  };
  await new Promise((resolve, reject) => {
    sink.server.once("error", reject);
    sink.server.listen(0, "127.0.0.1", resolve);
  });
  sink.port = sink.server.address().port;
  return sink;
}

/** Whether any process of the browser's own group is left. */
export function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {
    // already gone
  }
}

/** Spawns the browser; resolves once the OS started it, rejects on a spawn error (never an uncaught event). */
export function spawnBrowser(binary, args, options) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, options);
    } catch (e) {
      reject(e);
      return;
    }
    child.once("error", (e) => reject(new Error(`the browser could not be started: ${e.message}`)));
    child.once("spawn", () => resolve(child));
  });
}

export async function startChrome({ dir, allowedPort, onSpawn }) {
  const binary = browserBinary();
  const sink = await startSink();
  let plan;
  try {
    // The user's home from the account database, not from the environment.
    plan = chromeLaunchPlan({ binary, dir: path.resolve(dir), sinkPort: sink.port, userHome: os.userInfo().homedir, allowed: { host: "127.0.0.1", port: allowedPort }, lang: process.env.LANG || "en_US.UTF-8" });
    // The profile must be new: an existing one (another run's, or a rerun's) is refused.
    for (const d of plan.dirs) mkdirSync(d, { recursive: false });
  } catch (e) {
    sink.server.close();
    throw e;
  }
  let out;
  try {
    out = openSync(path.join(dir, "chrome.log"), "wx"); // new: never another run's log
  } catch (e) {
    sink.server.close();
    throw e;
  }
  let child;
  try {
    // detached: its own process group (helpers included), so cleanup can signal exactly that group.
    child = await spawnBrowser(plan.binary, plan.args, { stdio: ["ignore", out, out], detached: true, env: plan.env });
  } catch (e) {
    sink.server.close();
    throw e;
  }
  const chrome = { pid: child.pid, port: null, endpoint: null, sink, home: plan.home, profile: plan.profile, binary: plan.binary, browser: null };
  child.once("error", () => {}); // later errors (e.g. a failed signal) are seen through groupAlive
  // Registered the moment it exists: an interrupt, deadline or exit during the rest of startup
  // still reaches it (killAllBrowsersNow), and the caller can record it at once (onSpawn).
  await superviseStartup(chrome, async () => {
    onSpawn?.(chrome);
    await adoptEndpoint(chrome, { profile: plan.profile, log: path.join(dir, "chrome.log") });
  });
  return chrome;
}

/**
 * Registers a just-spawned browser (so killAllBrowsersNow and the exit hook reach it from now on)
 * and runs the rest of its startup; any failure kills its group before rethrowing.
 */
export async function superviseStartup(chrome, startup) {
  register(chrome);
  try {
    await startup();
  } catch (e) {
    killChromeNow(chrome);
    throw e;
  }
  return chrome;
}

/**
 * Finds and adopts the endpoint this browser wrote into its own new profile (or logged once into
 * its own new log): /json/version on that port must answer with exactly that browser's socket URL;
 * then its initial tab is closed. Throws on anything else; the caller kills the group. `io` is
 * injectable for the checks only.
 */
export async function adoptEndpoint(chrome, { profile, log }, io = { readOrNull, listening, fetchJson, alive: groupAlive, sleep, tries: 80 }) {
  for (let i = 0; i < io.tries; i++) {
    const active = parseDevToolsActivePort(io.readOrNull(path.join(profile, "DevToolsActivePort"))) ?? parseDevToolsListening(io.readOrNull(log));
    if (active) {
      const v = await io.listening(active.port);
      if (v && !endpointMatches(v, active)) throw new Error(`port ${active.port} answers for another browser; refusing it`);
      if (v) {
        chrome.port = active.port;
        chrome.endpoint = active.url;
        // Close the initial blank tab so only the harness's own pages run (a background tab stalls frames).
        const tabs = await io.fetchJson(`http://127.0.0.1:${active.port}/json/list`);
        if (!Array.isArray(tabs)) throw new Error("/json/list did not answer with a list");
        for (const t of tabs) if (t?.type === "page") await io.fetchJson(`http://127.0.0.1:${active.port}/json/close/${encodeURIComponent(t.id)}`, { text: true });
        chrome.browser = v.Browser;
        return chrome;
      }
    }
    if (!io.alive(chrome.pid)) break;
    await io.sleep(250);
  }
  throw new Error("the headless shell did not start (no DevTools endpoint of its own)");
}

/** A bounded GET on the run's own DevTools port; a non-2xx answer or a timeout throws. */
async function fetchJson(url, { text = false } = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return text ? r.text() : r.json();
}

// Every browser this process started and has not yet seen gone.
const live = new Set();
let exitHookInstalled = false;
function register(chrome) {
  live.add(chrome);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Any exit of this process (normal, process.exit, uncaught error) kills what is still alive.
    process.once("exit", () => killAllBrowsersNow());
  }
}

/** Synchronous: SIGKILL every browser group this process started that is still alive. */
export function killAllBrowsersNow() {
  for (const chrome of [...live]) killChromeNow(chrome);
}

/** How many browsers this process started that are not known to be gone. */
export function liveBrowsers() {
  return [...live].filter((c) => groupAlive(c.pid)).length;
}

/** Synchronous last resort (halt, watchdog, signal, exit): SIGKILL of the browser's own group, sink closed. */
export function killChromeNow(chrome) {
  if (!chrome) return;
  if (groupAlive(chrome.pid)) signalGroup(chrome.pid, "SIGKILL");
  if (chrome.sink?.server.listening) chrome.sink.server.close();
  if (!groupAlive(chrome.pid)) live.delete(chrome);
}

export async function stopChrome(chrome) {
  const v = chrome.port ? await listening(chrome.port) : null;
  // Browser.close only to this run's own browser (its unique socket URL); otherwise signals only.
  if (v && v.webSocketDebuggerUrl === chrome.endpoint) {
    const ws = new WebSocket(chrome.endpoint);
    await Promise.race([
      new Promise((resolve) => {
        ws.onopen = resolve;
        ws.onerror = resolve;
      }),
      sleep(3_000),
    ]);
    try {
      ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    } catch {
      // already closing
    }
  }
  for (let i = 0; i < 20 && groupAlive(chrome.pid); i++) await sleep(250);
  if (groupAlive(chrome.pid)) signalGroup(chrome.pid, "SIGTERM");
  for (let i = 0; i < 60 && groupAlive(chrome.pid); i++) await sleep(250);
  if (groupAlive(chrome.pid)) signalGroup(chrome.pid, "SIGKILL");
  for (let i = 0; i < 20 && groupAlive(chrome.pid); i++) await sleep(250);
  if (chrome.sink.server.listening) chrome.sink.server.close();
  // Let connections already accepted record their line, then count any still open as such.
  for (let i = 0; i < 8 && chrome.sink.ledger.pending > 0; i++) await sleep(250);
  chrome.sink.ledger.finalize();
  const drops = { attempts: chrome.sink.ledger.attempts, targets: chrome.sink.ledger.summary(), pending: chrome.sink.ledger.pending };
  if (!groupAlive(chrome.pid)) live.delete(chrome);
  return { pid: chrome.pid, endpoint: chrome.endpoint, stopped: !groupAlive(chrome.pid), portFree: chrome.port ? !(await listening(chrome.port)) : true, drops, proxiedAttemptsDropped: drops.attempts, proxiedTargets: drops.targets, home: chrome.home };
}
