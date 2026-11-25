import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink, chmod, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PipelineError } from "../shared/errors";
import { sha256Hex } from "./hash";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * The only file operations Pipeline performs on its own data. Every write is durable when the
 * promise resolves: file contents are synced and the parent directory is synced after a name
 * changes. No operation follows a symlink at the target path.
 */
export interface PipelineFs {
  /** Creates the directory and missing parents with mode 0700. */
  ensureDir(path: string): Promise<void>;
  /** The exact bytes, or null when the file does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Atomically replaces the file: temp file in the same directory, sync, rename, directory sync. */
  replaceFile(path: string, bytes: Uint8Array): Promise<void>;
  /** Writes a file only if none exists; returns false and leaves the existing file untouched otherwise. */
  publishNoClobber(path: string, bytes: Uint8Array): Promise<boolean>;
  /** Appends one line plus a newline and syncs the file. The line must not contain a newline. */
  appendLine(path: string, line: string): Promise<void>;
  /** Shortens the file to `length` bytes and syncs it. */
  truncate(path: string, length: number): Promise<void>;
  /** Removes the file; returns false when it did not exist. */
  remove(path: string): Promise<boolean>;
  /** Entry names sorted by code unit, or [] when the directory does not exist. */
  listDir(path: string): Promise<string[]>;
}

/** Called at the named step of a write; a throwing hook stands in for a crash at that point. */
export type FsStep = "replace.synced" | "replace.renamed" | "publish.synced" | "publish.linked";
export type FsHook = (step: FsStep, path: string) => void | Promise<void>;

const TEMP_SUFFIX = ".tmp";

/** True for the temp names `replaceFile` and `publishNoClobber` create. */
export function isTempName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(TEMP_SUFFIX);
}

/** SHA-256 hex of the exact bytes, or `absent`. */
export function digestOf(bytes: Uint8Array | null): string {
  return bytes === null ? "absent" : sha256Hex(bytes);
}

function errno(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

function unsafe(path: string, cause?: unknown): PipelineError {
  return new PipelineError("unsafe_path", `Refusing a non-regular file: ${basename(path)}`, { cause });
}

async function syncDir(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeTemp(path: string, bytes: Uint8Array): Promise<string> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}${TEMP_SUFFIX}`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temp;
}

async function openExisting(path: string, flags: number): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, flags | constants.O_NOFOLLOW);
  } catch (error) {
    const code = errno(error);
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EISDIR") throw unsafe(path, error);
    throw error;
  }
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    throw unsafe(path);
  }
  return handle;
}

export function createNodeFs(options: { hook?: FsHook } = {}): PipelineFs {
  const hook = options.hook ?? (() => undefined);

  return {
    async ensureDir(path) {
      await mkdir(path, { recursive: true, mode: DIR_MODE });
      const stat = await lstat(path);
      if (!stat.isDirectory()) throw unsafe(path);
      if ((stat.mode & 0o777) !== DIR_MODE) await chmod(path, DIR_MODE);
    },

    async readFile(path) {
      const handle = await openExisting(path, constants.O_RDONLY);
      if (handle === null) return null;
      try {
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    },

    async replaceFile(path, bytes) {
      const existing = await lstat(path).catch((error: unknown) => {
        if (errno(error) === "ENOENT") return null;
        throw error;
      });
      if (existing !== null && !existing.isFile()) throw unsafe(path);
      const temp = await writeTemp(path, bytes);
      try {
        await hook("replace.synced", path);
        await rename(temp, path);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
      await syncDir(dirname(path));
      await hook("replace.renamed", path);
    },

    async publishNoClobber(path, bytes) {
      const temp = await writeTemp(path, bytes);
      let published = true;
      try {
        await hook("publish.synced", path);
        await link(temp, path);
      } catch (error) {
        if (errno(error) !== "EEXIST") {
          await unlink(temp).catch(() => undefined);
          throw error;
        }
        published = false;
      }
      await unlink(temp);
      await syncDir(dirname(path));
      if (published) await hook("publish.linked", path);
      return published;
    },

    async appendLine(path, line) {
      if (line.includes("\n")) throw new PipelineError("internal", "An appended line must not contain a newline.");
      const probe = await openExisting(path, constants.O_RDONLY);
      await probe?.close();
      const created = probe === null;
      const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, FILE_MODE);
      try {
        await handle.writeFile(`${line}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (created) await syncDir(dirname(path));
    },

    async truncate(path, length) {
      const handle = await openExisting(path, constants.O_RDWR);
      if (handle === null) throw new PipelineError("internal", `Cannot truncate a missing file: ${basename(path)}`);
      try {
        await handle.truncate(length);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },

    async remove(path) {
      try {
        await unlink(path);
      } catch (error) {
        if (errno(error) === "ENOENT") return false;
        throw error;
      }
      await syncDir(dirname(path));
      return true;
    },

    async listDir(path) {
      try {
        return (await readdir(path)).sort();
      } catch (error) {
        if (errno(error) === "ENOENT") return [];
        throw error;
      }
    },
  };
}
