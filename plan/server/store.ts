import { join, resolve, sep } from "node:path";
import { canonicalJson, deepClone, isRecord } from "../shared/canonical";
import { DomainError, errnoCode, isDomainError } from "../shared/errors";
import { validateGraph } from "../shared/graph";
import { assertNumbersStable, backfillNumbers } from "../shared/numbering";
import { z } from "zod";
import {
  cancellationRefIssues,
  outOfScopeRefIssues,
  ExecutionRun,
  Feature,
  GEN_RE,
  Manifest,
  Plan,
  PlanV1,
  RoadmapData,
  RoadmapMeta,
  Session,
  SessionV1,
  StartDelegation,
  type RoadmapDataV1,
} from "../shared/model";
import { nodeStoreFs, type StoreFs } from "./fs-port";
import { sha256Hex } from "./hash";
import { ulid } from "./ids";
import { projectV1 } from "./legacy-projection";

export type StoreReadResult =
  | { status: "missing" }
  | { status: "ok"; revision: number; changeToken: string; disabled: boolean; schemaVersion: SchemaVersion; data: RoadmapData }
  | { status: "invalid"; revision?: number; error: { message: string; issues?: unknown } };

/** Schema version of the generation on disk; `data` is always the v2 view. */
export type SchemaVersion = 1 | 2;

export interface StoreOptions {
  storeRoot: string;
  projectId: string;
  fs?: StoreFs;
  now?: () => Date;
  newId?: () => string;
  keepGenerations?: number;
  log?: (message: string, error?: unknown) => void;
}

export interface Store {
  readonly storeRoot: string;
  readonly projectId: string;
  init(): Promise<{ created: boolean; revision: number }>;
  read(): Promise<StoreReadResult>;
  /** `schemaVersion` is null unless the store reads ok: an invalid generation has no verified schema. */
  version(): Promise<{ exists: boolean; revision: number | null; status: StoreReadResult["status"]; schemaVersion: SchemaVersion | null }>;
  transact<T>(expectedRevision: number, fn: (draft: RoadmapData) => T): Promise<{ result: T; revision: number }>;
}

/** Ids become file names inside a generation. */
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TMP_PREFIX = "manifest.json.tmp-";
const DELEGATIONS_FILE = "delegations.json";

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

class Invalid extends Error {
  constructor(message: string, readonly issues?: unknown) {
    super(message);
  }
}

const isEnoent = (e: unknown) => errnoCode(e) === "ENOENT";

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Invalid(`${what} is not valid JSON`);
  }
}

function checkIds(ids: string[], what: string, fail: (msg: string) => never): void {
  if (new Set(ids).size !== ids.length) fail(`duplicate ${what} ids`);
  const bad = ids.filter((id) => !FILE_ID_RE.test(id));
  if (bad.length > 0) fail(`unsafe ${what} ids: ${bad.join(", ")}`);
}

/**
 * Starts independent fs calls in a fixed order and waits for all of them, so a failure never
 * leaves a call running after the commit has rejected. Rethrows the first failure.
 */
async function settleAll(calls: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(calls.map((call) => call()));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

/** Graph rules over the sessions of a generation; a violation makes the generation invalid. */
function validateSessions(sessions: Session[]): void {
  try {
    validateGraph(sessions);
  } catch (e) {
    if (isDomainError(e)) throw new Invalid(e.message, e.details);
    throw e;
  }
}

const generationName = (revision: number, id: string) => `g-${String(revision).padStart(10, "0")}-${id}`;
const generationRevision = (name: string) => (GEN_RE.test(name) ? Number(name.slice(2, 12)) : null);

export function openStore(opts: StoreOptions): Store {
  const fs = opts.fs ?? nodeStoreFs;
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => ulid());
  const keep = Math.max(1, opts.keepGenerations ?? 2);
  const log = opts.log ?? ((m: string, e?: unknown) => console.error(m, e));
  const { storeRoot, projectId } = opts;
  const lockKey = resolve(storeRoot);
  const decisionsDir = join(storeRoot, ".decisions");
  const manifestPath = join(decisionsDir, "manifest.json");
  const generationsDir = join(decisionsDir, "generations");

  async function readRawManifest(): Promise<unknown | undefined> {
    let text: string;
    try {
      text = await fs.readFile(manifestPath);
    } catch (e) {
      if (isEnoent(e)) return undefined;
      throw e;
    }
    return parseJson(text, "manifest.json");
  }

  function checkProject(raw: unknown): void {
    const found = isRecord(raw) ? raw.projectId : undefined;
    if (typeof found === "string" && found !== projectId) {
      throw new DomainError("project_mismatch", `store belongs to project ${found}`, { expected: projectId, actual: found });
    }
  }

  async function loadGeneration(manifest: Manifest): Promise<{ schemaVersion: SchemaVersion; data: RoadmapData }> {
    const genDir = join(generationsDir, manifest.generation);
    if (!resolve(genDir).startsWith(resolve(generationsDir) + sep)) throw new Invalid("generation outside generations/");
    const fail = (message: string): never => {
      throw new Invalid(message);
    };
    const parse = async <T>(
      schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: unknown } } },
      path: string,
      what: string,
    ) => {
      let text: string;
      try {
        text = await fs.readFile(path);
      } catch (e) {
        if (isEnoent(e)) throw new Invalid(`${what} is missing`);
        throw e;
      }
      const result = schema.safeParse(parseJson(text, what));
      if (!result.success) throw new Invalid(`${what} does not match the schema`, result.error.issues);
      return result.data;
    };
    const listed = async (sub: string, ids: string[]) => {
      let names: string[];
      try {
        names = await fs.readdir(join(genDir, sub));
      } catch (e) {
        if (isEnoent(e)) names = [];
        else throw e;
      }
      const onDisk = names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
      if (canonicalJson(onDisk) !== canonicalJson([...ids].sort())) fail(`${sub}/ files do not match the listed ids`);
    };
    /** Every record of `ids` from `<sub>/<id>.json`, each holding its own id. */
    const records = <T extends { id: string }>(schema: z.ZodType<T>, sub: string, ids: string[]) =>
      Promise.all(
        ids.map(async (id) => {
          const record = await parse(schema, join(genDir, sub, `${id}.json`), `${sub}/${id}.json`);
          if (record.id !== id) fail(`${sub}/${id}.json holds ${record.id}`);
          return record;
        }),
      );
    const verify = (raw: unknown) => {
      if (sha256Hex(canonicalJson(raw)) !== manifest.changeToken) fail("changeToken does not match the snapshot");
    };

    const meta = await parse(RoadmapMeta, join(genDir, "roadmap.json"), "roadmap.json");
    if (meta.projectId !== manifest.projectId) fail("roadmap.json projectId differs from the manifest");
    checkIds(meta.sessionIds, "session", fail);
    checkIds(meta.planIds, "plan", fail);
    if (new Set(meta.links.map((l) => l.id)).size !== meta.links.length) fail("duplicate link ids");

    if (meta.version === 1) {
      // Legacy generation: strict v1 schemas, token verified on the raw v1 form, then projected.
      const [, , sessions, plans] = await Promise.all([
        listed("sessions", meta.sessionIds),
        listed("plans", meta.planIds),
        records(SessionV1, "sessions", meta.sessionIds),
        records(PlanV1, "plans", meta.planIds),
      ]);
      validateSessions(sessions);
      const raw: RoadmapDataV1 = { meta, sessions, plans };
      verify(raw);
      return { schemaVersion: 1, data: projectV1(raw) };
    }

    checkIds(meta.featureIds, "feature", fail);
    checkIds(meta.runIds, "run", fail);
    // Reads are independent; issue them together (calls still start in a fixed order).
    const [, , , , sessions, plans, features, runs, delegations] = await Promise.all([
      listed("sessions", meta.sessionIds),
      listed("plans", meta.planIds),
      listed("features", meta.featureIds),
      listed("runs", meta.runIds),
      records(Session, "sessions", meta.sessionIds),
      records(Plan, "plans", meta.planIds),
      records(Feature, "features", meta.featureIds),
      records(ExecutionRun, "runs", meta.runIds),
      parse(z.array(StartDelegation), join(genDir, DELEGATIONS_FILE), DELEGATIONS_FILE),
    ]);
    validateSessions(sessions);
    const data: RoadmapData = { meta, sessions, plans, features, runs, delegations };
    // The loader parses the parts, so cross-record integrity of cancellations is checked here.
    const dangling = cancellationRefIssues(data);
    if (dangling.length > 0) fail(`cancellation of an unknown decision: ${dangling.map((r) => `${r.sessionId}/${r.questionId}`).join(", ")}`);
    const unmarked = outOfScopeRefIssues(data);
    if (unmarked.length > 0) fail(`out-of-scope mark of an unknown question: ${unmarked.map((r) => `${r.sessionId}/${r.questionId}`).join(", ")}`);
    verify(data);
    return { schemaVersion: 2, data };
  }

  async function read(): Promise<StoreReadResult> {
    // A concurrent commit may prune the generation mid-read; retry when the manifest moved on.
    let result = await readOnce();
    for (let attempt = 0; attempt < 3 && result.status === "invalid"; attempt++) {
      const again = await readOnce();
      if (again.status !== "invalid" || again.revision === result.revision) return again;
      result = again;
    }
    return result;
  }

  async function readOnce(): Promise<StoreReadResult> {
    let raw: unknown;
    try {
      raw = await readRawManifest();
    } catch (e) {
      if (e instanceof Invalid) return { status: "invalid", error: { message: e.message } };
      throw e;
    }
    if (raw === undefined) return { status: "missing" };
    checkProject(raw);
    const rawRevision = (raw as { revision?: unknown } | null)?.revision;
    const revision = typeof rawRevision === "number" ? rawRevision : undefined;
    const parsed = Manifest.safeParse(raw);
    if (!parsed.success) {
      return { status: "invalid", revision, error: { message: "manifest.json does not match the schema", issues: parsed.error.issues } };
    }
    const manifest = parsed.data;
    try {
      const { schemaVersion, data } = await loadGeneration(manifest);
      return {
        status: "ok",
        revision: manifest.revision,
        changeToken: manifest.changeToken,
        disabled: manifest.disabled === true,
        schemaVersion,
        data,
      };
    } catch (e) {
      if (e instanceof Invalid) return { status: "invalid", revision, error: { message: e.message, issues: e.issues } };
      throw e;
    }
  }

  function validateDraft(draft: RoadmapData): RoadmapData {
    const invalid = (message: string, details?: unknown): never => {
      throw new DomainError("invalid_input", message, details);
    };
    if (draft?.meta) {
      draft.meta.sessionIds = (draft.sessions ?? []).map((s) => s?.id);
      draft.meta.planIds = (draft.plans ?? []).map((p) => p?.id);
      draft.meta.featureIds = (draft.features ?? []).map((f) => f?.id);
      draft.meta.runIds = (draft.runs ?? []).map((r) => r?.id);
    }
    const parsed = RoadmapData.safeParse(draft);
    if (!parsed.success) invalid("roadmap data does not match the schema", { issues: parsed.error.issues });
    const data = parsed.data!;
    if (data.meta.projectId !== projectId) invalid("meta.projectId must not change");
    checkIds(data.meta.sessionIds, "session", (m) => invalid(m));
    checkIds(data.meta.planIds, "plan", (m) => invalid(m));
    checkIds(data.meta.featureIds, "feature", (m) => invalid(m));
    checkIds(data.meta.runIds, "run", (m) => invalid(m));
    if (new Set(data.meta.links.map((l) => l.id)).size !== data.meta.links.length) invalid("duplicate link ids");
    try {
      validateGraph(data.sessions);
    } catch (e) {
      if (isDomainError(e)) invalid(e.message, { code: e.code, details: e.details });
      throw e;
    }
    return data;
  }

  async function prune(current: string, currentRevision: number): Promise<void> {
    try {
      const older = (await fs.readdir(generationsDir))
        .filter((n) => n !== current)
        .map((n) => ({ n, rev: generationRevision(n) }));
      const kept = new Set(
        older
          .filter((g): g is { n: string; rev: number } => g.rev !== null && g.rev < currentRevision)
          .sort((a, b) => b.rev - a.rev || (a.n < b.n ? 1 : -1))
          .slice(0, keep - 1)
          .map((g) => g.n),
      );
      for (const { n } of older) {
        if (!kept.has(n)) await fs.rm(join(generationsDir, n)).catch((e) => log(`decision-roadmap: prune ${n} failed`, e));
      }
      for (const n of await fs.readdir(decisionsDir)) {
        if (n.startsWith(TMP_PREFIX)) await fs.rm(join(decisionsDir, n)).catch((e) => log(`decision-roadmap: prune ${n} failed`, e));
      }
    } catch (e) {
      log("decision-roadmap: prune failed", e);
    }
  }

  async function commit(data: RoadmapData, revision: number, disabled: boolean): Promise<void> {
    const generation = generationName(revision, newId());
    const genDir = join(generationsDir, generation);
    const sessionsDir = join(genDir, "sessions");
    const plansDir = join(genDir, "plans");
    const featuresDir = join(genDir, "features");
    const runsDir = join(genDir, "runs");
    for (const dir of [sessionsDir, plansDir, featuresDir, runsDir]) await fs.mkdir(dir);
    // Legacy plans are serialised exactly as before, so their file bytes never change; legacy
    // sessions change only by the numbers backfilled on their first write.
    await settleAll([
      () => fs.writeFileDurable(join(genDir, "roadmap.json"), canonicalJson(data.meta)),
      ...data.sessions.map((s) => () => fs.writeFileDurable(join(sessionsDir, `${s.id}.json`), canonicalJson(s))),
      ...data.plans.map((p) => () => fs.writeFileDurable(join(plansDir, `${p.id}.json`), canonicalJson(p))),
      ...data.features.map((f) => () => fs.writeFileDurable(join(featuresDir, `${f.id}.json`), canonicalJson(f))),
      ...data.runs.map((r) => () => fs.writeFileDurable(join(runsDir, `${r.id}.json`), canonicalJson(r))),
      () => fs.writeFileDurable(join(genDir, DELEGATIONS_FILE), canonicalJson(data.delegations)),
    ]);
    await settleAll([sessionsDir, plansDir, featuresDir, runsDir, genDir, generationsDir].map((d) => () => fs.fsyncDir(d)));
    const manifest: Manifest = {
      version: 1,
      projectId,
      revision,
      generation,
      changeToken: sha256Hex(canonicalJson(data)),
      ...(disabled ? { disabled: true } : {}),
    };
    const tmp = join(decisionsDir, `${TMP_PREFIX}${newId()}`);
    await fs.writeFileDurable(tmp, canonicalJson(manifest));
    await fs.rename(tmp, manifestPath);
    await fs.fsyncDir(decisionsDir);
    await prune(generation, revision);
  }

  return {
    storeRoot,
    projectId,
    read,
    async version() {
      const result = await read();
      if (result.status === "ok") return { exists: true, revision: result.revision, status: "ok", schemaVersion: result.schemaVersion };
      if (result.status === "invalid") return { exists: true, revision: result.revision ?? null, status: "invalid", schemaVersion: null };
      return { exists: false, revision: null, status: "missing", schemaVersion: null };
    },
    init() {
      return withLock(lockKey, async () => {
        const current = await read();
        if (current.status === "ok") return { created: false, revision: current.revision };
        if (current.status === "invalid") {
          throw new DomainError("store_invalid", current.error.message, current.error);
        }
        const data: RoadmapData = {
          meta: {
            version: 2,
            projectId,
            createdAt: now().toISOString(),
            links: [],
            sessionIds: [],
            planIds: [],
            featureIds: [],
            runIds: [],
            settings: {},
          },
          sessions: [],
          plans: [],
          features: [],
          runs: [],
          delegations: [],
        };
        await commit(data, 1, false);
        return { created: true, revision: 1 };
      });
    },
    transact<T>(expectedRevision: number, fn: (draft: RoadmapData) => T) {
      return withLock(lockKey, async () => {
        // Cheap pre-check: a valid manifest at another revision conflicts without loading the snapshot.
        const head = Manifest.safeParse(await readRawManifest().catch(() => undefined));
        if (head.success) {
          checkProject(head.data);
          if (head.data.revision !== expectedRevision) {
            throw new DomainError("revision_conflict", "store revision changed", {
              expected: expectedRevision,
              actual: head.data.revision,
            });
          }
        }
        const current = await read();
        if (current.status === "missing") throw new DomainError("store_missing", "roadmap store does not exist");
        if (current.status === "invalid") {
          throw new DomainError("store_invalid", current.error.message, current.error);
        }
        if (current.revision !== expectedRevision) {
          throw new DomainError("revision_conflict", "store revision changed", {
            expected: expectedRevision,
            actual: current.revision,
          });
        }
        const draft = deepClone(current.data);
        // Every write stores the derived numbers of questions written before numbering (order + 1)
        // before the caller's change, so its guards and the number check below see them.
        for (const s of draft.sessions) backfillNumbers(s);
        const result = fn(draft);
        const data = validateDraft(draft);
        // No write may delete a session or question or change a question's number.
        assertNumbersStable(current.data, data);
        const revision = current.revision + 1;
        await commit(data, revision, current.disabled);
        return { result, revision };
      });
    },
  };
}
