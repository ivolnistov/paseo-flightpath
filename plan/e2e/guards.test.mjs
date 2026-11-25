// Checks of the harness's safety decisions without a browser, host, daemon or network:
//   node --test e2e/guards.test.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createCaller } from "./lib/caller.mjs";
import { killRunningNow, runBounded, runningCount } from "./lib/proc.mjs";
import { createDropLedger, handleSinkSocket, lineKey, NO_LINE, unexpectedDrops } from "./lib/sink.mjs";
import { acquireLock, holdsLock, inspectLock, LockBusy, newLockToken, releaseLock } from "./lib/lock.mjs";
import { Page } from "./lib/cdp.mjs";
import { adoptEndpoint, browserBinary, browserTree, groupAlive, killAllBrowsersNow, liveBrowsers, spawnBrowser, superviseStartup } from "./lib/chrome.mjs";
import { openSession } from "./lib/ui.mjs";
import {
  buildRpcInput,
  callAllowed,
  checkBrowserPath,
  chromeLaunchPlan,
  classifyConflict,
  createHalt,
  endpointMatches,
  goToVerdict,
  HEADLESS_SHELL,
  HEADLESS_SHELL_MANIFEST,
  insideDir,
  manifestProblems,
  newRunId,
  pageSocketOk,
  proxyTarget,
  EXPECTED_BLOCKED,
  ownsBrowserProcess,
  parseDevToolsActivePort,
  parseDevToolsListening,
  parseSafety,
  RUN_ID,
  sdkCapabilities,
  hostMismatch,
  selectForHost,
  JOURNEY_HOST,
  selectJourneys,
  visibleFraction,
  withTimeout,
  WRITES,
} from "./lib/guards.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REV = "94e0aa26b2b1aca1be8fcc627730e5803bb74712";
const OTHER = "0123456789abcdef0123456789abcdef01234567";

// The sandbox tool's real line shapes (tools/safety-check.mjs, tools/rpc-probe.mjs).
const checkLines = ({ outbound = "0 outbound", agents = "0", extra = [] } = {}) =>
  [
    "  ok    versions: running 0.15.3 (daemon /api/status 0.15.3); installed 0.15.3; verified 0.15.0, 0.15.3",
    "  ok    processes (5, mode offline): 1 supervisor; 2 daemon; 3 plugin; none an unexpected agent, package runner or unrecognised",
    `  ok    network sockets: 3; listening only on loopback 127.0.0.1:61141, 127.0.0.1:6887; ${outbound}`,
    `  ok    agents (including archived): ${agents}`,
    ...extra,
    "safety-check --runtime: passed",
  ].join("\n");
const probeLines = ({ rev = REV, outbound = "0 outbound", extra = [] } = {}) =>
  [
    checkLines({ outbound }),
    `rpc-probe: answered by plugin pid 3 (started 2026-11-11T05:27:09.000Z), proven to run the staged ${rev}`,
    "  rpc   roadmap.version -> ok (status ok, revision 477)",
    ...extra,
    "rpc-probe: passed",
  ].join("\n");
const good = { checkText: checkLines(), checkStatus: 0, probeText: probeLines(), probeStatus: 0, stagedRev: REV, rev: REV };

test("safety: the tool's passing output passes", () => {
  const r = parseSafety(good);
  assert.equal(r.passed, true);
  assert.equal(r.loopbackOnly, true);
  assert.equal(r.agents, true);
  assert.equal(r.servedRev, REV);
});

test("safety: 10 outbound fails (the old pattern accepted it); so do 1, 00 and suffixed counts", () => {
  for (const outbound of ["10 outbound", "1 outbound", "100 outbound", "1 outbound (live agent to port 443 only)", "0 outbound (live agent to port 443 only)", "00 outbound", "-0 outbound"]) {
    const r = parseSafety({ ...good, checkText: checkLines({ outbound }) });
    assert.equal(r.loopbackOnly, false, outbound);
    assert.equal(r.passed, false, outbound);
  }
});

test("safety: every socket line must be zero (the probe's own check counts too)", () => {
  const r = parseSafety({ ...good, probeText: probeLines({ outbound: "10 outbound" }) });
  assert.equal(r.passed, false);
});

test("safety: a missing socket or agent line fails", () => {
  assert.equal(parseSafety({ ...good, checkText: "safety-check --runtime: passed", probeText: probeLines().replace(/.*network sockets.*\n/, "") }).passed, false);
  assert.equal(parseSafety({ ...good, checkText: "safety-check --runtime: passed", probeText: probeLines().replace(/.*agents \(including.*\n/, "") }).passed, false);
});

test("safety: any agent count but exactly 0 fails", () => {
  for (const agents of ["10", "1", "0 of at most 2, every one a Discuss chat on claude", "00"]) {
    assert.equal(parseSafety({ ...good, checkText: checkLines({ agents }) }).passed, false, agents);
  }
});

test("safety: a FAIL line, a failed probe, a not-ok RPC or a non-zero exit fails", () => {
  assert.equal(parseSafety({ ...good, checkText: checkLines({ extra: ["  FAIL  processes: an unexpected agent"] }) }).passed, false);
  assert.equal(parseSafety({ ...good, probeText: probeLines().replace("rpc-probe: passed", "rpc-probe: FAILED") }).passed, false);
  assert.equal(parseSafety({ ...good, probeText: probeLines({ extra: ["  rpc   feature.list -> not ok {}"] }) }).passed, false);
  assert.equal(parseSafety({ ...good, checkStatus: 1 }).passed, false);
  assert.equal(parseSafety({ ...good, probeStatus: null }).passed, false);
});

test("safety: the served, staged and requested revisions must all be the same 40-hex revision", () => {
  assert.equal(parseSafety({ ...good, probeText: probeLines({ rev: OTHER }) }).passed, false);
  assert.equal(parseSafety({ ...good, stagedRev: OTHER }).passed, false);
  assert.equal(parseSafety({ ...good, rev: OTHER }).passed, false);
  assert.equal(parseSafety({ ...good, rev: "94e0aa2" }).passed, false);
  const twoRevs = `${probeLines()}\nrpc-probe: answered by plugin pid 4 (started x), proven to run the staged ${OTHER}`;
  assert.equal(parseSafety({ ...good, probeText: twoRevs }).passed, false);
  assert.equal(parseSafety({ ...good, probeText: probeLines().replace(/.*proven to run.*\n/, "") }).passed, false);
});

const ctx = () => ({ projectId: "prj_e2e", owned: new Set(["ses_own"]) });

test("rpc: the project is pinned and cannot be overridden, at any depth", () => {
  assert.deepEqual(buildRpcInput("roadmap.version", {}, ctx()), { projectId: "prj_e2e" });
  assert.throws(() => buildRpcInput("roadmap.overview", { projectId: "prj_user" }, ctx()), /another project/);
  assert.throws(() => buildRpcInput("question.create", { sessionId: "ses_own", activatedBy: [{ parent: { projectId: "prj_user", sessionId: "ses_own", questionId: "q" } }] }, ctx()), /another project/);
  assert.equal(buildRpcInput("session.get", { projectId: "prj_e2e", sessionId: "x" }, ctx()).projectId, "prj_e2e");
  assert.throws(() => buildRpcInput("roadmap.version", {}, { projectId: "", owned: new Set() }), /no pinned project/);
});

test("rpc: only the listed methods; link.create and every other relation or destructive write is refused", () => {
  assert.equal(WRITES.has("link.create"), false);
  for (const m of ["link.create", "link.delete", "session.delete", "session.update", "roadmap.init", "feature.create", "planner.bind", "chat.send", "__proto__", "constructor"]) {
    assert.throws(() => buildRpcInput(m, { sessionId: "ses_own" }, ctx()), /is not allowed/, m);
  }
});

test("rpc: session.create needs an exact [e2e] title and may not name a session", () => {
  assert.ok(buildRpcInput("session.create", { title: "[e2e] 1 x" }, ctx()));
  for (const title of ["x", " [e2e] x", "[e2e]x", "[E2E] x", "", undefined, 7]) {
    assert.throws(() => buildRpcInput("session.create", { title }, ctx()), /only \[e2e\]/, String(title));
  }
  assert.throws(() => buildRpcInput("session.create", { title: "[e2e] x", sessionId: "ses_user" }, ctx()), /may not name a session/);
});

test("rpc: every other write, and every session it names (relation parents included), must be run-owned", () => {
  assert.ok(buildRpcInput("question.answer", { sessionId: "ses_own", questionId: "q", optionId: "a" }, ctx()));
  assert.ok(buildRpcInput("question.create", { sessionId: "ses_own", activatedBy: [{ parent: { sessionId: "ses_own", questionId: "q" }, optionIds: ["a"] }], invalidatedBy: [] }, ctx()));
  assert.throws(() => buildRpcInput("question.answer", { sessionId: "ses_user", questionId: "q" }, ctx()), /did not create/);
  assert.throws(() => buildRpcInput("block.accept", { sessionId: "ses_user" }, ctx()), /did not create/);
  assert.throws(() => buildRpcInput("question.create", { sessionId: "ses_own", activatedBy: [{ parent: { sessionId: "ses_user", questionId: "q" }, optionIds: ["a"] }] }, ctx()), /did not create \(ses_user\)/);
  assert.throws(() => buildRpcInput("question.create", { sessionId: "ses_own", invalidatedBy: [{ parent: { sessionId: "ses_user", questionId: "q" } }] }, ctx()), /did not create/);
  assert.throws(() => buildRpcInput("question.answer", { questionId: "q" }, ctx()), /needs a sessionId/);
  for (const input of [null, [], "x"]) assert.throws(() => buildRpcInput("question.answer", input, ctx()), /must be an object/);
});

test("safety: inert fixture agents pass only for a run that names the provider and limit", () => {
  const inertLine = (n, provider = "e2e-inert") => `${n}, every one on the inert e2e provider ${provider}`;
  const withAgents = (agents) => ({ ...good, checkText: checkLines({ agents }), probeText: probeLines().replace("agents (including archived): 0", `agents (including archived): ${agents}`) });
  const opts = { inertProvider: "e2e-inert", inertMax: 1 };
  assert.equal(parseSafety({ ...withAgents(inertLine(1)), ...opts }).passed, true);
  assert.equal(parseSafety({ ...good, ...opts }).passed, true, "0 agents still passes");
  assert.equal(parseSafety(withAgents(inertLine(1))).passed, false, "not without the run's allowance");
  assert.equal(parseSafety({ ...withAgents(inertLine(2)), ...opts }).passed, false, "more than the limit");
  assert.equal(parseSafety({ ...withAgents(inertLine(1, "codex")), ...opts }).passed, false, "another provider");
  assert.equal(parseSafety({ ...withAgents(inertLine(0)), ...opts }).passed, false, "an inert line must count at least one");
  assert.equal(parseSafety({ ...withAgents(`${inertLine(1)} and more`), ...opts }).passed, false, "nothing after the provider");
  assert.equal(parseSafety({ ...withAgents("1"), ...opts }).passed, false, "an agent not marked inert");
  for (const bad of [{ inertProvider: "e2e-inert", inertMax: 0 }, { inertProvider: "", inertMax: 1 }, { inertProvider: "e2e inert", inertMax: 1 }, { inertProvider: "e2e-inert", inertMax: 1.5 }]) {
    assert.equal(parseSafety({ ...withAgents(inertLine(1)), ...bad }).passed, false, JSON.stringify(bad));
  }
});

test("rpc: session.planner.set binds only the run's inert agent, only on a run-owned session", () => {
  const agent = "90b898dd-7347-423c-a4cc-cdb68895eb27";
  const withAgent = () => ({ ...ctx(), plannerAgentId: agent });
  assert.deepEqual(buildRpcInput("session.planner.set", { sessionId: "ses_own", agentId: agent }, withAgent()), { sessionId: "ses_own", agentId: agent, projectId: "prj_e2e" });
  assert.throws(() => buildRpcInput("session.planner.set", { sessionId: "ses_own", agentId: agent }, ctx()), /is not allowed without the run's inert fixture agent/);
  assert.throws(() => buildRpcInput("session.planner.set", { sessionId: "ses_own", agentId: "other" }, withAgent()), /only the run's inert fixture agent/);
  assert.throws(() => buildRpcInput("session.planner.set", { sessionId: "ses_own" }, withAgent()), /only the run's inert fixture agent/);
  assert.throws(() => buildRpcInput("session.planner.set", { sessionId: "ses_user", agentId: agent }, withAgent()), /did not create/);
  assert.throws(() => buildRpcInput("session.planner.set", { agentId: agent }, withAgent()), /needs a sessionId/);
  assert.throws(() => buildRpcInput("session.planner.set", { sessionId: "ses_own", agentId: agent, projectId: "prj_user" }, withAgent()), /another project/);
  assert.equal(WRITES.has("session.planner.set"), false, "not a general write");
});

test("caller: session.planner.set is a write (revision read, lock guard, transcript) with the run's agent only", async () => {
  const agent = "90b898dd-7347-423c-a4cc-cdb68895eb27";
  const client = fakeClient({ "roadmap.version": rev, "session.create": { ok: true, value: { sessionId: "ses_own" } }, "session.planner.set": { ok: true, value: { epoch: 1, revision: 7 } } });
  const halt = createHalt();
  let guardCalls = 0;
  const c = createCaller({ client, pluginId: "plg", projectId: "prj_e2e", halt, timeoutMs: 1_000, plannerAgentId: agent, writeGuard: () => (guardCalls++, null) });
  await c.call("session.create", { title: "[e2e] t" });
  const before = guardCalls;
  await c.call("session.planner.set", { sessionId: "ses_own", agentId: agent });
  assert.equal(guardCalls, before + 1);
  const entry = c.transcript.at(-1);
  assert.equal(entry.method, "session.planner.set");
  assert.equal(entry.write, true);
  assert.equal(entry.input.expectedRevision, 5);
  await assert.rejects(c.call("session.planner.set", { sessionId: "ses_own", agentId: "someone-else" }), /only the run's inert fixture agent/);
  const plain = createCaller({ client, pluginId: "plg", projectId: "prj_e2e", halt: createHalt(), timeoutMs: 1_000 });
  await assert.rejects(plain.call("session.planner.set", { sessionId: "ses_own", agentId: agent }), /not allowed/);
});

test("host: capabilities come from the SDK's own exports, both halves needed for subscriptions", () => {
  const shared016 = "export { defineRpc, defineSubscription, } from \"./rpc.js\";";
  const client016 = "export { useRpc, useSubscription } from \"./rpc-context.js\"; export { useComposer, useComposers } from \"./composer.js\";";
  assert.deepEqual(sdkCapabilities(shared016, client016), { subscriptions: true, composers: true });
  assert.deepEqual(sdkCapabilities("export { defineRpc } from \"./rpc.js\";", "export { useRpc } from \"./rpc-context.js\";"), { subscriptions: false, composers: false });
  assert.deepEqual(sdkCapabilities(shared016, "export { useRpc };"), { subscriptions: false, composers: false }, "a daemon without the app hook is not a subscription host");
  assert.deepEqual(sdkCapabilities("", client016), { subscriptions: false, composers: true });
  assert.equal(sdkCapabilities(shared016, "export { useSubscriptionState };").subscriptions, false, "a longer name is not the export");
  assert.deepEqual(sdkCapabilities(undefined, null), { subscriptions: false, composers: false });
});

test("host: journeys that need what the host or run lacks are named with the reason", () => {
  const h16 = { subscriptions: true, composers: true };
  const h15 = { subscriptions: false, composers: false };
  assert.equal(hostMismatch("j5", h16), null);
  assert.match(hostMismatch("j5", h15), /with plugin subscriptions/);
  assert.equal(hostMismatch("j9", h15), null);
  assert.match(hostMismatch("j9", h16), /without plugin subscriptions/);
  assert.match(hostMismatch("j9", {}), /without plugin subscriptions/, "unknown capabilities never pass as absent");
  assert.match(hostMismatch("j6", h16), /--inert-agent/);
  assert.equal(hostMismatch("j7", h16, { inertAgent: true }), null);
  assert.match(hostMismatch("j8", h15, { inertAgent: true }), /composer API/);
  for (const id of ["j1", "j2", "j3", "j4"]) assert.equal(hostMismatch(id, h15), null, id);
  for (const id of ["j1", "j2", "j3"]) assert.equal(hostMismatch(id, h16), null, id);
  assert.match(hostMismatch("j4", h16), /without plugin subscriptions/, "the two-tab conflict needs a stale tab");
  assert.deepEqual(Object.keys(JOURNEY_HOST).sort(), ["j4", "j5", "j6", "j7", "j8", "j9"]);
});

test("host: a default run never mixes j5 and j9; an explicit incompatible selection is refused whole", () => {
  const ids = ["j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8", "j9"];
  const needs = { j3: ["j2"], j4: ["j2"] };
  const h16 = { subscriptions: true, composers: true };
  const h15 = { subscriptions: false, composers: false };
  assert.deepEqual(selectForHost(undefined, ids, needs, h16), ["j1", "j2", "j3", "j5"]);
  assert.deepEqual(selectForHost(undefined, ids, needs, h16, { inertAgent: true }), ["j1", "j2", "j3", "j5", "j6", "j7", "j8"]);
  assert.deepEqual(selectForHost(undefined, ids, needs, h15, { inertAgent: true }), ["j1", "j2", "j3", "j4", "j9"]);
  assert.deepEqual(selectForHost("j9,j1", ids, needs, h15), ["j1", "j9"]);
  assert.throws(() => selectForHost("j5,j9", ids, needs, h16), /not for this host: j9 needs a host without plugin subscriptions/);
  assert.throws(() => selectForHost("j5", ids, needs, h15), /j5 needs a host with plugin subscriptions/);
  assert.throws(() => selectForHost("j6", ids, needs, h16), /j6 needs --inert-agent/);
  assert.throws(() => selectForHost("j3", ids, needs, h16), /j3 needs j2/, "dependency rules still apply");
});

test("sources: the runner selects per host in both processes, j5 bounds the event re-read, j6-j8 name themselves", () => {
  const run = readFileSync(path.join(here, "run.mjs"), "utf8");
  assert.equal((run.match(/selectForHost\(args\.only, JOURNEYS\.map\(\(j\) => j\.id\), JOURNEY_NEEDS, /g) ?? []).length, 2);
  assert.ok(!/selectJourneys\(/.test(run), "no host-blind selection left");
  assert.match(run, /const EVENT_REREAD_MS = 300;/);
  assert.match(run, /w\.firstVersionReadAfterEventMs <= EVENT_REREAD_MS/);
  assert.match(run, /`\$\{id\} needs --inert-agent <id>/);
  assert.match(run, /report = \{ runId, rev: args\.rev, host, selected/);
});

test("timeout: a slow promise is rejected naming it; a fast one resolves", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "slow rpc"), /slow rpc: no result within 20 ms/);
  assert.equal(await withTimeout(Promise.resolve(7), 1_000, "fast"), 7);
});

const USER = "/Users/someone";
const plan = (over = {}) => chromeLaunchPlan({ binary: HEADLESS_SHELL, dir: "/tmp/dr-e2e-x", sinkPort: 50123, userHome: USER, allowed: { host: "127.0.0.1", port: 6887 }, ...over });
const flag = (args, name) => args.filter((a) => a === name || a.startsWith(`${name}=`));

test("chrome: its HOME is task-owned, the keychain mocked, basic password store, everything off loopback to the sink", () => {
  const p = plan();
  assert.equal(p.env.HOME, "/tmp/dr-e2e-x/home");
  assert.equal(p.env.CFFIXED_USER_HOME, "/tmp/dr-e2e-x/home");
  assert.deepEqual(Object.keys(p.env).sort(), ["CFFIXED_USER_HOME", "HOME", "LANG", "PATH", "TMPDIR"]);
  for (const v of Object.values(p.env)) assert.ok(!v.startsWith(USER), v);
  for (const f of ["--use-mock-keychain", "--password-store=basic", "--proxy-server=http://127.0.0.1:50123", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=/tmp/dr-e2e-x/profile", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-background-networking", "--disable-sync"]) {
    assert.ok(p.args.includes(f), f);
  }
  assert.ok(!p.args.some((a) => a.includes(USER)));
});

test("browser: only the headless shell, by default the cached Chrome for Testing one; never branded Chrome", () => {
  assert.equal(HEADLESS_SHELL, "/Users/example/.cache/puppeteer/chrome-headless-shell/mac_arm-156.0.8078.47/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  assert.equal(checkBrowserPath(HEADLESS_SHELL), HEADLESS_SHELL);
  assert.equal(plan().binary, HEADLESS_SHELL);
  for (const b of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/chrome-headless-shell", "/opt/chrome/chrome", "chrome-headless-shell", "/opt/my dir/chrome-headless-shell", "", undefined]) {
    assert.throws(() => checkBrowserPath(b), String(b));
    assert.throws(() => plan({ binary: b }), String(b));
  }
});

test("browser: fails closed when the configured headless shell is missing, not a file or not executable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-guards-"));
  const before = process.env.E2E_CHROME;
  try {
    process.env.E2E_CHROME = path.join(dir, "missing", "chrome-headless-shell");
    assert.throws(() => browserBinary(), /unavailable.*not falling back/);
    const file = path.join(dir, "chrome-headless-shell");
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    process.env.E2E_CHROME = file;
    assert.throws(() => browserBinary(), /unavailable/);
    chmodSync(file, 0o755);
    // Executable, but not the pinned build: refused.
    assert.throws(() => browserBinary(), /not the pinned build/);
    process.env.E2E_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    assert.throws(() => browserBinary(), /whitespace|only a chrome-headless-shell/);
  } finally {
    if (before === undefined) delete process.env.E2E_CHROME;
    else process.env.E2E_CHROME = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser: the proxy bypass is exactly the sandbox origin, with the implicit loopback bypass removed", () => {
  const p = plan();
  assert.deepEqual(flag(p.args, "--proxy-bypass-list"), ["--proxy-bypass-list=<-loopback>;127.0.0.1:6887;localhost:6887"]);
  assert.deepEqual(flag(p.args, "--proxy-server"), ["--proxy-server=http://127.0.0.1:50123"]);
  assert.deepEqual(flag(p.args, "--host-resolver-rules"), ["--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]);
  assert.deepEqual(flag(p.args, "--host-rules"), []);
  assert.ok(!p.args.some((a) => /--headless=new|--no-proxy-server|--proxy-pac-url|--proxy-auto-detect|--remote-allow-origins/.test(a)), "no flag widens the proxy");
  // localhost appears only as the sandbox origin's second name and its mapping to 127.0.0.1.
  assert.deepEqual(p.args.filter((a) => /localhost/.test(a)), ["--proxy-bypass-list=<-loopback>;127.0.0.1:6887;localhost:6887", "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]);
  assert.deepEqual(flag(p.args, "--headless"), ["--headless"]);
  // No flag appears twice (a later duplicate would override the checked one).
  const names = p.args.filter((a) => a.startsWith("--")).map((a) => a.split("=")[0]);
  assert.equal(new Set(names).size, names.length);
  assert.equal(plan({ allowed: { host: "127.0.0.1", port: 7001 } }).args.find((a) => a.startsWith("--proxy-bypass-list")), "--proxy-bypass-list=<-loopback>;127.0.0.1:7001;localhost:7001");
  for (const allowed of [{ host: "localhost", port: 6887 }, { host: "0.0.0.0", port: 6887 }, { host: "[::1]", port: 6887 }, { host: "127.0.0.1", port: 6886 }, { host: "127.0.0.1", port: 50123 }, { host: "127.0.0.1", port: 80 }, undefined]) {
    assert.throws(() => plan({ allowed }), JSON.stringify(allowed));
  }
});

test("cleanup: a process is the run's browser only with exactly its binary and exactly its profile", () => {
  const profile = "/tmp/dr-e2e-x/profile";
  const ok = `${HEADLESS_SHELL} --headless --remote-debugging-port=9334 --user-data-dir=${profile} about:blank`;
  assert.equal(ownsBrowserProcess({ command: ok, binary: HEADLESS_SHELL, profile }), true);
  assert.equal(ownsBrowserProcess({ command: `${ok}\n`, binary: HEADLESS_SHELL, profile }), true);
  for (const command of [
    ok.replace(`=${profile}`, `=${profile}2`),
    ok.replace(`=${profile}`, `=/tmp/dr-e2e-x/profile/sub`),
    ok.replace(HEADLESS_SHELL, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ok.replace(HEADLESS_SHELL, `${HEADLESS_SHELL}-other`),
    `/bin/sh -c ${ok}`,
    `${ok} --user-data-dir=/tmp/other`,
    `${HEADLESS_SHELL} --headless about:blank`,
    "",
  ]) {
    assert.equal(ownsBrowserProcess({ command, binary: HEADLESS_SHELL, profile }), false, command);
  }
  assert.equal(ownsBrowserProcess({ command: ok, binary: HEADLESS_SHELL, profile: "" }), false);
  assert.equal(ownsBrowserProcess({ command: ok, binary: HEADLESS_SHELL, profile: "/tmp/a b" }), false);
});

test("chrome: refuses a home that is, or contains, the user's home, and refuses unsafe ports", () => {
  assert.throws(() => plan({ dir: USER }), /user's home/);
  assert.throws(() => plan({ dir: "/Users" }), /user's home/);
  assert.throws(() => plan({ dir: "/" }), /user's home/);
  assert.throws(() => plan({ dir: "tmp/x" }), /absolute/);
  assert.throws(() => plan({ userHome: "" }), /home must be known/);
  for (const sinkPort of [6886, 6887, 80, 0, 70000, 1.5]) assert.throws(() => plan({ sinkPort }), /refusing (sink|allowed origin) port/, String(sinkPort));
  assert.ok(plan({ dir: `${USER}/WORK/runs/r1` }).env.HOME.endsWith("/r1/home"));
  assert.throws(() => plan({ dir: "/tmp/dr e2e" }), /whitespace/);
});

test("sources: nothing hands the user's HOME to Chrome any more", () => {
  const run = readFileSync(path.join(here, "run.mjs"), "utf8");
  const chrome = readFileSync(path.join(here, "lib", "chrome.mjs"), "utf8");
  assert.ok(!/E2E_CHROME_HOME/.test(run + chrome));
  assert.ok(!/process\.env\.HOME/.test(chrome));
  assert.match(chrome, /env: plan\.env/);
  assert.match(chrome, /detached: true/);
  assert.ok(!/Google Chrome/.test(chrome + run));
});

test("halt: the first reason wins once; afterwards only final reads may be sent", () => {
  let calls = 0;
  const halt = createHalt(() => calls++);
  assert.equal(halt.trigger("first"), true);
  assert.equal(halt.trigger("second"), false);
  assert.equal(halt.reason, "first");
  assert.equal(calls, 1);
  assert.equal(callAllowed(null, "question.create", false), true);
  assert.equal(callAllowed("x", "roadmap.version", true), true);
  assert.equal(callAllowed("x", "roadmap.version", false), false);
  assert.equal(callAllowed("x", "question.create", true), false);
  assert.equal(callAllowed("x", "session.create", true), false);
});

/** A fake plugin client: answers per method, or never (a hung write). */
function fakeClient(answers) {
  const sent = [];
  return {
    sent,
    invokePluginRpc(pluginId, method, input) {
      sent.push({ pluginId, method, input });
      const a = answers[method];
      if (a === "hang") return new Promise(() => {});
      return Promise.resolve(typeof a === "function" ? a(input) : a);
    },
  };
}
const rev = { ok: true, value: { revision: 5 } };

test("caller: an unanswered write is ambiguous, halts the run, and nothing after it is sent but final reads", async () => {
  const client = fakeClient({ "roadmap.version": rev, "session.create": { ok: true, value: { sessionId: "ses_own", revision: 6 } }, "question.create": "hang", "question.answer": { ok: true, value: {} } });
  const halt = createHalt();
  const c = createCaller({ client, pluginId: "plg", projectId: "prj_e2e", halt, timeoutMs: 30 });
  await c.call("session.create", { title: "[e2e] t" });
  await assert.rejects(c.call("question.create", { sessionId: "ses_own", title: "q" }), /no result within 30 ms/);
  assert.match(halt.reason, /question\.create got no answer \(an ambiguous write\)/);
  const pending = c.transcript.find((t) => t.method === "question.create");
  assert.equal(pending.ok, null);
  assert.match(pending.outcome, /^ambiguous: .*may or may not have applied/);
  const sentBefore = client.sent.length;
  await assert.rejects(c.call("question.answer", { sessionId: "ses_own", questionId: "q", optionId: "a" }), /refused: the run is halted/);
  await assert.rejects(c.call("session.create", { title: "[e2e] u" }), /refused: the run is halted/);
  await assert.rejects(c.call("roadmap.version"), /refused: the run is halted/);
  assert.equal(client.sent.length, sentBefore, "nothing was sent after the halt");
  assert.equal((await c.call("roadmap.version", {}, { final: true })).revision, 5);
  await assert.rejects(c.call("question.answer", { sessionId: "ses_own", questionId: "q" }, { final: true }), /refused/);
});

test("caller: a definite refusal is not ambiguous and does not halt; an unreadable answer does", async () => {
  const halt = createHalt();
  const c = createCaller({ client: fakeClient({ "roadmap.version": rev, "session.create": { ok: false, error: { code: "revision_conflict" } } }), pluginId: "plg", projectId: "prj_e2e", halt, timeoutMs: 1_000 });
  await assert.rejects(c.call("session.create", { title: "[e2e] t" }), /revision_conflict/);
  assert.equal(halt.reason, null);
  assert.equal(c.transcript.at(-1).ok, false);
  const halt2 = createHalt();
  const c2 = createCaller({ client: fakeClient({ "roadmap.version": rev, "session.create": { value: {} } }), pluginId: "plg", projectId: "prj_e2e", halt: halt2, timeoutMs: 1_000 });
  await assert.rejects(c2.call("session.create", { title: "[e2e] t" }), /unreadable/);
  assert.match(halt2.reason, /unreadable answer \(an ambiguous write\)/);
  assert.match(c2.transcript.at(-1).outcome, /^ambiguous/);
});

test("caller: the client always receives the pinned project and the run's own sessions only", async () => {
  const client = fakeClient({ "roadmap.version": rev, "session.create": { ok: true, value: { sessionId: "ses_own" } }, "block.accept": { ok: true, value: {} } });
  const c = createCaller({ client, pluginId: "plg", projectId: "prj_e2e", halt: createHalt(), timeoutMs: 1_000 });
  await assert.rejects(c.call("block.accept", { sessionId: "ses_own" }), /did not create/);
  await assert.rejects(c.call("roadmap.overview", { projectId: "prj_user" }), /another project/);
  await c.call("session.create", { title: "[e2e] t" });
  await c.call("block.accept", { sessionId: "ses_own" });
  assert.ok(client.sent.every((x) => x.input.projectId === "prj_e2e" && x.pluginId === "plg"));
  assert.deepEqual(client.sent.map((x) => x.method), ["roadmap.version", "session.create", "roadmap.version", "block.accept"]);
});

test("Go to: passes only when the target ends visible and was not visible before, or moved", () => {
  const vis = (x, y) => ({ found: 1, fraction: 1, hit: true, rect: { x, y, w: 100, h: 40 } });
  const hidden = { found: 1, fraction: 0, hit: false, rect: { x: 10, y: 2000, w: 100, h: 40 } };
  assert.equal(goToVerdict(hidden, vis(10, 300)).verdict, "pass");
  assert.equal(goToVerdict({ ...vis(10, 300), fraction: 0.3 }, vis(10, 300)).verdict, "pass");
  assert.equal(goToVerdict({ ...vis(10, 300), hit: false }, vis(10, 300)).verdict, "pass");
  assert.equal(goToVerdict(vis(10, 300), vis(10, 200)).verdict, "pass");
  assert.equal(goToVerdict(vis(10, 300), vis(12, 303)).verdict, "inconclusive");
  assert.equal(goToVerdict(vis(10, 300), vis(10, 300)).verdict, "inconclusive");
  assert.equal(goToVerdict(hidden, hidden).verdict, "fail");
  assert.equal(goToVerdict(hidden, { ...vis(10, 300), hit: false }).verdict, "fail");
  assert.equal(goToVerdict(hidden, { ...vis(10, 300), fraction: 0.49 }).verdict, "fail");
  assert.equal(goToVerdict(hidden, { found: 2, fraction: 1, hit: true }).verdict, "fail");
});

test("j4: only a store-proven conflict with the draft kept and one copy after retry passes", () => {
  const ok = { noticeShown: true, draftKept: true, revisionBeforeAdd: 10, revisionAfterFirstAdd: 10, copiesAfterFirstAdd: 0, copiesAfterRetry: 1 };
  assert.equal(classifyConflict(ok).verdict, "revision_conflict");
  assert.equal(classifyConflict({ ...ok, noticeShown: false }).verdict, "inconclusive");
  assert.equal(classifyConflict({ ...ok, noticeShown: false, copiesAfterFirstAdd: 1 }).verdict, "inconclusive");
  assert.equal(classifyConflict({ ...ok, draftKept: false }).verdict, "fail");
  assert.equal(classifyConflict({ ...ok, revisionAfterFirstAdd: 11 }).verdict, "fail");
  assert.equal(classifyConflict({ ...ok, copiesAfterFirstAdd: 1 }).verdict, "fail");
  assert.equal(classifyConflict({ ...ok, copiesAfterRetry: 2 }).verdict, "fail");
  assert.equal(classifyConflict({ ...ok, copiesAfterRetry: null }).verdict, "fail");
});

test("Go to: visibility is clipped by the viewport and every clipping ancestor", () => {
  const vp = { w: 1000, h: 800 };
  assert.equal(visibleFraction({ x: 10, y: 10, w: 100, h: 50 }, [], vp).fraction, 1);
  assert.equal(visibleFraction({ x: 10, y: 900, w: 100, h: 50 }, [], vp).fraction, 0);
  // Inside the window but scrolled out of its scroll view: invisible.
  assert.equal(visibleFraction({ x: 10, y: 500, w: 100, h: 50 }, [{ x: 0, y: 0, w: 1000, h: 400 }], vp).fraction, 0);
  const half = visibleFraction({ x: 10, y: 375, w: 100, h: 50 }, [{ x: 0, y: 0, w: 1000, h: 400 }], vp);
  assert.equal(half.fraction, 0.5);
  assert.deepEqual(half.centre, { x: 60, y: 387.5 });
  assert.equal(visibleFraction({ x: 10, y: 10, w: 0, h: 50 }, [], vp).fraction, 0);
  // The in-page copy is the same function (it is injected through toString).
  const copy = new Function(`return ${visibleFraction.toString()}`)();
  assert.deepEqual(copy({ x: 10, y: 375, w: 100, h: 50 }, [{ x: 0, y: 0, w: 1000, h: 400 }], vp), half);
});

const UUID = "0f8e7d6c-5b4a-3928-1716-151413121110";

test("DevTools: only the endpoint the run's own browser wrote, on a safe loopback port, is adopted", () => {
  assert.deepEqual(parseDevToolsActivePort(`41234\n/devtools/browser/${UUID}\n`), { port: 41234, path: `/devtools/browser/${UUID}`, url: `ws://127.0.0.1:41234/devtools/browser/${UUID}` });
  assert.equal(parseDevToolsActivePort(null), null);
  assert.equal(parseDevToolsActivePort("41234\n"), null);
  assert.equal(parseDevToolsActivePort(""), null);
  for (const text of [`6886\n/devtools/browser/${UUID}`, `6887\n/devtools/browser/${UUID}`, `80\n/devtools/browser/${UUID}`, `70000\n/devtools/browser/${UUID}`, `4x\n/devtools/browser/${UUID}`, "41234\n/devtools/page/abc", "41234\n/../../etc"]) {
    assert.throws(() => parseDevToolsActivePort(text), text);
  }
  const line = `DevTools listening on ws://127.0.0.1:41234/devtools/browser/${UUID}`;
  assert.equal(parseDevToolsListening(`noise\n${line}\nmore`).port, 41234);
  assert.equal(parseDevToolsListening("nothing yet"), null);
  assert.throws(() => parseDevToolsListening(`${line}\n${line}`), /more than one/);
  assert.throws(() => parseDevToolsListening(`DevTools listening on ws://localhost:41234/devtools/browser/${UUID}`), /refusing/);
  assert.throws(() => parseDevToolsListening(`DevTools listening on ws://10.0.0.2:41234/devtools/browser/${UUID}`), /refusing/);
  const active = parseDevToolsActivePort(`41234\n/devtools/browser/${UUID}`);
  assert.equal(endpointMatches({ webSocketDebuggerUrl: active.url }, active), true);
  assert.equal(endpointMatches({ webSocketDebuggerUrl: `ws://127.0.0.1:41234/devtools/browser/${UUID.replace("0f", "1f")}` }, active), false, "another browser on the same port");
  assert.equal(endpointMatches(null, active), false);
  assert.equal(endpointMatches({ webSocketDebuggerUrl: active.url }, null), false);
});

test("run identity: a random suffix keeps same-second runs apart", () => {
  const now = new Date("2026-11-11T06:00:00.123Z");
  let n = 0;
  const a = newRunId(now, () => 0.01);
  const b = newRunId(now, () => ((n += 0.13) % 1));
  assert.match(a, RUN_ID);
  assert.match(b, RUN_ID);
  assert.ok(a.startsWith("20261111-060000-"));
  assert.notEqual(a, b);
  for (const bad of ["20261111-060000", "20261111-060000-ABCDEF", "../x", "20261111-060000-abcdef/.."]) assert.equal(RUN_ID.test(bad), false, bad);
});

test("--only: unknown, empty or valueless selections are refused; a run never selects nothing", () => {
  const ids = ["j1", "j2", "j3", "j4"];
  assert.deepEqual(selectJourneys(undefined, ids), ids);
  assert.deepEqual(selectJourneys("j2,j1", ids), ["j1", "j2"]);
  assert.deepEqual(selectJourneys(" j3 ", ids), ["j3"]);
  for (const only of ["true", "", " ", "j5", "j1,j5", "j1,", ",", "J1", 7]) assert.throws(() => selectJourneys(only, ids), String(only));
});

/** A Page over a fake socket: the test plays the browser's side of the protocol. */
function fakePage() {
  const sent = [];
  const ws = { send: (data) => sent.push(JSON.parse(data)), close() {} };
  const page = new Page(ws, "T", 1);
  const answer = (msg) => ws.onmessage({ data: JSON.stringify(msg) });
  return { page, sent, answer };
}

test("CDP: a protocol error rejects naming the method; a result resolves", async () => {
  const { page, sent, answer } = fakePage();
  const failing = page.send("Page.navigate", { url: "x" }, 1_000);
  answer({ id: sent[0].id, error: { code: -32000, message: "Cannot navigate to invalid URL" } });
  await assert.rejects(failing, /Page\.navigate: protocol error -32000 Cannot navigate to invalid URL/);
  const ok = page.send("Runtime.evaluate", {}, 1_000);
  answer({ id: sent[1].id, result: { result: { value: 3 } } });
  assert.deepEqual(await ok, { result: { value: 3 } });
  await assert.rejects(page.send("Page.reload", {}, 20), /no answer from the page within 20 ms/);
});

/** A fake page for openSession: `navigates` decides whether pressing the row opens the session. */
function sessionPage(title, navigates) {
  let screen = "list";
  const row = { role: "button", label: `Open session ${title}`, text: title };
  return {
    clicks: 0,
    async controls() {
      return screen === "list" ? [row] : [{ role: "button", label: "‹ Back", text: "‹ Back" }, { role: "button", label: "Chat menu, Grilling", text: "Chat" }];
    },
    async text() {
      return title; // the title is shown on both screens
    },
    async click() {
      this.clicks++;
      if (navigates) screen = "session";
    },
    waitFor: Page.prototype.waitFor,
  };
}

test("openSession: the title on the list is not enough; the session screen's own controls must appear", async () => {
  const title = "[e2e] 20261111-060000-abcdef blocks";
  const stuck = sessionPage(title, false);
  await assert.rejects(openSession(stuck, title, { timeout: 300 }), /timed out waiting for the session screen/);
  assert.equal(stuck.clicks, 1);
  await openSession(sessionPage(title, true), title, { timeout: 300 });
});

test("browser spawn: an error rejects with a diagnostic instead of an uncaught event", async () => {
  // A path that does not exist: nothing is executed.
  await assert.rejects(spawnBrowser("/nonexistent-e2e-guards/chrome-headless-shell", [], { stdio: "ignore" }), /the browser could not be started: .*ENOENT/);
});

test("sources: no fixed DevTools port, no shared default output, and the usage names only real journeys", () => {
  const run = readFileSync(path.join(here, "run.mjs"), "utf8");
  assert.ok(!/9334/.test(run));
  // Every journey the usage names is defined (as an entry or a discussJourney call).
  const defined = new Set([...run.matchAll(/\bid: "(j\d+)"/g)].map((m) => m[1]));
  const usage = run.match(/const USAGE = "([^"]*)"/)?.[1] ?? "";
  for (const id of usage.match(/\bj\d+\b/g) ?? []) assert.ok(defined.has(id), `usage names ${id}, which is not defined`);
  assert.deepEqual([...defined].sort(), ["j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8", "j9"]);
  assert.match(run, /newRunId\(\)/);
  assert.match(run, /mkdirSync\(out, \{ recursive: false, mode: 0o700 \}\)/);
});

// ---- Browser provenance ----

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** A fake browser directory in a temp dir, and the manifest it should match. */
function fakeShell() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-shell-"));
  const files = { "chrome-headless-shell": "#!/bin/sh\nexit 0\n", "lib/libx.dylib": "lib", "data.pak": "pak" };
  const manifest = {};
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
    manifest[rel] = [sha(text), Buffer.byteLength(text)];
  }
  chmodSync(path.join(dir, "chrome-headless-shell"), 0o755);
  return { dir, binary: path.join(dir, "chrome-headless-shell"), manifest };
}

function withChrome(binary, fn) {
  const before = process.env.E2E_CHROME;
  process.env.E2E_CHROME = binary;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.E2E_CHROME;
    else process.env.E2E_CHROME = before;
  }
}

test("provenance: the pinned manifest names the cached build's binary and its 16 files", () => {
  assert.equal(Object.keys(HEADLESS_SHELL_MANIFEST).length, 16);
  assert.deepEqual(HEADLESS_SHELL_MANIFEST["chrome-headless-shell"], ["3c3950c515a97109e1220670ecc31c1f73605ed8379e36a45d1bee064a991162", 177028368]);
  assert.ok(Object.isFrozen(HEADLESS_SHELL_MANIFEST));
});

test("provenance: an identical tree passes; a renamed executable, a changed byte, an extra, missing or linked file is refused", () => {
  const { dir, binary, manifest } = fakeShell();
  try {
    assert.equal(withChrome(binary, () => browserBinary({ manifest })), binary);
    // An arbitrary executable renamed to chrome-headless-shell.
    writeFileSync(binary, "#!/bin/sh\necho other\n");
    assert.throws(() => withChrome(binary, () => browserBinary({ manifest })), /not the pinned build: chrome-headless-shell differs/);
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    writeFileSync(path.join(dir, "data.pak"), "paK");
    assert.throws(() => withChrome(binary, () => browserBinary({ manifest })), /data\.pak differs/);
    writeFileSync(path.join(dir, "data.pak"), "pak");
    writeFileSync(path.join(dir, "extra.dylib"), "x");
    assert.throws(() => withChrome(binary, () => browserBinary({ manifest })), /unexpected file extra\.dylib/);
    rmSync(path.join(dir, "extra.dylib"));
    rmSync(path.join(dir, "lib", "libx.dylib"));
    symlinkSync(path.join(dir, "data.pak"), path.join(dir, "lib", "libx.dylib"));
    assert.throws(() => withChrome(binary, () => browserBinary({ manifest })), /lib\/libx\.dylib is a symlink/);
    rmSync(path.join(dir, "lib", "libx.dylib"));
    assert.throws(() => withChrome(binary, () => browserBinary({ manifest })), /missing lib\/libx\.dylib/);
    // The real pinned manifest refuses the fake tree outright.
    assert.throws(() => withChrome(binary, () => browserBinary()), /not the pinned build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provenance: manifestProblems reports every kind of difference", () => {
  const m = { a: [sha("a"), 1], b: [sha("b"), 1] };
  assert.deepEqual(manifestProblems(m, { a: { type: "file", sha256: sha("a"), size: 1 }, b: { type: "file", sha256: sha("b"), size: 1 } }), []);
  const p = manifestProblems(m, { a: { type: "file", sha256: sha("a"), size: 2 }, c: { type: "other" }, b: { type: "symlink" } });
  assert.equal(p.length, 3);
  assert.deepEqual(manifestProblems(m, {}).length, 2);
});

test("provenance: browserTree types and hashes what it finds", () => {
  const { dir, manifest } = fakeShell();
  try {
    const t = browserTree(dir);
    assert.deepEqual(manifestProblems(manifest, t), []);
    assert.equal(t["data.pak"].sha256, sha("pak"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CDP: only exactly this page's socket on the run's own endpoint port is accepted", () => {
  const id = "A1B2C3D4E5F60718293A4B5C6D7E8F90";
  assert.equal(pageSocketOk({ id, webSocketDebuggerUrl: `ws://127.0.0.1:41234/devtools/page/${id}` }, 41234), true);
  for (const [target, port] of [
    [{ id, webSocketDebuggerUrl: `ws://127.0.0.1:41235/devtools/page/${id}` }, 41234],
    [{ id, webSocketDebuggerUrl: `ws://localhost:41234/devtools/page/${id}` }, 41234],
    [{ id, webSocketDebuggerUrl: `ws://10.0.0.2:41234/devtools/page/${id}` }, 41234],
    [{ id, webSocketDebuggerUrl: `ws://127.0.0.1:41234/devtools/browser/${id}` }, 41234],
    [{ id, webSocketDebuggerUrl: `ws://127.0.0.1:41234/devtools/page/${id.replace("A1", "B1")}` }, 41234],
    [{ id: "../x", webSocketDebuggerUrl: "ws://127.0.0.1:41234/devtools/page/../x" }, 41234],
    [{ id }, 41234],
    [null, 41234],
  ]) {
    assert.equal(pageSocketOk(target, port), false, JSON.stringify(target));
  }
});

// ---- The sandbox run lock ----

function lockDir() {
  return mkdtempSync(path.join(os.tmpdir(), "e2e-lock-"));
}

test("lock: one holder; contention fails closed and leaves the holder's lock untouched", () => {
  const dir = lockDir();
  const file = path.join(dir, "e2e-run.lock");
  try {
    const a = newLockToken();
    const b = newLockToken();
    acquireLock(file, { token: a, runId: "run-a" });
    const before = readFileSync(file, "utf8");
    assert.equal(holdsLock(file, a), true);
    assert.throws(() => acquireLock(file, { token: b, runId: "run-b" }), (e) => e instanceof LockBusy && /run-a .*alive/.test(e.message));
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(releaseLock(file, b), { released: false, reason: "left in place: held by another run" });
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(releaseLock(file, a), { released: true });
    assert.deepEqual(releaseLock(file, a), { released: false, reason: "absent" });
    acquireLock(file, { token: b, runId: "run-b" });
    assert.equal(holdsLock(file, b), true);
    assert.equal(holdsLock(file, a), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock: a stale or malformed lock is reported, never deleted, and blocks the run", () => {
  const dir = lockDir();
  const file = path.join(dir, "e2e-run.lock");
  try {
    const stale = JSON.stringify({ token: newLockToken(), runId: "old", pid: 2 ** 22 + 12345, startedAt: "2026-11-10T00:00:00Z" });
    writeFileSync(file, stale);
    assert.throws(() => acquireLock(file, { token: newLockToken(), runId: "new" }), /run old .*not running: stale.*never removed automatically/);
    assert.equal(releaseLock(file, newLockToken()).released, false);
    assert.equal(readFileSync(file, "utf8"), stale);
    for (const junk of ["", "{", JSON.stringify({ token: "short" }), "x".repeat(5000)]) {
      writeFileSync(file, junk);
      assert.throws(() => acquireLock(file, { token: newLockToken(), runId: "new" }), /malformed/);
      assert.equal(releaseLock(file, newLockToken()).released, false);
      assert.equal(readFileSync(file, "utf8"), junk);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock: a symlink, dangling symlink or directory at the lock path is contention and is never followed", () => {
  const dir = lockDir();
  const file = path.join(dir, "e2e-run.lock");
  const target = path.join(dir, "victim.txt");
  try {
    writeFileSync(target, "keep me");
    symlinkSync(target, file);
    assert.throws(() => acquireLock(file, { token: newLockToken(), runId: "x" }), /not a regular file \(symlink\)/);
    assert.equal(releaseLock(file, newLockToken()).released, false);
    assert.equal(readFileSync(target, "utf8"), "keep me");
    rmSync(file);
    symlinkSync(path.join(dir, "nowhere"), file);
    assert.throws(() => acquireLock(file, { token: newLockToken(), runId: "x" }), LockBusy);
    assert.equal(inspectLock(path.join(dir, "nowhere")).state, "absent", "a dangling link's target is not created");
    rmSync(file);
    mkdirSync(file);
    assert.throws(() => acquireLock(file, { token: newLockToken(), runId: "x" }), /directory/);
    assert.throws(() => acquireLock(path.join(dir, "e2e-run2.lock"), { token: "not-hex", runId: "x" }), /32 hex/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock: of eight processes racing for it, exactly one wins", async () => {
  const dir = lockDir();
  const file = path.join(dir, "e2e-run.lock");
  const lockModule = path.join(here, "lib", "lock.mjs");
  const script = `import(${JSON.stringify(lockModule)}).then((m) => { try { m.acquireLock(${JSON.stringify(file)}, { token: m.newLockToken(), runId: "racer" }); process.exit(0); } catch (e) { process.exit(e instanceof m.LockBusy ? 3 : 1); } });`;
  try {
    const codes = await Promise.all(
      Array.from({ length: 8 }, () => new Promise((resolve) => spawnProcess(process.execPath, ["-e", script], { stdio: "ignore" }).on("exit", resolve))),
    );
    assert.equal(codes.filter((c) => c === 0).length, 1, String(codes));
    assert.equal(codes.filter((c) => c === 3).length, 7, String(codes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caller: a write whose guard fails (the lock lost) halts and sends nothing", async () => {
  const client = fakeClient({ "roadmap.version": rev, "session.create": { ok: true, value: { sessionId: "ses_own" } } });
  const halt = createHalt();
  let lost = null;
  const c = createCaller({ client, pluginId: "plg", projectId: "prj_e2e", halt, timeoutMs: 1_000, writeGuard: () => lost });
  await c.call("session.create", { title: "[e2e] a" });
  lost = "the sandbox E2E lock is no longer held by this run";
  const sent = client.sent.length;
  await assert.rejects(c.call("session.create", { title: "[e2e] b" }), /refused: the run is halted/);
  assert.equal(halt.reason, lost);
  assert.equal(client.sent.filter((x) => x.method === "session.create").length, 1);
  assert.ok(client.sent.length <= sent + 1, "at most the revision read went out");
});

test("sources: the parent takes the lock before the sandbox and the worker refuses without it", () => {
  const run = readFileSync(path.join(here, "run.mjs"), "utf8");
  const parent = run.slice(run.indexOf("if (process.env.PASEO_HOME !== PASEO_HOME)"));
  assert.ok(parent.indexOf("acquireLock(RUN_LOCK") < parent.indexOf("sandboxEnv()"), "lock before the sandbox environment");
  assert.ok(parent.indexOf("acquireLock(RUN_LOCK") < parent.indexOf("spawn(process.execPath"), "lock before the worker");
  assert.match(parent, /releaseLock\(RUN_LOCK, nonce\)/);
  assert.ok(!/unlinkSync|rmSync/.test(run), "run.mjs deletes nothing");
  const main = run.slice(run.indexOf("async function main()"), run.indexOf("if (process.env.PASEO_HOME !== PASEO_HOME)"));
  assert.ok(main.indexOf("safety(args.rev") > 0 && main.indexOf("holdsLock(RUN_LOCK, token)") < main.indexOf("safety(args.rev"), "the worker checks the lock before the sandbox");
  assert.match(main, /writeGuard: lockLost/);
});

test("sink: a dropped request is recorded by method and target only, never its query", () => {
  assert.deepEqual(proxyTarget("CONNECT fonts.example:443 HTTP/1.1"), { method: "CONNECT", target: "fonts.example:443" });
  assert.deepEqual(proxyTarget("GET http://127.0.0.1:6000/a/b?token=secret#x HTTP/1.1"), { method: "GET", target: "http://127.0.0.1:6000/a/b" });
  assert.deepEqual(proxyTarget("GET ws://127.0.0.1:6000/ws?k=v HTTP/1.1"), { method: "GET", target: "ws://127.0.0.1:6000/ws" });
  for (const junk of [null, "", "\u0016\u0003\u0001", "GET", "get http://x/ HTTP/1.1"]) assert.equal(proxyTarget(junk).method, null, String(junk));
  assert.ok(proxyTarget(`GET http://h/${"a".repeat(500)} HTTP/1.1`).target.length <= 200);
});

// ---- The drop sink's accounting (fake sockets: no listener, no network) ----

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const dropsOf = (ledger) => ({ attempts: ledger.attempts, targets: ledger.summary(), pending: ledger.pending });

test("sink: every accepted connection is recorded exactly once, however it ends", async () => {
  const ledger = createDropLedger();
  const conns = Array.from({ length: 7 }, () => new FakeSocket());
  for (const c of conns) handleSinkSocket(c, ledger, { timeoutMs: 30 });
  conns[0].emit("data", Buffer.from("CONNECT localhost:6879 HTTP/1.1\r\nHost: x\r\n\r\n"));
  conns[1].emit("close"); // closed before any byte
  conns[2].emit("data", Buffer.from("GET http://127.0.0.1:6886/x?t=1 HT")); // partial line, then closed
  conns[2].emit("close");
  conns[3].emit("error", new Error("ECONNRESET"));
  conns[4].emit("end");
  conns[5].emit("data", Buffer.from("\u0016\u0003\u0001".repeat(800))); // binary, no CRLF, over the line limit
  // conns[6] stays silent: the timer records it.
  await new Promise((r) => setTimeout(r, 80));
  await tick();
  // A second event after the first outcome changes nothing.
  conns[0].emit("close");
  conns[1].emit("data", Buffer.from("GET http://x/ HTTP/1.1\r\n"));
  const d = dropsOf(ledger);
  assert.equal(d.attempts, 7);
  assert.equal(ledger.recorded, 7);
  assert.equal(d.pending, 0);
  assert.deepEqual(Object.fromEntries(d.targets.map((t) => [t.target, t.count])), {
    "CONNECT localhost:6879": 1,
    [NO_LINE.closed]: 3,
    [NO_LINE.error]: 1,
    [NO_LINE.unreadable]: 1,
    [NO_LINE.silent]: 1,
  });
  assert.ok(conns.every((c) => c.destroyed), "every connection is dropped");
});

test("sink: beyond the record cap further distinct targets are counted under one overflow key", () => {
  const ledger = createDropLedger({ maxKeys: 3 });
  for (let i = 0; i < 10; i++) ledger.open()(`CONNECT 127.0.0.1:${7000 + i}`);
  for (let i = 0; i < 4; i++) ledger.open()("CONNECT 127.0.0.1:7000"); // an existing key keeps counting
  const d = dropsOf(ledger);
  assert.equal(d.attempts, 14);
  assert.equal(d.targets.reduce((n, t) => n + t.count, 0), 14);
  assert.equal(d.targets.find((t) => t.target === NO_LINE.overflow).count, 7);
  assert.equal(d.targets.find((t) => t.target === "CONNECT 127.0.0.1:7000").count, 5);
  assert.deepEqual(unexpectedDrops(d, ["CONNECT 127.0.0.1:7000", "CONNECT 127.0.0.1:7001", "CONNECT 127.0.0.1:7002"]), [{ target: NO_LINE.overflow, count: 7 }]);
});

test("sink: connections still open at teardown are recorded as such and fail the run", () => {
  const ledger = createDropLedger();
  ledger.open()("CONNECT localhost:6879");
  ledger.open(); // accepted, never finished
  assert.deepEqual(unexpectedDrops(dropsOf(ledger), EXPECTED_BLOCKED), [{ target: "(attempts not accounted for)", count: 1 }, { target: "(attempts still pending)", count: 1 }]);
  ledger.finalize();
  assert.deepEqual(unexpectedDrops(dropsOf(ledger), EXPECTED_BLOCKED), [{ target: NO_LINE.open, count: 1 }]);
});

test("drops: the named 6879 probes alone pass; any other, unknown or unaccounted attempt fails", () => {
  assert.deepEqual(EXPECTED_BLOCKED, ["CONNECT localhost:6879", "CONNECT 127.0.0.1:6879"]);
  const only6879 = { attempts: 90, pending: 0, targets: [{ target: "CONNECT localhost:6879", count: 87 }, { target: "CONNECT 127.0.0.1:6879", count: 3 }] };
  assert.deepEqual(unexpectedDrops(only6879, EXPECTED_BLOCKED), []);
  assert.deepEqual(unexpectedDrops({ attempts: 0, pending: 0, targets: [] }, EXPECTED_BLOCKED), []);
  // Mixed: the expected ones stay listed and distinguishable, the others fail.
  const mixed = { attempts: 95, pending: 0, targets: [...only6879.targets, { target: "CONNECT localhost:6887", count: 4 }, { target: NO_LINE.closed, count: 1 }] };
  assert.deepEqual(unexpectedDrops(mixed, EXPECTED_BLOCKED), [{ target: "CONNECT localhost:6887", count: 4 }, { target: NO_LINE.closed, count: 1 }]);
  for (const near of ["CONNECT localhost:68790", "CONNECT localhost:687", "GET http://localhost:6879/", "CONNECT [::1]:6879", "connect localhost:6879", NO_LINE.unreadable, NO_LINE.silent, NO_LINE.error, NO_LINE.overflow]) {
    assert.equal(unexpectedDrops({ attempts: 1, pending: 0, targets: [{ target: near, count: 1 }] }, EXPECTED_BLOCKED).length, 1, near);
  }
  // Counts that do not add up to the attempts fail even when every listed target is expected.
  assert.deepEqual(unexpectedDrops({ attempts: 92, pending: 0, targets: only6879.targets }, EXPECTED_BLOCKED), [{ target: "(attempts not accounted for)", count: 2 }]);
  for (const bad of [undefined, null, {}, { attempts: 1 }, { targets: [] }]) assert.equal(unexpectedDrops(bad, EXPECTED_BLOCKED).length, 1, JSON.stringify(bad));
});

test("drops: a request line maps to the exact expected key only for exactly that target", () => {
  assert.equal(lineKey("CONNECT localhost:6879 HTTP/1.1"), "CONNECT localhost:6879");
  assert.equal(lineKey("CONNECT 127.0.0.1:6879 HTTP/1.1"), "CONNECT 127.0.0.1:6879");
  assert.equal(lineKey("GET http://localhost:6879/ws?k=1 HTTP/1.1"), "GET http://localhost:6879/ws");
  assert.equal(lineKey("garbage"), NO_LINE.unreadable);
  assert.equal(lineKey(null), NO_LINE.unreadable);
});

test("sources: report.ok rests on the full drop verdict, and the proof on its canary targets", () => {
  const run = readFileSync(path.join(here, "run.mjs"), "utf8");
  assert.match(run, /report\.unexpectedDrops = unexpectedDrops\(report\.cleanup\.chrome\?\.drops, EXPECTED_BLOCKED\)/);
  assert.match(run, /report\.unexpectedDrops\.length === 0/);
  assert.ok(!/proxiedAttemptsDropped === 0|proxiedTargets\)/.test(run));
  const chrome = readFileSync(path.join(here, "lib", "chrome.mjs"), "utf8");
  assert.match(chrome, /handleSinkSocket\(socket, ledger\)/);
  assert.match(chrome, /ledger\.finalize\(\)/);
  const proof = readFileSync(path.join(here, "isolation-proof.mjs"), "utf8");
  assert.match(proof, /unexpectedDrops\(report\.cleanup\?\.drops/);
});

// ---- Findings of DeepSeek 01a1c96e (fakes and a stand-in process only) ----

test("provenance: an extra __proto__ or constructor file is reported and refused", () => {
  for (const name of ["__proto__", "constructor", "hasOwnProperty"]) {
    const { dir, binary, manifest } = fakeShell();
    try {
      writeFileSync(path.join(dir, name), "planted");
      assert.ok(Object.hasOwn(browserTree(dir), name), `${name} is an own entry`);
      assert.throws(() => withChrome(binary, () => browserBinary({ manifest })), new RegExp(`unexpected file ${name}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // A manifest never matches a prototype member either.
  const actual = Object.create(null);
  actual.__proto__ = { type: "file", sha256: "x", size: 1 };
  assert.deepEqual(manifestProblems({}, actual), ["unexpected file __proto__"]);
  assert.deepEqual(manifestProblems({ toString: ["x", 1] }, Object.create(null)), ["missing toString"]);
});

test("DevTools: a partially written endpoint file is not yet ready; a complete wrong one is refused", () => {
  const full = `/devtools/browser/${UUID}`;
  for (const cut of [1, 5, 18, 20, full.length - 1]) assert.equal(parseDevToolsActivePort(`41234\n${full.slice(0, cut)}`), null, full.slice(0, cut));
  assert.throws(() => parseDevToolsActivePort(`41234\n${full.slice(0, 20)}\n`), /unexpected DevTools browser path/, "a finished line is complete");
  assert.throws(() => parseDevToolsActivePort("41234\n/devtools/page/x"), /unexpected/);
  assert.throws(() => parseDevToolsActivePort(`41234\n/devtools/browser/${"z".repeat(5)}`), /unexpected/);
});

/** A harmless stand-in for the browser: /bin/sleep as the leader of its own process group. */
async function standIn() {
  const child = await spawnBrowser("/bin/sleep", ["30"], { stdio: "ignore", detached: true });
  return { pid: child.pid, port: null, endpoint: null, sink: null };
}
const gone = async (pid) => {
  for (let i = 0; i < 40 && groupAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !groupAlive(pid);
};
const fakeIo = (over) => ({
  readOrNull: (f) => (f.endsWith("DevToolsActivePort") ? `41234\n/devtools/browser/${UUID}` : null),
  listening: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:41234/devtools/browser/${UUID}`, Browser: "HeadlessChrome/fake" }),
  fetchJson: async (url) => (url.endsWith("/json/list") ? [{ type: "page", id: "A" }] : "Target is closing"),
  alive: () => true,
  sleep: async () => {},
  tries: 3,
  ...over,
});

test("startup: a /json/list or /json/close failure after spawn kills the browser group", async () => {
  for (const failing of ["/json/list", "/json/close"]) {
    const chrome = await standIn();
    const io = fakeIo({ fetchJson: async (url) => { if (url.includes(failing)) throw new Error(`${failing}: HTTP 500`); return url.endsWith("/json/list") ? [{ type: "page", id: "A" }] : ""; } });
    await assert.rejects(superviseStartup(chrome, () => adoptEndpoint(chrome, { profile: "/p", log: "/l" }, io)), new RegExp(failing));
    assert.equal(await gone(chrome.pid), true, `${failing}: the group is gone`);
  }
});

test("startup: an endpoint of another browser, a bad endpoint file or no endpoint at all kills the group", async () => {
  for (const io of [
    fakeIo({ listening: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:41234/devtools/browser/${UUID.replace("0f", "1f")}` }) }),
    fakeIo({ readOrNull: (f) => (f.endsWith("DevToolsActivePort") ? "6886\n/devtools/browser/x" : null) }),
    fakeIo({ readOrNull: () => null }),
    fakeIo({ fetchJson: async () => ({ not: "a list" }) }),
  ]) {
    const chrome = await standIn();
    await assert.rejects(superviseStartup(chrome, () => adoptEndpoint(chrome, { profile: "/p", log: "/l" }, io)));
    assert.equal(await gone(chrome.pid), true);
  }
});

test("startup: an interrupt while startup is still pending reaches the browser (killAllBrowsersNow)", async () => {
  const chrome = await standIn();
  let release;
  const pending = superviseStartup(chrome, () => new Promise((r) => (release = r)));
  assert.equal(liveBrowsers() >= 1, true);
  killAllBrowsersNow(); // what abort, a signal handler or the exit hook does
  assert.equal(await gone(chrome.pid), true);
  release();
  await pending;
  assert.equal(liveBrowsers(), 0);
});

test("startup: a successful adoption records the endpoint and closes only page tabs", async () => {
  const closed = [];
  const chrome = { pid: 1 };
  await adoptEndpoint(chrome, { profile: "/p", log: "/l" }, fakeIo({ fetchJson: async (url) => (url.endsWith("/json/list") ? [{ type: "page", id: "A" }, { type: "service_worker", id: "B" }] : (closed.push(url), "")) }));
  assert.equal(chrome.port, 41234);
  assert.equal(chrome.endpoint, `ws://127.0.0.1:41234/devtools/browser/${UUID}`);
  assert.deepEqual(closed, ["http://127.0.0.1:41234/json/close/A"]);
});

test("lock: a failed write or fsync after the exclusive create removes the half-made lock", () => {
  const dir = lockDir();
  const file = path.join(dir, "e2e-run.lock");
  try {
    for (const io of [
      { writeSync: () => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); }, fsyncSync: () => {} },
      { writeSync: () => 1, fsyncSync: () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } },
    ]) {
      assert.throws(() => acquireLock(file, { token: newLockToken(), runId: "x" }, io), /ENOSPC|EIO/);
      assert.equal(inspectLock(file).state, "absent");
    }
    // The cleanup is only for the file this call created: an existing lock is still untouched.
    const t = newLockToken();
    acquireLock(file, { token: t, runId: "held" });
    assert.throws(() => acquireLock(file, { token: newLockToken(), runId: "x" }, { writeSync: () => { throw new Error("never reached"); }, fsyncSync: () => {} }), LockBusy);
    assert.equal(holdsLock(file, t), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("containment: a path counts as inside only when it really is under the sandbox", () => {
  assert.equal(insideDir("/s/runtime/paseo-home", "/s"), true);
  assert.equal(insideDir("/s", "/s"), true);
  for (const p of ["/s2/x", "/x", "/s/../x", "/", "/Users/me/.paseo"]) assert.equal(insideDir(path.resolve(p), "/s"), false, p);
});

test("--only: a journey cannot be selected without the journey it needs", () => {
  const ids = ["j1", "j2", "j3", "j4"];
  const needs = { j3: ["j2"], j4: ["j2"] };
  assert.throws(() => selectJourneys("j3", ids, needs), /j3 needs j2/);
  assert.throws(() => selectJourneys("j1,j4", ids, needs), /j4 needs j2/);
  assert.deepEqual(selectJourneys("j4,j2", ids, needs), ["j2", "j4"]);
  assert.deepEqual(selectJourneys(undefined, ids, needs), ids);
});

test("sources: the fixes are wired where they act", () => {
  const run = readFileSync(path.join(here, "run.mjs"), "utf8");
  const proof = readFileSync(path.join(here, "isolation-proof.mjs"), "utf8");
  const sandbox = readFileSync(path.join(here, "lib", "sandbox.mjs"), "utf8");
  // The browser is recorded at spawn, and every stop path kills all registered browsers.
  assert.match(run, /onSpawn: \(spawned\) => \{\s+chrome = spawned;/);
  assert.equal((run.match(/killAllBrowsersNow\(\)/g) ?? []).length >= 3, true);
  assert.ok(!/killChromeNow\(chrome\)/.test(run));
  assert.match(run, /mode: 0o700/);
  assert.match(run, /E2E_SANDBOX: SANDBOX/);
  assert.match(run, /JOURNEY_NEEDS = \{ j3: \["j2"\], j4: \["j2"\] \}/);
  // j3 asserts the detail's own relation rows, not page-wide text.
  assert.match(run, /Q1_LEADS_TO_Q3 = "Q3 Which database engine\? · activated by it when Database"/);
  assert.match(run, /Q3_COMES_AFTER_Q1 = "Q1 Where is the data stored\? · activates it when Database"/);
  assert.ok(!/\/Comes after\/\.test|\/Leads to\/\.test/.test(run));
  // The proof cleans up on interrupts and exit too.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.match(proof, new RegExp(sig));
  assert.match(proof, /process\.once\("exit", \(\) => killAllBrowsersNow\(\)\)/);
  assert.match(proof, /onSpawn: \(spawned\) => \(chrome = spawned\)/);
  // The sandbox tool no longer blocks the event loop, and paths are contained by real path.
  assert.ok(!/spawnSync/.test(sandbox));
  assert.match(sandbox, /insideDir\(real, SANDBOX\)/);
});

// ---- The sandbox tool runner (stand-in shell scripts; their sleeps are in the tool's own group) ----

function standInTool(body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-tool-"));
  const file = path.join(dir, "tool.sh");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return { dir, file };
}
const groupGone = async (pid) => {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test("tool: a timeout kills the tool and its grandchild (which holds the pipes) and settles within the bound", async () => {
  const { dir, file } = standInTool("( sleep 30 ) &\necho started\nexec sleep 30");
  try {
    // 1500 ms: the stand-in shell must get to print "started" first even on a loaded host (300 ms
    // was missed there right after a full test run); the bound below still proves the kill.
    const r = await runBounded(file, [], { timeoutMs: 1500, graceMs: 200 });
    assert.equal(r.status, null);
    assert.match(r.error, /no result within 1500 ms/);
    assert.match(r.text, /started/);
    assert.ok(r.ms < 1500 + 200 + 400, `settled in ${r.ms} ms`);
    assert.equal(await groupGone(r.pid), true, "the tool's whole group is gone");
    assert.equal(runningCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool: a tool that exits leaving a grandchild on its pipes settles after the grace, not at the grandchild's end", async () => {
  const { dir, file } = standInTool("( sleep 30 ) &\necho done\necho warn >&2\nexit 0");
  try {
    const r = await runBounded(file, [], { timeoutMs: 5_000, graceMs: 200 });
    assert.equal(r.status, 0);
    assert.equal(r.error, null);
    assert.match(r.text, /done/);
    assert.match(r.text, /warn/);
    assert.equal(r.lingering, true, "the leftover grandchild is reported");
    assert.ok(r.ms < 1_500, `settled in ${r.ms} ms`);
    assert.equal(await groupGone(r.pid), true, "and killed with the rest of the tool's group");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool: a clean tool reports its status and output, with nothing lingering", async () => {
  const { dir, file } = standInTool("echo ok\nexit 3");
  try {
    const r = await runBounded(file, [], { timeoutMs: 5_000, graceMs: 200 });
    assert.deepEqual({ status: r.status, error: r.error, lingering: r.lingering, text: r.text }, { status: 3, error: null, lingering: false, text: "ok\n" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool: an abort (killRunningNow) kills only the running tools' groups; an unrelated process survives", async () => {
  const { dir, file } = standInTool("( sleep 30 ) &\nexec sleep 30");
  // Our own unrelated process, outside the tool's group: it must survive the abort.
  const bystander = spawnProcess("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    const run = runBounded(file, [], { timeoutMs: 30_000, graceMs: 200 });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(runningCount(), 1);
    killRunningNow();
    const r = await run;
    assert.match(r.error ?? "", /ended by SIGKILL/);
    assert.ok(r.ms < 1_500, `settled in ${r.ms} ms`);
    assert.equal(await groupGone(r.pid), true);
    assert.equal(runningCount(), 0);
    process.kill(bystander.pid, 0); // still alive (throws otherwise)
  } finally {
    bystander.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool: a missing tool settles with an error instead of throwing", async () => {
  const r = await runBounded("/nonexistent-e2e-guards/paseo-fd-test", ["check"], { timeoutMs: 1_000 });
  assert.equal(r.status, null);
  assert.match(r.error, /ENOENT/);
  assert.equal(runningCount(), 0);
});

test("sources: the sandbox tool uses the bounded group runner", () => {
  const sandbox = readFileSync(path.join(here, "lib", "sandbox.mjs"), "utf8");
  assert.match(sandbox, /runBounded\(path\.join\(SANDBOX, "bin", "paseo-fd-test"\), args, \{ timeoutMs \}\)/);
  assert.ok(!/\bspawn\(/.test(sandbox));
  const proc = readFileSync(path.join(here, "lib", "proc.mjs"), "utf8");
  assert.match(proc, /detached: true/);
  assert.ok(!/process\.kill\(pid|process\.kill\(child\.pid/.test(proc), "only negative (group) pids are signalled");
});
