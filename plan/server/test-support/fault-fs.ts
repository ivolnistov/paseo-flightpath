// StoreFs wrappers that record calls or inject a failure at a chosen call.
import type { StoreFs } from "../fs-port";

export type FsOp = keyof StoreFs;
export type FsCall = { n: number; op: FsOp; path: string; to?: string };

/** Calls that change disk state or its durability; a crash can land on any of them. */
export const MUTATING_OPS: ReadonlySet<FsOp> = new Set<FsOp>([
  "mkdir",
  "writeFileDurable",
  "rename",
  "fsyncDir",
  "rm",
]);

function wrap(base: StoreFs, before: (call: FsCall) => void): StoreFs {
  let n = 0;
  const record = (op: FsOp, path: string, to?: string) => {
    n += 1;
    before({ n, op, path, ...(to !== undefined ? { to } : {}) });
  };
  // Typed as the full port: a new StoreFs operation is a compile error here until it is wrapped.
  const out: StoreFs = {
    mkdir: async (path) => (record("mkdir", path), base.mkdir(path)),
    writeFileDurable: async (path, data) => (record("writeFileDurable", path), base.writeFileDurable(path, data)),
    rename: async (from, to) => (record("rename", from, to), base.rename(from, to)),
    fsyncDir: async (path) => (record("fsyncDir", path), base.fsyncDir(path)),
    readFile: async (path) => (record("readFile", path), base.readFile(path)),
    readdir: async (path) => (record("readdir", path), base.readdir(path)),
    rm: async (path) => (record("rm", path), base.rm(path)),
    lstat: async (path) => (record("lstat", path), base.lstat(path)),
    realpath: async (path) => (record("realpath", path), base.realpath(path)),
  };
  return out;
}

/** Throws `Error("injected")` before delegating the call for which `failOn` returns true. */
export function faultFs(
  base: StoreFs,
  plan: { failOn: (op: string, path: string, n: number) => boolean },
): StoreFs {
  return wrap(base, ({ op, path, n }) => {
    if (plan.failOn(String(op), path, n)) throw new Error("injected");
  });
}

/** Delegates every call and logs it; `n` is the 1-based call index shared with `faultFs`. */
export function recordingFs(base: StoreFs): { fs: StoreFs; calls: FsCall[] } {
  const calls: FsCall[] = [];
  return { fs: wrap(base, (call) => void calls.push(call)), calls };
}
