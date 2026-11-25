import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent, RunEventBody } from "../shared/run";
import { createNodeFs } from "./fs-port";
import { initialState, replay, stampEvents } from "./run-engine";
import { createRunStore, parseJournal, snapshotHashOf } from "./run-store";
import { snapshotBody } from "./run-test-kit";

const WORKFLOW = `name: Store
jobs:
  a: { uses: agent, with: { prompt: a, agent: { model: p/m } } }
`;

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "run-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store() {
  return createRunStore({ stateDir: dir, fs: createNodeFs() });
}

const BODIES: RunEventBody[] = [
  { kind: "workspace.intent", branchName: "flightpath/run-run1" },
  { kind: "workspace.bound", workspaceId: "ws", directory: "/w", baseCommit: "base" },
  { kind: "attempt.started", jobId: "a", attemptId: "a#1", n: 1, cause: "first", target: "primary" },
];

function events(): RunEvent[] {
  const snapshot = { ...snapshotBody(WORKFLOW), snapshotHash: snapshotHashOf(snapshotBody(WORKFLOW)) };
  return stampEvents(initialState(snapshot), BODIES, "2026-11-21T00:00:00.000Z");
}

function journalPath(runId = "run1", projectId = "proj"): string {
  return join(dir, "runs", projectId, runId, "journal.jsonl");
}

async function seeded() {
  const runs = store();
  const snapshot = await runs.create(snapshotBody(WORKFLOW));
  for (const event of events()) await runs.append("run1", event);
  return { runs, snapshot };
}

describe("run store", () => {
  it("writes the snapshot once with its hash and owner-only modes", async () => {
    const runs = store();
    const snapshot = await runs.create(snapshotBody(WORKFLOW));
    expect(snapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    const path = join(dir, "runs", "proj", "run1", "snapshot.json");
    const bytes = await readFile(path);
    await expect(runs.create(snapshotBody(WORKFLOW))).rejects.toMatchObject({ code: "run_exists" });
    expect(await readFile(path)).toEqual(bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "runs", "proj", "run1"))).mode & 0o777).toBe(0o700);
    expect((await runs.load("run1")).snapshot).toEqual(snapshot);
  });

  it("finds a run by its startKey from a store rebuilt on the same directory", async () => {
    await store().create(snapshotBody(WORKFLOW, { startKey: "key-a" }));
    await store().create(snapshotBody(WORKFLOW, { runId: "run2", startKey: "key-b" }));
    const rebuilt = store();
    expect((await rebuilt.findByStartKey("proj", "key-b"))?.runId).toBe("run2");
    expect(await rebuilt.findByStartKey("proj", "key-c")).toBeNull();
    expect(await rebuilt.findByStartKey("other", "key-a")).toBeNull();
    expect((await rebuilt.list("proj")).map((run) => run.runId)).toEqual(["run1", "run2"]);
  });

  it("appends one synced line per record with consecutive seq and refuses a gap", async () => {
    const { runs } = await seeded();
    const text = await readFile(journalPath(), "utf8");
    expect(text.split("\n")).toHaveLength(4);
    const loaded = await runs.load("run1");
    expect(loaded).toMatchObject({ health: "ok" });
    expect(loaded.events).toEqual(events());
    const [, , third] = events();
    if (!third) throw new Error("missing event");
    await expect(runs.append("run1", { ...third, seq: 5 })).rejects.toMatchObject({ code: "seq_conflict" });
    await expect(runs.append("run1", third)).rejects.toMatchObject({ code: "seq_conflict" });
  });

  it("repairs a torn last record once on the first append and keeps every complete record in order", async () => {
    await seeded();
    const before = await readFile(journalPath());
    await appendFile(journalPath(), '{"seq":4,"id":"x","at":"t","kind":"run.pau');
    const reopened = store();
    const loaded = await reopened.load("run1");
    expect(loaded).toMatchObject({ health: "ok", events: events() });
    const state = replay(loaded.snapshot, loaded.events);
    const [next] = stampEvents(state, [{ kind: "run.paused", reason: "human" }], "t");
    if (!next) throw new Error("missing event");
    await reopened.append("run1", next);
    const after = await readFile(journalPath());
    expect(after.subarray(0, before.length)).toEqual(before);
    expect((await reopened.load("run1")).events).toEqual([...events(), next]);
  });

  it("treats a complete but unparsable last line as torn", async () => {
    await seeded();
    await appendFile(journalPath(), "not json\n");
    const reopened = store();
    expect(await reopened.load("run1")).toMatchObject({ health: "ok", events: events() });
    const state = replay((await reopened.load("run1")).snapshot, events());
    const [next] = stampEvents(state, [{ kind: "run.paused", reason: "human" }], "t");
    if (!next) throw new Error("missing event");
    await reopened.append("run1", next);
    expect(parseJournal(await readFile(journalPath()))).toMatchObject({ health: "ok", torn: false });
  });

  it("reports a corrupt middle record as journal_corrupt and refuses the append", async () => {
    await seeded();
    const lines = (await readFile(journalPath(), "utf8")).split("\n");
    lines[1] = "{broken";
    await writeFile(journalPath(), lines.join("\n"));
    const corrupt = await readFile(journalPath());
    const reopened = store();
    expect(await reopened.load("run1")).toMatchObject({ health: "journal_corrupt" });
    const [, , third] = events();
    if (!third) throw new Error("missing event");
    await expect(reopened.append("run1", { ...third, seq: 4 })).rejects.toMatchObject({ code: "journal_corrupt" });
    expect(await readFile(journalPath())).toEqual(corrupt);
    expect((await reopened.listLive()).map((run) => [run.runId, run.health])).toEqual([["run1", "journal_corrupt"]]);
  });

  it("reports a seq gap before the last record as journal_corrupt", async () => {
    await seeded();
    const lines = (await readFile(journalPath(), "utf8")).split("\n");
    const second = lines[1] ?? "";
    lines[1] = second.replace('"seq":2', '"seq":7');
    await writeFile(journalPath(), lines.join("\n"));
    expect(await store().load("run1")).toMatchObject({ health: "journal_corrupt" });
  });

  it("lists only runs that have not finished or been cancelled", async () => {
    const { runs } = await seeded();
    await runs.create(snapshotBody(WORKFLOW, { runId: "run2", startKey: "k2" }));
    const done = stampEvents(initialState({ ...snapshotBody(WORKFLOW, { runId: "run2" }), snapshotHash: "0".repeat(64) }), [{ kind: "workspace.intent", branchName: "flightpath/run-run2" }, { kind: "run.cancelled" }], "t");
    for (const event of done) await runs.append("run2", event);
    expect((await store().listLive()).map((run) => run.runId)).toEqual(["run1"]);
  });

  it("refuses a snapshot whose hash does not match", async () => {
    await store().create(snapshotBody(WORKFLOW));
    const path = join(dir, "runs", "proj", "run1", "snapshot.json");
    await writeFile(path, (await readFile(path, "utf8")).replace('"startKey":"start-1"', '"startKey":"start-2"'));
    await expect(store().load("run1")).rejects.toMatchObject({ code: "snapshot_corrupt" });
  });

  it("refuses unsafe run and project ids", async () => {
    await expect(store().load("../x")).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(store().findByStartKey("../x", "k")).rejects.toMatchObject({ code: "unsafe_path" });
  });
});
