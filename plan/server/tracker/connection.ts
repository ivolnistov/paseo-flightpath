// SnailOrbit connection source (O1): the Codex-native `[mcp_servers.snailorbit]` table with `url`
// only, read locally per use. The URL is secret-bearing and is held only inside a ConnectionSnapshot.
import { createHmac } from "node:crypto";
import { readFile as fsReadFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { errnoCode } from "../../shared/errors";

export type ConnectionError = "connection_missing" | "connection_invalid" | "connection_unsupported";
export interface ConnectionSource {
  read(): Promise<{ url: URL } | { error: ConnectionError }>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function codexConnectionSource(opts: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  readFile?: (p: string) => Promise<string>;
}): ConnectionSource {
  const env = opts.env ?? process.env;
  const read = opts.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
  return {
    async read() {
      let text: string;
      try {
        // An empty CODEX_HOME counts as unset, so it never resolves to a cwd-relative config.toml.
        const home = env.CODEX_HOME || join((opts.homedir ?? osHomedir)(), ".codex");
        text = await read(join(home, "config.toml"));
      } catch (e) {
        return { error: errnoCode(e) === "ENOENT" ? "connection_missing" : "connection_invalid" };
      }
      let doc: unknown;
      try {
        doc = parse(text);
      } catch {
        return { error: "connection_invalid" };
      }
      const servers = isObject(doc) ? doc.mcp_servers : undefined;
      const table = isObject(servers) ? servers.snailorbit : undefined;
      if (!isObject(table)) return { error: "connection_missing" };
      if (Object.keys(table).some((k) => k !== "url")) return { error: "connection_unsupported" };
      if (table.url === undefined) return { error: "connection_missing" };
      if (typeof table.url !== "string") return { error: "connection_invalid" };
      let url: URL;
      try {
        url = new URL(table.url);
      } catch {
        return { error: "connection_invalid" };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "connection_invalid" };
      return { url };
    },
  };
}

/** One local read of the connection. Only the keyed fingerprint is ever serialised. */
export class ConnectionSnapshot {
  readonly fingerprint: string;
  #url: URL;
  constructor(fingerprint: string, url: URL) {
    this.fingerprint = fingerprint;
    this.#url = url;
  }
  toJSON(): { fingerprint: string } {
    return { fingerprint: this.fingerprint };
  }
  /** For the transport inside snailorbit.ts only. */
  urlForTransport(): URL {
    return new URL(this.#url.href);
  }
}

export async function snapshotConnection(source: ConnectionSource, key: Buffer): Promise<ConnectionSnapshot | { error: ConnectionError }> {
  const r = await source.read();
  if ("error" in r) return { error: r.error };
  const fingerprint = createHmac("sha256", key).update(`snailorbit-conn:v1\n${r.url.href}`, "utf8").digest("base64url");
  return new ConnectionSnapshot(fingerprint, r.url);
}
