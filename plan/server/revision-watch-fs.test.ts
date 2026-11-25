// roadmap.revision.watch end to end on the real filesystem: the registered handler, the real store
// and node's directory watch. Writes come from this process and from a separate node process doing
// the store's own atomic manifest replacement (temp file + rename), corrupting it, removing the
// store and swapping the whole .decisions directory.
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as installedSdk from "@getpaseo/plugin";
import { afterEach, describe, expect, it } from "vitest";
import { RevisionEvent, RoadmapRevisionWatch } from "../shared/rpc-live";
import { hostSupportsSubscriptions, registerRevisionWatch } from "./revision-handlers";
import { nodeDirWatch, type DirWatch } from "./revision-watcher";
import { openProjectStore, type ProjectDirectory } from "./store-root";
import { fixedClock, jsonString, nextId, q, readJsonObject, session } from "./test-support/build";
import { rejectsCode } from "./test-support/expect-error";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(prefix = "dr-live-"): Promise<string> {
  // realpath: os.tmpdir() is behind a symlink on macOS.
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

const storeOptions = { now: fixedClock, newId: nextId };
type Context = { paseo: unknown; signal: AbortSignal; push(event: RevisionEvent): Promise<void> };
/** The registered handler, called the way the daemon calls it. */
type Handler = (input: { projectId: string }, context: Context) => Promise<void>;

/** A mutable registry standing in for the daemon's project list. */
function registry(projects: Record<string, string>) {
  const map = { ...projects };
  const directory: ProjectDirectory = {
    listProjects: async () => Object.entries(map).map(([projectId, projectRootPath]) => ({ projectId, projectRootPath, projectKind: "git" })),
    listWorkspaces: async () => [],
  };
  return { map, directory };
}

/** Counts open node directory watches so release can be proven. */
function countingWatch() {
  const open = new Set<string>();
  let n = 0;
  const watch: DirWatch = (dir, onEvent, onError) => {
    const stop = nodeDirWatch(dir, onEvent, onError);
    const id = `${++n}:${dir}`;
    open.add(id);
    return () => {
      open.delete(id);
      stop();
    };
  };
  return { watch, open };
}

function serve(directory: ProjectDirectory, opts: { supported?: boolean; watch?: DirWatch } = {}) {
  const registered: Array<{ contract: unknown; handler: Handler }> = [];
  const server: Pick<PluginServerContext, "handle"> = {
    handle: (contract: unknown, handler: unknown) => {
      if (typeof handler !== "function") throw new Error("no handler");
      registered.push({
        contract,
        handler: async (input, context) => {
          const out: unknown = Reflect.apply(handler, undefined, [input, context]);
          await out;
        },
      });
    },
  };
  const stop = registerRevisionWatch(server, { directory: () => directory, storeOptions, settleMs: 20, ...(opts.watch ? { watch: opts.watch } : {}) }, opts.supported ?? true);
  return { registered, stop };
}

function subscribe(handler: Handler, projectId: string) {
  const events: RevisionEvent[] = [];
  const controller = new AbortController();
  let settled: { ok: boolean; error?: unknown } | null = null;
  const raw = handler({ projectId }, {
    paseo: {},
    signal: controller.signal,
    push: async (event) => {
      // The daemon validates every event against the contract before it leaves the process.
      RoadmapRevisionWatch.event.parse(event);
      events.push(event);
    },
  });
  const done = raw.then(
    () => void (settled = { ok: true }),
    (error: unknown) => void (settled = { ok: false, error }),
  );
  return { events, controller, done, raw, settled: () => settled };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, label: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await tick(10);
  }
}

/** Runs a node script in another process; its argv after `--` are the paths it works on. */
function external(script: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", script, "--", ...args], (error, _stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()));
  });
}

// The store's commit protocol from outside: copy the new generation in, write a temp manifest, fsync, rename over.
const ATOMIC_COMMIT = `
import { cp, open, rename } from "node:fs/promises";
import { join } from "node:path";
const [stagingDecisions, decisions, generation] = process.argv.slice(1);
await cp(join(stagingDecisions, "generations", generation), join(decisions, "generations", generation), { recursive: true });
const { readFile } = await import("node:fs/promises");
const manifest = await readFile(join(stagingDecisions, "manifest.json"));
const tmp = join(decisions, "manifest.json.tmp-external");
const fh = await open(tmp, "w");
await fh.writeFile(manifest);
await fh.sync();
await fh.close();
await rename(tmp, join(decisions, "manifest.json"));
`;
const ATOMIC_CORRUPT = `
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
const [decisions] = process.argv.slice(1);
await writeFile(join(decisions, "manifest.json.tmp-bad"), "{ not json");
await rename(join(decisions, "manifest.json.tmp-bad"), join(decisions, "manifest.json"));
`;
const RESTORE = `
import { copyFile, rename } from "node:fs/promises";
import { join } from "node:path";
const [saved, decisions] = process.argv.slice(1);
await copyFile(saved, join(decisions, "manifest.json.tmp-restore"));
await rename(join(decisions, "manifest.json.tmp-restore"), join(decisions, "manifest.json"));
`;
const REMOVE = `
import { rm } from "node:fs/promises";
await rm(process.argv[1], { recursive: true, force: true });
`;
const SWAP = `
import { rename } from "node:fs/promises";
const [decisions, aside, replacement] = process.argv.slice(1);
await rename(decisions, aside);
await rename(replacement, decisions);
`;

const facts = (e: RevisionEvent) => [e.status, e.revision];

describe("roadmap.revision.watch on the real filesystem", () => {
  it("emits only version facts with the project id, and follows initialisation and writes in this process", async () => {
    const root = await newRoot();
    const { directory } = registry({ prj_a: root });
    const counted = countingWatch();
    const { registered } = serve(directory, { watch: counted.watch });
    expect(registered).toHaveLength(1);
    expect(registered[0].contract).toBe(RoadmapRevisionWatch);

    const sub = subscribe(registered[0].handler, "prj_a");
    await until(() => sub.events.length === 1, "missing facts");
    expect(sub.events[0]).toEqual({ exists: false, status: "missing", revision: null, schemaVersion: null, projectId: "prj_a" });

    const store = await openProjectStore(directory, "prj_a", storeOptions);
    await store.init();
    await until(() => sub.events.length === 2, "initialised facts");
    expect(sub.events[1]).toEqual({ exists: true, status: "ok", revision: 1, schemaVersion: 2, projectId: "prj_a" });

    await store.transact(1, (d) => {
      d.sessions.push(session("s1", [q("q1", { title: "Secret title that must not leak" })]));
    });
    await until(() => sub.events.length === 3, "rev 2 facts");
    expect(sub.events[2]).toEqual({ exists: true, status: "ok", revision: 2, schemaVersion: 2, projectId: "prj_a" });
    for (const e of sub.events) expect(Object.keys(e).sort()).toEqual(["exists", "projectId", "revision", "schemaVersion", "status"]);
    expect(JSON.stringify(sub.events)).not.toMatch(/Secret|q1|s1/);

    sub.controller.abort();
    await sub.done;
    expect(sub.settled()).toEqual({ ok: true });
    expect(counted.open.size).toBe(0);
  });

  it("follows another process's atomic manifest replacement, corruption, restore, removal and re-initialisation", async () => {
    const root = await newRoot();
    const staging = await newRoot("dr-staging-");
    const { directory } = registry({ prj_a: root, prj_stage: staging });
    const store = await openProjectStore(directory, "prj_a", storeOptions);
    await store.init();
    // Revision 2 is produced in a copy and committed into the watched store by another process.
    await cp(join(root, ".decisions"), join(staging, ".decisions"), { recursive: true });
    const stagingStore = await (await import("./store")).openStore({ ...storeOptions, storeRoot: staging, projectId: "prj_a" });
    await stagingStore.transact(1, (d) => {
      d.sessions.push(session("s1", [q("q1")]));
    });
    const stagedManifest = readJsonObject(await readFile(join(staging, ".decisions", "manifest.json"), "utf8"));
    expect(stagedManifest.revision).toBe(2);

    const counted = countingWatch();
    const { registered } = serve(directory, { watch: counted.watch });
    const sub = subscribe(registered[0].handler, "prj_a");
    await until(() => sub.events.length === 1, "initial facts");
    expect(facts(sub.events[0])).toEqual(["ok", 1]);
    const inodeBefore = (await stat(join(root, ".decisions", "manifest.json"))).ino;

    await external(ATOMIC_COMMIT, join(staging, ".decisions"), join(root, ".decisions"), jsonString(stagedManifest, "generation"));
    await until(() => sub.events.length === 2, "external commit");
    expect(sub.events[1]).toEqual({ exists: true, status: "ok", revision: 2, schemaVersion: 2, projectId: "prj_a" });
    expect((await stat(join(root, ".decisions", "manifest.json"))).ino).not.toBe(inodeBefore);

    const saved = join(staging, "manifest-rev2.json");
    await cp(join(root, ".decisions", "manifest.json"), saved);
    await external(ATOMIC_CORRUPT, join(root, ".decisions"));
    await until(() => sub.events.length === 3, "corrupt manifest");
    expect(sub.events[2]).toEqual({ exists: true, status: "invalid", revision: null, schemaVersion: null, projectId: "prj_a" });

    await external(RESTORE, saved, join(root, ".decisions"));
    await until(() => sub.events.length === 4, "restored manifest");
    expect(facts(sub.events[3])).toEqual(["ok", 2]);

    await external(REMOVE, join(root, ".decisions"));
    await until(() => sub.events.length === 5, "store removed");
    expect(sub.events[4]).toEqual({ exists: false, status: "missing", revision: null, schemaVersion: null, projectId: "prj_a" });

    await store.init();
    await until(() => sub.events.length === 6, "re-initialised");
    expect(facts(sub.events[5])).toEqual(["ok", 1]);
    expect(sub.settled()).toBeNull();

    sub.controller.abort();
    await sub.done;
    expect(counted.open.size).toBe(0);
  });

  it("a .decisions directory swapped by another process is followed, and writes into the new one are seen", async () => {
    const root = await newRoot();
    const staging = await newRoot("dr-staging-");
    const { directory } = registry({ prj_a: root });
    const store = await openProjectStore(directory, "prj_a", storeOptions);
    await store.init();
    await cp(join(root, ".decisions"), join(staging, "replacement"), { recursive: true });
    const { openStore } = await import("./store");
    // Advance the replacement to revision 3 by staging it as a store root of its own.
    await mkdir(join(staging, "stage"));
    await cp(join(staging, "replacement"), join(staging, "stage", ".decisions"), { recursive: true });
    const staged = await openStore({ ...storeOptions, storeRoot: join(staging, "stage"), projectId: "prj_a" });
    await staged.transact(1, (d) => void d.sessions.push(session("s1", [q("q1")])));
    await staged.transact(2, (d) => void d.sessions.push(session("s2", [q("q2")])));
    await rm(join(staging, "replacement"), { recursive: true });

    const counted = countingWatch();
    const { registered } = serve(directory, { watch: counted.watch });
    const sub = subscribe(registered[0].handler, "prj_a");
    await until(() => sub.events.length === 1, "initial facts");

    await external(SWAP, join(root, ".decisions"), join(staging, "aside"), join(staging, "stage", ".decisions"));
    await until(() => sub.events.length === 2, "swapped directory");
    expect(facts(sub.events[1])).toEqual(["ok", 3]);

    // A commit into the new directory is observed on the re-armed watch.
    await store.transact(3, (d) => void d.sessions.push(session("s3", [q("q3")])));
    await until(() => sub.events.length === 3, "write after swap");
    expect(facts(sub.events[2])).toEqual(["ok", 4]);
    expect(counted.open.size).toBe(1);

    sub.controller.abort();
    await sub.done;
    expect(counted.open.size).toBe(0);
  });

  it("rapid commits end on the final revision with increasing, distinct pushes", async () => {
    const root = await newRoot();
    const { directory } = registry({ prj_a: root });
    const store = await openProjectStore(directory, "prj_a", storeOptions);
    await store.init();
    const { registered } = serve(directory);
    const sub = subscribe(registered[0].handler, "prj_a");
    await until(() => sub.events.length === 1, "initial facts");
    for (let rev = 1; rev <= 10; rev++) {
      await store.transact(rev, (d) => void d.sessions.push(session(`s${rev}`, [q(`q${rev}`)])));
    }
    await until(() => sub.events.at(-1)?.revision === 11, "final revision");
    const revisions = sub.events.map((e) => e.revision ?? 0);
    for (let i = 1; i < revisions.length; i++) expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
    sub.controller.abort();
    await sub.done;
  });

  it("isolates projects: another project's writes push nothing, and events name only the subscribed project", async () => {
    const rootA = await newRoot();
    const rootB = await newRoot();
    const { directory } = registry({ prj_a: rootA, prj_b: rootB });
    const a = await openProjectStore(directory, "prj_a", storeOptions);
    const b = await openProjectStore(directory, "prj_b", storeOptions);
    await a.init();
    await b.init();
    const { registered } = serve(directory);
    const subA = subscribe(registered[0].handler, "prj_a");
    const subB = subscribe(registered[0].handler, "prj_b");
    await until(() => subA.events.length === 1 && subB.events.length === 1, "initial facts");
    await b.transact(1, (d) => void d.sessions.push(session("s1", [q("q1")])));
    await until(() => subB.events.length === 2, "B's write");
    await tick(200);
    expect(subA.events).toHaveLength(1);
    expect(subA.events.every((e) => e.projectId === "prj_a")).toBe(true);
    expect(subB.events.every((e) => e.projectId === "prj_b")).toBe(true);
    subA.controller.abort();
    subB.controller.abort();
    await Promise.all([subA.done, subB.done]);
  });

  it("refuses an unknown project and an unsafe store before watching anything", async () => {
    const root = await newRoot();
    const elsewhere = await newRoot();
    await symlink(elsewhere, join(root, ".decisions"));
    const { directory } = registry({ prj_link: root });
    const counted = countingWatch();
    const { registered } = serve(directory, { watch: counted.watch });
    const unknown = subscribe(registered[0].handler, "prj_nope");
    await rejectsCode(unknown.raw, "unknown_project");
    const unsafe = subscribe(registered[0].handler, "prj_link");
    await rejectsCode(unsafe.raw, "unsafe_root");
    expect(unknown.events).toEqual([]);
    expect(unsafe.events).toEqual([]);
    expect(counted.open.size).toBe(0);
  });

  it("a project that leaves the registry fails the subscription on its next change, releasing the watch", async () => {
    const root = await newRoot();
    const reg = registry({ prj_a: root });
    const store = await openProjectStore(reg.directory, "prj_a", storeOptions);
    await store.init();
    const counted = countingWatch();
    const { registered } = serve(reg.directory, { watch: counted.watch });
    const sub = subscribe(registered[0].handler, "prj_a");
    await until(() => sub.events.length === 1, "initial facts");
    delete reg.map.prj_a;
    await store.transact(1, (d) => void d.sessions.push(session("s1", [q("q1")])));
    await until(() => sub.settled() !== null, "subscription failed");
    expect(sub.settled()?.ok).toBe(false);
    expect(String(sub.settled()?.error)).toMatch(/not registered/);
    expect(sub.events).toHaveLength(1);
    expect(counted.open.size).toBe(0);
  });

  it("an abort before the project resolves ends the subscription without a watch", async () => {
    const root = await newRoot();
    const { directory } = registry({ prj_a: root });
    const counted = countingWatch();
    const { registered } = serve(directory, { watch: counted.watch });
    const sub = subscribe(registered[0].handler, "prj_a");
    sub.controller.abort();
    await sub.done;
    expect(sub.settled()).toEqual({ ok: true });
    expect(sub.events).toEqual([]);
    expect(counted.open.size).toBe(0);
  });

  it("plugin shutdown ends every open subscription and its watch; later writes push nothing", async () => {
    const root = await newRoot();
    const { directory } = registry({ prj_a: root });
    const store = await openProjectStore(directory, "prj_a", storeOptions);
    await store.init();
    const counted = countingWatch();
    const { registered, stop } = serve(directory, { watch: counted.watch });
    const one = subscribe(registered[0].handler, "prj_a");
    const two = subscribe(registered[0].handler, "prj_a");
    await until(() => one.events.length === 1 && two.events.length === 1, "initial facts");
    expect(counted.open.size).toBe(2);
    stop();
    await Promise.all([one.done, two.done]);
    expect(one.settled()).toEqual({ ok: true });
    expect(two.settled()).toEqual({ ok: true });
    expect(counted.open.size).toBe(0);
    await store.transact(1, (d) => void d.sessions.push(session("s1", [q("q1")])));
    await tick(200);
    expect(one.events).toHaveLength(1);
    expect(two.events).toHaveLength(1);
  });
});

describe("roadmap.revision.watch on hosts without subscriptions", () => {
  it("registers nothing when unsupported, and its stop function is harmless", () => {
    const { directory } = registry({});
    const { registered, stop } = serve(directory, { supported: false });
    expect(registered).toEqual([]);
    expect(() => stop()).not.toThrow();
  });

  it("detects support only from a defineSubscription function export", () => {
    // The SDK this plugin builds against predates subscriptions, like a 0.15 daemon's.
    expect(hostSupportsSubscriptions(installedSdk)).toBe(false);
    expect(hostSupportsSubscriptions({})).toBe(false);
    expect(hostSupportsSubscriptions({ defineSubscription: "yes" })).toBe(false);
    expect(hostSupportsSubscriptions({ defineSubscription: () => ({}) })).toBe(true);
    const refusing = new Proxy({}, {
      has: () => {
        throw new Error("unknown export");
      },
      get: () => {
        throw new Error("unknown export");
      },
    });
    expect(hostSupportsSubscriptions(refusing)).toBe(false);
  });

  it("the contract is a subscription contract (an `event` schema) a 0.16 daemon routes as such", () => {
    expect("event" in RoadmapRevisionWatch).toBe(true);
    expect("output" in RoadmapRevisionWatch).toBe(false);
    expect(RoadmapRevisionWatch.name).toMatch(/^[a-z][a-z0-9._-]*$/);
    expect(Object.isFrozen(RoadmapRevisionWatch)).toBe(true);
  });
});
