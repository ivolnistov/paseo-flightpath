// The harness's safety decisions as pure functions, with no I/O, so they can be checked without a
// browser, a host or a daemon (e2e/guards.test.mjs). Every other module calls these.
import path from "node:path";

export const E2E_PREFIX = "[e2e] ";
export const READS = new Set(["roadmap.version", "roadmap.overview", "session.get"]);
/** No relation-creating write is allowed: the journeys do not need one. */
export const WRITES = new Set(["session.create", "question.create", "question.answer", "block.accept"]);
/** Binding a planner: allowed only for a run that names its inert fixture agent, and only that agent. */
export const PLANNER_WRITE = "session.planner.set";
export const isWrite = (method) => WRITES.has(method) || method === PLANNER_WRITE;
/** Ports the harness must never drive or share: the user's host and the sandbox itself. */
export const FORBIDDEN_PORTS = new Set([6886, 6887]);
/**
 * The browser: the Chrome for Testing headless shell already in the puppeteer cache (never branded
 * Chrome, never installed or modified by the harness). E2E_CHROME may name another headless shell.
 */
export const HEADLESS_SHELL = "/Users/example/.cache/puppeteer/chrome-headless-shell/mac_arm-156.0.8078.47/chrome-headless-shell-mac-arm64/chrome-headless-shell";

/**
 * Provenance of the headless shell: SHA-256 and size of every file in its directory (it loads its
 * dylibs, .pak files and resources from there), recorded from the local puppeteer cache on
 * 2026-11-11. The binary is ad-hoc signed (codesign: Identifier=headless_shell, Signature=adhoc,
 * no TeamIdentifier), so there is no signer to verify; these hashes are the identity. They were
 * not compared with Google's published checksums (that needs the network).
 */
export const HEADLESS_SHELL_MANIFEST = Object.freeze({
  ABOUT: ["34d078ce3003087a8374e7c6156fda374769b8047d6ddaf419d66414aa48edfb", 248],
  "LICENSE.headless_shell": ["a2196c2e406ebe900cd6403a033935ecc641a971b7f2a57bd8c24afa9574e492", 2151339],
  "chrome-headless-shell": ["3c3950c515a97109e1220670ecc31c1f73605ed8379e36a45d1bee064a991162", 177028368],
  "headless_command_resources.pak": ["4eecdc01a7158a78f68b6b20f1452586aa04d2ed2e1b56084c55d51ec3f31707", 3109],
  "headless_lib_data.pak": ["0f1fc97ff0b87cd4871bd1d122893a805fcfbe98824971c2884d3cc4f966f46a", 730161],
  "headless_lib_strings.pak": ["27c7bccc9466080a66908f94d11c640a453f4a619f31683f80d8ccd2c6dd9d1c", 5021252],
  "icudtl.dat": ["02a01b3188b6a41a756f7322fdb5e6b5ca6573b327b01dfc8ed662d571a6f769", 10824432],
  "libEGL.dylib": ["8b7e5b3ebed9cd5fc1cde7ff1458fd5eb150d496d7474e13f963d43546c08aeb", 736],
  "libGLESv2.dylib": ["7765bf768e52ced295a67cb362e3ca9714e64208e6ecea4e67e5b4b85e094934", 736],
  "libvk_swiftshader.dylib": ["2655fb354356ab6c0089af88a0501f5d7ff630edcdcd92a8eba2b33c3ff5a5fa", 16326576],
  "libvulkan.dylib": ["a23e1ee938c78bf6d098924297801073d4ba8adc8a13088eb40848ad316b0dc3", 499488],
  "resources/accessibility/reading_mode_gdocs_helper/content.js": ["6c0aeaaf9a71ad68aa45764c111e70bb23aa0fbf406644a375b6b709cbbe4b6e", 439],
  "resources/accessibility/reading_mode_gdocs_helper/gdocs_script.js": ["d291adabcfcb1a4a4a2ffacdd9d04fdb473ab0d6903556bef7446be9c3646d86", 1425],
  "resources/accessibility/reading_mode_gdocs_helper_manifest.json": ["355474bb5dc316273045a7081e5a4868d43c22021942c863d8d7f50144d894c3", 2375],
  "v8_context_snapshot.arm64.bin": ["e864c5b2224120d92461567788568a23459147d4fc1db29a2f8a66d7b56e79a1", 753112],
  "vk_swiftshader_icd.json": ["d717d915e31e7c27948b80b36ab34e2d897888114c5c7d0af835f93eb53e58f5", 110],
});

/**
 * Differences between the pinned manifest and what a browser directory holds: `actual` maps each
 * relative path to { type: "file" | "symlink" | "other", sha256?, size? }. Empty means identical;
 * any extra, missing, changed, linked or special entry is a difference.
 */
export function manifestProblems(expected, actual) {
  const problems = [];
  for (const [rel, [sha, size]] of Object.entries(expected)) {
    const a = Object.hasOwn(actual, rel) ? actual[rel] : undefined;
    if (!a) problems.push(`missing ${rel}`);
    else if (a.type !== "file") problems.push(`${rel} is a ${a.type}, not a regular file`);
    else if (a.size !== size || a.sha256 !== sha) problems.push(`${rel} differs (size ${a.size}, sha256 ${a.sha256})`);
  }
  for (const rel of Reflect.ownKeys(actual)) {
    if (typeof rel !== "string") problems.push("unexpected non-string entry");
    else if (!Object.hasOwn(expected, rel)) problems.push(`unexpected ${actual[rel]?.type ?? "entry"} ${rel}`);
  }
  return problems;
}

/**
 * What a dropped proxy request asked for, from its first line only: the method and the target's
 * scheme, host, port and path, with any query or fragment removed. Nothing is forwarded.
 */
export function proxyTarget(firstLine) {
  const m = typeof firstLine === "string" ? firstLine.match(/^([A-Z]{3,10}) (\S+) HTTP\/\d(?:\.\d)?$/) : null;
  if (!m) return { method: null, target: "(no readable request line)" };
  const [, method, raw] = m;
  if (method === "CONNECT") return { method, target: raw.slice(0, 200) };
  try {
    const u = new URL(raw);
    return { method, target: `${u.protocol}//${u.host}${u.pathname}`.slice(0, 200) };
  } catch {
    return { method, target: raw.split(/[?#]/)[0].slice(0, 200) };
  }
}

/**
 * Dropped attempts the run expects and accepts, by exact "METHOD target": the Paseo web UI probes
 * the default daemon port 6879 as a connection hint. On the development host the user's own Paseo
 * daemon listens there, which is exactly why it must stay blocked. Any other dropped target fails.
 */
export const EXPECTED_BLOCKED = Object.freeze(["CONNECT localhost:6879", "CONNECT 127.0.0.1:6879"]);

/** Whether DevTools offered exactly the page socket of `target` on the run's own endpoint port. */
export function pageSocketOk(target, port) {
  return !!target && typeof target.id === "string" && /^[0-9A-F]{32}$/i.test(target.id) && target.webSocketDebuggerUrl === `ws://127.0.0.1:${port}/devtools/page/${target.id}`;
}

/** Refuses anything but an absolute, whitespace-free path to a `chrome-headless-shell` binary outside an app bundle. */
export function checkBrowserPath(binary) {
  if (typeof binary !== "string" || !path.isAbsolute(binary)) throw new Error("the browser must be an absolute path");
  if (/\s/.test(binary)) throw new Error("the browser path may not contain whitespace");
  if (path.basename(binary) !== "chrome-headless-shell" || /\.app\//.test(binary)) throw new Error(`only a chrome-headless-shell binary is allowed, not ${binary}`);
  return binary;
}

/**
 * Reads the sandbox's `check` and `probe --read` output. Passed only when both exited 0, their
 * pass lines are present, nothing failed, every socket line reports exactly 0 outbound, every agent
 * line exactly 0 agents, and the plugin answering is proven to run `rev` (also the staged rev).
 */
export function parseSafety({ checkText, checkStatus, probeText, probeStatus, stagedRev, rev, inertProvider = null, inertMax = 0 }) {
  const lines = `${checkText ?? ""}\n${probeText ?? ""}`.split("\n").map((l) => l.trim());
  const sockets = lines.filter((l) => /network sockets:/.test(l));
  const agents = lines.filter((l) => /agents \(including archived\):/.test(l));
  const proven = lines.filter((l) => /proven to run the staged/.test(l));
  const failures = lines.filter((l) => /^(fail|FAIL|error|ERROR)\b/.test(l) || /: FAILED\b/.test(l) || /->\s*not ok\b/.test(l));
  const servedRevs = [...new Set(proven.map((l) => l.match(/proven to run the staged ([0-9a-f]{40})$/)?.[1] ?? "unparsed"))];
  const result = {
    runtimePassed: checkStatus === 0 && /safety-check --runtime: passed/.test(checkText ?? ""),
    probePassed: probeStatus === 0 && /rpc-probe: passed/.test(probeText ?? ""),
    // Exact: "ok network sockets: N; listening only on loopback …; 0 outbound" and nothing after.
    loopbackOnly: sockets.length > 0 && sockets.every((l) => /^ok\s+network sockets: \d+; listening only on loopback [^;]*; 0 outbound$/.test(l)),
    // 0 agents; or, only for a run that names the sandbox's inert fixture, up to inertMax agents all on it.
    agents: agents.length > 0 && agents.every((l) => /^ok\s+agents \(including archived\): 0$/.test(l) || inertAgentsLine(l, inertProvider, inertMax)),
    servedRev: servedRevs.length === 1 && servedRevs[0] !== "unparsed" ? servedRevs[0] : null,
    stagedRev: stagedRev ?? null,
    failures,
    evidence: [...lines.filter((l) => /^ok\s+(versions|processes|network|agents|loaded plugin)/.test(l)), ...proven, ...lines.filter((l) => /roadmap\.version ->/.test(l))],
  };
  result.passed =
    /^[0-9a-f]{40}$/.test(rev ?? "") &&
    result.runtimePassed &&
    result.probePassed &&
    result.loopbackOnly &&
    result.agents &&
    failures.length === 0 &&
    result.servedRev === rev &&
    result.stagedRev === rev;
  return result;
}

/** "ok agents (including archived): N, every one on the inert e2e provider <id>" with 1 <= N <= max. */
function inertAgentsLine(line, provider, max) {
  if (typeof provider !== "string" || !/^[a-z][a-z0-9-]*$/.test(provider) || !(Number.isInteger(max) && max > 0)) return false;
  const m = line.match(/^ok\s+agents \(including archived\): (\d+), every one on the inert e2e provider ([a-z0-9-]+)$/);
  return m !== null && m[2] === provider && Number(m[1]) >= 1 && Number(m[1]) <= max;
}

/** Every value under a key named `key`, at any depth (relations name sessions inside nested objects). */
function valuesOf(value, key, out = []) {
  if (Array.isArray(value)) for (const v of value) valuesOf(v, key, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === key) out.push(v);
      valuesOf(v, key, out);
    }
  }
  return out;
}

/**
 * The exact input sent for an RPC, or a thrown refusal. The project is always the pinned one (an
 * input may not name another, at any depth); writes are WRITES only; a new session must be titled
 * "[e2e] …"; every other write, and every session it names anywhere (a relation's parent
 * included), must be a session this run created.
 */
export function buildRpcInput(method, input, { projectId, owned, plannerAgentId = null }) {
  if (method === PLANNER_WRITE) {
    if (typeof plannerAgentId !== "string" || plannerAgentId === "") throw new Error(`${method} is not allowed without the run's inert fixture agent`);
    if (!input || typeof input !== "object" || input.agentId !== plannerAgentId) throw new Error(`${method} may bind only the run's inert fixture agent ${plannerAgentId}`);
  } else if (!READS.has(method) && !WRITES.has(method)) throw new Error(`${method} is not allowed`);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${method}: input must be an object`);
  if (typeof projectId !== "string" || projectId === "") throw new Error("no pinned project");
  for (const p of valuesOf(input, "projectId")) if (p !== projectId) throw new Error(`${method}: another project (${String(p)}) is refused`);
  if (isWrite(method)) {
    if (method === "session.create") {
      if (typeof input.title !== "string" || !input.title.startsWith(E2E_PREFIX)) throw new Error("only [e2e] sessions may be created");
      if (valuesOf(input, "sessionId").length > 0) throw new Error("session.create may not name a session");
    } else {
      const named = valuesOf(input, "sessionId");
      if (typeof input.sessionId !== "string") throw new Error(`${method} needs a sessionId`);
      for (const s of named) if (!owned.has(s)) throw new Error(`${method} names a session this run did not create (${String(s)})`);
    }
  }
  return { ...input, projectId };
}

/** Whether `child` is `parent` or lies under it (both absolute, already resolved). */
export function insideDir(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Rejects after `ms` with a message naming `what`; the timer never keeps the process alive. */
export function withTimeout(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no result within ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Chrome's arguments and environment. Its HOME (and CoreFoundation's home) is a directory the run
 * owns; it is refused when it is, or contains, the invoking user's home. The keychain is mocked,
 * and every connection Chrome makes that is not to loopback goes to the harness's own sink proxy.
 * Host rules alone would not stop an IP literal, hence the proxy; link-local and QUIC/WebRTC caveats
 * are recorded in the report.
 */
export function chromeLaunchPlan({ binary, dir, sinkPort, userHome, allowed, lang = "en_US.UTF-8" }) {
  checkBrowserPath(binary);
  if (allowed?.host !== "127.0.0.1") throw new Error("the only allowed origin host is 127.0.0.1");
  if (!Number.isInteger(allowed.port) || allowed.port < 1024 || allowed.port > 65535 || allowed.port === 6886 || allowed.port === sinkPort) throw new Error(`refusing allowed origin port ${allowed?.port}`);
  if (!Number.isInteger(sinkPort) || sinkPort < 1024 || sinkPort > 65535 || FORBIDDEN_PORTS.has(sinkPort)) throw new Error(`refusing sink port ${sinkPort}`);
  if (!path.isAbsolute(dir ?? "")) throw new Error("the run directory must be absolute");
  if (/\s/.test(dir)) throw new Error("the run directory may not contain whitespace");
  if (!path.isAbsolute(userHome ?? "")) throw new Error("the user's home must be known");
  const run = path.resolve(dir);
  const home = path.join(run, "home");
  const user = path.resolve(userHome);
  const inside = (a, b) => a === b || a.startsWith(`${b}${path.sep}`);
  if (inside(user, run) || inside(user, home) || run === path.parse(run).root) throw new Error(`refusing a Chrome home that is, or contains, the user's home (${user})`);
  const args = [
    "--headless",
    // Port 0: the browser picks a free port and writes it, with its own unique socket path, to
    // <profile>/DevToolsActivePort; the run drives only that endpoint (no fixed, shared port).
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${path.join(run, "profile")}`,
    "--use-mock-keychain",
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--no-pings",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-background-networking",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,CertificateTransparencyComponentUpdater",
    `--proxy-server=http://127.0.0.1:${sinkPort}`,
    // "<-loopback>" removes Chrome's implicit loopback bypass; only the sandbox origin goes direct,
    // under both names the Paseo web UI uses for it (127.0.0.1 and localhost).
    `--proxy-bypass-list=<-loopback>;127.0.0.1:${allowed.port};localhost:${allowed.port}`,
    // localhost resolves to 127.0.0.1 only (never ::1); every other name resolves to nothing.
    "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ];
  const env = { HOME: home, CFFIXED_USER_HOME: home, TMPDIR: `${path.join(run, "tmp")}/`, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: lang };
  return { binary, args, env, home, profile: path.join(run, "profile"), dirs: [home, path.join(run, "tmp"), path.join(run, "profile")] };
}

/**
 * The DevTools endpoint the run's own browser wrote into its fresh profile: a loopback port that
 * is neither the user's host nor the sandbox, and the browser's unique socket path. Anything else
 * is refused (null while the file is incomplete).
 */
export function parseDevToolsActivePort(text) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n").map((l) => l.trim());
  if (lines.length < 2 || lines[0] === "" || lines[1] === "") return null;
  const port = Number(lines[0]);
  if (!/^\d+$/.test(lines[0]) || port < 1024 || port > 65535 || FORBIDDEN_PORTS.has(port)) throw new Error(`refusing DevTools port ${lines[0]}`);
  if (!/^\/devtools\/browser\/[0-9a-f-]{36}$/.test(lines[1])) {
    // A read that overlaps the browser's write sees a prefix of the path: not yet, not an error.
    const full = "/devtools/browser/";
    const partial = lines[1].length < full.length + 36 && (full.startsWith(lines[1]) || (lines[1].startsWith(full) && /^[0-9a-f-]*$/.test(lines[1].slice(full.length))));
    if (partial && !text.endsWith("\n")) return null;
    throw new Error(`unexpected DevTools browser path ${lines[1]}`);
  }
  return { port, path: lines[1], url: `ws://127.0.0.1:${port}${lines[1]}` };
}

/**
 * The same endpoint from the browser's own stderr line ("DevTools listening on ws://…"), read from
 * the run's own new chrome.log; it must name 127.0.0.1 and pass the same checks. Exactly one such
 * line may exist (a reused log would carry two).
 */
export function parseDevToolsListening(logText) {
  if (typeof logText !== "string") return null;
  const found = [...logText.matchAll(/DevTools listening on (ws:\/\/[^\s]+)/g)].map((m) => m[1]);
  if (found.length === 0) return null;
  if (found.length > 1) throw new Error("more than one DevTools endpoint in the run's log");
  const m = found[0].match(/^ws:\/\/127\.0\.0\.1:(\d+)(\/devtools\/browser\/[0-9a-f-]{36})$/);
  if (!m) throw new Error(`refusing DevTools endpoint ${found[0]}`);
  return parseDevToolsActivePort(`${m[1]}\n${m[2]}`);
}

/** Whether /json/version on that port answers for exactly this browser (its unique socket URL). */
export function endpointMatches(version, active) {
  return !!version && !!active && version.webSocketDebuggerUrl === active.url;
}

/**
 * The run's identity: a timestamp and a random suffix, so two runs started in the same second
 * never share an output directory, a profile or fixture titles.
 */
export function newRunId(now = new Date(), random = Math.random) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const suffix = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)]).join("");
  return `${stamp}-${suffix}`;
}
export const RUN_ID = /^\d{8}-\d{6}-[a-z0-9]{6}$/;

/**
 * What a journey needs from the host beyond the sandbox: plugin subscriptions (daemon
 * defineSubscription and app useSubscription), the composer API (useComposers), or the named inert
 * fixture agent. j9 is the fallback check and needs a host WITHOUT subscriptions; so does j4, whose
 * two-tab revision conflict only arises while the second tab is stale: with live revision events
 * that tab is refreshed first and its Add lands once without a conflict (observed on 0.16).
 */
export const JOURNEY_HOST = Object.freeze({
  j4: { subscriptions: false },
  j5: { subscriptions: true },
  j6: { composers: true, inertAgent: true },
  j7: { composers: true, inertAgent: true },
  j8: { composers: true, inertAgent: true },
  j9: { subscriptions: false },
});

/** The host's capabilities from its installed plugin SDK's shared and client entry sources. */
export function sdkCapabilities(sharedSource, clientSource) {
  const has = (text, name) => typeof text === "string" && new RegExp(`\\b${name}\\b`).test(text);
  return { subscriptions: has(sharedSource, "defineSubscription") && has(clientSource, "useSubscription"), composers: has(clientSource, "useComposers") };
}

/** Why journey `id` cannot run on a host with `caps` (and the run's named inert agent, or none); null when it can. */
export function hostMismatch(id, caps, { inertAgent = false } = {}) {
  const need = JOURNEY_HOST[id];
  if (need === undefined) return null;
  if (need.subscriptions === true && caps?.subscriptions !== true) return "needs a host with plugin subscriptions";
  if (need.subscriptions === false && caps?.subscriptions !== false) return "needs a host without plugin subscriptions";
  if (need.composers === true && caps?.composers !== true) return "needs a host with the composer API";
  if (need.inertAgent === true && inertAgent !== true) return "needs --inert-agent <id>";
  return null;
}

/**
 * The journeys to run on this host. Without --only: every journey the host and the run can serve
 * (so a default run never mixes j5 and j9). With --only: exactly those, refused as a whole when any
 * of them cannot run here.
 */
export function selectForHost(only, ids, requires, caps, opts = {}) {
  const picked = selectJourneys(only, ids, requires);
  if (only === undefined) return picked.filter((id) => hostMismatch(id, caps, opts) === null);
  const refused = picked.map((id) => [id, hostMismatch(id, caps, opts)]).filter(([, why]) => why !== null);
  if (refused.length > 0) throw new Error(`not for this host: ${refused.map(([id, why]) => `${id} ${why}`).join("; ")}`);
  return picked;
}

/** The journeys `--only` selects: every id must exist; empty, valueless or unknown selections are refused. */
export function selectJourneys(only, ids, requires = {}) {
  if (only === undefined) return [...ids];
  if (typeof only !== "string" || only === "true" || only.trim() === "") throw new Error("--only needs a comma-separated list of journey ids");
  const picked = only.split(",").map((x) => x.trim());
  const unknown = picked.filter((x) => !ids.includes(x));
  if (unknown.length > 0 || picked.some((x) => x === "")) throw new Error(`--only names unknown journeys: ${unknown.join(", ") || "(empty)"}; known: ${ids.join(", ")}`);
  const missing = picked.flatMap((x) => (requires[x] ?? []).filter((r) => !picked.includes(r)).map((r) => `${x} needs ${r}`));
  if (missing.length > 0) throw new Error(`--only leaves out a journey another one needs: ${missing.join(", ")}`);
  return ids.filter((x) => picked.includes(x));
}

/**
 * Whether a process's command line is exactly this run's browser: it starts with the run's binary
 * and carries, as a whole argument, the run's own profile directory. Paths are whitespace-free
 * (checkBrowserPath, chromeLaunchPlan), so splitting on spaces is exact.
 */
export function ownsBrowserProcess({ command, binary, profile }) {
  if (typeof command !== "string" || typeof binary !== "string" || typeof profile !== "string" || /\s/.test(binary) || /\s/.test(profile) || profile === "") return false;
  const tokens = command.trim().split(/\s+/);
  return tokens[0] === binary && tokens.filter((t) => t === `--user-data-dir=${profile}`).length === 1 && tokens.filter((t) => t.startsWith("--user-data-dir=")).length === 1;
}

/** Whether a call may still be sent: before a halt any call; after it, only reads marked final. */
export function callAllowed(haltReason, method, final) {
  if (!haltReason) return true;
  return final === true && READS.has(method);
}

/**
 * A run-wide stop shared by the RPC client, the steps and the journeys: the first reason wins and
 * `onHalt` runs once (it kills the browser, so no UI action can write afterwards).
 */
export function createHalt(onHalt = () => {}) {
  const halt = {
    reason: null,
    trigger(why) {
      if (halt.reason) return false;
      halt.reason = why;
      onHalt(why);
      return true;
    },
  };
  return halt;
}

/** What a transcript entry without an answer means: a write may or may not have applied. */
export function unansweredOutcome(write) {
  return write ? "ambiguous: sent, no answer; the write may or may not have applied" : "no answer (read)";
}

/**
 * j4's verdict. A conflict is shown only when the UI said so, the draft survived, tab B's first Add
 * wrote nothing (revision unchanged, no copy), and the retry added exactly one copy. Anything else
 * is inconclusive or a failure, never a pass.
 */
export function classifyConflict({ noticeShown, draftKept, revisionBeforeAdd, revisionAfterFirstAdd, copiesAfterFirstAdd, copiesAfterRetry }) {
  if (!noticeShown) return { verdict: "inconclusive", reason: "no revision-conflict notice was shown" };
  if (!draftKept) return { verdict: "fail", reason: "the draft was lost" };
  if (revisionAfterFirstAdd !== revisionBeforeAdd || copiesAfterFirstAdd !== 0) return { verdict: "fail", reason: "the conflicting Add wrote to the store" };
  if (copiesAfterRetry !== 1) return { verdict: "fail", reason: `${copiesAfterRetry} copies after the retry` };
  return { verdict: "revision_conflict" };
}

/**
 * Go to's verdict from the target's visibility before and after the press: the target must end
 * genuinely visible (at least half inside every clip, hit-testable), and Go to must have done
 * something: the target was not visible before, or it moved at least `minMove` px.
 */
export function goToVerdict(before, after, minMove = 8) {
  const visible = (v) => !!v && v.found === 1 && v.fraction >= 0.5 && v.hit === true;
  if (!visible(after)) return { verdict: "fail", reason: "the target is not genuinely visible after Go to" };
  if (!visible(before)) return { verdict: "pass", reason: "brought into view" };
  const moved = before.rect && after.rect ? Math.hypot(after.rect.x - before.rect.x, after.rect.y - before.rect.y) : 0;
  if (moved >= minMove) return { verdict: "pass", reason: `already visible, moved ${Math.round(moved)} px` };
  return { verdict: "inconclusive", reason: "the target was already visible and did not move" };
}

/**
 * How much of `rect` is visible (0…1) once clipped by the viewport and every clipping ancestor's
 * rectangle. Self-contained so it can also run inside the page (Function.prototype.toString).
 */
export function visibleFraction(rect, clips, viewport) {
  let l = Math.max(rect.x, 0);
  let t = Math.max(rect.y, 0);
  let r = Math.min(rect.x + rect.w, viewport.w);
  let b = Math.min(rect.y + rect.h, viewport.h);
  for (const c of clips) {
    l = Math.max(l, c.x);
    t = Math.max(t, c.y);
    r = Math.min(r, c.x + c.w);
    b = Math.min(b, c.y + c.h);
  }
  const area = rect.w * rect.h;
  if (!(area > 0) || r <= l || b <= t) return { fraction: 0, centre: null };
  return { fraction: ((r - l) * (b - t)) / area, centre: { x: (l + r) / 2, y: (t + b) / 2 } };
}
