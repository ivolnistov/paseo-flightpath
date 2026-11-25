import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { z, ZodType } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ViewResultSchema, workflowDraftEdit, workflowDraftSetText, workflowGet, workflowSave, type RpcError, type ViewResult } from "../shared/rpc";
import { createNodeFs, type FsHook, type PipelineFs } from "./fs-port";
import { registerWorkflowHandlers, type RpcRegistrar } from "./handlers";
import { createWorkflowStore, MAX_PROPOSALS, WorkflowConflictError, type WorkflowStore } from "./workflow-store";

const PROJECT = "prj_1";
const A = `# saved workflow
jobs:
  build:
    uses: checks
    with: { run: [npm test] }
`;
const B = `${A}  lint:
    needs: [build]
    uses: checks
    with: { run: [npm run lint] }
`;
const C = `${B}  accept: { needs: [lint], uses: approval }
`;
const INVALID = `jobs:
  build:
    uses: nope
`;
const ABSENT = "absent";

let root: string;
let dir: string;
let ids: number;

function digest(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function makeStore(fs: PipelineFs = createNodeFs(), logs: string[] = []): WorkflowStore {
  return createWorkflowStore({
    stateDir: () => root,
    fs,
    log: (message) => logs.push(message),
    now: () => new Date(Date.UTC(2026, 10, 21, 12, 0, 0)),
    newProposalId: () => `prp_${String(++ids).padStart(4, "0")}`,
  });
}

const saved = (): Promise<string> => readFile(join(dir, "workflow.yaml"), "utf8");
const draftFile = (): Promise<string | null> => readFile(join(dir, "workflow.draft.yaml"), "utf8").catch(() => null);
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

async function conflict(promise: Promise<unknown>): Promise<WorkflowConflictError> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WorkflowConflictError);
  if (!(error instanceof WorkflowConflictError)) throw new Error("expected a conflict");
  return error;
}

/** Wraps a file system so the first matching call waits until `release()`. */
function pausing(base: PipelineFs, match: (op: "replaceFile" | "remove", path: string) => boolean) {
  let armed = true;
  let reached = (): void => undefined;
  let release = (): void => undefined;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold = async (op: "replaceFile" | "remove", path: string): Promise<void> => {
    if (armed && match(op, path)) {
      armed = false;
      reached();
      await gate;
    }
  };
  const fs: PipelineFs = {
    ...base,
    async replaceFile(path, bytes) {
      await hold("replaceFile", path);
      return base.replaceFile(path, bytes);
    },
    async remove(path) {
      await hold("remove", path);
      return base.remove(path);
    },
  };
  return { fs, paused, release: () => release() };
}

async function ticks(count = 20): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  return { promise: tracked, settled: () => done };
}

async function seedSaved(store: WorkflowStore, text: string): Promise<void> {
  const view = await store.get(PROJECT);
  const drafted = await store.setDraftText(PROJECT, { editableDigest: view.editableDigest, yaml: text });
  await store.save(PROJECT, { savedDigest: drafted.saved?.digest ?? ABSENT, draftDigest: drafted.draft?.digest ?? ABSENT });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pipeline-store-"));
  dir = join(root, "projects", PROJECT);
  ids = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("reading", () => {
  it("shows an empty project with absent digests and writes nothing", async () => {
    const view = await makeStore().get(PROJECT);
    expect(view).toEqual({ saved: null, draft: null, editableDigest: ABSENT, diagnostics: [], model: null, graph: null, savedPlan: null, proposals: [] });
    expect(await readdir(root)).toEqual([]);
  });

  it("reports the draft as editable with its diagnostics and model", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const view = await store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: INVALID });
    expect(view.saved).toEqual({ yaml: A, digest: digest(A) });
    expect(view.draft).toEqual({ yaml: INVALID, digest: digest(INVALID) });
    expect(view.editableDigest).toBe(digest(INVALID));
    expect(view.diagnostics.map((d) => d.code)).toEqual(["uses_unknown"]);
    expect(view.model?.jobs.map((j) => j.id)).toEqual(["build"]);
    expect(view.graph).toBeNull();
    expect(view.savedPlan?.model.jobs.map((j) => j.id)).toEqual(["build"]);
    expect(view.savedPlan?.graph.jobs.map((j) => [j.id, j.uses])).toEqual([["build", "checks"]]);
  });

  it("gives a valid draft its own graph and keeps the saved plan beside it", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const view = await store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    expect(view.graph?.jobs.map((j) => j.id)).toEqual(["build", "lint"]);
    expect(view.graph?.edges).toEqual([{ from: "build", to: "lint" }]);
    expect(view.savedPlan?.graph.jobs.map((j) => j.id)).toEqual(["build"]);
  });

  it("omits the saved plan when there is no draft or the saved text is invalid", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const clean = await store.get(PROJECT);
    expect(clean.graph?.jobs.map((j) => j.id)).toEqual(["build"]);
    expect(clean.savedPlan).toBeNull();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workflow.yaml"), INVALID);
    await writeFile(join(dir, "workflow.draft.yaml"), B);
    const view = await store.get(PROJECT);
    expect(view.graph?.jobs.map((j) => j.id)).toEqual(["build", "lint"]);
    expect(view.savedPlan).toBeNull();
  });

  it("keeps a saved plan whose tasks come only from Start beside an invalid draft", async () => {
    const tasksOnly = 'inputs: { tasks: { type: tasks } }\njobs:\n  implement: { uses: run-tasks, with: { tasks: "${{ inputs.tasks }}" } }\n';
    const store = makeStore();
    await seedSaved(store, tasksOnly);
    const clean = await store.get(PROJECT);
    expect(clean.diagnostics).toEqual([]);
    expect(clean.graph?.jobs.map((j) => j.id)).toEqual(["implement.main"]);
    const view = await store.setDraftText(PROJECT, { editableDigest: digest(tasksOnly), yaml: INVALID });
    expect(view.savedPlan?.model.inputs.tasks?.type).toBe("tasks");
    expect(view.savedPlan?.graph.jobs.map((j) => j.id)).toEqual(["implement.main"]);
  });

  it("returns a null model for unparseable text", async () => {
    const view = await makeStore().setDraftText(PROJECT, { editableDigest: ABSENT, yaml: "jobs: [" });
    expect(view.model).toBeNull();
    expect(view.diagnostics.map((d) => d.code)).toEqual(["yaml_syntax"]);
  });

  it("rejects a project id that could leave the data directory", async () => {
    await expect(makeStore().get("../escape")).rejects.toMatchObject({ code: "unsafe_path" });
  });
});

describe("draft mutations", () => {
  it("writes the draft only when the editable digest matches", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const error = await conflict(store.setDraftText(PROJECT, { editableDigest: digest(B), yaml: C }));
    expect(error.current).toEqual({ savedDigest: digest(A), draftDigest: ABSENT, editableDigest: digest(A) });
    expect(await draftFile()).toBeNull();

    await store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    expect(await draftFile()).toBe(B);
    await conflict(store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: C }));
    expect(await draftFile()).toBe(B);
  });

  it("keeps no draft when the text equals the saved text", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    await store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    const view = await store.setDraftText(PROJECT, { editableDigest: digest(B), yaml: A });
    expect(view.draft).toBeNull();
    expect(view.editableDigest).toBe(digest(A));
    expect(await draftFile()).toBeNull();
  });

  it("applies a structured edit to the editable text and keeps its comment", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const view = await store.editDraft(PROJECT, {
      editableDigest: digest(A),
      op: { kind: "job.add", id: "lint", fields: { needs: ["build"], uses: "checks", with: { run: ["npm run lint"] } } },
    });
    const text = await draftFile();
    expect(text?.startsWith(A)).toBe(true);
    expect(text).toContain("# saved workflow");
    expect(view.model?.jobs.map((j) => [j.id, j.needs])).toEqual([
      ["build", []],
      ["lint", ["build"]],
    ]);
    expect(await saved()).toBe(A);
  });

  it("refuses an edit whose digest is stale and leaves the files", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    await store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    await conflict(store.editDraft(PROJECT, { editableDigest: digest(A), op: { kind: "job.remove", id: "build" } }));
    expect(await draftFile()).toBe(B);
  });

  it("surfaces editor refusals without writing", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    await expect(store.editDraft(PROJECT, { editableDigest: digest(A), op: { kind: "job.remove", id: "missing" } })).rejects.toMatchObject({
      code: "job_not_found",
    });
    expect(await draftFile()).toBeNull();
  });

  it("discards the draft under a matching digest only", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    await store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    await conflict(store.discardDraft(PROJECT, { editableDigest: digest(A) }));
    expect(await draftFile()).toBe(B);
    const view = await store.discardDraft(PROJECT, { editableDigest: digest(B) });
    expect(view.draft).toBeNull();
    expect(view.editableDigest).toBe(digest(A));
    expect(await draftFile()).toBeNull();
    expect(await saved()).toBe(A);
  });
});

describe("save", () => {
  it("publishes the draft and removes it", async () => {
    const store = makeStore();
    await store.setDraftText(PROJECT, { editableDigest: ABSENT, yaml: A });
    const view = await store.save(PROJECT, { savedDigest: ABSENT, draftDigest: digest(A) });
    expect(view.saved).toEqual({ yaml: A, digest: digest(A) });
    expect(view.draft).toBeNull();
    expect(await saved()).toBe(A);
    expect(await draftFile()).toBeNull();
  });

  it("lets only the first of two saves from one digest through", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    await store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    const read = { savedDigest: digest(A), draftDigest: digest(B) };
    const [first, second] = await Promise.allSettled([store.save(PROJECT, read), store.save(PROJECT, read)]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toBeInstanceOf(WorkflowConflictError);
      expect(second.reason).toMatchObject({ current: { savedDigest: digest(B), draftDigest: ABSENT, editableDigest: digest(B) } });
    }
    expect(await saved()).toBe(B);
  });

  it("refuses a stale draft digest", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    await store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    await store.setDraftText(PROJECT, { editableDigest: digest(B), yaml: C });
    await conflict(store.save(PROJECT, { savedDigest: digest(A), draftDigest: digest(B) }));
    expect(await saved()).toBe(A);
    expect(await draftFile()).toBe(C);
  });

  it("refuses an invalid draft and leaves workflow.yaml byte-identical", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const before = await readFile(join(dir, "workflow.yaml"));
    await store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: INVALID });
    await expect(store.save(PROJECT, { savedDigest: digest(A), draftDigest: digest(INVALID) })).rejects.toMatchObject({
      code: "workflow_invalid",
      diagnostics: [expect.objectContaining({ code: "uses_unknown" })],
    });
    expect(Buffer.compare(await readFile(join(dir, "workflow.yaml")), before)).toBe(0);
    expect(await draftFile()).toBe(INVALID);
  });

  it("keeps exactly one workflow file after three saves", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    await seedSaved(store, B);
    await seedSaved(store, C);
    expect(await readdir(dir)).toEqual(["workflow.yaml"]);
    expect(await saved()).toBe(C);
  });

  it("leaves the old text and the draft when the crash comes before the rename", async () => {
    await seedSaved(makeStore(), A);
    await makeStore().setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    const hook: FsHook = (step, path) => {
      if (step === "replace.synced" && path.endsWith("workflow.yaml")) throw new Error("crash");
    };
    await expect(makeStore(createNodeFs({ hook })).save(PROJECT, { savedDigest: digest(A), draftDigest: digest(B) })).rejects.toThrow("crash");
    const view = await makeStore().get(PROJECT);
    expect(view.saved?.yaml).toBe(A);
    expect(view.draft?.yaml).toBe(B);
  });

  it("reads as saved with no draft when the crash comes between the rename and the draft removal", async () => {
    await seedSaved(makeStore(), A);
    await makeStore().setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    const hook: FsHook = (step, path) => {
      if (step === "replace.renamed" && path.endsWith("workflow.yaml")) throw new Error("crash");
    };
    await expect(makeStore(createNodeFs({ hook })).save(PROJECT, { savedDigest: digest(A), draftDigest: digest(B) })).rejects.toThrow("crash");
    expect(await draftFile()).toBe(B);
    const view = await makeStore().get(PROJECT);
    expect(view.saved?.yaml).toBe(B);
    expect(view.draft).toBeNull();
    expect(view.editableDigest).toBe(digest(B));
    expect(await readdir(dir)).toEqual(["workflow.yaml"]);
  });

  it("sweeps temp files a crash left behind", async () => {
    await seedSaved(makeStore(), A);
    await writeFile(join(dir, ".workflow.yaml.0123456789ab.tmp"), "half");
    await mkdir(join(dir, "proposals"), { recursive: true });
    await writeFile(join(dir, "proposals", ".prp_9.json.0123456789ab.tmp"), "{");
    await makeStore().get(PROJECT);
    expect(await readdir(dir)).toEqual(["proposals", "workflow.yaml"]);
    expect(await readdir(join(dir, "proposals"))).toEqual([]);
  });

  it("uses modes 0700 for directories and 0600 for files", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    await store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    await store.addProposal(PROJECT, { baseToken: digest(B), yaml: C, summary: "Add approval", agentId: "agent-1" });
    for (const path of [root, join(root, "projects"), dir, join(dir, "proposals")]) expect(await mode(path)).toBe(0o700);
    for (const path of [join(dir, "workflow.yaml"), join(dir, "workflow.draft.yaml"), join(dir, "proposals", "prp_0001.json")]) {
      expect(await mode(path)).toBe(0o600);
    }
  });
});

describe("project lock", () => {
  it("makes an edit wait for a save paused before the draft removal, then applies it over the saved text", async () => {
    await seedSaved(makeStore(), A);
    await makeStore().setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    const pause = pausing(createNodeFs(), (op, path) => op === "remove" && path.endsWith("workflow.draft.yaml"));
    const store = makeStore(pause.fs);
    const save = store.save(PROJECT, { savedDigest: digest(A), draftDigest: digest(B) });
    await pause.paused;
    const edit = track(store.setDraftText(PROJECT, { editableDigest: digest(B), yaml: C }));
    await ticks();
    expect(edit.settled()).toBe(false);
    expect(await saved()).toBe(B);
    expect(await draftFile()).toBe(B);
    pause.release();
    await save;
    const view = await edit.promise;
    expect(view.saved).toEqual({ yaml: B, digest: digest(B) });
    expect(view.draft).toEqual({ yaml: C, digest: digest(C) });
    expect(await saved()).toBe(B);
    expect(await draftFile()).toBe(C);
  });

  it("refuses an edit that waited for a save when its digest no longer matches", async () => {
    await seedSaved(makeStore(), A);
    await makeStore().setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    const pause = pausing(createNodeFs(), (op, path) => op === "remove" && path.endsWith("workflow.draft.yaml"));
    const store = makeStore(pause.fs);
    const save = store.save(PROJECT, { savedDigest: digest(A), draftDigest: digest(B) });
    await pause.paused;
    const edit = track(store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: C }));
    await ticks();
    expect(edit.settled()).toBe(false);
    pause.release();
    await save;
    await conflict(edit.promise);
    expect(await saved()).toBe(B);
    expect(await draftFile()).toBeNull();
  });

  it("keeps a read from dropping a draft between an edit's digest check and its write", async () => {
    await seedSaved(makeStore(), A);
    await writeFile(join(dir, "workflow.draft.yaml"), A, { mode: 0o600 });
    const pause = pausing(createNodeFs(), (op, path) => op === "replaceFile" && path.endsWith("workflow.draft.yaml"));
    const store = makeStore(pause.fs);
    const edit = store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    await pause.paused;
    const read = track(store.get(PROJECT));
    await ticks();
    expect(read.settled()).toBe(false);
    pause.release();
    expect((await edit).draft?.yaml).toBe(B);
    const view = await read.promise;
    expect(view.draft).toEqual({ yaml: B, digest: digest(B) });
    expect(await draftFile()).toBe(B);
  });
});

describe("proposals", () => {
  it("keeps at most MAX_PROPOSALS, removing stale, applied or discarded ones first and never a pending one", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const propose = (baseToken: string) => store.addProposal(PROJECT, { baseToken, yaml: B, summary: "s", agentId: "agent-1" });
    const stale = await propose("0".repeat(64));
    const discarded = await propose(digest(A));
    await store.discardProposal(PROJECT, { proposalId: discarded.id });
    const pending: string[] = [];
    while (pending.length < MAX_PROPOSALS - 2) pending.push((await propose(digest(A))).id);
    pending.push((await propose(digest(A))).id);
    let ids = (await store.get(PROJECT)).proposals.map((proposal) => proposal.id);
    expect(ids).toHaveLength(MAX_PROPOSALS);
    expect(ids).not.toContain(stale.id);
    pending.push((await propose(digest(A))).id);
    ids = (await store.get(PROJECT)).proposals.map((proposal) => proposal.id);
    expect(ids).toEqual(pending);
    await expect(propose(digest(A))).rejects.toMatchObject({ code: "proposal_limit" });
    expect((await store.get(PROJECT)).proposals.map((proposal) => proposal.id)).toEqual(pending);
    await store.discardProposal(PROJECT, { proposalId: pending[0] ?? "" });
    const next = await propose(digest(A));
    ids = (await store.get(PROJECT)).proposals.map((proposal) => proposal.id);
    expect(ids).toEqual([...pending.slice(1), next.id]);
  });

  it("records a proposal without touching the draft or the saved workflow", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const proposal = await store.addProposal(PROJECT, { baseToken: digest(A), yaml: B, summary: "Add lint", agentId: "agent-1" });
    const model: unknown = expect.objectContaining({ jobs: [expect.objectContaining({ id: "build" }), expect.objectContaining({ id: "lint", needs: ["build"] })] });
    expect(proposal).toEqual({
      id: "prp_0001",
      baseToken: digest(A),
      yaml: B,
      summary: "Add lint",
      agentId: "agent-1",
      createdAt: "2026-11-21T12:00:00.000Z",
      status: "pending",
      diagnostics: [],
      model,
    });
    expect(await draftFile()).toBeNull();
    expect(await saved()).toBe(A);
    expect((await store.get(PROJECT)).proposals.map((p) => [p.id, p.status])).toEqual([["prp_0001", "pending"]]);
  });

  it("applies a validating current proposal into the draft and marks the others stale", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const chosen = await store.addProposal(PROJECT, { baseToken: digest(A), yaml: B, summary: "Add lint", agentId: "agent-1" });
    const sibling = await store.addProposal(PROJECT, { baseToken: digest(A), yaml: C, summary: "Add all", agentId: "agent-2" });
    const view = await store.applyProposal(PROJECT, { proposalId: chosen.id, editableDigest: digest(A) });
    expect(view.draft?.yaml).toBe(B);
    expect(await saved()).toBe(A);
    expect(view.proposals.map((p) => [p.id, p.status])).toEqual([
      [chosen.id, "applied"],
      [sibling.id, "stale"],
    ]);
    const stored: unknown = JSON.parse(await readFile(join(dir, "proposals", `${sibling.id}.json`), "utf8"));
    expect(stored).toMatchObject({ status: "stale" });
  });

  it("refuses a stale proposal and leaves the draft", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const proposal = await store.addProposal(PROJECT, { baseToken: digest(A), yaml: C, summary: "Add all", agentId: "agent-1" });
    await store.setDraftText(PROJECT, { editableDigest: digest(A), yaml: B });
    expect((await store.get(PROJECT)).proposals[0]?.status).toBe("stale");
    await expect(store.applyProposal(PROJECT, { proposalId: proposal.id, editableDigest: digest(B) })).rejects.toMatchObject({ code: "proposal_stale" });
    expect(await draftFile()).toBe(B);
    await store.setDraftText(PROJECT, { editableDigest: digest(B), yaml: A });
    await expect(store.applyProposal(PROJECT, { proposalId: proposal.id, editableDigest: digest(A) })).rejects.toMatchObject({ code: "proposal_stale" });
    expect(await draftFile()).toBeNull();
  });

  it("refuses an invalid proposal", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const proposal = await store.addProposal(PROJECT, { baseToken: digest(A), yaml: INVALID, summary: "Broken", agentId: "agent-1" });
    expect(proposal.diagnostics.map((d) => d.code)).toEqual(["uses_unknown"]);
    await expect(store.applyProposal(PROJECT, { proposalId: proposal.id, editableDigest: digest(A) })).rejects.toMatchObject({ code: "workflow_invalid" });
    expect(await draftFile()).toBeNull();
    expect((await store.get(PROJECT)).proposals[0]?.status).toBe("pending");
  });

  it("refuses an apply with a stale editable digest", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const proposal = await store.addProposal(PROJECT, { baseToken: digest(A), yaml: B, summary: "Add lint", agentId: "agent-1" });
    await conflict(store.applyProposal(PROJECT, { proposalId: proposal.id, editableDigest: digest(C) }));
    expect(await draftFile()).toBeNull();
  });

  it("discards a pending proposal and refuses to apply it afterwards", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const proposal = await store.addProposal(PROJECT, { baseToken: digest(A), yaml: B, summary: "Add lint", agentId: "agent-1" });
    const view = await store.discardProposal(PROJECT, { proposalId: proposal.id });
    expect(view.proposals[0]?.status).toBe("discarded");
    await expect(store.applyProposal(PROJECT, { proposalId: proposal.id, editableDigest: digest(A) })).rejects.toMatchObject({
      code: "proposal_not_pending",
    });
    await expect(store.discardProposal(PROJECT, { proposalId: "prp_9999" })).rejects.toMatchObject({ code: "proposal_not_found" });
  });

  it("settles as applied after a crash between the draft write and the applied record", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const proposal = await store.addProposal(PROJECT, { baseToken: digest(A), yaml: B, summary: "Add lint", agentId: "agent-1" });
    let proposalWrites = 0;
    const hook: FsHook = (step, path) => {
      if (step === "replace.synced" && path.endsWith(`${proposal.id}.json`) && ++proposalWrites === 2) throw new Error("crash");
    };
    await expect(makeStore(createNodeFs({ hook })).applyProposal(PROJECT, { proposalId: proposal.id, editableDigest: digest(A) })).rejects.toThrow("crash");
    expect(await draftFile()).toBe(B);

    const restarted = makeStore();
    const view = await restarted.get(PROJECT);
    expect(view.draft?.yaml).toBe(B);
    expect(view.proposals.map((p) => [p.id, p.status])).toEqual([[proposal.id, "applied"]]);
    const stored: unknown = JSON.parse(await readFile(join(dir, "proposals", `${proposal.id}.json`), "utf8"));
    expect(stored).toMatchObject({ status: "applied" });
    expect(stored).not.toHaveProperty("applying");
    await conflict(restarted.applyProposal(PROJECT, { proposalId: proposal.id, editableDigest: digest(A) }));
    await expect(restarted.applyProposal(PROJECT, { proposalId: proposal.id, editableDigest: digest(B) })).rejects.toMatchObject({
      code: "proposal_not_pending",
    });
    expect(await draftFile()).toBe(B);
  });

  it("settles as pending after a crash before the draft write, so a retry applies it", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const proposal = await store.addProposal(PROJECT, { baseToken: digest(A), yaml: B, summary: "Add lint", agentId: "agent-1" });
    const hook: FsHook = (step, path) => {
      if (step === "replace.synced" && path.endsWith("workflow.draft.yaml")) throw new Error("crash");
    };
    await expect(makeStore(createNodeFs({ hook })).applyProposal(PROJECT, { proposalId: proposal.id, editableDigest: digest(A) })).rejects.toThrow("crash");

    const restarted = makeStore();
    const view = await restarted.get(PROJECT);
    expect(view.draft).toBeNull();
    expect(view.proposals.map((p) => p.status)).toEqual(["pending"]);
    const stored: unknown = JSON.parse(await readFile(join(dir, "proposals", `${proposal.id}.json`), "utf8"));
    expect(stored).not.toHaveProperty("applying");
    const applied = await restarted.applyProposal(PROJECT, { proposalId: proposal.id, editableDigest: digest(A) });
    expect(applied.draft?.yaml).toBe(B);
    expect(applied.proposals.map((p) => p.status)).toEqual(["applied"]);
  });

  it("still applies when marking a sibling stale fails, and the sibling reads as stale", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const chosen = await store.addProposal(PROJECT, { baseToken: digest(A), yaml: B, summary: "Add lint", agentId: "agent-1" });
    const sibling = await store.addProposal(PROJECT, { baseToken: digest(A), yaml: C, summary: "Add all", agentId: "agent-2" });
    const hook: FsHook = (step, path) => {
      if (step === "replace.synced" && path.endsWith(`${sibling.id}.json`)) throw new Error("disk full");
    };
    const logs: string[] = [];
    const view = await makeStore(createNodeFs({ hook }), logs).applyProposal(PROJECT, { proposalId: chosen.id, editableDigest: digest(A) });
    expect(view.proposals.map((p) => [p.id, p.status])).toEqual([
      [chosen.id, "applied"],
      [sibling.id, "stale"],
    ]);
    expect(logs).toEqual([`could not mark proposal ${sibling.id} stale: disk full`]);
    const stored: unknown = JSON.parse(await readFile(join(dir, "proposals", `${sibling.id}.json`), "utf8"));
    expect(stored).toMatchObject({ status: "pending" });
  });

  it("omits an unreadable proposal file", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    await mkdir(join(dir, "proposals"), { recursive: true });
    await writeFile(join(dir, "proposals", "prp_bad.json"), "{not json");
    expect((await store.get(PROJECT)).proposals).toEqual([]);
  });
});

describe("RPC handlers", () => {
  type Handler = (input: unknown) => Promise<ViewResult>;

  function register(store: WorkflowStore, logs: string[] = []): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    const server: RpcRegistrar = {
      handle<I extends ZodType, O extends ZodType>(contract: PluginRpcContract<I, O>, handler: (input: z.output<I>) => z.input<O> | Promise<z.input<O>>) {
        handlers.set(contract.name, async (input) => ViewResultSchema.parse(await handler(contract.input.parse(input))));
      },
    };
    registerWorkflowHandlers(server, store, { log: (m) => logs.push(m) });
    return handlers;
  }

  async function call(handlers: Map<string, Handler>, name: string, input: unknown): Promise<ViewResult> {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no handler ${name}`);
    return handler(input);
  }

  function failure(result: ViewResult): RpcError {
    if (result.ok) throw new Error("expected a failure");
    return result.error;
  }

  it("registers every workflow RPC", () => {
    expect([...register(makeStore()).keys()].sort()).toEqual([
      "workflow.draft.discard",
      "workflow.draft.edit",
      "workflow.draft.set-text",
      "workflow.get",
      "workflow.proposal.apply",
      "workflow.proposal.discard",
      "workflow.save",
    ]);
  });

  it("applies a visual editor patch through workflow.draft.edit, keeping comments and unrelated keys inside `with`", async () => {
    const original = `jobs:
  build:
    uses: run-tasks # tasks
    with:
      # what to build
      prompt: Build it # prompt note
      context: docs/notes.md # unrelated
      agent:
        model: a/m1 # primary
        # tuned retries
        retries: 3
        fallback:
          model: b/m2 # fallback note
          reasoning: low
      reviewer: { profile: rev } # reviewer note
    # job trailer
`;
    const store = makeStore();
    await seedSaved(store, original);
    const handlers = register(store);
    // The exact payload the visual editor sends for a prompt, model and fallback reasoning edit.
    const op = {
      kind: "job.patch",
      id: "build",
      changes: [
        { path: ["with", "prompt"], value: "Build it well" },
        { path: ["with", "agent", "model"], value: "a/m9" },
        { path: ["with", "agent", "fallback", "reasoning"], value: "high" },
        { path: ["with", "agent", "reasoning"], value: "medium" },
      ],
    };
    const result = await call(handlers, workflowDraftEdit.name, { projectId: PROJECT, editableDigest: digest(original), op });
    const expected = original
      .replace("prompt: Build it # prompt note", "prompt: Build it well # prompt note")
      .replace("model: a/m1 # primary", "model: a/m9 # primary")
      .replace("          reasoning: low\n", "          reasoning: high\n        reasoning: medium\n");
    expect(result.ok && result.value.draft).toEqual({ yaml: expected, digest: digest(expected) });
    expect(result.ok && result.value.diagnostics).toEqual([]);
    expect(await draftFile()).toBe(expected);
    expect(await saved()).toBe(original);

    const stale = await call(handlers, workflowDraftEdit.name, { projectId: PROJECT, editableDigest: digest(original), op });
    expect(failure(stale).code).toBe("workflow_conflict");
    expect(await draftFile()).toBe(expected);
  });

  it("returns a conflict with the current digests", async () => {
    const store = makeStore();
    await seedSaved(store, A);
    const handlers = register(store);
    const result = await call(handlers, workflowDraftSetText.name, { projectId: PROJECT, editableDigest: ABSENT, yaml: B });
    const error = failure(result);
    expect(error.code).toBe("workflow_conflict");
    expect(error.current).toEqual({ savedDigest: digest(A), draftDigest: ABSENT, editableDigest: digest(A) });
    expect(error.message).not.toBe("");
  });

  it("returns save diagnostics as workflow_invalid", async () => {
    const store = makeStore();
    await store.setDraftText(PROJECT, { editableDigest: ABSENT, yaml: INVALID });
    const result = await call(register(store), workflowSave.name, { projectId: PROJECT, savedDigest: ABSENT, draftDigest: digest(INVALID) });
    expect(failure(result)).toMatchObject({ code: "workflow_invalid", diagnostics: [expect.objectContaining({ code: "uses_unknown" })] });
  });

  it("hides unexpected failures behind internal and logs them", async () => {
    const logs: string[] = [];
    const broken: PipelineFs = { ...createNodeFs(), readFile: () => Promise.reject(new Error("disk gone")) };
    const result = await call(register(makeStore(broken), logs), workflowGet.name, { projectId: PROJECT });
    expect(failure(result)).toEqual({ code: "internal", message: "The workflow store failed." });
    expect(logs).toEqual(["workflow store failure: Error: disk gone"]);
  });

  it("rejects a malformed digest at the boundary", () => {
    expect(workflowDraftSetText.input.safeParse({ projectId: PROJECT, editableDigest: "abc", yaml: A }).success).toBe(false);
    expect(workflowGet.input.safeParse({ projectId: "../x" }).success).toBe(false);
  });
});
