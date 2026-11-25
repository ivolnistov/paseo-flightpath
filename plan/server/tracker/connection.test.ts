// SnailOrbit connection source and snapshot identity (Stage 4 P4.6 O1, T4.7). Synthetic config files
// in a temp CODEX_HOME; homedir is injected to throw, so the real home is never read.
import { createHmac } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionSnapshot, codexConnectionSource, snapshotConnection } from "./connection";

const URL_A = "https://synthetic-a.invalid/mcp/secret-token-AAAA";
const URL_B = "https://synthetic-b.invalid/mcp/secret-token-BBBB";
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 32 - i));
const noHome = () => {
  throw new Error("real home must not be read");
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function codexHome(config: string | null) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dr-codex-")));
  dirs.push(dir);
  if (config !== null) await writeFile(join(dir, "config.toml"), config);
  return codexConnectionSource({ env: { CODEX_HOME: dir }, homedir: noHome });
}

describe("codexConnectionSource", () => {
  it("accepts a url-only [mcp_servers.snailorbit] table", async () => {
    const out = await (await codexHome(`model = "x"\n\n[mcp_servers.snailorbit]\nurl = "${URL_A}"\n\n[mcp_servers.other]\ncommand = "x"\n`)).read();
    expect("url" in out && out.url.href).toBe(URL_A);
  });

  it.each([
    ["missing file", null],
    ["missing table", `[mcp_servers.other]\nurl = "${URL_A}"\n`],
    ["missing url", `[mcp_servers.snailorbit]\n`],
  ])("%s → connection_missing", async (_name, config) => {
    expect(await (await codexHome(config)).read()).toEqual({ error: "connection_missing" });
  });

  it.each([
    ["bad TOML", `[mcp_servers.snailorbit\nurl = "${URL_A}"`],
    ["ftp URL", `[mcp_servers.snailorbit]\nurl = "ftp://synthetic.invalid/x"\n`],
    ["non-URL string", `[mcp_servers.snailorbit]\nurl = "not a url"\n`],
  ])("%s → connection_invalid", async (_name, config) => {
    expect(await (await codexHome(config)).read()).toEqual({ error: "connection_invalid" });
  });

  it.each([
    ["http_headers", `[mcp_servers.snailorbit]\nurl = "${URL_A}"\n[mcp_servers.snailorbit.http_headers]\nAuthorization = "x"\n`],
    ["env", `[mcp_servers.snailorbit]\nurl = "${URL_A}"\nenv = { A = "b" }\n`],
    ["command", `[mcp_servers.snailorbit]\nurl = "${URL_A}"\ncommand = "npx"\n`],
    ["bearer_token_env_var", `[mcp_servers.snailorbit]\nurl = "${URL_A}"\nbearer_token_env_var = "T"\n`],
  ])("extra key %s → connection_unsupported", async (_name, config) => {
    expect(await (await codexHome(config)).read()).toEqual({ error: "connection_unsupported" });
  });

  it("reads only CODEX_HOME/config.toml and never the real home", async () => {
    const reads: string[] = [];
    const out = await codexConnectionSource({ env: {}, homedir: () => "/nonexistent-synthetic-home", readFile: async (p) => {
      reads.push(p);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    } }).read();
    expect(out).toEqual({ error: "connection_missing" });
    // c0065: the fallback is exactly <homedir>/.codex/config.toml, read once.
    expect(reads).toEqual([join("/nonexistent-synthetic-home", ".codex", "config.toml")]);
  });

  it("an empty CODEX_HOME is treated as absent and resolves the default from homedir (c0060)", async () => {
    const reads: string[] = [];
    const out = await codexConnectionSource({ env: { CODEX_HOME: "" }, homedir: () => "/synthetic-home-c0060", readFile: async (p) => {
      reads.push(p);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    } }).read();
    expect(out).toEqual({ error: "connection_missing" });
    expect(reads).toEqual([join("/synthetic-home-c0060", ".codex", "config.toml")]);
  });

  it("errors never carry the synthetic URL", async () => {
    const src = await codexHome(`[mcp_servers.snailorbit]\nurl = "${URL_A}"\nenv = { SECRET = "${URL_A}" }\n`);
    const out = await src.read();
    expect(JSON.stringify(out)).not.toContain("secret-token");
  });
});

describe("ConnectionSnapshot", () => {
  const fp = (url: string) => createHmac("sha256", KEY).update(`snailorbit-conn:v1\n${new URL(url).href}`, "utf8").digest("base64url");

  it("fingerprint is base64url(HMAC-SHA256(trackerKey, \"snailorbit-conn:v1\\n\" + href)), stable and URL-specific", async () => {
    const a = await snapshotConnection(await codexHome(`[mcp_servers.snailorbit]\nurl = "${URL_A}"\n`), KEY);
    const a2 = await snapshotConnection(await codexHome(`[mcp_servers.snailorbit]\nurl = "${URL_A}"\n`), KEY);
    const b = await snapshotConnection(await codexHome(`[mcp_servers.snailorbit]\nurl = "${URL_B}"\n`), KEY);
    expect(a).toBeInstanceOf(ConnectionSnapshot);
    // Narrows all three; an error result fails here (its fingerprint assertions could not hold).
    if (!(a instanceof ConnectionSnapshot && a2 instanceof ConnectionSnapshot && b instanceof ConnectionSnapshot)) throw new Error("expected three snapshots");
    const sa = a;
    expect(sa.fingerprint).toBe(fp(URL_A));
    expect(sa.fingerprint).toHaveLength(43);
    expect(a2.fingerprint).toBe(sa.fingerprint);
    expect(b.fingerprint).toBe(fp(URL_B));
    expect(b.fingerprint).not.toBe(sa.fingerprint);
    const otherKey = Buffer.from(KEY);
    otherKey[0] ^= 1;
    const other = await snapshotConnection(await codexHome(`[mcp_servers.snailorbit]\nurl = "${URL_A}"\n`), otherKey);
    expect(other instanceof ConnectionSnapshot ? other.fingerprint : other).not.toBe(sa.fingerprint);
  });

  it("never serialises the URL; only urlForTransport exposes it", async () => {
    const s = await snapshotConnection(await codexHome(`[mcp_servers.snailorbit]\nurl = "${URL_A}"\n`), KEY);
    if (!(s instanceof ConnectionSnapshot)) throw new Error("expected a snapshot");
    expect(JSON.stringify(s)).toBe(JSON.stringify({ fingerprint: s.fingerprint }));
    expect(JSON.stringify({ wrapped: s })).not.toContain("synthetic-a");
    expect(String(Object.keys(s))).not.toContain("url");
    expect(s.urlForTransport().href).toBe(URL_A);
  });

  it("a source error is returned as the error code, not a snapshot", async () => {
    expect(await snapshotConnection(await codexHome(null), KEY)).toEqual({ error: "connection_missing" });
  });
});
