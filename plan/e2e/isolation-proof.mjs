#!/usr/bin/env node
// Isolation proof for the harness's browser, with task-owned listeners only and no sandbox:
// one allowed HTTP server on an ephemeral 127.0.0.1 port (the only origin the launch plan lets
// through) and one canary server on a different ephemeral 127.0.0.1 port that counts every
// connection. The pinned headless shell (lib/chrome.mjs: manifest-verified, task-owned HOME and
// profile, mocked keychain, proxy to the drop sink) must load the allowed page, while every
// attempt at the canary (fetch to 127.0.0.1 and to localhost, a WebSocket, a top-level navigation)
// must reach the sink and never the canary. The browser's process group must be gone afterwards.
// No external, link-local or other address is contacted. Bounded by a hard deadline.
//   node e2e/isolation-proof.mjs [--out <new dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Page, sleep } from "./lib/cdp.mjs";
import { groupAlive, killAllBrowsersNow, startChrome, stopChrome } from "./lib/chrome.mjs";
import { newRunId, withTimeout } from "./lib/guards.mjs";
import { unexpectedDrops } from "./lib/sink.mjs";

const DEADLINE_MS = 90_000;
const outArg = process.argv.indexOf("--out");
const out = path.resolve(outArg > 0 ? process.argv[outArg + 1] : `/tmp/dr-e2e-iso-${newRunId()}`);
mkdirSync(path.dirname(out), { recursive: true });
mkdirSync(out, { recursive: false, mode: 0o700 });
const report = { startedAt: new Date().toISOString(), out, ok: false, checks: {} };
const save = () => writeFileSync(path.join(out, "isolation.json"), JSON.stringify(report, null, 1));

function listen(handler) {
  const server = http.createServer(handler);
  const stats = { connections: 0, requests: [] };
  server.on("connection", () => stats.connections++);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, stats, port: server.address().port }));
  });
}

let chrome = null;
// Interrupts and any exit kill every browser this process started (also one still starting).
const interrupted = (sig) => {
  report.error = `interrupted by ${sig}`;
  killAllBrowsersNow();
  save();
  console.error(`[iso] ${report.error}; browser group killed`);
  process.exit(1);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => interrupted(sig));
process.once("exit", () => killAllBrowsersNow());
const watchdog = setTimeout(() => {
  report.error = `deadline ${DEADLINE_MS} ms exceeded`;
  killAllBrowsersNow();
  save();
  console.error(`[iso] ${report.error}; browser group killed`);
  process.exit(1);
}, DEADLINE_MS);

const canary = await listen((req, res) => {
  canary.stats.requests.push(req.url);
  res.end("canary");
});
const allowed = await listen((req, res) => {
  allowed.stats.requests.push(req.url);
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>e2e-allowed</title><p>allowed</p><script>
window.__probe = async () => {
  const r = {};
  const attempt = async (name, url) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try { const res = await fetch(url, { signal: ctl.signal, cache: "no-store", mode: "no-cors" }); r[name] = "reached " + res.type; }
    catch (e) { r[name] = "failed " + e.name; }
    finally { clearTimeout(t); }
  };
  await attempt("fetchAllowedLocalhost", "http://localhost:${allowed.port}/via-localhost");
  await attempt("fetchCanary127", "http://127.0.0.1:${canary.port}/fetch-127");
  await attempt("fetchCanaryLocalhost", "http://localhost:${canary.port}/fetch-localhost");
  r.wsCanary = await new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket("ws://127.0.0.1:${canary.port}/ws"); } catch (e) { resolve("failed " + e.name); return; }
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve("no open within 5 s"); }, 5000);
    ws.onopen = () => { clearTimeout(t); ws.close(); resolve("opened"); };
    ws.onerror = () => { clearTimeout(t); resolve("failed error"); };
  });
  return r;
};
</script>`);
});
report.ports = { allowed: allowed.port, canary: canary.port };

try {
  await startChrome({ dir: out, allowedPort: allowed.port, onSpawn: (spawned) => (chrome = spawned) });
  report.browser = { version: chrome.browser, binary: chrome.binary, pid: chrome.pid, endpoint: chrome.endpoint, home: chrome.home, sinkPort: chrome.sink.port };
  console.log(`[iso] ${chrome.browser} pid ${chrome.pid}; allowed ${allowed.port}, canary ${canary.port}, sink ${chrome.sink.port}`);
  const page = await Page.open(chrome.port, "about:blank");
  const nav = await page.send("Page.navigate", { url: `http://127.0.0.1:${allowed.port}/` }, 20_000);
  report.checks.allowedNavigate = nav;
  await page.waitFor("the allowed page", async () => (await page.ev("document.title")) === "e2e-allowed", 15_000);
  report.checks.allowedLoaded = true;
  const sinkBefore = chrome.sink.attempts;
  report.checks.probe = await withTimeout(page.ev("window.__probe()"), 20_000, "in-page probe");
  report.checks.sinkAttemptsFromProbe = chrome.sink.attempts - sinkBefore;
  const sinkBeforeNav = chrome.sink.attempts;
  try {
    report.checks.canaryNavigate = await page.send("Page.navigate", { url: `http://127.0.0.1:${canary.port}/navigate` }, 20_000);
  } catch (e) {
    report.checks.canaryNavigate = { error: e instanceof Error ? e.message : String(e) };
  }
  await sleep(1500);
  report.checks.canaryNavigateTitle = await page.ev("document.title").catch((e) => `unreadable: ${e.message}`);
  report.checks.sinkAttemptsFromNavigate = chrome.sink.attempts - sinkBeforeNav;
  await withTimeout(page.close(), 5_000, "page close").catch(() => {});
} catch (e) {
  report.error = e instanceof Error ? e.message : String(e);
} finally {
  if (chrome) {
    report.cleanup = await stopChrome(chrome).catch((e) => ({ error: e.message }));
    report.cleanup.groupAliveAfter = groupAlive(chrome.pid);
  }
  report.canary = { connections: canary.stats.connections, requests: canary.stats.requests };
  report.allowedServer = { connections: allowed.stats.connections, requests: allowed.stats.requests };
  canary.server.close();
  allowed.server.close();
  clearTimeout(watchdog);
  const c = report.checks;
  report.ok =
    !report.error &&
    c.allowedLoaded === true &&
    report.canary.connections === 0 &&
    // The allowed origin is reachable as localhost too; nothing else is.
    /^reached/.test(c.probe?.fetchAllowedLocalhost ?? "") &&
    report.allowedServer.requests.includes("/via-localhost") &&
    !Object.entries(c.probe ?? {}).some(([k, v]) => k !== "fetchAllowedLocalhost" && /^reached|^opened/.test(v)) &&
    c.sinkAttemptsFromProbe >= 3 &&
    c.sinkAttemptsFromNavigate >= 1 &&
    // Every dropped attempt was one of the canary attempts (no other destination was tried).
    // Every dropped attempt is accounted for and was one of the canary attempts.
    unexpectedDrops(report.cleanup?.drops, [`GET http://127.0.0.1:${canary.port}/fetch-127`, `GET http://localhost:${canary.port}/fetch-localhost`, `CONNECT 127.0.0.1:${canary.port}`, `GET http://127.0.0.1:${canary.port}/navigate`]).length === 0 &&
    report.cleanup?.stopped === true &&
    report.cleanup?.groupAliveAfter === false;
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ ok: report.ok, error: report.error ?? null, browser: report.browser?.version, checks: report.checks, canary: report.canary, allowedServer: report.allowedServer, cleanup: report.cleanup }, null, 1));
  process.exit(report.ok ? 0 : 1);
}
