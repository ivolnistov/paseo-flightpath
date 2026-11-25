import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { errnoCode } from "../shared/errors";

export interface StoreFs {
  mkdir(path: string): Promise<void>;
  writeFileDurable(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  fsyncDir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  rm(path: string): Promise<void>;
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean } | null>;
  realpath(path: string): Promise<string>;
}

const isEnoent = (e: unknown) => errnoCode(e) === "ENOENT";

export const nodeStoreFs: StoreFs = {
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async writeFileDurable(path, data) {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => rename(from, to),
  async fsyncDir(path) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  readFile: (path) => readFile(path, "utf8"),
  readdir: (path) => readdir(path),
  rm: (path) => rm(path, { recursive: true, force: true }),
  async lstat(path) {
    try {
      return await lstat(path);
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
  },
  realpath: (path) => realpath(path),
};
