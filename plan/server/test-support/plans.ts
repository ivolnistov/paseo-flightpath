// Stage 3 test support: receipt builders and fs wrappers, and makePlanProject (plan commands and
// the UI plan service over a real temp project store and a temp plugin-data stateDir).
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalReceipt, Ref } from "../../shared/model";
import type { ApprovalFs } from "../approval-fs";
import { createApprovalStore } from "../approvals";
import type { StoreFs } from "../fs-port";
import type { StoreOpener } from "../sessions";
import { openProjectStore } from "../store-root";
import { fakeDirectory } from "./fake-dir";
import { makeProject } from "./service";
import { fixedClock, nextId, NOW_ISO, opt } from "./build";

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);

export const receipt = (partial: Partial<ApprovalReceipt> = {}): ApprovalReceipt => ({
  receiptId: "rcpt-1",
  projectId: "prj_test",
  planId: "plan-1",
  planRev: 1,
  contentHash: HASH_A,
  decisionSnapshotHash: HASH_B,
  at: NOW_ISO,
  actor: { kind: "human" },
  ...partial,
});

/** Temp plugin-data directory (`stateDir`) inside its own temp parent, plus a log sink. */
export async function makeApprovalEnv() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "dr-approvals-")));
  const stateDir = join(parent, "state");
  const logs: string[] = [];
  return {
    stateDir,
    logs,
    log: (m: string) => void logs.push(m),
    receiptPath: (r: Pick<ApprovalReceipt, "projectId" | "planId" | "planRev">) =>
      join(stateDir, "approvals", r.projectId, r.planId, `${r.planRev}.json`),
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

/** Delegating ApprovalFs that records every call; `override` replaces individual methods. */
export function wrapApprovalFs(base: ApprovalFs, override: Partial<ApprovalFs> = {}) {
  const calls: Array<{ op: keyof ApprovalFs; path: string }> = [];
  const record = (op: keyof ApprovalFs, path: string) => void calls.push({ op, path });
  const fs: ApprovalFs = {
    ensureDir: (path) => (record("ensureDir", path), override.ensureDir ? override.ensureDir(path) : base.ensureDir(path)),
    publishNoClobber: (path, data) => (record("publishNoClobber", path), override.publishNoClobber ? override.publishNoClobber(path, data) : base.publishNoClobber(path, data)),
    readFile: (path) => (record("readFile", path), override.readFile ? override.readFile(path) : base.readFile(path)),
    removeStaleTemps: (dir, olderThanMs) => (record("removeStaleTemps", dir), override.removeStaleTemps ? override.removeStaleTemps(dir, olderThanMs) : base.removeStaleTemps(dir, olderThanMs)),
    mode: (path) => (record("mode", path), override.mode ? override.mode(path) : base.mode(path)),
  };
  return { fs, calls };
}

/** A temp project with an initialised store, plan commands and the UI plan service. */
export async function makePlanProject(opts: { storeFs?: StoreFs } = {}) {
  // Loaded lazily so receipt tests importing this file do not depend on the plan commands module.
  const { createPlanCommands, createPlanService } = await import("../plans");
  const project = await makeProject();
  const env = await makeApprovalEnv();
  const P = project.projectId;
  if (!(await project.service.init(project.paseo, { projectId: P })).ok) throw new Error("init failed");
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  const storeOptions = { now: fixedClock, newId: nextId, log: env.log, ...(opts.storeFs ? { fs: opts.storeFs } : {}) };
  const deps = { directory: () => dir, now: fixedClock, newId: nextId, storeOptions };
  const approvals = createApprovalStore({ stateDir: env.stateDir, log: env.log });
  const makeCommands = () => createPlanCommands({ ...deps, approvals: createApprovalStore({ stateDir: env.stateDir, log: env.log }) });
  const plans = createPlanCommands({ ...deps, approvals });
  const ui = createPlanService({ ...deps, approvals });
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  const revision = async () => (await (await open(P)).version()).revision!;

  async function seedAnswered(): Promise<{ sessionId: string; q1: Ref; q2: Ref; revision: number }> {
    const { service, paseo } = project;
    const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      return r.value;
    };
    const sessionId = unwrap(await service.sessionCreate(paseo, { projectId: P, expectedRevision: await revision(), title: "Plan basis" })).sessionId;
    const create = async (title: string, options: string[]) =>
      unwrap(
        await service.questionCreate(paseo, {
          projectId: P, expectedRevision: await revision(), sessionId, title, context: "",
          options: options.map(opt), allowFreeText: false, activatedBy: [], invalidatedBy: [],
        }),
      ).questionId;
    const q1 = await create("Q1", ["a", "b"]);
    const q2 = await create("Q2", ["c", "d"]);
    unwrap(await service.questionAnswer(paseo, { projectId: P, expectedRevision: await revision(), sessionId, questionId: q1, optionId: "a" }));
    unwrap(await service.questionAnswer(paseo, { projectId: P, expectedRevision: await revision(), sessionId, questionId: q2, optionId: "c" }));
    return { sessionId, q1: { sessionId, questionId: q1 }, q2: { sessionId, questionId: q2 }, revision: await revision() };
  }

  return {
    project, P, stateDir: env.stateDir, logs: env.logs, env, approvals, plans, ui, open, revision, makeCommands, seedAnswered,
    async cleanup() {
      await project.cleanup();
      await env.cleanup();
    },
  };
}
export type PlanProject = Awaited<ReturnType<typeof makePlanProject>>;
