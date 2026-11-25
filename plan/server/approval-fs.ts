// Dedicated fs port for approval receipts: owner-only modes and atomic no-clobber publication.
// The store's StoreFs is deliberately not reused: it has no modes, chmod or link, and rename
// would replace an existing receipt.
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DomainError, errnoCode } from "../shared/errors";

// A type alias rather than an interface, so it stays assignable to plain records (test wrappers).
export type ApprovalFs = {
  /** mkdir -p, then chmod 0o700; the directory must not be a symlink. */
  ensureDir(path: string): Promise<void>;
  /** tmp "wx" 0o600 + fsync, link to the final name (EEXIST → "exists"), unlink tmp, fsync dir. */
  publishNoClobber(path: string, data: string): Promise<"created" | "exists">;
  /** ENOENT → null. */
  readFile(path: string): Promise<string | null>;
  removeStaleTemps(dir: string, olderThanMs: number): Promise<void>;
  /** st_mode & 0o777. */
  mode(path: string): Promise<number>;
};

const code = errnoCode;

/** Receipt temps: `.<rev>.json.tmp-<id>`. */
export const TEMP_RE = /^\.[^/]+\.json\.tmp-[A-Za-z0-9_-]+$/;

async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const nodeApprovalFs: ApprovalFs = {
  async ensureDir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const st = await lstat(path);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new DomainError("unsafe_root", "approval directory is not a real directory");
    }
    await chmod(path, 0o700);
  },
  async publishNoClobber(path, data) {
    const dir = dirname(path);
    const tmp = join(dir, `.${basename(path)}.tmp-${randomBytes(8).toString("hex")}`);
    let outcome: "created" | "exists";
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(data, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(tmp, 0o600);
      try {
        await link(tmp, path);
        outcome = "created";
      } catch (e) {
        if (code(e) !== "EEXIST") throw e; // EPERM/ENOTSUP included: no clobbering fallback
        outcome = "exists";
      }
    } finally {
      // Best-effort cleanup; separate from the durability guarantee below.
      await unlink(tmp).catch(() => undefined);
    }
    // Durability: neither a new nor an existing receipt is reported until its directory entry is
    // synced. On failure the final file may remain linked; a retry finds it and syncs again.
    await fsyncDir(dir);
    return outcome;
  },
  async readFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch (e) {
      if (code(e) === "ENOENT") return null;
      throw e;
    }
  },
  async removeStaleTemps(dir, olderThanMs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (code(e) === "ENOENT") return;
      throw e;
    }
    const cutoff = Date.now() - olderThanMs;
    for (const name of names) {
      if (!TEMP_RE.test(name)) continue;
      const full = join(dir, name);
      const st = await lstat(full).catch(() => null);
      if (st && st.isFile() && st.mtimeMs < cutoff) await unlink(full).catch(() => undefined);
    }
  },
  async mode(path) {
    return (await stat(path)).mode & 0o777;
  },
};
