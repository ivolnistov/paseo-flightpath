// watchRevisions with an in-memory directory watch and identity: what is watched and when, how
// notifications become reads and pushes, and how the watch ends. The real filesystem is covered in
// revision-watcher-fs.test.ts.
import { describe, expect, it } from "vitest";
import type { RevisionFacts } from "../shared/rpc-live";
import { watchRevisions, type DirIdentity, type DirWatch } from "./revision-watcher";

const ROOT = "/p/root";
const DECISIONS = `${ROOT}/.decisions`;

type Watch = { dir: string; onEvent(filename: string | null): void; onError(e: unknown): void; stopped: boolean };

const facts = (revision: number | null, status: RevisionFacts["status"] = revision === null ? "missing" : "ok"): RevisionFacts => ({
  exists: status !== "missing",
  status,
  revision,
  schemaVersion: status === "ok" ? 2 : null,
});

function harness(opts: { id?: string | null } = {}) {
  const log: string[] = [];
  const watches: Watch[] = [];
  const state = { id: opts.id === undefined ? "1:10" : opts.id, facts: facts(1), watchThrows: [] as unknown[] };
  const pushed: RevisionFacts[] = [];
  const watch: DirWatch = (dir, onEvent, onError) => {
    const next = state.watchThrows.shift();
    if (next !== undefined) throw next;
    const w: Watch = { dir, onEvent, onError, stopped: false };
    watches.push(w);
    log.push(`watch ${dir}`);
    return () => {
      w.stopped = true;
      log.push(`stop ${dir}`);
    };
  };
  const identity: DirIdentity = async (path) => {
    expect(path).toBe(DECISIONS);
    return state.id;
  };
  let reads = 0;
  let readHook: (() => Promise<void> | void) | null = null;
  const read = async () => {
    reads++;
    log.push("read");
    // The read's result is what was on disk when it started; the hook models a writer racing it.
    const snapshot = { ...state.facts };
    if (readHook !== null) await readHook();
    return snapshot;
  };
  const push = async (f: RevisionFacts) => {
    log.push(`push ${f.status}:${String(f.revision)}`);
    pushed.push(f);
  };
  const controller = new AbortController();
  const start = (extra: Partial<Parameters<typeof watchRevisions>[0]> = {}) =>
    watchRevisions({ decisionsDir: DECISIONS, read, push, signal: controller.signal, watch, identity, settleMs: 5, ...extra });
  const live = () => watches.filter((w) => !w.stopped);
  return {
    log,
    watches,
    live,
    state,
    pushed,
    controller,
    start,
    reads: () => reads,
    onRead(fn: (() => Promise<void> | void) | null) {
      readHook = fn;
    },
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, label: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await tick(2);
  }
}

describe("watchRevisions: start", () => {
  it("watches .decisions before the first read and pushes the initial facts once", async () => {
    const t = harness();
    const done = t.start();
    await until(() => t.pushed.length === 1, "initial push");
    expect(t.log.slice(0, 2)).toEqual([`watch ${DECISIONS}`, "read"]);
    expect(t.pushed).toEqual([facts(1)]);
    expect(t.live().map((w) => w.dir)).toEqual([DECISIONS]);
    t.controller.abort();
    await expect(done).resolves.toBeUndefined();
  });

  it("watches the project root while .decisions is absent and pushes missing facts", async () => {
    const t = harness({ id: null });
    t.state.facts = facts(null);
    const done = t.start();
    await until(() => t.pushed.length === 1, "initial push");
    expect(t.log.slice(0, 2)).toEqual([`watch ${ROOT}`, "read"]);
    expect(t.pushed).toEqual([facts(null)]);
    t.controller.abort();
    await done;
  });

  it("resolves at once and never watches or reads when the signal is already aborted", async () => {
    const t = harness();
    t.controller.abort();
    await expect(t.start()).resolves.toBeUndefined();
    await tick(20);
    expect(t.log).toEqual([]);
  });

  it("a change between arming the watch and the first read's result is not lost", async () => {
    const t = harness();
    // The writer commits while the first read is in flight; its notification arrives on the armed watch.
    t.onRead(() => {
      if (t.reads() === 1) {
        t.state.facts = facts(2);
        t.watches[0].onEvent("manifest.json");
      }
    });
    const done = t.start();
    await until(() => t.pushed.length === 2, "second push");
    expect(t.pushed).toEqual([facts(1), facts(2)]);
    expect(t.reads()).toBe(2);
    t.controller.abort();
    await done;
  });
});

describe("watchRevisions: notifications", () => {
  it("a burst of notifications is one read and one push", async () => {
    const t = harness();
    const done = t.start();
    await until(() => t.pushed.length === 1, "initial push");
    const before = t.reads();
    t.state.facts = facts(2);
    for (let i = 0; i < 20; i++) t.watches[0].onEvent(i % 2 === 0 ? "manifest.json" : null);
    await until(() => t.pushed.length === 2, "burst push");
    await tick(30);
    expect(t.reads() - before).toBe(1);
    expect(t.pushed).toEqual([facts(1), facts(2)]);
    t.controller.abort();
    await done;
  });

  it("drops facts equal to the last pushed (a notification without a durable change)", async () => {
    const t = harness();
    const done = t.start();
    await until(() => t.pushed.length === 1, "initial push");
    t.watches[0].onEvent("generations");
    await until(() => t.reads() === 2, "second read");
    await tick(30);
    expect(t.pushed).toEqual([facts(1)]);
    t.controller.abort();
    await done;
  });

  it("notifications during a read cause exactly one more read, which sees the latest facts", async () => {
    const t = harness();
    const gate: { release: (() => void) | null } = { release: null };
    const done = t.start();
    await until(() => t.pushed.length === 1, "initial push");
    t.onRead(() => new Promise<void>((r) => (gate.release = r)));
    t.state.facts = facts(2);
    t.watches[0].onEvent("manifest.json");
    await until(() => gate.release !== null, "slow read started");
    const slow = gate.release;
    if (slow === null) throw new Error("no slow read");
    gate.release = null;
    t.state.facts = facts(3);
    t.watches[0].onEvent("manifest.json");
    t.watches[0].onEvent("manifest.json");
    t.onRead(null);
    slow();
    await until(() => t.pushed.at(-1)?.revision === 3, "latest push");
    await tick(30);
    // Read 2 returned facts already superseded (rev 3 written meanwhile); read 3 is the only follow-up.
    expect(t.reads()).toBe(3);
    expect(t.pushed.map((f) => f.revision)).toEqual([1, 2, 3]);
    t.controller.abort();
    await done;
  });

  it("status changes with the same revision are pushed (ok to invalid)", async () => {
    const t = harness();
    const done = t.start();
    await until(() => t.pushed.length === 1, "initial push");
    t.state.facts = facts(1, "invalid");
    t.watches[0].onEvent("manifest.json");
    await until(() => t.pushed.length === 2, "invalid push");
    expect(t.pushed[1]).toEqual({ exists: true, status: "invalid", revision: 1, schemaVersion: null });
    t.controller.abort();
    await done;
  });
});

describe("watchRevisions: the watched directory changes", () => {
  it("first initialisation: parent watch, .decisions appears, the watch moves to it and the facts are pushed", async () => {
    const t = harness({ id: null });
    t.state.facts = facts(null);
    const done = t.start();
    await until(() => t.pushed.length === 1, "missing push");
    const parent = t.watches[0];
    // Unrelated names in the project root are not a store change.
    parent.onEvent("README.md");
    await tick(30);
    expect(t.reads()).toBe(1);
    t.state.id = "1:20";
    t.state.facts = facts(1);
    parent.onEvent(".decisions");
    await until(() => t.pushed.length === 2, "ok push");
    expect(parent.stopped).toBe(true);
    expect(t.live().map((w) => w.dir)).toEqual([DECISIONS]);
    expect(t.pushed[1]).toEqual(facts(1));
    // Later commits are seen on the new watch.
    t.state.facts = facts(2);
    t.live()[0].onEvent("manifest.json");
    await until(() => t.pushed.length === 3, "rev 2 push");
    t.controller.abort();
    await done;
  });

  it("a replaced .decisions directory is re-watched by its new identity", async () => {
    const t = harness();
    const done = t.start();
    await until(() => t.pushed.length === 1, "initial push");
    const old = t.watches[0];
    t.state.id = "1:99";
    t.state.facts = facts(7);
    old.onEvent(null);
    await until(() => t.pushed.length === 2, "replacement push");
    expect(old.stopped).toBe(true);
    expect(t.live()).toHaveLength(1);
    expect(t.live()[0]).not.toBe(old);
    t.state.facts = facts(8);
    t.live()[0].onEvent("manifest.json");
    await until(() => t.pushed.length === 3, "push on the new directory");
    expect(t.pushed.map((f) => f.revision)).toEqual([1, 7, 8]);
    t.controller.abort();
    await done;
  });

  it("the store removed: the watch falls back to the project root and missing facts are pushed", async () => {
    const t = harness();
    const done = t.start();
    await until(() => t.pushed.length === 1, "initial push");
    t.state.id = null;
    t.state.facts = facts(null);
    t.watches[0].onEvent(null);
    await until(() => t.pushed.length === 2, "missing push");
    expect(t.live().map((w) => w.dir)).toEqual([ROOT]);
    t.controller.abort();
    await done;
  });

  it("the directory changing during a read is read again under the new watch before pushing", async () => {
    const t = harness();
    t.onRead(() => {
      if (t.reads() === 1) {
        t.state.id = "1:55";
        t.state.facts = facts(4);
      }
    });
    const done = t.start();
    await until(() => t.pushed.length === 1, "push");
    expect(t.reads()).toBe(2);
    expect(t.pushed).toEqual([facts(4)]);
    t.controller.abort();
    await done;
  });

  it("an ENOENT from the watch (directory vanished after the check) is retried", async () => {
    const t = harness();
    t.state.watchThrows.push(Object.assign(new Error("gone"), { code: "ENOENT" }));
    const done = t.start();
    await until(() => t.pushed.length === 1, "push");
    expect(t.live()).toHaveLength(1);
    t.controller.abort();
    await done;
  });
});

describe("watchRevisions: end", () => {
  it("abort stops the watch, resolves, and later notifications neither read nor push", async () => {
    const t = harness();
    const done = t.start();
    await until(() => t.pushed.length === 1, "initial push");
    const w = t.watches[0];
    t.controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(w.stopped).toBe(true);
    const reads = t.reads();
    t.state.facts = facts(2);
    w.onEvent("manifest.json");
    await tick(30);
    expect(t.reads()).toBe(reads);
    expect(t.pushed).toHaveLength(1);
  });

  it("abort while a coalescing timer is pending cancels the read", async () => {
    const t = harness();
    const done = t.start({ settleMs: 40 });
    await until(() => t.pushed.length === 1, "initial push");
    t.watches[0].onEvent("manifest.json");
    t.controller.abort();
    await done;
    const reads = t.reads();
    await tick(80);
    expect(t.reads()).toBe(reads);
  });

  it("a watcher error rejects (the caller's poll takes over) and stops the watch", async () => {
    const t = harness();
    const done = t.start();
    await until(() => t.pushed.length === 1, "initial push");
    t.watches[0].onError(new Error("EMFILE: too many open files"));
    await expect(done).rejects.toThrow(/EMFILE/);
    expect(t.live()).toHaveLength(0);
  });

  it("a non-Error watcher failure still rejects with an Error", async () => {
    const t = harness();
    const done = t.start();
    await until(() => t.pushed.length === 1, "initial push");
    t.watches[0].onError("boom");
    await expect(done).rejects.toBeInstanceOf(Error);
  });

  it("a watch that cannot be started rejects", async () => {
    const t = harness();
    t.state.watchThrows.push(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(t.start()).rejects.toThrow(/denied/);
    expect(t.reads()).toBe(0);
  });

  it("a failing read rejects and stops the watch", async () => {
    const t = harness();
    t.onRead(() => {
      throw new Error("project prj_a is not registered exactly once");
    });
    await expect(t.start()).rejects.toThrow(/not registered/);
    expect(t.live()).toHaveLength(0);
  });

  it("a failing push rejects and stops the watch", async () => {
    const t = harness();
    const done = t.start({ push: async () => Promise.reject(new Error("subscriber gone")) });
    await expect(done).rejects.toThrow(/subscriber gone/);
    expect(t.live()).toHaveLength(0);
  });

  it("an identity failure other than missing rejects", async () => {
    const t = harness();
    const done = t.start({
      identity: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    await expect(done).rejects.toThrow(/EACCES/);
    expect(t.reads()).toBe(0);
  });
});
