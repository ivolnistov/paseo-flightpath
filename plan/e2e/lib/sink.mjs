// The drop sink's accounting, independent of sockets so it can be checked with fakes
// (e2e/guards.test.mjs). Every accepted connection is recorded exactly once: by its request line, or
// as closed/errored/silent before one, or as still open at teardown. The number of distinct targets
// kept is capped; any further distinct target is counted under one overflow key, never dropped from
// the totals. The ledger's counts always add up to its attempts.
import { proxyTarget } from "./guards.mjs";

export const NO_LINE = Object.freeze({
  closed: "(closed before a request line)",
  error: "(error before a request line)",
  silent: "(no request line within the time limit)",
  unreadable: "(no readable request line)",
  open: "(still open at teardown)",
  overflow: "(further distinct targets beyond the record cap)",
});

export function createDropLedger({ maxKeys = 200 } = {}) {
  const counts = new Map();
  const pending = new Set();
  let attempts = 0;
  let recorded = 0;
  const add = (key) => {
    const k = counts.has(key) || counts.size < maxKeys ? key : NO_LINE.overflow;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    recorded++;
  };
  return {
    /** A new accepted connection; returns its one-shot recorder. */
    open() {
      attempts++;
      const entry = { done: false };
      pending.add(entry);
      return (key) => {
        if (entry.done) return false;
        entry.done = true;
        pending.delete(entry);
        add(key);
        return true;
      };
    },
    /** Records every connection still pending as open at teardown. */
    finalize() {
      for (const entry of [...pending]) {
        entry.done = true;
        pending.delete(entry);
        add(NO_LINE.open);
      }
    },
    get attempts() {
      return attempts;
    },
    get recorded() {
      return recorded;
    },
    get pending() {
      return pending.size;
    },
    /** Targets with counts, most frequent first. */
    summary() {
      return [...counts].sort((a, b) => b[1] - a[1]).map(([target, count]) => ({ target, count }));
    },
  };
}

/** The ledger key for a request line: "METHOD target", or the unreadable marker. */
export function lineKey(line) {
  const t = proxyTarget(line);
  return t.method ? `${t.method} ${t.target}` : NO_LINE.unreadable;
}

/**
 * Handles one accepted sink connection (a net.Socket, or any EventEmitter with destroy()): reads
 * only the request line, records exactly one outcome, then destroys it. Nothing is answered or
 * forwarded.
 */
export function handleSinkSocket(socket, ledger, { timeoutMs = 1_000, maxLine = 2048 } = {}) {
  const record = ledger.open();
  let buf = "";
  const finish = (key) => {
    clearTimeout(timer);
    record(key);
    if (!socket.destroyed) socket.destroy();
  };
  const timer = setTimeout(() => finish(NO_LINE.silent), timeoutMs);
  timer.unref?.();
  socket.on("data", (chunk) => {
    buf += Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk);
    const end = buf.indexOf("\r\n");
    if (end >= 0) finish(lineKey(buf.slice(0, end)));
    else if (buf.length > maxLine) finish(NO_LINE.unreadable);
  });
  socket.on("error", () => finish(NO_LINE.error));
  socket.on("close", () => finish(NO_LINE.closed));
  socket.on("end", () => finish(NO_LINE.closed));
}

/**
 * The run's verdict on its drops: every attempt must be accounted for (counts adding up to the
 * attempts, nothing pending) and every target must be one of `expected`. Returns what is not; a
 * run passes only when it is empty.
 */
export function unexpectedDrops(drops, expected) {
  if (!drops || !Array.isArray(drops.targets) || !Number.isInteger(drops.attempts)) return [{ target: "(no record of dropped attempts)", count: 1 }];
  const out = drops.targets.filter((t) => !expected.includes(t.target));
  const sum = drops.targets.reduce((n, t) => n + t.count, 0);
  if (sum !== drops.attempts) out.push({ target: "(attempts not accounted for)", count: Math.abs(drops.attempts - sum) });
  if (drops.pending) out.push({ target: "(attempts still pending)", count: drops.pending });
  return out;
}
