// Approval receipts in plugin-data (Stage 3 ruling 4): modes, atomic durable no-clobber publication,
// concurrent writers, crash leftovers, no rename fallback, path binding and id safety.
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeApprovalFs, type ApprovalFs } from "./approval-fs";
import { createApprovalStore } from "./approvals";
import { rejectsCode } from "./test-support/expect-error";
import { makeApprovalEnv, receipt, wrapApprovalFs } from "./test-support/plans";

// `link` can fail with a chosen code, and `sync()` on a handle opened for one chosen directory can
// fail (directory fsync at publication); everything else is the real fs.
const { linkFault, dirSyncFault, withLinkFault } = vi.hoisted(() => {
  const linkFault = { code: null as string | null };
  const dirSyncFault = { dir: null as string | null, hits: 0 };
  const withLinkFault = async (importOriginal: () => Promise<unknown>) => {
    const real = (await importOriginal()) as typeof import("node:fs/promises");
    const link: typeof real.link = (a, b) =>
      linkFault.code ? Promise.reject(Object.assign(new Error(`${linkFault.code}: link`), { code: linkFault.code })) : real.link(a, b);
    const open = (async (path: Parameters<typeof real.open>[0], ...rest: unknown[]) => {
      const handle = await (real.open as (...a: unknown[]) => Promise<import("node:fs/promises").FileHandle>)(path, ...rest);
      if (dirSyncFault.dir === null || String(path) !== dirSyncFault.dir) return handle;
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === "sync") {
            return () => {
              dirSyncFault.hits++;
              return Promise.reject(Object.assign(new Error("EIO: fsync"), { code: "EIO" }));
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    }) as typeof real.open;
    return { ...real, default: { ...real, link, open }, link, open };
  };
  return { linkFault, dirSyncFault, withLinkFault };
});
vi.mock("node:fs/promises", withLinkFault);
vi.mock("fs/promises", withLinkFault);

let env: Awaited<ReturnType<typeof makeApprovalEnv>> | undefined;
afterEach(async () => {
  linkFault.code = null;
  dirSyncFault.dir = null;
  dirSyncFault.hits = 0;
  await env?.cleanup();
  env = undefined;
});

async function setup() {
  env = await makeApprovalEnv();
  return env;
}
const store = (e: NonNullable<typeof env>, fs?: ApprovalFs) => createApprovalStore({ stateDir: e.stateDir, log: e.log, ...(fs ? { fs } : {}) });
const exists = (p: string) => stat(p).then(() => true, () => false);

describe("approval receipts", () => {
  it("round-trips at approvals/<project>/<plan>/<rev>.json with 0600 file and 0700 directories", async () => {
    const e = await setup();
    const r = receipt();
    expect(await store(e).write(r)).toEqual({ created: true, receipt: r });
    expect(await store(e).read(r.projectId, r.planId, r.planRev)).toEqual(r);
    const file = e.receiptPath(r);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(r);
    expect(await nodeApprovalFs.mode(file)).toBe(0o600);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    for (const dir of [join(e.stateDir, "approvals"), join(e.stateDir, "approvals", r.projectId), dirname(file)]) {
      expect(await nodeApprovalFs.mode(dir), dir).toBe(0o700);
      expect((await stat(dir)).mode & 0o777, dir).toBe(0o700);
    }
    expect((await readdir(dirname(file))).filter((n) => n !== basename(file))).toEqual([]);
  });

  it("a second write for the same rev does not clobber: created false, stored receipt, same bytes", async () => {
    const e = await setup();
    const first = receipt({ receiptId: "rcpt-first" });
    await store(e).write(first);
    const bytes = await readFile(e.receiptPath(first), "utf8");
    const second = await store(e).write(receipt({ receiptId: "rcpt-second", note: "later" }));
    expect(second).toEqual({ created: false, receipt: first });
    expect(await readFile(e.receiptPath(first), "utf8")).toBe(bytes);
  });

  it("two concurrent writers on two store instances: exactly one creates, both see the winner", async () => {
    const e = await setup();
    const a = receipt({ receiptId: "rcpt-a" });
    const b = receipt({ receiptId: "rcpt-b" });
    const [ra, rb] = await Promise.all([store(e).write(a), store(e).write(b)]);
    expect([ra.created, rb.created].filter(Boolean)).toHaveLength(1);
    const winner = ra.created ? a : b;
    expect(ra.receipt).toEqual(winner);
    expect(rb.receipt).toEqual(winner);
    expect(JSON.parse(await readFile(e.receiptPath(a), "utf8"))).toEqual(winner);
    expect((await readdir(dirname(e.receiptPath(a)))).filter((n) => n !== "1.json")).toEqual([]);
  });

  it("a crash after the temp write and before link leaves no receipt; the next publish succeeds and clears old temps", async () => {
    const e = await setup();
    const r = receipt();
    const dir = dirname(e.receiptPath(r));
    const crashing = wrapApprovalFs(nodeApprovalFs, {
      publishNoClobber: async (path: string, data: string) => {
        await writeFile(join(dirname(path), `.${basename(path)}.tmp-crashed`), data.slice(0, 10), { mode: 0o600 });
        throw new Error("crash before link");
      },
    });
    await expect(store(e, crashing.fs).write(r)).rejects.toThrow();
    expect(await store(e).read(r.projectId, r.planId, r.planRev)).toBeNull();
    expect(await exists(e.receiptPath(r))).toBe(false);

    const old = join(dir, `.${r.planRev}.json.tmp-crashed`);
    const past = new Date(Date.now() - 120_000);
    await utimes(old, past, past);
    const fresh = join(dir, `.${r.planRev}.json.tmp-inflight`);
    await writeFile(fresh, "{", { mode: 0o600 });

    expect(await store(e).write(r)).toEqual({ created: true, receipt: r });
    expect(await exists(old), "a temp older than 60 s is removed").toBe(false);
    expect(await exists(fresh), "a recent temp may belong to a live writer").toBe(true);
    expect(await store(e).read(r.projectId, r.planId, r.planRev)).toEqual(r);
  });

  it.each(["ENOTSUP", "EPERM"])("link failing with %s rejects the write without any clobbering fallback", async (code) => {
    const e = await setup();
    const r = receipt();
    linkFault.code = code;
    await expect(store(e).write(r)).rejects.toThrow();
    expect(await exists(e.receiptPath(r))).toBe(false);
    linkFault.code = null;
    expect(await store(e).read(r.projectId, r.planId, r.planRev)).toBeNull();
  });

  it("a failed directory fsync at publication does not report a durable created receipt", async () => {
    const e = await setup();
    const r = receipt();
    dirSyncFault.dir = dirname(e.receiptPath(r));
    const outcome = await store(e).write(r).then(
      (v) => ({ ok: true as const, v }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    expect(dirSyncFault.hits, "the real node fs opened and synced the receipt directory").toBeGreaterThan(0);
    // The linked file may remain on disk, but the publishing call must not claim durable success.
    expect(outcome.ok ? outcome.v : null, "write must not resolve created: true after a failed directory fsync").toBeNull();
  });

  it("a receipt whose content disagrees with its path reads as null and is logged", async () => {
    const e = await setup();
    const r = receipt();
    await mkdir(dirname(e.receiptPath(r)), { recursive: true });
    await writeFile(e.receiptPath(r), JSON.stringify({ ...r, projectId: "prj_other" }), { mode: 0o600 });
    expect(await store(e).read(r.projectId, r.planId, r.planRev)).toBeNull();
    expect(e.logs.some((l) => l.includes("receipt invalid"))).toBe(true);
    for (const l of e.logs) expect(l).not.toContain(r.contentHash);

    await writeFile(e.receiptPath(r), "{ truncated", { mode: 0o600 });
    expect(await store(e).read(r.projectId, r.planId, r.planRev)).toBeNull();
  });

  it("ids with path segments are unsafe_root before any fs call", async () => {
    const e = await setup();
    const rec = wrapApprovalFs(nodeApprovalFs);
    const s = store(e, rec.fs);
    await rejectsCode(s.write(receipt({ planId: "../escape" })), "unsafe_root");
    await rejectsCode(s.write(receipt({ projectId: "a/b" })), "unsafe_root");
    await rejectsCode(s.read("../prj", "plan-1", 1), "unsafe_root");
    await rejectsCode(s.read("prj_test", "..", 1), "unsafe_root");
    expect(rec.calls).toEqual([]);
    expect(await exists(e.stateDir)).toBe(false);
  });

  it("survives a restart: a new store on the same stateDir reads the receipt", async () => {
    const e = await setup();
    const r = receipt({ planRev: 3, note: "ship it" });
    await store(e).write(r);
    expect(await createApprovalStore({ stateDir: e.stateDir, log: e.log }).read(r.projectId, r.planId, 3)).toEqual(r);
    expect(await createApprovalStore({ stateDir: e.stateDir, log: e.log }).read(r.projectId, r.planId, 2)).toBeNull();
  });
});
