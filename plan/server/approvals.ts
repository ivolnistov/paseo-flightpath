// Approval receipts in plugin-data: <stateDir>/approvals/<projectId>/<planId>/<rev>.json.
// Receipts are written once and never replaced; logs carry fingerprints, never hashes or notes.
import { join } from "node:path";
import { DomainError } from "../shared/errors";
import { ApprovalReceipt } from "../shared/model";
import { nodeApprovalFs, type ApprovalFs } from "./approval-fs";
import { sha256Hex } from "./hash";
import { defaultStateDir } from "./mcp-state";

export interface ApprovalStore {
  write(r: ApprovalReceipt): Promise<{ created: boolean; receipt: ApprovalReceipt }>;
  read(projectId: string, planId: string, rev: number): Promise<ApprovalReceipt | null>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const STALE_TEMP_MS = 60_000;

function checkIds(projectId: string, planId: string, rev: number): void {
  if (typeof projectId !== "string" || !ID_RE.test(projectId) || typeof planId !== "string" || !ID_RE.test(planId)) {
    throw new DomainError("unsafe_root", "unsafe approval path");
  }
  if (!Number.isSafeInteger(rev) || rev < 1) throw new DomainError("unsafe_root", "unsafe approval path");
}

export function createApprovalStore(opts: { stateDir?: string; log: (m: string) => void; fs?: ApprovalFs }): ApprovalStore {
  const fs = opts.fs ?? nodeApprovalFs;
  const { log } = opts;
  const stateDir = () => opts.stateDir ?? defaultStateDir();
  const paths = (projectId: string, planId: string, rev: number) => {
    const approvals = join(stateDir(), "approvals");
    const projectDir = join(approvals, projectId);
    const planDir = join(projectDir, planId);
    return { levels: [stateDir(), approvals, projectDir, planDir], planDir, file: join(planDir, `${rev}.json`) };
  };

  async function read(projectId: string, planId: string, rev: number): Promise<ApprovalReceipt | null> {
    checkIds(projectId, planId, rev);
    const { file } = paths(projectId, planId, rev);
    const text = await fs.readFile(file);
    if (text === null) return null;
    const fp = sha256Hex(`${projectId}/${planId}/${rev}`).slice(0, 8);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      log(`receipt invalid fp=${fp}`);
      return null;
    }
    const parsed = ApprovalReceipt.safeParse(raw);
    if (!parsed.success || parsed.data.projectId !== projectId || parsed.data.planId !== planId || parsed.data.planRev !== rev) {
      log(`receipt invalid fp=${fp}`);
      return null;
    }
    return parsed.data;
  }

  return {
    read,
    async write(r) {
      checkIds(r.projectId, r.planId, r.planRev);
      const receipt = ApprovalReceipt.parse(r);
      const { levels, planDir, file } = paths(receipt.projectId, receipt.planId, receipt.planRev);
      for (const dir of levels) await fs.ensureDir(dir);
      await fs.removeStaleTemps(planDir, STALE_TEMP_MS);
      const outcome = await fs.publishNoClobber(file, JSON.stringify(receipt));
      if (outcome === "created") return { created: true, receipt };
      const stored = await read(receipt.projectId, receipt.planId, receipt.planRev);
      if (!stored) throw new DomainError("store_invalid", "an existing approval receipt could not be read");
      return { created: false, receipt: stored };
    },
  };
}
