// Stage R3.3 (task card 2026-10-29 R3 §1.3, §4.3): the process port. `nodeProcessPort()` wraps the
// installed `spawnProcess`/`terminateProcess`; here both are replaced by an in-memory child (event
// emitter plus PassThrough streams), so no real process, shell or git runs. The result settles exactly
// once (close or error, e.g. ENOENT), keeps stdout/stderr bytes intact, truncates at maxBuffer and
// terminates, and terminates on timeout or abort. `gitBytes` returns stdout bytes for exit 0, else throws.
// `./process-port` is new in R3.3, so it is loaded from the module namespace.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  children: [] as Array<{ command: string; args: string[]; options: unknown; child: unknown }>,
  terminated: [] as unknown[],
  /** R3 corrective (c0002): a terminated child exits but a descendant keeps its pipes, so `close` never comes. */
  noCloseOnTerminate: false,
}));

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; pid: number; kill: (s?: string) => boolean };

vi.mock("@getpaseo/plugin/server", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    spawnProcess: (command: string, args: string[], options: unknown) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 4242, kill: () => true,
      });
      h.children.push({ command, args, options, child });
      return child;
    },
    terminateProcess: async (child: FakeChild) => {
      h.terminated.push(child);
      if (h.noCloseOnTerminate) setTimeout(() => child.emit("exit", null, "SIGKILL"), 0);
      else setTimeout(() => child.emit("close", null, "SIGKILL"), 0);
    },
  };
});

const load = async () => {
  const mod: Record<string, unknown> = await import("./process-port");
  for (const name of ["nodeProcessPort", "gitBytes"]) expect(typeof mod[name], `server/process-port exports ${name}`).toBe("function");
  return import("./process-port");
};
const lastChild = () => h.children.at(-1)!.child as FakeChild;
const opts = (extra: Partial<{ maxBuffer: number; timeoutMs: number; signal: AbortSignal }> = {}) => ({ cwd: "/synthetic/wt", env: { PATH: "/bin" }, maxBuffer: 1024, timeoutMs: 60_000, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.children.length = 0;
  h.terminated.length = 0;
  h.noCloseOnTerminate = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("R3.3 nodeProcessPort", () => {
  it("passes command, args and cwd through; stdout and stderr bytes (non-UTF-8 included) are intact; close settles the result", async () => {
    const p = await load();
    const run = p.nodeProcessPort().spawn("git", ["ls-files", "-z"], opts());
    expect(h.children).toHaveLength(1);
    expect(h.children[0]).toMatchObject({ command: "git", args: ["ls-files", "-z"] });
    expect(JSON.stringify(h.children[0].options)).toContain("/synthetic/wt");
    const child = lastChild();
    const bytes = Buffer.from([0x61, 0x00, 0xff, 0xfe, 0x62, 0x00]);
    child.stdout.write(bytes.subarray(0, 3));
    child.stdout.write(bytes.subarray(3));
    child.stderr.write(Buffer.from("warn\n"));
    await tick();
    child.emit("close", 0, null);
    const r = await run.result;
    expect(r.exitCode).toBe(0);
    expect(r.signal).toBeNull();
    expect(Buffer.compare(r.stdout, bytes)).toBe(0);
    expect(r.stderr.toString("utf8")).toBe("warn\n");
    expect(r.truncated).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it("a spawn error (ENOENT) settles the result once; a later close does not change it", async () => {
    const p = await load();
    const run = p.nodeProcessPort().spawn("missing-binary", [], opts());
    const child = lastChild();
    const enoent = Object.assign(new Error("spawn missing-binary ENOENT"), { code: "ENOENT" });
    child.emit("error", enoent);
    child.emit("close", 1, null);
    const r = await run.result;
    expect(typeof r.error).toBe("string");
    expect(r.error).toContain("ENOENT");
    expect(r.exitCode).not.toBe(0);
    expect(await run.result).toEqual(r);
  });

  it("output beyond maxBuffer is truncated and the child terminated; the result still settles", async () => {
    const p = await load();
    const run = p.nodeProcessPort().spawn("sh", ["-c", "yes"], opts({ maxBuffer: 4 }));
    const child = lastChild();
    child.stdout.write(Buffer.from("0123456789"));
    const r = await run.result;
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(4);
    expect(h.terminated).toContain(child);
  });

  it("a timeout terminates the child and settles once", async () => {
    vi.useFakeTimers();
    const p = await load();
    const run = p.nodeProcessPort().spawn("sh", ["-c", "sleep 100"], opts({ timeoutMs: 1000 }));
    const child = lastChild();
    await vi.advanceTimersByTimeAsync(1001);
    expect(h.terminated).toContain(child);
    await vi.advanceTimersByTimeAsync(10);
    const r = await run.result;
    expect(r.exitCode).not.toBe(0);
  });

  it("an abort signal terminates the child and settles once", async () => {
    const p = await load();
    const ac = new AbortController();
    const run = p.nodeProcessPort().spawn("sh", ["-c", "sleep 100"], opts({ signal: ac.signal }));
    const child = lastChild();
    ac.abort();
    const r = await run.result;
    expect(h.terminated).toContain(child);
    expect(r.exitCode).not.toBe(0);
  });

  it("write and end reach the child's stdin", async () => {
    const p = await load();
    const run = p.nodeProcessPort().spawn("review", [], opts());
    const child = lastChild();
    const chunks: Buffer[] = [];
    child.stdin.on("data", (c: Buffer) => chunks.push(c));
    let ended = false;
    child.stdin.on("finish", () => (ended = true));
    run.write('{"a":1}');
    run.end();
    await tick();
    expect(Buffer.concat(chunks).toString("utf8")).toBe('{"a":1}');
    expect(ended).toBe(true);
    child.emit("close", 0, null);
    await run.result;
  });
});

describe("R3.3 gitBytes", () => {
  const fakePort = (result: { exitCode: number | null; stdout: Buffer; error?: string }) => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const port = {
      spawn: (command: string, args: string[]) => {
        calls.push({ command, args });
        return {
          write: () => undefined,
          end: () => undefined,
          terminate: async () => undefined,
          result: Promise.resolve({ signal: null, stderr: Buffer.alloc(0), truncated: false, ...result }),
        };
      },
    };
    return { port, calls };
  };

  it("exit 0 returns the exact stdout bytes of `git <args>`; a non-zero exit or a spawn error throws", async () => {
    const p = await load();
    const bytes = Buffer.from([0x00, 0xff, 0x61]);
    const ok = fakePort({ exitCode: 0, stdout: bytes });
    const out = await p.gitBytes(ok.port, "/synthetic/wt", ["rev-parse", "HEAD"]);
    expect(Buffer.compare(out, bytes)).toBe(0);
    expect(ok.calls).toEqual([{ command: "git", args: ["rev-parse", "HEAD"] }]);
    await expect(p.gitBytes(fakePort({ exitCode: 128, stdout: Buffer.alloc(0) }).port, "/synthetic/wt", ["status"])).rejects.toThrow();
    await expect(p.gitBytes(fakePort({ exitCode: null, stdout: Buffer.alloc(0), error: "ENOENT" }).port, "/synthetic/wt", ["status"])).rejects.toThrow();
  });
});

// R3 corrective (DeepSeek c0002, root ruling): a terminated check whose descendant keeps stdout open
// emits `exit` but never `close`. After termination the result settles within a bounded grace
// (<= 2 s), exactly once and fail-closed (never exit 0); a late `close` changes nothing.
describe("R3 corrective: bounded settle after termination without close (c0002)", () => {
  const GRACE_MAX = 2000;
  const track = <T,>(p: Promise<T>) => {
    const box: { done: boolean; value?: T } = { done: false };
    void p.then((v) => {
      box.done = true;
      box.value = v;
    });
    return box;
  };

  it("timeout: terminate, exit without close → settles within the grace, fail-closed, once; a late close is ignored", async () => {
    vi.useFakeTimers();
    h.noCloseOnTerminate = true;
    const p = await load();
    const run = p.nodeProcessPort().spawn("/bin/sh", ["-c", "npm test"], opts({ timeoutMs: 1000 }));
    const child = lastChild();
    child.stdout.write(Buffer.from("partial"));
    const box = track(run.result);
    await vi.advanceTimersByTimeAsync(1001);
    expect(h.terminated).toContain(child);
    expect(box.done, "not settled before the exit").toBe(false);
    await vi.advanceTimersByTimeAsync(GRACE_MAX + 10);
    expect(box.done, "settled within the bounded grace").toBe(true);
    const r = box.value!;
    expect(r.exitCode).not.toBe(0);
    expect(typeof r.error).toBe("string");
    child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(10);
    expect(await run.result).toEqual(r);
  });

  it("abort: terminate, exit without close → settles within the grace, fail-closed", async () => {
    vi.useFakeTimers();
    h.noCloseOnTerminate = true;
    const p = await load();
    const ac = new AbortController();
    const run = p.nodeProcessPort().spawn("/bin/sh", ["-c", "npm test"], opts({ signal: ac.signal }));
    const child = lastChild();
    const box = track(run.result);
    ac.abort();
    await vi.advanceTimersByTimeAsync(GRACE_MAX + 10);
    expect(h.terminated).toContain(child);
    expect(box.done).toBe(true);
    expect(box.value!.exitCode).not.toBe(0);
    expect(typeof box.value!.error).toBe("string");
  });

  it("a shell that exits 0 while a descendant holds the pipes is not a pass: the timeout terminates and the result settles fail-closed", async () => {
    vi.useFakeTimers();
    h.noCloseOnTerminate = true;
    const p = await load();
    const run = p.nodeProcessPort().spawn("/bin/sh", ["-c", "server &"], opts({ timeoutMs: 1000 }));
    const child = lastChild();
    const box = track(run.result);
    child.emit("exit", 0, null); // the shell is gone; its background child keeps stdout open
    await vi.advanceTimersByTimeAsync(500);
    expect(box.done, "no termination requested yet: still waiting for close").toBe(false);
    await vi.advanceTimersByTimeAsync(500 + GRACE_MAX + 10);
    expect(h.terminated).toContain(child);
    expect(box.done).toBe(true);
    expect(box.value!.exitCode).not.toBe(0);
  });
});
