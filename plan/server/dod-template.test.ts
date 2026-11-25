// DoD template resolution (redesign Stage R0.3, task card §4; plan §1 "Project DoD template
// sources"): `<storeRoot>/dod template.md` (a regular, non-symlink file) > project text > global
// text > none. First found wins, no merge. Real temp directories exercise the Node port; small
// fakes cover lstat answers a real filesystem cannot produce.
//
// A regular file wins even when empty or whitespace-only, with its text verbatim. Not asserted here:
// an unreadable regular file or another thrown filesystem error, a whitespace-only global text, the
// trimming of returned text, and the log line wording.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeStoreFs, type StoreFs } from "./fs-port";
import { resolveDodTemplate } from "./dod-template";
import { MUTATING_OPS, recordingFs } from "./test-support/fault-fs";

const FILE_NAME = "dod template.md";
const FILE_TEXT = "- [check] npm test\nEvery endpoint is documented";
const PROJECT_TEXT = "- [check] npm run typecheck\nProject criterion";
const GLOBAL_TEXT = "Global criterion";

let root: string;
let logs: string[];
const log = (m: string) => void logs.push(m);

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "dod-template-")));
  logs = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const resolve = (opts: { fs?: StoreFs; project?: string; global?: string } = {}) =>
  resolveDodTemplate({ fs: opts.fs ?? nodeStoreFs, storeRoot: root, project: opts.project, global: opts.global, log });

describe("nodeStoreFs.lstat isFile", () => {
  it("is true only for a regular file; symlinks are not followed", async () => {
    await writeFile(join(root, "regular"), "x");
    await mkdir(join(root, "dir"));
    await symlink(join(root, "regular"), join(root, "link"));
    const regular = await nodeStoreFs.lstat(join(root, "regular"));
    const dir = await nodeStoreFs.lstat(join(root, "dir"));
    const link = await nodeStoreFs.lstat(join(root, "link"));
    expect([regular!.isFile(), regular!.isDirectory(), regular!.isSymbolicLink()]).toEqual([true, false, false]);
    expect([dir!.isFile(), dir!.isDirectory(), dir!.isSymbolicLink()]).toEqual([false, true, false]);
    expect([link!.isFile(), link!.isDirectory(), link!.isSymbolicLink()]).toEqual([false, false, true]);
    expect(await nodeStoreFs.lstat(join(root, "missing"))).toBeNull();
  });

  it("recordingFs passes isFile through unchanged", async () => {
    await writeFile(join(root, "regular"), "x");
    const { fs } = recordingFs(nodeStoreFs);
    expect((await fs.lstat(join(root, "regular")))!.isFile()).toBe(true);
  });
});

describe("resolveDodTemplate precedence: file > project > global > none", () => {
  it("a regular `dod template.md` wins over project and global, without merging", async () => {
    await writeFile(join(root, FILE_NAME), FILE_TEXT);
    const result = await resolve({ project: PROJECT_TEXT, global: GLOBAL_TEXT });
    expect(result).toEqual({ source: "file", text: FILE_TEXT });
    expect(result.text).not.toContain("Project criterion");
    expect(result.text).not.toContain("Global criterion");
  });

  it("an empty or whitespace-only regular file still wins over project and global, verbatim", async () => {
    for (const text of ["", "  \n\t \r\n"]) {
      await writeFile(join(root, FILE_NAME), text);
      expect(await resolve({ project: PROJECT_TEXT, global: GLOBAL_TEXT }), JSON.stringify(text)).toEqual({ source: "file", text });
    }
  });

  it("the file wins even when project and global are absent", async () => {
    await writeFile(join(root, FILE_NAME), FILE_TEXT);
    expect(await resolve()).toEqual({ source: "file", text: FILE_TEXT });
  });

  it("without the file, non-empty project text wins over global, without merging", async () => {
    const result = await resolve({ project: PROJECT_TEXT, global: GLOBAL_TEXT });
    expect(result).toEqual({ source: "project", text: PROJECT_TEXT });
  });

  it("without the file and project text, global text is used", async () => {
    expect(await resolve({ global: GLOBAL_TEXT })).toEqual({ source: "global", text: GLOBAL_TEXT });
  });

  it("project text that is empty or whitespace-only falls through to global", async () => {
    for (const project of ["", "   ", "\n\t \r\n"]) {
      expect(await resolve({ project, global: GLOBAL_TEXT }), JSON.stringify(project)).toEqual({ source: "global", text: GLOBAL_TEXT });
    }
  });

  it("project text with surrounding whitespace is still project text", async () => {
    const result = await resolve({ project: `\n  ${PROJECT_TEXT}  \n`, global: GLOBAL_TEXT });
    expect(result.source).toBe("project");
    expect(result.text.trim()).toBe(PROJECT_TEXT);
  });

  it("no source at all resolves to none with empty text", async () => {
    expect(await resolve()).toEqual({ source: "none", text: "" });
    expect(await resolve({ project: "  " })).toEqual({ source: "none", text: "" });
  });

  it("reads exactly `<storeRoot>/dod template.md`; other spellings and locations are not templates", async () => {
    for (const name of ["dod-template.md", "dod_template.md", "dod template.txt", "dod template.md.bak", "dodtemplate.md"]) {
      await writeFile(join(root, name), "Wrong file");
    }
    await mkdir(join(root, ".decisions"));
    await writeFile(join(root, ".decisions", FILE_NAME), "Wrong location");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", FILE_NAME), "Wrong location");
    expect(await resolve({ project: PROJECT_TEXT })).toEqual({ source: "project", text: PROJECT_TEXT });
  });

  it("looks the file up with lstat on the exact path, reads it from that path and writes nothing", async () => {
    await writeFile(join(root, FILE_NAME), FILE_TEXT);
    const { fs, calls } = recordingFs(nodeStoreFs);
    expect(await resolve({ fs, project: PROJECT_TEXT })).toEqual({ source: "file", text: FILE_TEXT });
    const path = join(root, FILE_NAME);
    expect(calls).toContainEqual(expect.objectContaining({ op: "lstat", path }));
    expect(calls).toContainEqual(expect.objectContaining({ op: "readFile", path }));
    const lstatAt = calls.findIndex((c) => c.op === "lstat" && c.path === path);
    const readAt = calls.findIndex((c) => c.op === "readFile" && c.path === path);
    expect(lstatAt).toBeLessThan(readAt);
    expect(calls.filter((c) => MUTATING_OPS.has(c.op))).toEqual([]);
  });

  it("does not read any file when no template file exists", async () => {
    const { fs, calls } = recordingFs(nodeStoreFs);
    expect(await resolve({ fs, global: GLOBAL_TEXT })).toEqual({ source: "global", text: GLOBAL_TEXT });
    expect(calls.filter((c) => c.op === "readFile")).toEqual([]);
    expect(calls.filter((c) => MUTATING_OPS.has(c.op))).toEqual([]);
  });
});

describe("resolveDodTemplate ignores a non-regular `dod template.md` with one log line", () => {
  /** Resolves through a recording port and asserts the template path was never read. */
  async function resolveIgnoring(opts: { project?: string; global?: string }) {
    const { fs, calls } = recordingFs(nodeStoreFs);
    const result = await resolve({ fs, ...opts });
    expect(calls.filter((c) => c.op === "readFile" && c.path === join(root, FILE_NAME))).toEqual([]);
    expect(calls.filter((c) => MUTATING_OPS.has(c.op))).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(typeof logs[0]).toBe("string");
    return result;
  }

  it("a directory named `dod template.md`", async () => {
    await mkdir(join(root, FILE_NAME));
    await writeFile(join(root, FILE_NAME, "inner.md"), "Inner");
    expect(await resolveIgnoring({ project: PROJECT_TEXT, global: GLOBAL_TEXT })).toEqual({ source: "project", text: PROJECT_TEXT });
  });

  it("a symlink to a regular file inside the store root", async () => {
    await writeFile(join(root, "target.md"), "Linked text");
    await symlink(join(root, "target.md"), join(root, FILE_NAME));
    expect(await resolveIgnoring({ global: GLOBAL_TEXT })).toEqual({ source: "global", text: GLOBAL_TEXT });
  });

  it("a symlink to a regular file outside the store root", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "dod-template-outside-")));
    try {
      await writeFile(join(outside, "secret.md"), "Outside text");
      await symlink(join(outside, "secret.md"), join(root, FILE_NAME));
      const result = await resolveIgnoring({ project: PROJECT_TEXT });
      expect(result).toEqual({ source: "project", text: PROJECT_TEXT });
      expect(result.text).not.toContain("Outside text");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("a dangling symlink", async () => {
    await symlink(join(root, "missing.md"), join(root, FILE_NAME));
    expect(await resolveIgnoring({})).toEqual({ source: "none", text: "" });
  });

  it("a symlink to a directory", async () => {
    await mkdir(join(root, "real-dir"));
    await symlink(join(root, "real-dir"), join(root, FILE_NAME));
    expect(await resolveIgnoring({ global: GLOBAL_TEXT })).toEqual({ source: "global", text: GLOBAL_TEXT });
  });
});

describe("resolveDodTemplate with lstat answers a real filesystem rarely gives", () => {
  type Stat = { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean };

  /** nodeStoreFs with lstat of the template path answered by `stat`; reads of that path recorded. */
  function fakeTemplateStat(stat: Stat, content = FILE_TEXT) {
    const path = join(root, FILE_NAME);
    const reads: string[] = [];
    const fs: StoreFs = {
      ...nodeStoreFs,
      lstat: async (p) => (p === path ? stat : nodeStoreFs.lstat(p)),
      readFile: async (p) => {
        reads.push(p);
        if (p === path) return content;
        return nodeStoreFs.readFile(p);
      },
    };
    return { fs, reads, path };
  }

  it("another file type (not a file, directory or symlink, e.g. a FIFO or socket) is ignored with one log line", async () => {
    const { fs, reads, path } = fakeTemplateStat({ isDirectory: () => false, isSymbolicLink: () => false, isFile: () => false });
    expect(await resolve({ fs, project: PROJECT_TEXT })).toEqual({ source: "project", text: PROJECT_TEXT });
    expect(reads).not.toContain(path);
    expect(logs).toHaveLength(1);
  });

  it("an answer that is both isFile and isSymbolicLink is not used", async () => {
    const { fs, reads, path } = fakeTemplateStat({ isDirectory: () => false, isSymbolicLink: () => true, isFile: () => true });
    expect(await resolve({ fs, global: GLOBAL_TEXT })).toEqual({ source: "global", text: GLOBAL_TEXT });
    expect(reads).not.toContain(path);
    expect(logs).toHaveLength(1);
  });

  it("a regular-file answer is read through the port and returned as the file source", async () => {
    const { fs, reads, path } = fakeTemplateStat({ isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true }, "Port text");
    expect(await resolve({ fs, project: PROJECT_TEXT, global: GLOBAL_TEXT })).toEqual({ source: "file", text: "Port text" });
    expect(reads).toEqual([path]);
  });
});
