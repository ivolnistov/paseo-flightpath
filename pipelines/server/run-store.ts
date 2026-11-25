import { join } from "node:path";
import { canonicalJson } from "../shared/canonical";
import { PipelineError } from "../shared/errors";
import { PROJECT_ID_PATTERN } from "../shared/rpc";
import { RUN_ID_PATTERN, RunEventSchema, RunSnapshotBodySchema, RunSnapshotSchema, type RunEvent, type RunSnapshot, type RunSnapshotBody } from "../shared/run";
import type { PipelineFs } from "./fs-port";
import { sha256Hex } from "./hash";
import { createKeyedLock } from "./keyed-lock";

export type JournalHealth = "ok" | "journal_corrupt";

export type LoadedRun = { snapshot: RunSnapshot; events: RunEvent[]; health: JournalHealth };

export type RunSummary = { projectId: string; runId: string; startKey: string; createdAt: string };

export interface RunStore {
  /** Writes `snapshot.json` once with its `snapshotHash`; refuses with `run_exists` when it is present. */
  create(snapshot: RunSnapshotBody): Promise<RunSnapshot>;
  /** Scans the project's snapshots on disk for the start key. */
  findByStartKey(projectId: string, startKey: string): Promise<RunSnapshot | null>;
  /** Appends one synced record whose `seq` follows the last one. */
  append(runId: string, event: RunEvent): Promise<void>;
  load(runId: string): Promise<LoadedRun>;
  list(projectId: string): Promise<RunSummary[]>;
  /** Runs with neither `run.finished` nor `run.cancelled`, corrupt journals included. */
  listLive(): Promise<Array<RunSummary & { health: JournalHealth }>>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function snapshotHashOf(body: RunSnapshotBody): string {
  return sha256Hex(canonicalJson(body));
}

type Parsed = {
  events: RunEvent[];
  health: JournalHealth;
  /** Byte length of the complete, valid prefix; shorter than the file when the last record is torn. */
  validLength: number;
  torn: boolean;
};

/**
 * A torn last record (no final newline, or a last line that does not parse) is ignored and later
 * truncated. A bad record or a `seq` gap before the last record makes the journal corrupt.
 */
export function parseJournal(bytes: Uint8Array): Parsed {
  const events: RunEvent[] = [];
  let offset = 0;
  let index = 0;
  const lines: Array<{ start: number; end: number; complete: boolean }> = [];
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) {
      lines.push({ start: offset, end: bytes.length, complete: false });
      break;
    }
    lines.push({ start: offset, end: newline, complete: true });
    offset = newline + 1;
  }
  let validLength = 0;
  for (const line of lines) {
    const last = index === lines.length - 1;
    index += 1;
    const event = line.complete ? parseRecord(bytes.subarray(line.start, line.end)) : null;
    const expectedSeq = events.length + 1;
    if (event === null || event.seq !== expectedSeq) {
      if (last && (event === null || !line.complete)) return { events, health: "ok", validLength, torn: true };
      return { events, health: "journal_corrupt", validLength, torn: false };
    }
    events.push(event);
    validLength = line.end + 1;
  }
  return { events, health: "ok", validLength, torn: false };
}

function parseRecord(bytes: Uint8Array): RunEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  const parsed = RunEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function createRunStore(opts: { stateDir: string; fs: PipelineFs }): RunStore {
  const { fs } = opts;
  const runsDir = join(opts.stateDir, "runs");
  const lock = createKeyedLock();
  const projectOf = new Map<string, string>();
  const journals = new Map<string, { lastSeq: number } | "corrupt">();

  const checkProject = (projectId: string): void => {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new PipelineError("unsafe_path", "Invalid project id.");
  };
  const checkRun = (runId: string): void => {
    if (!RUN_ID_PATTERN.test(runId)) throw new PipelineError("unsafe_path", "Invalid run id.");
  };
  const runDir = (projectId: string, runId: string): string => join(runsDir, projectId, runId);

  async function readSnapshot(projectId: string, runId: string): Promise<RunSnapshot | null> {
    const bytes = await fs.readFile(join(runDir(projectId, runId), "snapshot.json"));
    if (bytes === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(bytes));
    } catch (error) {
      throw new PipelineError("snapshot_corrupt", `Snapshot of ${runId} does not parse.`, { cause: error });
    }
    const parsed = RunSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new PipelineError("snapshot_corrupt", `Snapshot of ${runId} is invalid.`);
    const { snapshotHash, ...body } = parsed.data;
    if (snapshotHashOf(body) !== snapshotHash || body.runId !== runId || body.projectId !== projectId) {
      throw new PipelineError("snapshot_corrupt", `Snapshot of ${runId} does not match its hash.`);
    }
    return parsed.data;
  }

  async function locate(runId: string): Promise<string> {
    checkRun(runId);
    const known = projectOf.get(runId);
    if (known !== undefined) return known;
    const owners: string[] = [];
    for (const projectId of await fs.listDir(runsDir)) {
      if (!PROJECT_ID_PATTERN.test(projectId)) continue;
      if ((await fs.readFile(join(runDir(projectId, runId), "snapshot.json"))) !== null) owners.push(projectId);
    }
    const [owner] = owners;
    if (owner === undefined || owners.length > 1) throw new PipelineError("run_not_found", `Run ${runId} was not found.`);
    projectOf.set(runId, owner);
    return owner;
  }

  async function runIds(projectId: string): Promise<string[]> {
    return (await fs.listDir(join(runsDir, projectId))).filter((name) => RUN_ID_PATTERN.test(name));
  }

  async function summaries(projectId: string): Promise<RunSnapshot[]> {
    const out: RunSnapshot[] = [];
    for (const runId of await runIds(projectId)) {
      const snapshot = await readSnapshot(projectId, runId);
      if (snapshot) out.push(snapshot);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.runId < b.runId ? -1 : 1));
  }

  const summary = (snapshot: RunSnapshot): RunSummary => ({ projectId: snapshot.projectId, runId: snapshot.runId, startKey: snapshot.startKey, createdAt: snapshot.createdAt });

  return {
    async create(input) {
      const body = RunSnapshotBodySchema.parse(input);
      checkProject(body.projectId);
      checkRun(body.runId);
      const snapshot: RunSnapshot = { ...body, snapshotHash: snapshotHashOf(body) };
      const dir = runDir(body.projectId, body.runId);
      await fs.ensureDir(dir);
      const published = await fs.publishNoClobber(join(dir, "snapshot.json"), encoder.encode(canonicalJson(snapshot)));
      if (!published) throw new PipelineError("run_exists", `Run ${body.runId} already exists.`);
      projectOf.set(body.runId, body.projectId);
      return snapshot;
    },

    async findByStartKey(projectId, startKey) {
      checkProject(projectId);
      for (const snapshot of await summaries(projectId)) {
        if (snapshot.startKey === startKey) {
          projectOf.set(snapshot.runId, projectId);
          return snapshot;
        }
      }
      return null;
    },

    async append(runId, event) {
      const projectId = await locate(runId);
      const record = RunEventSchema.parse(event);
      const line = JSON.stringify(record);
      await lock.run(runId, async () => {
        const path = join(runDir(projectId, runId), "journal.jsonl");
        let journal = journals.get(runId);
        if (journal === undefined) {
          const bytes = (await fs.readFile(path)) ?? new Uint8Array();
          const parsed = parseJournal(bytes);
          if (parsed.health === "journal_corrupt") {
            journal = "corrupt";
          } else {
            if (parsed.torn) await fs.truncate(path, parsed.validLength);
            journal = { lastSeq: parsed.events.length };
          }
          journals.set(runId, journal);
        }
        if (journal === "corrupt") throw new PipelineError("journal_corrupt", `The journal of ${runId} is corrupt.`);
        if (record.seq !== journal.lastSeq + 1) throw new PipelineError("seq_conflict", `Expected seq ${journal.lastSeq + 1}, got ${record.seq}.`);
        await fs.appendLine(path, line);
        journal.lastSeq = record.seq;
      });
    },

    async load(runId) {
      const projectId = await locate(runId);
      const snapshot = await readSnapshot(projectId, runId);
      if (!snapshot) throw new PipelineError("run_not_found", `Run ${runId} was not found.`);
      const bytes = (await fs.readFile(join(runDir(projectId, runId), "journal.jsonl"))) ?? new Uint8Array();
      const parsed = parseJournal(bytes);
      return { snapshot, events: parsed.events, health: parsed.health };
    },

    async list(projectId) {
      checkProject(projectId);
      return (await summaries(projectId)).map(summary);
    },

    async listLive() {
      const out: Array<RunSummary & { health: JournalHealth }> = [];
      for (const projectId of await fs.listDir(runsDir)) {
        if (!PROJECT_ID_PATTERN.test(projectId)) continue;
        for (const snapshot of await summaries(projectId)) {
          const bytes = (await fs.readFile(join(runDir(projectId, snapshot.runId), "journal.jsonl"))) ?? new Uint8Array();
          const parsed = parseJournal(bytes);
          if (parsed.events.some((event) => event.kind === "run.finished" || event.kind === "run.cancelled")) continue;
          out.push({ ...summary(snapshot), health: parsed.health });
        }
      }
      return out;
    },
  };
}
