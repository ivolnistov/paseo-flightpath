// The sandbox's exclusive E2E run lock: one harness run per sandbox store at a time.
//
// - Acquire creates the lock file exclusively (O_CREAT|O_EXCL|O_NOFOLLOW): an existing file, a
//   symlink or anything else at that path is contention, and the run stops (fail closed).
// - The lock names its holder with a random token. Only that token releases it; a lock held by
//   another run, a stale one (dead pid) or a malformed one is reported and never deleted: a human
//   decides whether to remove it.
// - Release checks the token immediately before unlinking. No other run deletes a lock it does not
//   hold, so the file cannot be replaced between the check and the unlink.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

const MAX_LOCK_BYTES = 4096;

export function newLockToken() {
  return randomBytes(16).toString("hex");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** What is at the lock path: absent, a lock file (parsed when possible), or something else. */
export function inspectLock(file) {
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if (e?.code === "ENOENT") return { state: "absent" };
    throw e;
  }
  if (!st.isFile()) return { state: "not a regular file", type: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : "other" };
  if (st.size > MAX_LOCK_BYTES) return { state: "malformed", reason: `${st.size} bytes` };
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { state: "malformed", reason: "not JSON" };
  }
  if (!data || typeof data.token !== "string" || !/^[0-9a-f]{32}$/.test(data.token)) return { state: "malformed", reason: "no token" };
  return { state: "held", holder: { pid: data.pid, runId: data.runId, startedAt: data.startedAt, alive: pidAlive(data.pid) }, token: data.token };
}

export class LockBusy extends Error {}

/** Takes the lock for `token` or throws LockBusy describing the holder; never touches an existing lock. */
export function acquireLock(file, { token, runId, pid = process.pid, now = new Date() }, io = { writeSync, fsyncSync }) {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) throw new Error("a lock token must be 32 hex characters");
  let fd;
  try {
    fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if (e?.code === "EEXIST" || e?.code === "ELOOP") {
      const found = inspectLock(file);
      const who = found.state === "held" ? `run ${found.holder.runId ?? "?"} (pid ${found.holder.pid}, ${found.holder.alive ? "alive" : "not running: stale"}, since ${found.holder.startedAt ?? "?"})` : `${found.state}${found.type ? ` (${found.type})` : ""}${found.reason ? ` (${found.reason})` : ""}`;
      throw new LockBusy(`the sandbox E2E lock ${file} is taken by ${who}; refusing to run. It is never removed automatically: remove it by hand only after confirming no run uses the sandbox.`);
    }
    throw e;
  }
  try {
    io.writeSync(fd, JSON.stringify({ token, runId, pid, startedAt: now.toISOString() }));
    io.fsyncSync(fd);
  } catch (e) {
    // This call created the file exclusively a moment ago, so it is ours to remove: a half-written
    // lock would otherwise block every later run as "malformed".
    closeSync(fd);
    unlinkSync(file);
    throw e;
  }
  closeSync(fd);
  return { file, token };
}

/** Whether the lock is held by `token` right now. */
export function holdsLock(file, token) {
  const found = inspectLock(file);
  return found.state === "held" && found.token === token;
}

/** Releases the lock only when `token` holds it; otherwise leaves whatever is there untouched. */
export function releaseLock(file, token) {
  const found = inspectLock(file);
  if (found.state === "absent") return { released: false, reason: "absent" };
  if (found.state !== "held") return { released: false, reason: `left in place: ${found.state}` };
  if (found.token !== token) return { released: false, reason: "left in place: held by another run" };
  unlinkSync(file);
  return { released: true };
}
