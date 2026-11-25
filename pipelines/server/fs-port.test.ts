import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PipelineError } from "../shared/errors";
import { createNodeFs, digestOf, isTempName, type FsStep } from "./fs-port";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pipeline-fs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("digestOf", () => {
  it("hashes the exact bytes and names a missing file absent", () => {
    expect(digestOf(bytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(digestOf(null)).toBe("absent");
  });
});

describe("isTempName", () => {
  it("recognises only hidden temp names", () => {
    expect(isTempName(".workflow.yaml.0a1b2c.tmp")).toBe(true);
    expect(isTempName("workflow.yaml")).toBe(false);
    expect(isTempName("notes.tmp")).toBe(false);
  });
});

describe("ensureDir", () => {
  it("creates nested directories with mode 0700", async () => {
    const fs = createNodeFs();
    await fs.ensureDir(join(root, "a", "b"));
    expect(await mode(join(root, "a"))).toBe(0o700);
    expect(await mode(join(root, "a", "b"))).toBe(0o700);
  });

  it("tightens an existing directory to 0700", async () => {
    const dir = join(root, "open");
    await mkdir(dir);
    await chmod(dir, 0o755);
    await createNodeFs().ensureDir(dir);
    expect(await mode(dir)).toBe(0o700);
  });

  it("refuses a symlink in place of the directory", async () => {
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    await expect(createNodeFs().ensureDir(join(root, "link"))).rejects.toThrow(PipelineError);
  });
});

describe("readFile", () => {
  it("returns null for a missing file and exact bytes otherwise", async () => {
    const fs = createNodeFs();
    expect(await fs.readFile(join(root, "missing"))).toBeNull();
    await writeFile(join(root, "f"), "x\r\nyé");
    expect(Buffer.from((await fs.readFile(join(root, "f"))) ?? []).toString("utf8")).toBe("x\r\nyé");
  });

  it("refuses a symlink even when its target exists", async () => {
    await writeFile(join(root, "target"), "secret");
    await symlink(join(root, "target"), join(root, "link"));
    await expect(createNodeFs().readFile(join(root, "link"))).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("refuses a directory", async () => {
    await mkdir(join(root, "d"));
    await expect(createNodeFs().readFile(join(root, "d"))).rejects.toMatchObject({ code: "unsafe_path" });
  });
});

describe("replaceFile", () => {
  it("writes a new file with mode 0600 and leaves no temp file", async () => {
    const path = join(root, "w.yaml");
    await createNodeFs().replaceFile(path, bytes("one"));
    expect(await readFile(path, "utf8")).toBe("one");
    expect(await mode(path)).toBe(0o600);
    expect(await readdir(root)).toEqual(["w.yaml"]);
  });

  it("replaces existing content", async () => {
    const fs = createNodeFs();
    const path = join(root, "w.yaml");
    await fs.replaceFile(path, bytes("one"));
    await fs.replaceFile(path, bytes("two"));
    expect(await readFile(path, "utf8")).toBe("two");
    expect(await readdir(root)).toEqual(["w.yaml"]);
  });

  it("keeps the old text whole when the write fails before the rename", async () => {
    const path = join(root, "w.yaml");
    await writeFile(path, "old text");
    const fs = createNodeFs({
      hook: (step: FsStep) => {
        if (step === "replace.synced") throw new Error("crash before rename");
      },
    });
    await expect(fs.replaceFile(path, bytes("new text"))).rejects.toThrow("crash before rename");
    expect(await readFile(path, "utf8")).toBe("old text");
    expect(await readdir(root)).toEqual(["w.yaml"]);
  });

  it("holds the new text whole when the failure comes after the rename", async () => {
    const path = join(root, "w.yaml");
    await writeFile(path, "old text");
    const fs = createNodeFs({
      hook: (step: FsStep) => {
        if (step === "replace.renamed") throw new Error("crash after rename");
      },
    });
    await expect(fs.replaceFile(path, bytes("new text"))).rejects.toThrow("crash after rename");
    expect(await readFile(path, "utf8")).toBe("new text");
    expect(await readdir(root)).toEqual(["w.yaml"]);
  });

  it("refuses to replace a symlink and leaves its target untouched", async () => {
    await writeFile(join(root, "target"), "keep");
    await symlink(join(root, "target"), join(root, "link"));
    await expect(createNodeFs().replaceFile(join(root, "link"), bytes("x"))).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(join(root, "target"), "utf8")).toBe("keep");
  });
});

describe("publishNoClobber", () => {
  it("publishes once and never overwrites", async () => {
    const fs = createNodeFs();
    const path = join(root, "snapshot.json");
    expect(await fs.publishNoClobber(path, bytes("first"))).toBe(true);
    expect(await fs.publishNoClobber(path, bytes("second"))).toBe(false);
    expect(await readFile(path, "utf8")).toBe("first");
    expect(await mode(path)).toBe(0o600);
    expect(await readdir(root)).toEqual(["snapshot.json"]);
  });

  it("publishes nothing when the write fails before the link", async () => {
    const fs = createNodeFs({
      hook: (step: FsStep) => {
        if (step === "publish.synced") throw new Error("crash before link");
      },
    });
    await expect(fs.publishNoClobber(join(root, "s.json"), bytes("x"))).rejects.toThrow("crash before link");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("appendLine", () => {
  it("creates the file with mode 0600 and appends one line per call", async () => {
    const fs = createNodeFs();
    const path = join(root, "journal.jsonl");
    await fs.appendLine(path, '{"seq":1}');
    await fs.appendLine(path, '{"seq":2}');
    expect(await readFile(path, "utf8")).toBe('{"seq":1}\n{"seq":2}\n');
    expect(await mode(path)).toBe(0o600);
  });

  it("rejects a line that contains a newline and writes nothing", async () => {
    const path = join(root, "journal.jsonl");
    await expect(createNodeFs().appendLine(path, "a\nb")).rejects.toThrow("newline");
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a symlink", async () => {
    await writeFile(join(root, "target"), "");
    await symlink(join(root, "target"), join(root, "link"));
    await expect(createNodeFs().appendLine(join(root, "link"), "x")).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(join(root, "target"), "utf8")).toBe("");
  });
});

describe("truncate", () => {
  it("cuts a torn tail back to a given length", async () => {
    const path = join(root, "journal.jsonl");
    await writeFile(path, '{"seq":1}\n{"se');
    await createNodeFs().truncate(path, 10);
    expect(await readFile(path, "utf8")).toBe('{"seq":1}\n');
  });

  it("fails for a missing file", async () => {
    await expect(createNodeFs().truncate(join(root, "missing"), 0)).rejects.toThrow("missing");
  });
});

describe("remove and listDir", () => {
  it("reports whether a file was removed", async () => {
    const fs = createNodeFs();
    await writeFile(join(root, "f"), "x");
    expect(await fs.remove(join(root, "f"))).toBe(true);
    expect(await fs.remove(join(root, "f"))).toBe(false);
  });

  it("lists sorted names and treats a missing directory as empty", async () => {
    const fs = createNodeFs();
    await writeFile(join(root, "b"), "");
    await writeFile(join(root, "a"), "");
    await writeFile(join(root, "C"), "");
    expect(await fs.listDir(root)).toEqual(["C", "a", "b"]);
    expect(await fs.listDir(join(root, "missing"))).toEqual([]);
  });
});
