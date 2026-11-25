import { watch as fsWatch } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { RevisionFacts } from "../shared/rpc-live";

/** Starts watching one directory; throws when it cannot. The returned function stops the watch. */
export type DirWatch = (dir: string, onEvent: (filename: string | null) => void, onError: (error: unknown) => void) => () => void;

/** The identity of a real directory, or null when the path is absent or not a real directory. */
export type DirIdentity = (path: string) => Promise<string | null>;

export const nodeDirWatch: DirWatch = (dir, onEvent, onError) => {
  const watcher = fsWatch(dir, { persistent: false }, (_type, filename) => onEvent(filename === null ? null : String(filename)));
  watcher.on("error", onError);
  return () => watcher.close();
};

export const nodeDirIdentity: DirIdentity = async (path) => {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? `${stat.dev}:${stat.ino}` : null;
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
};

const isMissing = (e: unknown) => {
  const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
};

export interface RevisionWatchOptions {
  /** `<project root>/.decisions`; the project root is watched while it is absent. */
  decisionsDir: string;
  /** The store's canonical version facts. */
  read(): Promise<RevisionFacts>;
  /** Sends facts to the subscriber. */
  push(facts: RevisionFacts): Promise<void>;
  signal: AbortSignal;
  watch?: DirWatch;
  identity?: DirIdentity;
  /** How long notifications are gathered before one read. */
  settleMs?: number;
}

/**
 * Pushes the store's version facts now and after every durable change by any writer, until
 * `signal` aborts (resolves) or watching fails (rejects, so the caller's polling takes over).
 *
 * The watch is on the `.decisions` directory, never on `manifest.json`, whose file is replaced on
 * every commit. The watch is armed before each read, so a change between the two is not lost.
 * Notifications are coalesced into one read at a time; facts equal to the last pushed are dropped.
 */
export function watchRevisions(options: RevisionWatchOptions): Promise<void> {
  const watch = options.watch ?? nodeDirWatch;
  const identity = options.identity ?? nodeDirIdentity;
  const settleMs = options.settleMs ?? 50;
  const { decisionsDir, signal } = options;
  const parent = dirname(decisionsDir);
  const name = basename(decisionsDir);

  return new Promise<void>((resolve, reject) => {
    let armed: { key: string; stop(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading = false;
    let dirty = false;
    let last: string | null = null;
    let finished = false;

    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const stop = armed?.stop;
      armed = null;
      signal.removeEventListener("abort", onAbort);
      try {
        stop?.();
      } catch {
        // Closing a watcher that already failed changes nothing.
      }
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => finish();

    const schedule = () => {
      if (finished) return;
      if (reading) {
        dirty = true;
        return;
      }
      if (timer === null) timer = setTimeout(() => void run(), settleMs);
    };

    /** Watches `.decisions` when it is a real directory, otherwise the project root for its creation. Returns the watched target. */
    const arm = async (): Promise<string> => {
      for (let attempt = 0; ; attempt++) {
        const id = await identity(decisionsDir);
        if (finished) return "";
        const key = id === null ? `parent:${parent}` : `decisions:${id}`;
        if (armed?.key === key) return key;
        const previous = armed;
        armed = null;
        previous?.stop();
        let stop: () => void;
        try {
          stop =
            id === null
              ? watch(parent, (filename) => (filename === null || filename === name ? schedule() : undefined), (e) => finish(e))
              : watch(decisionsDir, () => schedule(), (e) => finish(e));
        } catch (e) {
          // The directory went away between the check and the watch: check again, a few times.
          if (isMissing(e) && attempt < 3) continue;
          throw e;
        }
        if (finished) {
          stop();
          return "";
        }
        armed = { key, stop };
        return key;
      }
    };

    const refresh = async () => {
      for (;;) {
        const before = await arm();
        const facts = await options.read();
        // A target that changed during the read (the directory appeared or was replaced) may have
        // missed a notification: read again under the new watch.
        const after = await arm();
        if (finished) return;
        if (after !== before) continue;
        const key = JSON.stringify([facts.exists, facts.status, facts.revision, facts.schemaVersion]);
        if (key === last) return;
        last = key;
        await options.push(facts);
        return;
      }
    };

    const run = async () => {
      timer = null;
      if (finished || reading) return;
      reading = true;
      try {
        do {
          dirty = false;
          await refresh();
        } while (dirty && !finished);
      } catch (e) {
        finish(e);
      } finally {
        reading = false;
      }
    };

    if (signal.aborted) {
      finished = true;
      resolve();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void run();
  });
}
