// Endpoint secret/port and project grants under the plugin data directory. Never log secrets,
// grant ids, URLs or signatures; only counts, ports and fingerprints.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sha256Hex } from "./hash";
import { ulid } from "./ids";
import { errnoCode } from "../shared/errors";

export const PLUGIN_ID = "decision-roadmap";
export const defaultStateDir = () => join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", PLUGIN_ID);

const EndpointStateSchema = z
  .object({ version: z.literal(1), port: z.number().int().min(0).max(65535), secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export type EndpointState = z.infer<typeof EndpointStateSchema>;

const GrantSchema = z
  .object({
    grantId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    projectId: z.string().min(1),
    storeRoot: z.string().min(1),
    provider: z.string().min(1),
    cwd: z.string(),
    port: z.number().int().min(0).max(65535),
    issuedAt: z.string().datetime(),
    stale: z.boolean(),
    // Stage R3.2: the agent bound to this grant on its interactive session_open (absent until then).
    agentId: z.string().min(1).optional(),
    workspaceId: z.string().nullable().optional(),
    boundAt: z.string().datetime().optional(),
  })
  .strict();
export type Grant = z.infer<typeof GrantSchema>;
const GrantsFileSchema = z.object({ version: z.literal(1), grants: z.array(GrantSchema) }).strict();
// Reservation marks: which grant was issued for which discussion chat's creation, from the reservation
// the plugin passed in the creation env, as the injection saw it. Kept in reservations.json beside
// grants.json, never in it, so a grants file read by an earlier plugin version still parses.
const ReservationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const MarksFileSchema = z
  .object({ version: z.literal(1), marks: z.array(z.object({ grantId: GrantSchema.shape.grantId, reservationId: ReservationIdSchema }).strict()) })
  .strict();
type Mark = z.infer<typeof MarksFileSchema>["marks"][number];

export interface McpState {
  loadOrCreateEndpoint(): Promise<EndpointState>;
  saveEndpoint(s: EndpointState): Promise<void>;
  /** Issues a grant; `reservationId` marks it as issued for that discussion chat's creation. */
  issueGrant(g: Omit<Grant, "grantId" | "issuedAt" | "stale"> & { reservationId?: string }): Promise<Grant>;
  getGrant(grantId: string): Promise<Grant | null>;
  markStale(oldPort: number): Promise<Grant[]>;
  /** Binds the live, unbound grant with this agent-env fingerprint; never rebinds to another agent. */
  bindByFingerprint(fp: string, x: { agentId: string; workspaceId: string | null; at: string }): Promise<Grant | null>;
  /** The live grant bound to this agent, else null. Rejects when the grants file cannot be read or parsed. */
  grantForAgent(agentId: string): Promise<Grant | null>;
  /**
   * Live (not stale) grants issued for `cwd` at or after `at` that no agent has bound yet. With scope
   * "unmarked" (the default) only grants without a reservation mark count, for a chat whose own
   * reservation is known (a marked grant belongs to that reservation's creation); with "all" marked
   * ones count too, for a chat whose reservation is not known. Rejects when the grants file cannot be
   * read or parsed and, for "unmarked" only, when the marks file cannot; "all" does not read the marks.
   */
  grantsIssuedSince(at: string, cwd: string, scope?: "unmarked" | "all"): Promise<number>;
  /** The live grants marked with this reservation, bound or not. Rejects when the grants or marks file cannot be read or parsed. */
  grantsForReservation(reservationId: string): Promise<Grant[]>;
}

/** The creation env variable that carries a discussion chat's reservation id to the injection. */
export const RESERVATION_ENV = "PASEO_ROADMAP_RESERVATION";
export const isReservationId = (v: unknown): v is string => ReservationIdSchema.safeParse(v).success;

export const MAX_GRANTS = 1000;

export const fingerprint = (grantId: string) => sha256Hex(grantId).slice(0, 8);

/** The env fingerprint that identifies a grant to session_open (32 hex; not a credential: the URL also needs the HMAC). */
export const GRANT_FP_ENV = "PASEO_ROADMAP_GRANT_FP";
export const envFingerprint = (grantId: string) => sha256Hex(grantId).slice(0, 32);

const isEnoent = (e: unknown) => errnoCode(e) === "ENOENT";

/** One promise chain per state directory, shared by every McpState over it in this process. */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(run, run);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

export function createMcpState(opts: {
  stateDir?: string;
  now?: () => Date;
  newId?: () => string;
  log?: (m: string) => void;
}): McpState {
  const stateDir = opts.stateDir ?? defaultStateDir();
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => ulid());
  const log = opts.log ?? ((m: string) => console.error(`[${PLUGIN_ID}] ${m}`));
  const endpointPath = join(stateDir, "mcp.json");
  const grantsPath = join(stateDir, "grants.json");
  const marksPath = join(stateDir, "reservations.json");

  async function ensureDir(): Promise<void> {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
  }

  /** Temp file (0600) then rename, so readers never see a partial file. */
  async function writeAtomic(path: string, data: unknown): Promise<void> {
    await ensureDir();
    const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async function readJson(path: string): Promise<{ missing: true } | { missing: false; value: unknown }> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if (isEnoent(e)) return { missing: true };
      throw e;
    }
    try {
      return { missing: false, value: JSON.parse(text) };
    } catch {
      return { missing: false, value: undefined };
    }
  }

  let reportedCorruptGrants = false;
  async function readGrants(): Promise<Grant[]> {
    const raw = await readJson(grantsPath);
    if (raw.missing) return [];
    const parsed = GrantsFileSchema.safeParse(raw.value);
    if (parsed.success) return parsed.data.grants;
    if (!reportedCorruptGrants) {
      reportedCorruptGrants = true;
      log("grants file invalid; treating it as empty; agents created before need recreation");
    }
    return [];
  }

  /** Like readGrants, but an unreadable or invalid file is an error rather than an empty list. */
  async function readGrantsStrict(): Promise<Grant[]> {
    const raw = await readJson(grantsPath);
    if (raw.missing) return [];
    const parsed = GrantsFileSchema.safeParse(raw.value);
    if (!parsed.success) throw new Error("grants file unreadable");
    return parsed.data.grants;
  }

  const writeGrants = (grants: Grant[]) => writeAtomic(grantsPath, { version: 1, grants });

  /** The reservation marks; a missing file is none, an unreadable or invalid one is an error. */
  async function readMarksStrict(): Promise<Mark[]> {
    const raw = await readJson(marksPath);
    if (raw.missing) return [];
    const parsed = MarksFileSchema.safeParse(raw.value);
    if (!parsed.success) throw new Error("reservation marks unreadable");
    return parsed.data.marks;
  }

  /**
   * Adds one mark and keeps only marks of grants that still exist. An unreadable marks file is left
   * as it is: replacing it would lose the earlier marks and could turn a chat's pending grant into an
   * unmarked one; while it is unreadable every tools state that reads it (the reservation lookup and
   * the unmarked count) is unknown.
   */
  async function addMark(mark: Mark, grants: Grant[]): Promise<void> {
    let marks: Mark[];
    try {
      marks = await readMarksStrict();
    } catch {
      log("reservation marks unreadable; mark not written");
      return;
    }
    const live = new Set(grants.map((g) => g.grantId));
    await writeAtomic(marksPath, { version: 1, marks: [...marks.filter((m) => live.has(m.grantId)), mark] });
  }

  return {
    loadOrCreateEndpoint: () =>
      withLock(stateDir, async () => {
        const raw = await readJson(endpointPath);
        if (!raw.missing) {
          const parsed = EndpointStateSchema.safeParse(raw.value);
          if (parsed.success) return parsed.data;
          log("endpoint state invalid; regenerated; existing agents need recreation");
        }
        const fresh: EndpointState = { version: 1, port: 0, secret: randomBytes(32).toString("base64url") };
        await writeAtomic(endpointPath, fresh);
        return fresh;
      }),
    saveEndpoint: (s) =>
      withLock(stateDir, async () => {
        await writeAtomic(endpointPath, EndpointStateSchema.parse(s));
      }),
    issueGrant: (g) =>
      withLock(stateDir, async () => {
        const grant = GrantSchema.parse({
          grantId: newId(),
          projectId: g.projectId,
          storeRoot: g.storeRoot,
          provider: g.provider,
          cwd: g.cwd,
          port: g.port,
          issuedAt: now().toISOString(),
          stale: false,
        });
        let grants = await readGrants();
        const excess = grants.length + 1 - MAX_GRANTS;
        if (excess > 0) {
          // Stale grants go first (oldest first), then the oldest live ones.
          const order = [...grants.keys()].sort((a, b) => Number(grants[b].stale) - Number(grants[a].stale) || a - b);
          const drop = new Set(order.slice(0, excess));
          grants = grants.filter((_, i) => !drop.has(i));
          log(`grant cap ${MAX_GRANTS} reached; dropped ${excess} grants`);
        }
        grants.push(grant);
        await writeGrants(grants);
        // After the grant, so a failed mark leaves a usable unmarked grant, never a mark without its grant.
        if (g.reservationId !== undefined && isReservationId(g.reservationId)) {
          await addMark({ grantId: grant.grantId, reservationId: g.reservationId }, grants).catch(() => log("reservation mark not written"));
        }
        return grant;
      }),
    async getGrant(grantId) {
      return (await readGrants()).find((x) => x.grantId === grantId) ?? null;
    },
    markStale: (oldPort) =>
      withLock(stateDir, async () => {
        const grants = await readGrants();
        const marked: Grant[] = [];
        for (const g of grants) {
          if (g.port === oldPort && !g.stale) {
            g.stale = true;
            marked.push({ ...g });
          }
        }
        if (marked.length > 0) await writeGrants(grants);
        return marked;
      }),
    grantForAgent: (agentId) =>
      withLock(stateDir, async () => {
        const grant = (await readGrantsStrict()).find((g) => !g.stale && g.agentId === agentId);
        return grant !== undefined ? { ...grant } : null;
      }),
    grantsIssuedSince: (at, cwd, scope = "unmarked") =>
      withLock(stateDir, async () => {
        const since = Date.parse(at);
        const grants = await readGrantsStrict();
        // "all" needs no marks; "unmarked" reads them strictly, so unreadable marks are never taken for none.
        const marked = new Set(scope === "all" ? [] : (await readMarksStrict()).map((m) => m.grantId));
        return grants.filter((g) => !g.stale && g.agentId === undefined && !marked.has(g.grantId) && g.cwd === cwd && Date.parse(g.issuedAt) >= since).length;
      }),
    grantsForReservation: (reservationId) =>
      withLock(stateDir, async () => {
        const grants = await readGrantsStrict();
        const ids = new Set((await readMarksStrict()).filter((m) => m.reservationId === reservationId).map((m) => m.grantId));
        return grants.filter((g) => !g.stale && ids.has(g.grantId)).map((g) => ({ ...g }));
      }),
    bindByFingerprint: (fp, x) =>
      withLock(stateDir, async () => {
        if (!/^[0-9a-f]{32}$/.test(fp)) return null;
        const grants = await readGrants();
        const grant = grants.find((g) => !g.stale && envFingerprint(g.grantId) === fp);
        if (!grant) return null;
        if (grant.agentId !== undefined) {
          if (grant.agentId === x.agentId) return { ...grant };
          log(`grant fp=${fingerprint(grant.grantId)} is bound to another agent; binding refused`);
          return null;
        }
        grant.agentId = x.agentId;
        grant.workspaceId = x.workspaceId;
        grant.boundAt = x.at;
        await writeGrants(grants);
        return { ...grant };
      }),
  };
}
