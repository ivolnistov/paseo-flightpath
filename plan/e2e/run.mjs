#!/usr/bin/env node
// Decision Roadmap end-to-end journeys through the real UI of the isolated offline Paseo sandbox:
// the Chrome for Testing headless shell (real mouse, touch and key events) → the Paseo web UI → the plugin's RPCs → the
// synthetic project's store. No live planner, agent, network beyond loopback, or real data.
//
// Usage (the sandbox must already run the revision under test; the harness never starts, stops or
// refreshes it):
//   node e2e/run.mjs --rev <40-hex staged revision> [--out <new dir>] [--only j1,j2,j3,j4] [--max-minutes 20]
//
// What it does, in order:
// 1. The sandbox's own safety check and read-only probe: runtime check passed, 0 agents, loopback
//    only, and the plugin answering proven to run --rev. Anything else stops the run before a write.
// 2. Its own headless shell (E2E_CHROME, default guards.HEADLESS_SHELL; missing means the run
//    stops): a task-owned HOME, a fresh profile, a mocked keychain, and a proxy that drops every
//    connection except to the sandbox origin. A navigation preflight must pass first.
//    A journey or RPC timeout halts the whole run: the browser is killed, nothing else writes,
//    and unanswered writes are reported as ambiguous.
// 3. The journeys below. Fixture sessions are created either through the UI ("New session") or
//    through allow-listed plugin RPCs (e2e/lib/rpc.mjs), always titled "[e2e] <run id> …"; the store
//    has no delete, so they stay. Results are read back through the UI after a reload and through
//    session.get.
// 4. The safety check again, the browser stopped, and evidence written to --out: report.json (steps,
//    fixture ids, store revisions, RPC transcript, console problems) and screenshots.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Page, sleep } from "./lib/cdp.mjs";
import { browserBinary, killAllBrowsersNow, startChrome, stopChrome } from "./lib/chrome.mjs";
import { classifyConflict, createHalt, EXPECTED_BLOCKED, goToVerdict, newRunId, ownsBrowserProcess, RUN_ID, selectForHost, withTimeout } from "./lib/guards.mjs";
import { unexpectedDrops } from "./lib/sink.mjs";
import { acquireLock, holdsLock, LockBusy, newLockToken, releaseLock } from "./lib/lock.mjs";
import { app, baseUrl, hostCapabilities, killToolsNow, PASEO_HOME, RUN_LOCK, SANDBOX, safety, sandboxEnv } from "./lib/sandbox.mjs";
import { answerOnCard, chooseMode, esc, fill, openPlugin, openSession } from "./lib/ui.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]] : acc), []),
);
const USAGE = "usage: node e2e/run.mjs --rev <40-hex revision> [--out <new dir>] [--only j1,...,j9] [--inert-agent <id> (j6-j8)] [--max-minutes 20]";
const usage = (why) => {
  console.error(`${why ? `${why}\n` : ""}${USAGE}`);
  process.exit(2);
};
if (!/^[0-9a-f]{40}$/.test(args.rev ?? "")) usage();
if (args.port !== undefined) usage("--port is gone: the browser picks its own DevTools port");
const maxMinutes = Number(args["max-minutes"] ?? 20);
// The sandbox's inert fixture agent (j6-j8): named explicitly, never discovered.
const INERT_AGENT = args["inert-agent"] ?? null;
if (INERT_AGENT !== null && !/^[0-9a-f-]{36}$/.test(INERT_AGENT)) usage("--inert-agent must be the inert fixture agent's id");
const inertSafety = () => (INERT_AGENT === null ? {} : { inertProvider: app.inertAgent?.provider ?? null, inertMax: app.inertAgent?.maxAgents ?? 0 });
if (!(maxMinutes > 0 && maxMinutes <= 60)) usage("--max-minutes must be between 0 and 60");

/** Bounds: one journey, the whole run (the re-executing parent allows a minute more). */
const JOURNEY_MS = 240_000;
const RUN_MS = maxMinutes * 60_000;

async function main() {
  const { connect, E2E_PREFIX } = await import("./lib/rpc.mjs");
  const host = hostCapabilities();
  const selected = selectForHost(args.only, JOURNEYS.map((j) => j.id), JOURNEY_NEEDS, host, { inertAgent: INERT_AGENT !== null });
  if (!RUN_ID.test(args["run-id"] ?? "") || !args.out) usage("the worker needs --run-id and --out from its parent");
  const runId = args["run-id"];
  // The worker runs only under its parent's sandbox lock (its token), and checks it before every
  // step and every write: losing it halts the run.
  const token = process.env.E2E_RUN_NONCE ?? "";
  if (!holdsLock(RUN_LOCK, token)) {
    console.error(`[e2e ${runId}] refusing: the sandbox E2E lock ${RUN_LOCK} is not held by this run`);
    process.exit(1);
  }
  const lockLost = () => (holdsLock(RUN_LOCK, token) ? null : `the sandbox E2E lock ${RUN_LOCK} is no longer held by this run`);
  const out = path.resolve(args.out);
  // A new output directory only: another run's (or a rerun's) evidence, profile and log are never reused.
  mkdirSync(path.dirname(out), { recursive: true });
  try {
    mkdirSync(out, { recursive: false, mode: 0o700 }); // private: profile, endpoint record, logs, report
  } catch (e) {
    console.error(`[e2e ${runId}] refusing ${out}: ${e instanceof Error ? e.message : String(e)} (the output directory must be new)`);
    process.exit(1);
  }
  const shots = path.join(out, "shots");
  mkdirSync(shots);
  const report = { runId, rev: args.rev, host, selected, startedAt: new Date().toISOString(), phase: "setup", sandbox: {}, browser: null, journeys: [], fixtures: [], store: {}, transcript: [], console: [], cleanup: {}, ok: false };
  const save = () => {
    try {
      writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
    } catch (e) {
      console.error(`[e2e ${runId}] could not write the report: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const log = (s) => console.log(`[e2e ${runId}] ${s}`);
  const errorOf = (e) => (e instanceof Error ? e.message : String(e));
  save();

  let chrome = null;
  let rpc = null;
  const pages = [];
  const ambiguous = () => ({
    rpcWrites: (rpc?.transcript ?? []).filter((t) => t.write && t.ok !== true && t.ok !== false).map((t) => ({ at: t.at, method: t.method, input: t.input, outcome: t.outcome ?? "ambiguous: pending when the run stopped; may or may not have applied" })),
    uiInFlightAtHalt: halt.reason ? "unknown: a UI action may have been in flight when the browser was killed; compare store.before/after and the [e2e] sessions" : null,
  });
  // One run-wide stop: a journey or RPC timeout (or an unanswered write) halts everything. The
  // browser is killed at once, so no UI action can write afterwards; later steps and journeys are
  // refused; only the final reads run.
  const halt = createHalt((why) => {
    killAllBrowsersNow();
    report.halted = why;
    log(`HALTED: ${why}; the browser was killed; no further step or write runs`);
    save();
  });
  // Overrun or interrupt (installed before anything starts): halt, kill the run's own browser
  // group, save what is known, exit. The sandbox is not touched.
  const abort = (why) => {
    halt.trigger(why);
    killAllBrowsersNow();
    killToolsNow();
    report.aborted = why;
    report.phase = `aborted during ${report.phase}`;
    report.cleanup.chrome = { pid: chrome?.pid ?? null, killedOnAbort: true };
    report.ambiguous = ambiguous();
    report.ok = false;
    report.finishedAt = new Date().toISOString();
    save();
    log(`aborted: ${why}; the browser was killed; ${report.ambiguous.rpcWrites.length} ambiguous RPC write(s)`);
    process.exit(1);
  };
  const watchdog = setTimeout(() => abort(`run exceeded ${RUN_MS} ms`), RUN_MS);
  watchdog.unref();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => abort(sig));
  process.once("exit", () => {
    killAllBrowsersNow();
    killToolsNow();
  });

  try {
    // The browser fails closed before anything else, the sandbox included.
    report.browserBinary = browserBinary();
    report.phase = "safety before";
    report.sandbox.before = await safety(args.rev, inertSafety());
    save();
    log(`safety before: ${report.sandbox.before.passed ? "passed" : "FAILED"}; served ${report.sandbox.before.servedRev}`);
    if (!report.sandbox.before.passed) throw new Error("stopping before any write: the sandbox is not safe or not the requested revision");
    report.phase = "connect";
    rpc = await connect({ halt, writeGuard: lockLost, plannerAgentId: INERT_AGENT });
    report.transcript = rpc.transcript;
    report.store.before = (await rpc.call("roadmap.version")).revision;
    report.phase = "browser";
    // The handle is recorded the moment the browser exists (not when startup finishes), so an
    // interrupt during startup and the parent's leftover check both reach it.
    await startChrome({
      dir: out,
      allowedPort: app.port,
      onSpawn: (spawned) => {
        chrome = spawned;
        writeFileSync(path.join(out, "chrome.json"), JSON.stringify({ pid: spawned.pid, binary: spawned.binary, profile: spawned.profile, nonce: process.env.E2E_RUN_NONCE ?? null }), { mode: 0o600 });
      },
    });
    report.browser = { version: chrome.browser, binary: chrome.binary, endpoint: chrome.endpoint, home: chrome.home };
    save();
    log(`browser ${chrome.browser} pid ${chrome.pid}, endpoint port ${chrome.port}, task-owned HOME ${chrome.home}`);
    // Navigation preflight: under its own HOME the browser must reach the sandbox; there is no
    // fallback to the user's HOME, the run stops instead.
    report.phase = "preflight";
    const pre = await Page.open(chrome.port, "about:blank");
    try {
      await pre.send("Page.navigate", { url: baseUrl }, 20_000);
      await pre.waitFor("the Paseo UI", async () => /Paseo/.test(await pre.ev("document.title")), 20_000);
      report.preflight = { ok: true };
    } catch (e) {
      report.preflight = { ok: false, error: errorOf(e) };
      throw new Error(`the headless shell cannot navigate to the sandbox under its task-owned HOME (${report.preflight.error}); not retrying with the user's HOME`);
    } finally {
      await withTimeout(pre.close(), 5_000, "page close").catch(() => {});
    }
    report.phase = "journeys";
    const tag = `${E2E_PREFIX}${runId}`;
    const ctx = {
      rpc,
      tag,
      shots,
      newPage: async (size) => {
        const p = await Page.open(chrome.port, "about:blank", size);
        pages.push(p);
        return p;
      },
    };
    for (const j of JOURNEYS) {
      if (!selected.includes(j.id)) continue;
      const rec = { id: j.id, title: j.title, kind: j.kind, steps: [], ok: true };
      report.journeys.push(rec);
      if (halt.reason) {
        rec.ok = false;
        rec.error = `not run: the run is halted (${halt.reason})`;
        continue;
      }
      const step = async (name, fn) => {
        if (!halt.reason && lockLost()) halt.trigger(lockLost());
        if (halt.reason) throw new Error(`step "${name}" refused: the run is halted (${halt.reason})`);
        const t0 = Date.now();
        try {
          const detail = await fn();
          rec.steps.push({ name, ok: true, ms: Date.now() - t0, ...(detail !== undefined ? { detail } : {}) });
        } catch (e) {
          rec.steps.push({ name, ok: false, ms: Date.now() - t0, error: errorOf(e) });
          throw e;
        }
      };
      log(`journey ${j.id}: ${j.title}`);
      try {
        await withTimeout(j.run({ ...ctx, step, fixtures: report.fixtures }), JOURNEY_MS, `journey ${j.id}`);
      } catch (e) {
        rec.ok = false;
        rec.error = errorOf(e);
        if (/^journey .*no result within/.test(rec.error)) halt.trigger(`journey ${j.id} timed out`);
        for (const p of halt.reason ? [] : pages) {
          try {
            await p.shot(path.join(shots, `${j.id}-failure-${pages.indexOf(p)}.png`));
          } catch {
            // a closed page
          }
        }
        log(`  FAILED: ${rec.error}`);
      }
      save();
    }
  } catch (e) {
    report.error = `${report.phase}: ${errorOf(e)}`;
    log(`STOPPED: ${report.error}`);
  } finally {
    // Teardown: each step on its own, the report saved before and after the fallible ones.
    report.phase = "teardown";
    for (const p of pages) {
      const all = p.problems();
      report.console.push({ page: pages.indexOf(p), lifecycleSkipped: p.lifecycleSkipped ?? 0, problems: all.filter((m) => !KNOWN_HOST_NOISE.some((re) => re.test(m))), knownHostNoise: all.filter((m) => KNOWN_HOST_NOISE.some((re) => re.test(m))) });
    }
    report.ambiguous = ambiguous();
    save();
    const attempt = async (what, fn) => {
      try {
        return await fn();
      } catch (e) {
        report.teardownErrors = [...(report.teardownErrors ?? []), `${what}: ${errorOf(e)}`];
        return undefined;
      }
    };
    for (const p of pages) await attempt("page close", () => withTimeout(p.close(), 5_000, "page close"));
    if (chrome) report.cleanup.chrome = (await attempt("browser stop", () => stopChrome(chrome))) ?? { pid: chrome.pid, stopped: false };
    save();
    if (rpc) {
      report.store.after = (await attempt("store revision after", async () => (await rpc.call("roadmap.version", {}, { final: true })).revision)) ?? null;
      await attempt("rpc close", () => rpc.close());
    }
    report.ambiguous = ambiguous();
    report.sandbox.after = (await attempt("safety after", () => safety(args.rev, inertSafety()))) ?? { passed: false };
    report.finishedAt = new Date().toISOString();
    report.phase = "done";
    report.unexpectedDrops = unexpectedDrops(report.cleanup.chrome?.drops, EXPECTED_BLOCKED);
    report.ok =
      !report.error &&
      !halt.reason &&
      !report.teardownErrors &&
      report.ambiguous.rpcWrites.length === 0 &&
      report.preflight?.ok === true &&
      report.journeys.length > 0 &&
      report.journeys.length === selected.length &&
      report.journeys.every((j) => j.ok) &&
      report.sandbox.after.passed === true &&
      report.console.every((c) => c.problems.length === 0) &&
      report.cleanup.chrome?.stopped === true &&
      report.unexpectedDrops.length === 0;
    clearTimeout(watchdog);
    save();
    log(`journeys ${report.journeys.filter((j) => j.ok).length}/${report.journeys.length} passed; proxied attempts dropped ${report.cleanup.chrome?.proxiedAttemptsDropped ?? "n/a"} (unexpected: ${report.unexpectedDrops.map((t) => `${t.target} ×${t.count}`).join(", ") || "none"}); ambiguous writes ${report.ambiguous.rpcWrites.length}; safety after ${report.sandbox.after.passed ? "passed" : "FAILED"}; store ${report.store.before ?? "?"} → ${report.store.after ?? "?"}; ${report.ok ? "OK" : "NOT OK"}; report ${path.join(out, "report.json")}`);
  }
  process.exit(report.ok ? 0 : 1);
}

// Console messages React Native Web itself logs on every web host (recorded, not counted as failures).
const KNOWN_HOST_NOISE = [/^Animated: `useNativeDriver` is not supported because the native animated module is missing/];

/** j5: how soon after a subscription event the panel must re-read the version (the poll is 3 s). */
const EVENT_REREAD_MS = 300;

/** j3 and j4 work on the session j2 creates. */
const JOURNEY_NEEDS = { j3: ["j2"], j4: ["j2"] };

const sessionOf = (rpc, sessionId) => rpc.call("session.get", { sessionId });

// The Map detail's relation rows by their exact labels (client/map-view.tsx relationRow): the
// wording carries the direction, "activated by it" under Leads to, "activates it" under Comes after.
const Q1_LEADS_TO_Q3 = "Q3 Which database engine? · activated by it when Database";
const Q3_COMES_AFTER_Q1 = "Q1 Where is the data stored? · activates it when Database";
const waitRelation = (page, label) => page.waitFor(`the relation row "${label}"`, async () => (await page.controls()).some((c) => c.label === label), 8_000);

// ---- Journeys ----
const JOURNEYS = [
  {
    id: "j1",
    title: "legacy session: New session, add a question with an answer, edit the answer, reload",
    kind: "UI writes only",
    async run({ rpc, tag, shots, step, fixtures, newPage }) {
      const page = await newPage();
      const title = `${tag} legacy`;
      const q = "Which file format do exports use?";
      let sessionId = null;
      await step("open the plugin", () => openPlugin(page, baseUrl));
      await step("New session (UI)", async () => {
        for (let i = 0; i < 4 && (await page.controls()).some((c) => c.label === "‹ Back"); i++) await page.click(/^‹ Back$/);
        await page.click(/^New session$/);
        await fill(page, /^Session title$/, title);
        await page.click(/^Create$/);
        await page.waitText(new RegExp(esc(title)));
      });
      await step("Add question with a free-text answer (UI)", async () => {
        await page.click(/^Add question$/);
        await fill(page, /^Question$/, q);
        await fill(page, /^Answer \(optional, free text\)$/, "CSV with a header row");
        await page.click(/^Add$/);
        await page.waitText(/CSV with a header row/);
      });
      await step("edit the answer on the card (UI)", async () => {
        await answerOnCard(page, q, { text: "JSON lines" });
        await page.waitText(/JSON lines/);
      });
      await step("the store holds it (session.get)", async () => {
        const ov = await rpc.call("roadmap.overview");
        sessionId = ov.sessions.find((s) => s.title === title)?.id ?? null;
        if (!sessionId) throw new Error("session not in the overview");
        fixtures.push({ journey: "j1", sessionId, title, createdBy: "UI" });
        const v = await sessionOf(rpc, sessionId);
        const qq = v.questions.find((x) => x.question.title === q)?.question;
        if (!qq) throw new Error("question not stored");
        if (v.session.blocks !== undefined) throw new Error("a UI-created session should stay without blocks");
        const texts = qq.revisions.map((r) => r.text);
        if (qq.answer?.text !== "JSON lines" || texts.join("|") !== "CSV with a header row|JSON lines") throw new Error(`answers ${texts.join(" | ")}`);
        return { sessionId, questionId: qq.id, revisions: qq.revisions.map((r) => ({ rev: r.rev, text: r.text, source: r.source })) };
      });
      await step("reload: the session and its current answer are still shown", async () => {
        await page.reload();
        await openPlugin(page, baseUrl);
        await openSession(page, title);
        await page.waitText(/JSON lines/);
        await page.shot(path.join(shots, "j1-after-reload.png"));
      });
    },
  },
  {
    id: "j2",
    title: "block session (seeded): branch by answer, add with an answer, Accept block and continue, add to the next block, reload",
    kind: "RPC fixture + UI writes",
    async run({ rpc, tag, shots, step, fixtures, newPage }) {
      const page = await newPage();
      const title = `${tag} blocks`;
      const store = { title };
      await step("seed: session with Block 1 (allow-listed RPCs)", async () => {
        const { sessionId } = await rpc.call("session.create", { title });
        const opts = [{ id: "files", label: "Files" }, { id: "db", label: "Database" }];
        const q1 = (await rpc.call("question.create", { sessionId, blockId: "e2e-b1", title: "Where is the data stored?", context: "", options: opts, allowFreeText: false, activatedBy: [], invalidatedBy: [] })).questionId;
        const fmt = [{ id: "csv", label: "CSV" }, { id: "json", label: "JSON" }];
        const q2 = (await rpc.call("question.create", { sessionId, blockId: "e2e-b1", title: "Which file format?", context: "", options: fmt, allowFreeText: false, activatedBy: [{ parent: { sessionId, questionId: q1 }, optionIds: ["files"] }], invalidatedBy: [] })).questionId;
        const dbs = [{ id: "pg", label: "Postgres" }, { id: "sqlite", label: "SQLite" }];
        const q3 = (await rpc.call("question.create", { sessionId, blockId: "e2e-b1", title: "Which database engine?", context: "", options: dbs, allowFreeText: false, activatedBy: [{ parent: { sessionId, questionId: q1 }, optionIds: ["db"] }], invalidatedBy: [] })).questionId;
        Object.assign(store, { sessionId, q1, q2, q3 });
        fixtures.push({ journey: "j2", sessionId, title, createdBy: "RPC", questions: { q1, q2, q3 }, firstBlock: "e2e-b1" });
        return store;
      });
      await step("open the session: Q1 shown, its two branches not yet", async () => {
        await openPlugin(page, baseUrl);
        await openSession(page, title);
        await page.waitText(/Where is the data stored\?/);
        const t = await page.text();
        if (/Which file format\?/.test(t) || /Which database engine\?/.test(t)) throw new Error("a branch is shown before Q1 is answered");
      });
      await step("answer Q1 = Files (UI): the file branch appears", async () => {
        await answerOnCard(page, "Where is the data stored?", { option: "Files" });
        await page.waitText(/Which file format\?/);
        if (/Which database engine\?/.test(await page.text())) throw new Error("the database branch is shown");
      });
      await step("change Q1 to Database (UI): the branches swap", async () => {
        await answerOnCard(page, "Where is the data stored?", { option: "Database" });
        await page.waitText(/Which database engine\?/);
        await page.waitFor("the file branch hidden", async () => !/Which file format\?/.test(await page.text()), 8_000);
        await page.shot(path.join(shots, "j2-branch-database.png"));
      });
      await step("add a question with an answer to Block 1 (UI)", async () => {
        await page.click(/^Add question to Block 1$/);
        await fill(page, /^Question$/, "How long are backups kept?");
        await fill(page, /^Answer \(optional, free text\)$/, "Thirty days");
        await page.click(/^Add$/);
        await page.waitText(/Thirty days/);
      });
      await step("Accept block and continue (UI): Block 2 opens", async () => {
        await page.click(/^Accept block and continue$/);
        await page.waitFor("Add question to Block 2", async () => (await page.controls()).some((c) => c.label === "Add question to Block 2"), 10_000);
      });
      await step("add a question to Block 2 (UI)", async () => {
        await page.click(/^Add question to Block 2$/);
        await fill(page, /^Question$/, "Who restores a backup?");
        await page.click(/^Add$/);
        await page.waitText(/Who restores a backup\?/);
      });
      await step("the store holds it (session.get)", async () => {
        const v = await sessionOf(rpc, store.sessionId);
        const blocks = v.session.blocks.map((b) => b.state).join("/");
        const byTitle = (t) => v.questions.find((x) => x.question.title === t);
        const q1 = byTitle("Where is the data stored?").question;
        const checks = {
          blocks,
          q1Answers: q1.revisions.map((r) => r.optionId).join(","),
          fileBranch: byTitle("Which file format?").visibility,
          dbBranch: byTitle("Which database engine?").visibility,
          added1: byTitle("How long are backups kept?")?.question.answer?.text,
          added2Block: v.session.blocks.find((b) => b.id === byTitle("Who restores a backup?")?.question.blockId)?.order,
          planner: v.session.planner ?? null,
        };
        const okAll = blocks === "accepted/open" && checks.q1Answers === "files,db" && checks.fileBranch === "inactive" && checks.dbBranch === "active" && checks.added1 === "Thirty days" && checks.added2Block === 1 && checks.planner === null;
        if (!okAll) throw new Error(`stored ${JSON.stringify(checks)}`);
        return checks;
      });
      await step("reload: Block 2 open with its question, Block 1 accepted", async () => {
        await page.reload();
        await openPlugin(page, baseUrl);
        await openSession(page, title);
        await page.waitText(/Who restores a backup\?/);
        const nav = (await page.controls()).filter((c) => /^Block \d/.test(c.label)).map((c) => c.label);
        if (!nav.some((l) => /^Block 1, accepted/.test(l)) || !nav.some((l) => /^Block 2, open/.test(l))) throw new Error(`navigator ${nav.join(" | ")}`);
        await page.shot(path.join(shots, "j2-after-reload.png"));
        return { navigator: nav };
      });
    },
  },
  {
    id: "j3",
    title: "Map on the block session: Find, List, Go to, Fit (desktop) and Find in the compact sheet",
    kind: "UI reads only",
    async run({ step, shots, fixtures, newPage }) {
      const fx = fixtures.find((f) => f.journey === "j2");
      if (!fx) throw new Error("needs j2's session");
      const page = await newPage();
      await step("open the session's Map (UI)", async () => {
        await openPlugin(page, baseUrl);
        await openSession(page, fx.title);
        await chooseMode(page, "Map");
        await page.waitFor("the Map toolbar", async () => (await page.controls()).some((c) => /^(✓ )?Fit$/.test(c.label || c.text)), 10_000);
      });
      await step("Find question → Q1: its detail shows it and what it leads to", async () => {
        await page.click(/^(✓ )?Find question$/);
        await page.click(/^Find Q1 /);
        await page.waitText(/Showing Q1 Where is the data stored\? and its neighbours/);
        // The detail's own relation rows (their labels carry the direction), not page-wide text.
        await waitRelation(page, Q1_LEADS_TO_Q3);
        await page.shot(path.join(shots, "j3-find-q1.png"));
      });
      await step("List → Show Q3: its detail shows its parent", async () => {
        await page.click(/^(✓ )?List$/);
        await page.click(/^Show Q3 .* on the map$/);
        await page.waitText(/Showing Q3 Which database engine\? and its neighbours/);
        await waitRelation(page, Q3_COMES_AFTER_Q1);
      });
      await step("Graph, Go to open Block 2, Fit", async () => {
        const graph = (await page.controls()).find((c) => /^(✓ )?Graph$/.test(c.label || c.text));
        if (graph && graph.pressed !== "true") await page.click(/^(✓ )?Graph$/);
        const before = await page.visibility(/^Q5 .*Block 2/);
        await page.click(/^Go to open Block 2$/);
        // Passes only when the node ends genuinely visible and Go to demonstrably acted: it was not
        // visible before, or it moved. Already visible and unmoved is inconclusive, not a pass.
        let after = null;
        let goTo = null;
        try {
          await page.waitFor(
            "Go to's effect on the Block 2 question node",
            async () => {
              after = await page.visibility(/^Q5 .*Block 2/);
              goTo = goToVerdict(before, after);
              return goTo.verdict === "pass";
            },
            8_000,
          );
        } catch {
          throw new Error(`Go to: ${goTo?.verdict ?? "fail"}: ${goTo?.reason ?? "no reading"} ${JSON.stringify({ before, after })}`);
        }
        await page.click(/^(✓ )?Fit$/);
        await page.waitFor("Fit pressed", async () => (await page.controls()).some((c) => /^(✓ )?Fit$/.test(c.label || c.text) && c.pressed === "true"), 5_000);
        await page.shot(path.join(shots, "j3-fit.png"));
        return { goToTarget: { before, after, verdict: goTo } };
      });
      await step("compact 390: Map, Find question → Q3 opens the detail sheet; Escape closes it", async () => {
        await page.size(390, 844, true);
        await sleep(1500);
        // Crossing the host's compact breakpoint remounts the panel at the plugin's session list (a
        // host layout switch, recorded); the session is opened again by touch.
        const row = new RegExp(`^Open session ${esc(fx.title)}$`);
        const remounted = (await page.controls()).some((c) => row.test(c.label));
        if (remounted) {
          await page.tap(row);
          await page.waitFor("the session's Chat menu", async () => (await page.controls()).some((c) => /^Chat menu/.test(c.label)), 10_000);
        }
        if (!(await page.controls()).some((c) => /^(✓ )?Find question$/.test(c.label || c.text))) await chooseMode(page, "Map", true);
        await page.waitFor("the compact Map toolbar", async () => (await page.controls()).some((c) => /^(✓ )?Find question$/.test(c.label || c.text)), 10_000);
        await page.tap(/^(✓ )?Find question$/);
        await page.tap(/^Find Q3 /);
        await waitRelation(page, Q3_COMES_AFTER_Q1);
        await page.shot(path.join(shots, "j3-compact-sheet.png"));
        await page.key("Escape", "Escape", 27);
        await page.waitFor("the sheet closed", async () => !(await page.controls()).some((c) => c.label === Q3_COMES_AFTER_Q1), 5_000);
        await page.size(1220, 847, false);
        return { remountedAtCompactBreakpoint: remounted };
      });
    },
  },
  {
    id: "j4",
    title: "revision conflict across two tabs: the draft survives and is added once",
    kind: "UI writes only (two tabs)",
    async run({ rpc, step, shots, fixtures, newPage }) {
      const fx = fixtures.find((f) => f.journey === "j2");
      if (!fx) throw new Error("needs j2's session");
      const a = await newPage();
      const b = await newPage();
      const draft = "Who approves a restore?";
      await step("both tabs open the session", async () => {
        for (const p of [a, b]) {
          await openPlugin(p, baseUrl);
          await openSession(p, fx.title);
        }
      });
      await step("tab B: type a draft in Block 2's form, not sent", async () => {
        await b.front();
        await b.click(/^Add question to Block 2$/);
        await fill(b, /^Question$/, draft);
      });
      let revisionBeforeAdd = null;
      await step("tab A: add another question to Block 2 (UI), changing the store", async () => {
        await a.front();
        await a.click(/^Add question to Block 2$/);
        await fill(a, /^Question$/, "Where are restores logged?");
        await a.click(/^Add$/);
        await a.waitText(/Where are restores logged\?/);
        revisionBeforeAdd = (await rpc.call("roadmap.version")).revision;
        return { revisionBeforeAdd };
      });
      await step("tab B: Add must hit revision_conflict (store unchanged, draft kept), then the retry adds it once", async () => {
        await b.front();
        await b.click(/^Add$/);
        let noticeShown = false;
        try {
          await b.waitText(/The roadmap changed meanwhile/, 5_000);
          noticeShown = true;
        } catch {
          // judged below: no notice is inconclusive, never a pass
        }
        const revisionAfterFirstAdd = (await rpc.call("roadmap.version")).revision;
        const copies = async () => (await sessionOf(rpc, fx.sessionId)).questions.filter((x) => x.question.title === draft).length;
        const copiesAfterFirstAdd = await copies();
        const draftKept = (await b.ev(`[...document.querySelectorAll('textarea,input')].map((e) => e.value)`)).includes(draft);
        let copiesAfterRetry = null;
        if (noticeShown) {
          await b.shot(path.join(shots, "j4-conflict.png"));
          if (draftKept && copiesAfterFirstAdd === 0) {
            await b.click(/^Add$/);
            await b.waitText(new RegExp(esc(draft)));
            // Polled, not slept: the stored copy count settles at 1 (or the step reports what it saw).
            copiesAfterRetry = await copies();
            for (let i = 0; i < 20 && copiesAfterRetry !== 1; i++) {
              await sleep(250);
              copiesAfterRetry = await copies();
            }
          }
        }
        const facts = { noticeShown, draftKept, revisionBeforeAdd, revisionAfterFirstAdd, copiesAfterFirstAdd, copiesAfterRetry };
        const verdict = classifyConflict(facts);
        if (verdict.verdict !== "revision_conflict") throw new Error(`${verdict.verdict}: ${verdict.reason} ${JSON.stringify(facts)}`);
        return { ...verdict, ...facts };
      });
    },
  },
  {
    id: "j5",
    title: "live revision: another client's writes reach the open panel through the subscription; disconnect, write, reconnect re-reads",
    kind: "RPC fixture writes (another client); UI reads only",
    async run({ rpc, tag, shots, step, fixtures, newPage }) {
      const title = `${tag} live`;
      let sessionId = null;
      await step("RPC fixture: an [e2e] session without blocks", async () => {
        sessionId = (await rpc.call("session.create", { title })).sessionId;
        fixtures.push({ journey: "j5", sessionId, title, createdBy: "RPC" });
        return { sessionId, revision: (await rpc.call("roadmap.version")).revision };
      });
      const page = await newPage();
      page.capture = new Set(["Network.webSocketCreated", "Network.webSocketClosed", "Network.webSocketFrameSent", "Network.webSocketFrameReceived"]);
      await page.send("Network.enable");
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: WS_CONTROL });
      const frames = (dir, re, since = 0) =>
        page.events.filter((e) => e.at >= since && e.method === (dir === "sent" ? "Network.webSocketFrameSent" : "Network.webSocketFrameReceived") && re.test(String(e.params?.response?.payloadData ?? "")));
      await step("open the session in the panel", async () => {
        await openPlugin(page, baseUrl);
        await openSession(page, title);
      });
      await step("the panel subscribed to roadmap.revision.watch for this project", async () => {
        await page.waitFor("a subscribe frame", async () => frames("sent", /roadmap\.revision\.watch/).length > 0, 10_000);
        const sub = frames("sent", /roadmap\.revision\.watch/);
        const text = String(sub[0].params.response.payloadData);
        if (!text.includes(rpc.projectId)) throw new Error(`the subscribe frame does not name ${rpc.projectId}: ${text.slice(0, 300)}`);
        return { subscribeFrames: sub.length, firstFrame: text.slice(0, 400) };
      });
      const writes = [];
      await step("three writes by another client appear without a reload; the event precedes the version re-read", async () => {
        for (let i = 1; i <= 3; i++) {
          await sleep(700 + i * 450);
          const q = `${tag} live write ${i}`;
          const t0 = Date.now();
          const { revision } = await rpc.call("question.create", { sessionId, title: q, context: "", options: [], allowFreeText: true, activatedBy: [], invalidatedBy: [] });
          const tWritten = Date.now();
          await page.waitFor(`"${q}" in the panel`, async () => (await page.text()).includes(q), 10_000, 40);
          const tShown = Date.now();
          const event = frames("received", new RegExp(`"revision":${revision}\\b`), t0).find((f) => /subscription|"projectId"/.test(String(f.params.response.payloadData)));
          const versionReads = frames("sent", /roadmap\.version/, t0);
          writes.push({
            question: q,
            revision,
            rpcMs: tWritten - t0,
            shownAfterWriteMs: tShown - tWritten,
            eventAfterWriteMs: event ? event.at - tWritten : null,
            firstVersionReadAfterEventMs: event ? (versionReads.find((f) => f.at >= event.at)?.at ?? NaN) - event.at : null,
            eventFrame: event ? String(event.params.response.payloadData).slice(0, 300) : null,
          });
        }
        await page.shot(path.join(shots, "j5-live.png"));
        const missing = writes.filter((w) => w.eventAfterWriteMs === null);
        if (missing.length > 0) throw new Error(`no subscription event frame carried revision ${missing.map((w) => w.revision).join(", ")}: ${JSON.stringify(writes)}`);
        // The event itself must trigger the version re-read: well inside the 3 s poll, so a poll
        // that happens to follow the event cannot stand in for a missing event-triggered re-read.
        const late = writes.filter((w) => !(Number.isFinite(w.firstVersionReadAfterEventMs) && w.firstVersionReadAfterEventMs >= 0 && w.firstVersionReadAfterEventMs <= EVENT_REREAD_MS));
        if (late.length > 0) throw new Error(`no version re-read within ${EVENT_REREAD_MS} ms of the event for revision ${late.map((w) => w.revision).join(", ")}: ${JSON.stringify(writes)}`);
        return { writes };
      });
      await step("disconnect: the page's sockets are closed and new ones refused; a write made meanwhile is not shown", async () => {
        const closed = await page.ev("window.__e2eWs.disconnect()");
        if (!(closed > 0)) throw new Error(`no open WebSocket to close (${closed})`);
        await sleep(800);
        const q = `${tag} offline write`;
        const { revision } = await rpc.call("question.create", { sessionId, title: q, context: "", options: [], allowFreeText: true, activatedBy: [], invalidatedBy: [] });
        await sleep(4_000);
        const shownWhileDown = (await page.text()).includes(q);
        const state = await page.ev("({ live: window.__e2eWs.live.size, refused: window.__e2eWs.refused, created: window.__e2eWs.created })");
        await page.shot(path.join(shots, "j5-disconnected.png"));
        if (shownWhileDown) throw new Error("the write appeared while every socket was down: the disconnect did not hold");
        return { closedSockets: closed, revision, socketsWhileDown: state, shownWhileDown };
      });
      await step("reconnect: the subscription is established again and the canonical re-read shows the missed write", async () => {
        const q = `${tag} offline write`;
        const t0 = Date.now();
        await page.ev("window.__e2eWs.reconnect()");
        await page.waitFor(`"${q}" after reconnecting`, async () => (await page.text()).includes(q), 40_000, 100);
        const tShown = Date.now();
        const resubscribed = frames("sent", /roadmap\.revision\.watch/, t0);
        const versionReads = frames("sent", /roadmap\.version/, t0);
        const created = page.events.filter((e) => e.at >= t0 && e.method === "Network.webSocketCreated").map((e) => String(e.params?.url ?? ""));
        await page.shot(path.join(shots, "j5-reconnected.png"));
        if (resubscribed.length === 0) throw new Error("no subscribe frame after reconnecting");
        return {
          shownAfterReconnectMs: tShown - t0,
          socketsCreated: created,
          resubscribeAfterMs: resubscribed[0].at - t0,
          firstVersionReadAfterMs: versionReads.length > 0 ? versionReads[0].at - t0 : null,
          versionReadsBeforeShown: versionReads.filter((f) => f.at <= tShown).length,
        };
      });
      await step("the store holds the four questions (session.get)", async () => {
        const v = await sessionOf(rpc, sessionId);
        const titles = v.questions.map((x) => x.question.title);
        if (titles.length !== 4) throw new Error(`questions ${titles.join(" | ")}`);
        return { titles };
      });
    },
  },
  {
    id: "j9",
    title: "host without plugin subscriptions (0.15): no subscription is requested; another client's write still appears through the version poll",
    kind: "RPC fixture writes (another client); UI reads only",
    async run({ rpc, tag, shots, step, fixtures, newPage }) {
      const title = `${tag} poll`;
      let sessionId = null;
      await step("RPC fixture: an [e2e] session without blocks", async () => {
        sessionId = (await rpc.call("session.create", { title })).sessionId;
        fixtures.push({ journey: "j9", sessionId, title, createdBy: "RPC" });
      });
      const page = await newPage();
      page.capture = new Set(["Network.webSocketFrameSent", "Network.webSocketFrameReceived"]);
      await page.send("Network.enable");
      const sent = (re, since = 0) => page.events.filter((e) => e.at >= since && e.method === "Network.webSocketFrameSent" && re.test(String(e.params?.response?.payloadData ?? "")));
      await step("open the session in the panel; no subscription is requested", async () => {
        await openPlugin(page, baseUrl);
        await openSession(page, title);
        await sleep(5000);
        const subscribe = sent(/roadmap\.revision\.watch|plugin\.rpc\.subscribe/);
        const versionReads = sent(/roadmap\.version/);
        if (subscribe.length > 0) throw new Error(`a subscription was requested: ${String(subscribe[0].params.response.payloadData).slice(0, 300)}`);
        if (versionReads.length < 2) throw new Error(`the version poll is not running (${versionReads.length} reads in 5 s)`);
        const gaps = versionReads.slice(1).map((f, i) => f.at - versionReads[i].at);
        return { versionReadsIn5s: versionReads.length, gapsMs: gaps };
      });
      await step("a write by another client appears through the poll, without a reload", async () => {
        const q = `${tag} poll write`;
        const t0 = Date.now();
        const { revision } = await rpc.call("question.create", { sessionId, title: q, context: "", options: [], allowFreeText: true, activatedBy: [], invalidatedBy: [] });
        const tWritten = Date.now();
        await page.waitFor(`"${q}" in the panel`, async () => (await page.text()).includes(q), 10_000, 50);
        const shownAfterWriteMs = Date.now() - tWritten;
        await page.shot(path.join(shots, "j9-poll.png"));
        if (shownAfterWriteMs > 4_500) throw new Error(`shown ${shownAfterWriteMs} ms after the write; the 3 s poll should show it sooner`);
        if (sent(/roadmap\.revision\.watch|plugin\.rpc\.subscribe/, t0).length > 0) throw new Error("a subscription was requested after the write");
        return { revision, shownAfterWriteMs };
      });
    },
  },
  discussJourney({ id: "j6", compact: false }),
  discussJourney({ id: "j7", compact: true }),
  discussJourney({ id: "j8", compact: false, empty: true }),
];

/**
 * Discuss in chat through the real UI into the sandbox's inert fixture chat (j6 wide, j7 compact:
 * 390×844 with touch, where revealing the chat replaces the panel).
 */
function discussJourney({ id, compact, empty = false }) {
  return {
    id,
    title: empty
      ? "Discuss in chat (wide, empty draft; card's More menu): the chat's draft becomes a blank line and the question's block; nothing is sent"
      : `Discuss in chat (${compact ? "compact 390×844, touch" : "wide"}; card's More menu): the question's block goes into the bound inert chat's draft after the prior draft and its selection; nothing is sent`,
    kind: "RPC fixture writes (session, question, answer, planner binding); UI only for the handoff",
    async run({ rpc, tag, shots, step, fixtures, newPage }) {
      if (INERT_AGENT === null) throw new Error(`${id} needs --inert-agent <id> (the sandbox's inert fixture agent)`);
      const ledgerFile = path.join(PASEO_HOME, "e2e-inert-ledger.jsonl");
      const ledger = () => (existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
      const prompts = () => ledger().filter((e) => e.input === "session.prompt");
      const title = `${tag} composer ${id}`;
      const q = "Which database should the sandbox use?";
      let sessionId = null;
      let questionId = null;
      await step("no prompt has ever reached the inert agent", async () => {
        const p = prompts();
        if (p.length !== 0) throw new Error(`${p.length} prompt(s) in the inert ledger before the journey`);
        return { ledgerEntries: ledger().length };
      });
      await step("RPC fixture: session, question with a free-text answer, the inert agent bound as planner", async () => {
        sessionId = (await rpc.call("session.create", { title })).sessionId;
        questionId = (await rpc.call("question.create", { sessionId, title: q, context: "", options: [], allowFreeText: true, activatedBy: [], invalidatedBy: [] })).questionId;
        await rpc.call("question.answer", { sessionId, questionId, text: "SQLite for the sandbox" });
        const bound = await rpc.call("session.planner.set", { sessionId, agentId: INERT_AGENT });
        fixtures.push({ journey: id, sessionId, title, createdBy: "RPC", questionId, planner: INERT_AGENT });
        await sleep(1500);
        const p = prompts();
        if (p.length !== 0) throw new Error(`binding the planner sent ${p.length} prompt(s) to the chat`);
        return { sessionId, questionId, bound, promptsAfterBinding: p.length };
      });
      const page = await newPage();
      const editable = () =>
        page.ev(`[...document.querySelectorAll('textarea,[contenteditable="true"],input[type="text"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map((e) => ({ tag: e.tagName, label: e.getAttribute('aria-label') || e.getAttribute('placeholder') || '', value: (e.value ?? e.innerText ?? '').slice(0, 2000), start: e.selectionStart ?? null, end: e.selectionEnd ?? null, focused: document.activeElement === e }))`);
      const PRIOR = empty ? "" : compact ? "Compact prior: keep this line." : "Prior draft: keep this line.";
      await step("open the inert chat and type a prior draft, selecting part of it (UI)", async () => {
        await page.send("Page.navigate", { url: baseUrl });
        await page.front();
        await page.waitFor("the sandbox workspace in the sidebar", async () => (await page.controls()).some((c) => c.label === "UI check" || c.text === "UI check"), 30_000);
        await page.click(/^UI check$/, { index: 0 });
        // The workspace opens on the agent's tab; its composer is the "Message agent..." field.
        await page.waitFor("the inert chat's tab", async () => (await page.controls()).some((c) => c.label === "[e2e] inert planner"), 15_000);
        await page.click(/^\[e2e\] inert planner$/, { index: 0 });
        await page.waitFor("the chat composer", async () => (await page.controls()).some((c) => c.role === "textarea" && /^Message agent/.test(c.label)), 15_000);
        await page.click(/^Message agent/);
        // A draft left by an earlier journey of this run (same browser profile) is cleared by keys.
        const leftover = (await editable()).find((f) => f.focused)?.value ?? "";
        if (leftover !== "") {
          await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] });
          await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 });
          await page.key("Backspace", "Backspace", 8);
          await sleep(500);
        }
        if (empty) {
          await sleep(1200);
          const now = (await editable()).find((f) => f.focused);
          await page.shot(path.join(shots, `${id}-prior-draft.png`));
          if (!now || now.value !== "") throw new Error(`the chat draft is not empty: ${JSON.stringify(now ?? (await editable()))}`);
          return { clearedLeftover: leftover !== "", value: "" };
        }
        await page.send("Input.insertText", { text: PRIOR });
        for (let i = 0; i < 9; i++) {
          await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 8 });
          await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 8 });
        }
        await sleep(1200);
        const after = (await editable()).find((f) => f.focused);
        await page.shot(path.join(shots, `${id}-prior-draft.png`));
        if (!after || after.value !== PRIOR || after.end - after.start !== 9) throw new Error(`the prior draft is not as typed: ${JSON.stringify(after ?? (await editable()))}`);
        return { clearedLeftover: leftover !== "", value: after.value, selection: [after.start, after.end], selected: after.value.slice(after.start, after.end) };
      });
      let before = 0;
      await step("open the Decision roadmap in a new tab and the session; its card offers Discuss in chat", async () => {
        // The panel's tab when an earlier journey of this run opened it, else New tab → Decision roadmap.
        const named = async () => (await page.controls()).filter((c) => /^Decision roadmap$/.test(c.label) || (c.label === "" && /^Decision roadmap$/.test(c.text)));
        const tabIndex = (await named()).findIndex((c) => c.role !== "menuitem");
        if (tabIndex >= 0) await page.click(/^Decision roadmap$/, { index: tabIndex });
        else {
          await page.click(/^New tab$/, { index: 0 });
          await page.waitFor("the Decision roadmap item", async () => (await named()).some((c) => c.role === "menuitem"), 10_000);
          await page.click(/^Decision roadmap$/, { index: (await named()).findIndex((c) => c.role === "menuitem") });
        }
        await page.waitFor("the plugin", async () => /Sessions|‹ Back/.test(await page.text()), 20_000);
        await openSession(page, title);
        let remounted = false;
        if (compact) {
          // Mobile emulation with touch; crossing the compact breakpoint may remount the panel at
          // its session list (a host layout switch), so the session is opened again by touch.
          await page.size(390, 844, true);
          await sleep(1500);
          const row = new RegExp(`^Open session ${esc(title)}$`);
          remounted = (await page.controls()).some((c) => row.test(c.label));
          if (remounted) await page.tap(row);
        }
        // The card's More menu holds Discuss in chat (the card shows it only with a bound planner).
        await page.waitFor("the card's More", async () => (await page.controls()).some((c) => (c.label || c.text) === "More"), 10_000);
        if (compact) await page.tap(/^More$/);
        else await page.click(/^More$/);
        await page.waitFor("Discuss in chat", async () => (await page.controls()).some((c) => (c.label || c.text) === "Discuss in chat"), 10_000);
        await page.shot(path.join(shots, `${id}-card.png`));
        before = prompts().length;
        return { promptsBefore: before, remountedAtCompactBreakpoint: remounted };
      });
      await step("press Discuss in chat (UI): the chat opens with the block after the prior draft; nothing is sent", async () => {
        if (compact) await page.tap(/^Discuss in chat$/);
        else await page.click(/^Discuss in chat$/);
        const expectedLines = [`--- Roadmap question Q1 ---`, `Question: Q1 ${JSON.stringify(q)}`, `Current answer (rev 1): "SQLite for the sandbox"`, `Link: roadmap://${rpc.projectId}/s/${sessionId}/q/1`, `--- End of roadmap question Q1 ---`];
        const expected = `${PRIOR}\n\n${expectedLines.join("\n")}`;
        let seen = null;
        await page
          .waitFor("the block in the chat draft", async () => {
            seen = (await editable()).find((f) => f.value.startsWith(PRIOR) && f.value.includes("--- Roadmap question")) ?? null;
            return seen !== null && seen.value === expected;
          }, 15_000)
          .catch(async (e) => {
            throw new Error(`${e.message}; seen ${JSON.stringify(seen)}; editable ${JSON.stringify(await editable())}; text ${(await page.text()).slice(0, 600)}`);
          });
        await page.shot(path.join(shots, `${id}-discussed.png`));
        const toastShown = /placed in the chat draft/i.test(await page.text());
        await sleep(3000);
        const after = prompts().length;
        const still = (await editable()).find((f) => f.value === expected) ?? null;
        if (after !== before) throw new Error(`${after - before} prompt(s) reached the inert agent after Discuss in chat`);
        if (still === null) throw new Error("the draft did not stay in the composer (sent or cleared?)");
        return { draft: seen.value, cursor: [seen.start, seen.end], cursorAtEnd: seen.start === seen.value.length && seen.end === seen.value.length, focused: seen.focused, toastShown, promptsAfter: after };
      });
    },
  };
}

/**
 * Test instrumentation installed before the app's scripts: records the page's WebSockets so a step
 * can close them (a client-side disconnect) and refuse new ones for a while; nothing else changes.
 */
const WS_CONTROL = `(() => {
  const Native = window.WebSocket;
  const state = { live: new Set(), blocked: false, created: 0, refused: 0, closedByTest: 0 };
  class E2EWebSocket extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      state.created++;
      if (state.blocked) {
        state.refused++;
        this.close();
        return;
      }
      state.live.add(this);
      this.addEventListener("close", () => state.live.delete(this));
    }
  }
  state.disconnect = () => {
    state.blocked = true;
    const open = [...state.live];
    for (const ws of open) ws.close(4000, "e2e disconnect");
    state.closedByTest += open.length;
    return open.length;
  };
  state.reconnect = () => {
    state.blocked = false;
    return true;
  };
  window.WebSocket = E2EWebSocket;
  window.__e2eWs = state;
})();`;

// The plugin RPCs go through the sandbox's own daemon connection, which reads its home from the
// environment: the run re-executes itself with the sandbox's environment (the browser then gets its own
// task-owned HOME from chrome.mjs, never the user's). The parent forwards interrupts and enforces a
// hard deadline a minute past the child's own. (Last, after JOURNEYS.)
if (process.env.PASEO_HOME !== PASEO_HOME) {
  // Fail fast on a bad selection, before the sandbox or a browser is touched.
  try {
    selectForHost(args.only, JOURNEYS.map((j) => j.id), JOURNEY_NEEDS, hostCapabilities(), { inertAgent: INERT_AGENT !== null });
  } catch (e) {
    usage(e instanceof Error ? e.message : String(e));
  }
  const runId = newRunId();
  const out = path.resolve(args.out ?? `/tmp/dr-e2e-${runId}`);
  if (existsSync(out)) usage(`${out} exists: the output directory must be new`);
  // One run per sandbox store: the parent takes the exclusive lock before anything touches the
  // sandbox and releases it, by its own token only, when it exits (after the leftover-browser
  // check below). Contention, a stale lock or anything else at the lock path stops the run.
  const nonce = newLockToken();
  try {
    acquireLock(RUN_LOCK, { token: nonce, runId });
  } catch (e) {
    console.error(`[e2e ${runId}] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof LockBusy ? 3 : 1);
  }
  let child = null;
  let lockReleased = false;
  process.on("exit", () => {
    if (lockReleased) return;
    lockReleased = true;
    const r = releaseLock(RUN_LOCK, nonce);
    console.error(`[e2e ${runId}] sandbox lock ${r.released ? "released" : `not released (${r.reason})`}`);
  });
  const early = (sig) => {
    if (!child) process.exit(130);
    child.kill(sig);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => early(sig));
  // The worker must see the same sandbox (and so the same lock) and the same browser as the parent.
  const env = { ...(await sandboxEnv()), E2E_RUN_NONCE: nonce, E2E_SANDBOX: SANDBOX, ...(process.env.E2E_CHROME ? { E2E_CHROME: process.env.E2E_CHROME } : {}) };
  const rest = process.argv.slice(2).filter((a, i, all) => !["--out", "--run-id"].includes(a) && !["--out", "--run-id"].includes(all[i - 1]));
  child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...rest, "--out", out, "--run-id", runId], { env, stdio: "inherit" });
  const hard = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
  }, RUN_MS + 60_000);
  hard.unref();
  child.on("error", (e) => {
    console.error(`[e2e] the worker could not start: ${e.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => {
    // A worker killed outright cannot stop its browser. Only this run's record (its nonce, its
    // own profile path) and only a process whose command is exactly that binary with exactly that
    // profile are stopped, with its whole group (helpers included).
    const file = path.join(out, "chrome.json");
    if (existsSync(file)) {
      try {
        const rec = JSON.parse(readFileSync(file, "utf8"));
        const expectedProfile = path.join(out, "profile");
        const cmd = Number.isInteger(rec.pid) ? (spawnSync("ps", ["-o", "command=", "-p", String(rec.pid)], { encoding: "utf8" }).stdout ?? "") : "";
        if (rec.nonce === nonce && rec.profile === expectedProfile && ownsBrowserProcess({ command: cmd, binary: rec.binary, profile: expectedProfile })) {
          process.kill(-rec.pid, "SIGKILL");
          console.error(`[e2e] killed the run's leftover browser group ${rec.pid}`);
        }
      } catch {
        // gone, or not this run's
      }
    }
    process.exit(code ?? 1);
  });
} else {
  await main();
}
