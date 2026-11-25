// Derived Markdown export of a plan's latest revision at <storeRoot>/.decisions/plans/<planId>.md.
// Never parsed back and never authoritative; failures leave the store commit intact.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { PlanRevision } from "../shared/model";
import { nodeStoreFs, type StoreFs } from "./fs-port";
import type { Store } from "./store";
import { errnoCode } from "../shared/errors";

export const exportHeader = (planId: string, rev: number, hash: string) =>
  `<!-- decision-roadmap plan ${planId} rev ${rev} sha256:${hash} generated; do not edit -->`;

export const renderExport = (planId: string, latest: PlanRevision) =>
  `${exportHeader(planId, latest.rev, latest.contentHash)}\n\n${latest.markdown}\n`;

export interface ExportDeps {
  fs?: StoreFs;
  /** Test hook only; runs just before the file is replaced. */
  beforeWrite?: () => Promise<void>;
  log?: (m: string) => void;
}

const MAX_ROUNDS = 3;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const isEnoent = (e: unknown) => errnoCode(e) === "ENOENT";

/** One promise chain per (storeRoot, planId). */
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

/**
 * Brings the export file in line with the plan's current latest revision (ruling 3). It renders
 * whatever is latest while holding the lock, compares the complete bytes, writes only on a
 * difference, and repeats (at most 3 rounds) when the store moved meanwhile. Returns true when the
 * file matches the latest revision it saw.
 */
export function syncExport(store: Store, planId: string, deps: ExportDeps = {}): Promise<boolean> {
  const fs = deps.fs ?? nodeStoreFs;
  const log = deps.log ?? (() => undefined);
  if (!ID_RE.test(planId)) return Promise.resolve(false);
  const dir = join(store.storeRoot, ".decisions", "plans");
  const file = join(dir, `${planId}.md`);

  return withLock(`${store.storeRoot}\n${planId}`, async () => {
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const read = await store.read();
        if (read.status !== "ok") return false;
        const latest = read.data.plans.find((p) => p.id === planId)?.revisions.at(-1);
        if (!latest) return false;
        const expected = renderExport(planId, latest);

        const dirStat = await fs.lstat(dir);
        if (dirStat && (dirStat.isSymbolicLink() || !dirStat.isDirectory())) {
          log("plan export refused: plans directory is not a real directory");
          return false;
        }
        const fileStat = await fs.lstat(file);
        if (fileStat && (fileStat.isSymbolicLink() || fileStat.isDirectory())) {
          log("plan export refused: export path is not a regular file");
          return false;
        }
        let current: string | null = null;
        if (fileStat) {
          try {
            current = await fs.readFile(file);
          } catch (e) {
            if (!isEnoent(e)) throw e;
          }
        }
        if (current !== expected) {
          await deps.beforeWrite?.();
          await fs.mkdir(dir);
          const tmp = join(dir, `.${planId}.md.tmp-${randomBytes(6).toString("hex")}`);
          try {
            await fs.writeFileDurable(tmp, expected);
            await fs.rename(tmp, file);
          } catch (e) {
            await fs.rm(tmp).catch(() => undefined);
            throw e;
          }
        }
        const after = await store.version();
        if (after.status === "ok" && after.revision === read.revision) return true;
      }
      return false;
    } catch (e) {
      log(`plan export failed: ${e instanceof Error ? e.name : "error"}`);
      return false;
    }
  });
}
