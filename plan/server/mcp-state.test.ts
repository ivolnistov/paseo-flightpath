import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpState, fingerprint, type McpState } from "./mcp-state";
import { fixedClock, nextId, readJsonObject } from "./test-support/build";
import { tempStateDir } from "./test-support/mcp";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(join(d, ".."), { recursive: true, force: true })));
});

async function fresh() {
  const stateDir = await tempStateDir();
  dirs.push(stateDir);
  const logs: string[] = [];
  const make = () => createMcpState({ stateDir, now: fixedClock, newId: nextId, log: (m: string) => void logs.push(m) });
  return { stateDir, logs, make, state: make() };
}
const grantInput = (port = 4100, projectId = "prj_test") => ({ projectId, storeRoot: `/synthetic/${projectId}`, provider: "claude", cwd: `/synthetic/${projectId}`, port });
const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe("endpoint state", () => {
  it("creates mcp.json 0600 in a 0700 directory with a 43-char base64url secret, stable across calls", async () => {
    const { stateDir, state, make } = await fresh();
    const first = await state.loadOrCreateEndpoint();
    expect(first.version).toBe(1);
    expect(first.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Number.isInteger(first.port)).toBe(true);
    expect(await mode(stateDir)).toBe(0o700);
    expect(await mode(join(stateDir, "mcp.json"))).toBe(0o600);
    expect(await state.loadOrCreateEndpoint()).toEqual(first);
    expect(await make().loadOrCreateEndpoint()).toEqual(first);
  });

  it("saveEndpoint persists the port for a reloaded state", async () => {
    const { state, make } = await fresh();
    const s = await state.loadOrCreateEndpoint();
    await state.saveEndpoint({ ...s, port: 4242 });
    expect(await make().loadOrCreateEndpoint()).toEqual({ ...s, port: 4242 });
  });

  it("a corrupt mcp.json is regenerated with a new secret, logged without either secret", async () => {
    const { stateDir, logs, state, make } = await fresh();
    const old = await state.loadOrCreateEndpoint();
    await writeFile(join(stateDir, "mcp.json"), "{ not json");
    const regenerated = await make().loadOrCreateEndpoint();
    expect(regenerated.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(regenerated.secret).not.toBe(old.secret);
    expect(logs.some((l) => l.includes("regenerated"))).toBe(true);
    for (const l of logs) {
      expect(l).not.toContain(old.secret);
      expect(l).not.toContain(regenerated.secret);
    }
  });
});

describe("grants", () => {
  it("issueGrant → getGrant round-trips and survives a reload; files are 0600 and atomically written", async () => {
    const { stateDir, state, make } = await fresh();
    const grant = await state.issueGrant(grantInput());
    expect(grant).toMatchObject({ ...grantInput(), stale: false, issuedAt: fixedClock().toISOString() });
    expect(grant.grantId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(Object.keys(grant).sort()).toEqual(["cwd", "grantId", "issuedAt", "port", "projectId", "provider", "stale", "storeRoot"]);
    expect(await state.getGrant(grant.grantId)).toEqual(grant);
    expect(await make().getGrant(grant.grantId)).toEqual(grant);
    expect(await state.getGrant("missing")).toBeNull();
    expect(await mode(join(stateDir, "grants.json"))).toBe(0o600);
    const file = readJsonObject(await readFile(join(stateDir, "grants.json"), "utf8"));
    expect(file.version).toBe(1);
    expect(JSON.stringify(file)).not.toContain("agentId");
    // temp-then-rename leaves no stray files behind
    expect((await readdir(stateDir)).filter((n) => n !== "grants.json" && n !== "mcp.json")).toEqual([]);
  });

  // Stage R3.2 adds exactly one binding method, bindByFingerprint (card §3.2); the discussion chat's
  // tools state adds three read-only lookups, grantForAgent, grantsIssuedSince and
  // grantsForReservation. There is still no claim or per-agent removal.
  it("exposes bindByFingerprint as its only binding method, three read-only grant lookups, and no claim or per-agent removal", async () => {
    const { state } = await fresh();
    expect(Object.keys(state).sort()).toEqual(["bindByFingerprint", "getGrant", "grantForAgent", "grantsForReservation", "grantsIssuedSince", "issueGrant", "loadOrCreateEndpoint", "markStale", "saveEndpoint"]);
  });

  it("a corrupt grants.json reads as empty and is logged", async () => {
    const { stateDir, logs, state, make } = await fresh();
    const g = await state.issueGrant(grantInput());
    await writeFile(join(stateDir, "grants.json"), "[]garbage");
    const reloaded = make();
    expect(await reloaded.getGrant(g.grantId)).toBeNull();
    expect(logs.some((l) => /grant/i.test(l))).toBe(true);
    expect(logs.join("\n")).not.toContain(g.grantId);
    const next = await reloaded.issueGrant(grantInput());
    expect(await make().getGrant(next.grantId)).toMatchObject({ grantId: next.grantId });
  });

  it("markStale marks and returns only grants on that port", async () => {
    const { state, make } = await fresh();
    const a1 = await state.issueGrant(grantInput(4100));
    const a2 = await state.issueGrant(grantInput(4100, "prj_b"));
    const b = await state.issueGrant(grantInput(4200));
    const marked = await state.markStale(4100);
    expect(marked.map((g) => g.grantId).sort()).toEqual([a1.grantId, a2.grantId].sort());
    expect(marked.every((g) => g.stale)).toBe(true);
    const reloaded = make();
    expect((await reloaded.getGrant(a1.grantId))?.stale).toBe(true);
    expect((await reloaded.getGrant(b.grantId))?.stale).toBe(false);
    expect(await state.markStale(4100)).toEqual([]); // already stale: not newly marked
  });

  it("at the 1000-grant cap a stale grant is dropped first, then the oldest, with the count logged", async () => {
    const { logs, state } = await fresh();
    const staleOne = await state.issueGrant(grantInput(1));
    await state.markStale(1);
    const ids: string[] = [];
    for (let i = 0; i < 999; i++) ids.push((await state.issueGrant(grantInput(4100))).grantId);
    const before = logs.length;
    const g1001 = await state.issueGrant(grantInput(4100));
    expect(await state.getGrant(staleOne.grantId)).toBeNull();
    expect(await state.getGrant(ids[0])).not.toBeNull();
    expect(await state.getGrant(g1001.grantId)).not.toBeNull();
    const dropLog = logs.slice(before).join("\n");
    expect(dropLog).toMatch(/\b1\b/);
    expect(dropLog).not.toContain(staleOne.grantId);

    await state.issueGrant(grantInput(4100)); // no stale left: the oldest goes
    expect(await state.getGrant(ids[0])).toBeNull();
    expect(await state.getGrant(ids[1])).not.toBeNull();
  }, 120_000);

  it("20 concurrent issueGrant calls persist 20 distinct grants", async () => {
    const { state, make } = await fresh();
    const grants = await Promise.all(Array.from({ length: 20 }, (_, i) => state.issueGrant(grantInput(4100 + i))));
    expect(new Set(grants.map((g) => g.grantId)).size).toBe(20);
    const reloaded = make();
    for (const g of grants) expect(await reloaded.getGrant(g.grantId)).toEqual(g);
  });

  it("fingerprint is the first 8 hex chars of sha256(grantId)", () => {
    expect(fingerprint("abc")).toBe("ba7816bf");
  });
});

// Stage R3.2 (task card 2026-10-29 R3 §3.2): grants gain optional agentId, workspaceId (string or
// null) and boundAt; the grants file stays version 1. bindByFingerprint(sha256Hex(grantId).slice(0,
// 32), { agentId, workspaceId, at }) binds a non-stale unbound grant once; the same agent is a no-op;
// a different agent is refused and logged. Logs never carry the grant id.
describe("R3.2 grant binding", () => {
  const fp32 = (grantId: string) => createHash("sha256").update(grantId, "utf8").digest("hex").slice(0, 32);
  const AT = "2026-10-29T10:00:00.000Z";
  const bind = (state: McpState, fp: string, x: { agentId: string; workspaceId: string | null }) => {
    expect(typeof state.bindByFingerprint, "McpState.bindByFingerprint exists (R3.2)").toBe("function");
    return state.bindByFingerprint(fp, { ...x, at: AT });
  };

  it("binds a fresh grant; persisted in a version 1 file and reloadable; workspaceId may be null", async () => {
    const { stateDir, state, make } = await fresh();
    const g = await state.issueGrant(grantInput());
    expect("agentId" in g, "a new grant starts unbound").toBe(false);
    await bind(state, fp32(g.grantId), { agentId: "agent-1", workspaceId: null });
    const bound = await make().getGrant(g.grantId);
    expect(bound).toMatchObject({ ...g, agentId: "agent-1", workspaceId: null, boundAt: AT });
    const file = readJsonObject(await readFile(join(stateDir, "grants.json"), "utf8"));
    expect(file.version).toBe(1);
  });

  it("the same agent again leaves the binding unchanged; a different agent is refused and logged without the grant id", async () => {
    const { state, logs } = await fresh();
    const g = await state.issueGrant(grantInput());
    await bind(state, fp32(g.grantId), { agentId: "agent-1", workspaceId: "ws-1" });
    const first = await state.getGrant(g.grantId);
    await bind(state, fp32(g.grantId), { agentId: "agent-1", workspaceId: "ws-1" });
    expect(await state.getGrant(g.grantId)).toEqual(first);
    const before = logs.length;
    await bind(state, fp32(g.grantId), { agentId: "agent-2", workspaceId: "ws-2" });
    expect(await state.getGrant(g.grantId)).toEqual(first);
    expect(logs.length).toBeGreaterThan(before);
    for (const l of logs) expect(l).not.toContain(g.grantId);
  });

  it("a stale grant or an unknown fingerprint binds nothing; other grants are untouched", async () => {
    const { state } = await fresh();
    const a = await state.issueGrant(grantInput(4100));
    const b = await state.issueGrant(grantInput(4200));
    await state.markStale(4100);
    await bind(state, fp32(a.grantId), { agentId: "agent-1", workspaceId: null });
    await bind(state, "0".repeat(32), { agentId: "agent-1", workspaceId: null });
    await bind(state, fp32(a.grantId).slice(0, 8), { agentId: "agent-1", workspaceId: null });
    expect((await state.getGrant(a.grantId))?.agentId).toBeUndefined();
    expect(await state.getGrant(b.grantId)).toEqual(b);
  });

  it("a grants file written before R3.2 (no binding fields) still loads unchanged", async () => {
    const { stateDir, state, make } = await fresh();
    await state.loadOrCreateEndpoint(); // creates the state directory
    const legacy = { grantId: "g-legacy", projectId: "prj_test", storeRoot: "/synthetic/prj_test", provider: "claude", cwd: "/synthetic/prj_test", port: 4100, issuedAt: AT, stale: false };
    await writeFile(join(stateDir, "grants.json"), JSON.stringify({ version: 1, grants: [legacy] }));
    expect(await make().getGrant("g-legacy")).toEqual(legacy);
  });
});
