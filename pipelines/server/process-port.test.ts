import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessRecordSchema, type ProcessRecord } from "../shared/run";
import { RELEASE_TOKEN, SHIM_SOURCE } from "./check-shim";
import { createProcessPort, groupAlive } from "./process-port";

const port = createProcessPort({ graceMs: 300, exitWaitMs: 3_000, pollMs: 10 });
let dir = "";
const children: ChildProcess[] = [];
/** Detached shim groups started by helpers; terminated by identity so a reused pid is never signalled. */
const shims: ProcessRecord[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fp-process-"));
});

afterEach(async () => {
  try {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const record of shims.splice(0)) {
      if (!(await port.terminateRecorded(record)).exited) throw new Error(`shim group ${record.pgid} did not exit`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await sleep(20);
  }
}

/**
 * A stand-in server process: it starts the real shim with the gate pipe on fd 3, prints the pid,
 * and writes the release only when told to on stdin. Killing it closes the gate's write end.
 */
async function helperServer(command: string, recordFile?: string): Promise<{ helper: ChildProcess; pid: number; release: () => void; exited: Promise<unknown> }> {
  const script = join(dir, "helper.cjs");
  await writeFile(
    script,
    `const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const shim = spawn(process.execPath, ["-e", ${JSON.stringify(SHIM_SOURCE)}, "--", "shell", process.argv[2]], { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
shim.on("spawn", () => {
  const recordFile = process.argv[3];
  if (recordFile) {
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(shim.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC0" }, encoding: "utf8" }).trim();
    const fd = fs.openSync(recordFile, "wx", 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: shim.pid, pgid: shim.pid, startedAt }) + "\\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }
  process.stdout.write(String(shim.pid) + "\\n");
});
process.stdin.on("data", () => shim.stdio[3].write(${JSON.stringify(RELEASE_TOKEN)}));
setInterval(() => {}, 1000);
`,
  );
  const helper = spawn(process.execPath, [script, command, ...(recordFile ? [recordFile] : [])], { stdio: ["pipe", "pipe", "inherit"] });
  children.push(helper);
  const exited = new Promise((resolve) => helper.once("exit", resolve));
  const pid = await new Promise<number>((resolve) => helper.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
  const startedAt = await port.startTime(pid);
  if (startedAt !== null) shims.push({ pid, pgid: pid, startedAt });
  return { helper, pid, release: () => helper.stdin?.write("go"), exited };
}

describe("gated launch", () => {
  it("runs nothing when the gate is aborted before release", async () => {
    const marker = join(dir, "marker");
    const gated = await port.spawnGated({ shell: `touch ${JSON.stringify(marker)}` }, { cwd: dir, maxBytes: 1024 });
    expect(await port.processAlive(gated.record)).toBe(true);
    expect(await gated.abort()).toEqual({ exited: true });
    const result = await gated.done;
    expect(result.ran).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(await port.processAlive(gated.record)).toBe(false);
  });

  it("runs the command after release and reports its exit code and output", async () => {
    const gated = await port.spawnGated({ shell: "echo hello; exit 3" }, { cwd: dir, maxBytes: 1024 });
    gated.release(5_000);
    const result = await gated.done;
    expect(result).toMatchObject({ ran: true, exitCode: 3, timedOut: false, cancelled: false });
    expect(result.output).toContain("hello");
  });

  it("passes an argv value with quotes, spaces, $() and backticks as one argument without a shell", async () => {
    const value = `it's "a" $(touch ${join(dir, "shell-ran")}) \`touch ${join(dir, "tick-ran")}\` x`;
    const out = join(dir, "argv.json");
    const gated = await port.spawnGated(
      { argv: [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))", out, value] },
      { cwd: dir, maxBytes: 1024 },
    );
    gated.release(5_000);
    expect((await gated.done).exitCode).toBe(0);
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual([value]);
    expect(existsSync(join(dir, "shell-ran"))).toBe(false);
    expect(existsSync(join(dir, "tick-ran"))).toBe(false);
  });

  it("an unrecorded shim exits without running when its server dies before the release", async () => {
    const marker = join(dir, "marker");
    const { helper, pid } = await helperServer(`touch ${JSON.stringify(marker)}`);
    const startedAt = await port.startTime(pid);
    expect(startedAt).not.toBeNull();
    helper.kill("SIGKILL");
    await until(() => !groupAlive(pid));
    expect(existsSync(marker)).toBe(false);
    expect(await port.processAlive({ pid, pgid: pid, startedAt: startedAt ?? "" })).toBe(false);
  });

  it("a shim recorded durably but never released runs nothing when its server dies, and recovery finds it gone", async () => {
    const marker = join(dir, "marker");
    const recordFile = join(dir, "record.json");
    const { helper, pid, exited } = await helperServer(`touch ${JSON.stringify(marker)}`, recordFile);
    const record = ProcessRecordSchema.parse(JSON.parse(await readFile(recordFile, "utf8")));
    expect(record.pid).toBe(pid);
    expect(await port.processState(record)).toBe("alive");
    helper.kill("SIGKILL");
    await exited;
    await until(() => !groupAlive(pid));
    expect(existsSync(marker)).toBe(false);
    expect(await port.processState(record)).toBe("gone");
    expect(await port.terminateRecorded(record)).toEqual({ exited: true });
    expect(existsSync(marker)).toBe(false);
  });

  it("a recorded group whose server died after the release stays alive until recovery terminates it", async () => {
    const marker = join(dir, "marker");
    const started = join(dir, "started");
    const { helper, pid, release, exited } = await helperServer(`touch ${JSON.stringify(started)}; sleep 30; touch ${JSON.stringify(marker)}`);
    const record = { pid, pgid: pid, startedAt: (await port.startTime(pid)) ?? "" };
    release();
    await until(() => existsSync(started));
    helper.kill("SIGKILL");
    await exited;
    expect(await port.processAlive(record)).toBe(true);
    expect(await port.terminateRecorded(record)).toEqual({ exited: true });
    expect(groupAlive(pid)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("treats a record whose pid belongs to another process as gone and signals nothing", async () => {
    const other = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    children.push(other);
    await new Promise((resolve) => other.once("spawn", resolve));
    const pid = other.pid ?? 0;
    const record = { pid, pgid: pid, startedAt: "Thu Jan  1 00:00:00 1970" };
    expect(await port.processAlive(record)).toBe(false);
    expect(await port.terminateRecorded(record)).toEqual({ exited: true });
    expect(groupAlive(pid)).toBe(true);
  });

  it("an orphaned group whose leader exited is unknown, never signalled and never reported exited", async () => {
    const leader = spawn("/bin/sh", ["-c", "sleep 30 & sleep 0.4; exit 0"], { detached: true, stdio: "ignore" });
    children.push(leader);
    await new Promise((resolve) => leader.once("spawn", resolve));
    const pid = leader.pid ?? 0;
    const record = { pid, pgid: pid, startedAt: (await port.startTime(pid)) ?? "" };
    expect(await port.processState(record)).toBe("alive");
    await new Promise((resolve) => leader.once("exit", resolve));
    try {
      expect(groupAlive(pid)).toBe(true);
      expect(await port.processState(record)).toBe("unknown");
      expect(await port.processAlive(record)).toBe(true);
      expect(await port.terminateRecorded(record)).toEqual({ exited: false });
      expect(groupAlive(pid)).toBe(true);
    } finally {
      process.kill(-pid, "SIGKILL");
    }
  });

  it("reports a group that outlived its shim's exit", async () => {
    const gated = await port.spawnGated({ shell: "sleep 30 & exit 0" }, { cwd: dir, maxBytes: 1024 });
    gated.release(10_000);
    const result = await gated.done;
    expect(result.groupExited).toBe(true);
    expect(groupAlive(gated.record.pgid)).toBe(false);
  });

  it("cancel escalates when the command ignores the first signal and resolves after the observed exit", async () => {
    const ready = join(dir, "ready");
    const gated = await port.spawnGated({ shell: `trap '' TERM; touch ${JSON.stringify(ready)}; while true; do sleep 0.05; done` }, { cwd: dir, maxBytes: 1024 });
    gated.release(60_000);
    await until(() => existsSync(ready));
    const started = Date.now();
    expect(await gated.cancel()).toEqual({ exited: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(groupAlive(gated.record.pgid)).toBe(false);
    expect((await gated.done).cancelled).toBe(true);
  });

  it("times out a command and stops its group", async () => {
    const gated = await port.spawnGated({ shell: "sleep 30" }, { cwd: dir, maxBytes: 1024 });
    gated.release(200);
    const result = await gated.done;
    expect(result.timedOut).toBe(true);
    expect(groupAlive(gated.record.pgid)).toBe(false);
  });
});
