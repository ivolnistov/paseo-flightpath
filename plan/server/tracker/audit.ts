// Durable resolution audit outside the project (O2): one no-clobber 0600 file per intent under
// <stateDir>/tracker-audit/<projectId>/<planId>/<intentId>.json, directories 0700. No URL or payload.
import { join } from "node:path";
import { nodeApprovalFs, type ApprovalFs } from "../approval-fs";
import { sha256Hex } from "../hash";
import { defaultStateDir } from "../mcp-state";

export type AuditEntry = {
  projectId: string;
  planId: string;
  intentId: string;
  planRev: number;
  resolution: "link" | "not_created" | "close_not_applied";
  remoteKey?: string;
  at: string;
};

export interface AuditStore {
  /** True only when this call durably published the record; never throws. */
  record(entry: AuditEntry): Promise<boolean>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function createAuditStore(opts: { stateDir?: string; log: (m: string) => void; fs?: ApprovalFs }): AuditStore {
  const fs = opts.fs ?? nodeApprovalFs;
  return {
    async record(entry) {
      const fp = sha256Hex(entry.intentId).slice(0, 8);
      try {
        if (![entry.projectId, entry.planId, entry.intentId].every((id) => ID_RE.test(id))) throw new Error("unsafe id");
        const stateDir = opts.stateDir ?? defaultStateDir();
        const audits = join(stateDir, "tracker-audit");
        const projectDir = join(audits, entry.projectId);
        const planDir = join(projectDir, entry.planId);
        for (const dir of [stateDir, audits, projectDir, planDir]) await fs.ensureDir(dir);
        const record = {
          intentId: entry.intentId,
          planRev: entry.planRev,
          resolution: entry.resolution,
          ...(entry.remoteKey !== undefined ? { remoteKey: entry.remoteKey } : {}),
          at: entry.at,
          actor: { kind: "human" as const },
        };
        const outcome = await fs.publishNoClobber(join(planDir, `${entry.intentId}.json`), JSON.stringify(record));
        if (outcome !== "created") opts.log(`tracker audit already present fp=${fp}`);
        return outcome === "created";
      } catch (e) {
        opts.log(`tracker audit not recorded fp=${fp}: ${e instanceof Error ? e.name : "error"}`);
        return false;
      }
    },
  };
}
