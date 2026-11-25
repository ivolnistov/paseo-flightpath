// Stage R3.1 (task card 2026-10-29 R3 §2.2, §2.3): start delegations. `coveringDelegation(data,
// featureId)` returns an unrevoked delegation covering the feature (feature scope for that feature,
// or roadmap scope); `delegatedStarts(data, coordinatorProfile?)` lists planned features with a
// current approved revision, a covering delegation and no live run. `./delegations` is new in R3.1,
// so it is loaded from the module namespace and each export is checked before use.
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionRun, RoadmapData, StartDelegation } from "../shared/model";
import { UI_ORIGIN } from "./sessions";
import { fixedClock, NOW_ISO, nextId } from "./test-support/build";
import { makePlanProject, type PlanProject } from "./test-support/plans";

let t: PlanProject | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};

const load = async () => {
  const mod: Record<string, unknown> = await import("./delegations");
  for (const name of ["recordDelegation", "coveringDelegation", "delegatedStarts"]) {
    expect(typeof mod[name], `server/delegations exports ${name}`).toBe("function");
  }
  return import("./delegations");
};

const delegation = (id: string, partial: Partial<StartDelegation> = {}): StartDelegation => ({
  id, scope: "feature", featureId: "f-other", grantedAt: NOW_ISO,
  provenance: { agentId: "agent-1", seqStart: 1, timestamp: NOW_ISO, quoted: "start it" }, ...partial,
});

/** Real data: feature "Search" planned by an approved, current bound plan; feature "Idle" created. */
async function data(): Promise<{ data: RoadmapData; featureId: string; idleId: string; planId: string }> {
  t = await makePlanProject();
  const s = t;
  const seed = await s.seedAnswered();
  const { createFeatureCommands } = await import("./features");
  const features = createFeatureCommands({ directory: () => { throw new Error("unused"); }, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId } });
  const featureId = ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Search", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
  const idleId = ok(await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Idle", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
  const d = ok(await s.plans.draft(s.open, { projectId: s.P, expectedRevision: await s.revision(), featureId, title: "Rollout", sessionIds: [seed.sessionId], markdown: "# R", tasks: [{ id: "t1", title: "Build", description: "", dod: "x" }] }, UI_ORIGIN));
  await (await s.open(s.P)).transact(await s.revision(), (draft) => {
    draft.features.find((f) => f.id === featureId)!.grillSessionId = seed.sessionId;
    draft.plans.find((p) => p.id === d.planId)!.grillSessionId = seed.sessionId;
  });
  ok(await s.plans.approve(s.open, { projectId: s.P, planId: d.planId, rev: 1, contentHash: d.contentHash }, UI_ORIGIN));
  const read = await (await s.open(s.P)).read();
  if (read.status !== "ok") throw new Error("store not ok");
  expect(read.data.features.find((f) => f.id === featureId)!.status, "precondition: planned").toBe("planned");
  return { data: read.data, featureId, idleId, planId: d.planId };
}

const withDelegations = (d: RoadmapData, delegations: StartDelegation[]): RoadmapData => ({ ...d, delegations });

describe("R3.1 coveringDelegation", () => {
  it("feature scope covers only its feature; roadmap scope covers every feature; revoked ones never cover", async () => {
    const x = await data();
    const d = await load();
    const own = delegation("d-own", { featureId: x.featureId });
    const roadmap = delegation("d-all", { scope: "roadmap", featureId: undefined });
    expect(d.coveringDelegation(withDelegations(x.data, []), x.featureId)).toBeUndefined();
    expect(d.coveringDelegation(withDelegations(x.data, [delegation("d-other")]), x.featureId)).toBeUndefined();
    expect(d.coveringDelegation(withDelegations(x.data, [own]), x.featureId)?.id).toBe("d-own");
    expect(d.coveringDelegation(withDelegations(x.data, [roadmap]), x.idleId)?.id).toBe("d-all");
    expect(d.coveringDelegation(withDelegations(x.data, [{ ...own, revokedAt: NOW_ISO }]), x.featureId)).toBeUndefined();
    expect(d.coveringDelegation(withDelegations(x.data, [{ ...roadmap, revokedAt: NOW_ISO }]), x.featureId)).toBeUndefined();
  });
});

describe("R3.1 delegatedStarts candidate sweep", () => {
  it("lists a planned feature with a current approved revision and a covering delegation, and nothing else", async () => {
    const x = await data();
    const d = await load();
    const covered = withDelegations(x.data, [delegation("d-own", { featureId: x.featureId })]);
    const ids = (out: unknown) => JSON.stringify(out);
    expect(ids(d.delegatedStarts(covered))).toContain(x.featureId);
    expect(ids(d.delegatedStarts(covered))).not.toContain(x.idleId);
    // No delegation, a revoked one, or one for another feature: no candidate.
    for (const ds of [[], [delegation("d-own", { featureId: x.featureId, revokedAt: NOW_ISO })], [delegation("d-other")]]) {
      expect(ids(d.delegatedStarts(withDelegations(x.data, ds))), JSON.stringify(ds)).not.toContain(x.featureId);
    }
    // A live run excludes the feature; an ended run does not.
    const run = (state: ExecutionRun["state"]): ExecutionRun => {
      const end: Pick<ExecutionRun, "endReason"> = state === "ended" ? { endReason: "finished" } : {};
      return {
      id: "run-1", featureId: x.featureId, planId: x.planId, planRev: 1, runToken: "tok", state, ...end,
      startAuth: { kind: "ui", at: NOW_ISO }, tasks: [], acks: [], events: [{ at: NOW_ISO, kind: "started" }], lateEvidence: [],
      };
    };
    for (const state of ["running", "paused"] as const) {
      expect(ids(d.delegatedStarts({ ...covered, runs: [run(state)] })), state).not.toContain(x.featureId);
    }
    expect(ids(d.delegatedStarts({ ...covered, runs: [run("ended")] }))).toContain(x.featureId);
  });

  it("is read only: the data is not modified", async () => {
    const x = await data();
    const d = await load();
    const covered = withDelegations(x.data, [delegation("d-own", { featureId: x.featureId })]);
    const before = JSON.stringify(covered);
    d.delegatedStarts(covered);
    d.coveringDelegation(covered, x.featureId);
    expect(JSON.stringify(covered)).toBe(before);
  });
});

// R3.1 verification control (root-authorised): recordDelegation appends exact schema records inside
// a real store transaction; feature and roadmap scopes; earlier records stay byte-identical.
describe("R3.1 recordDelegation writes", () => {
  it("records feature and roadmap delegations with the given provenance, append-only; an invalid feature scope writes nothing", async () => {
    const x = await data();
    const d = await load();
    const s = t!;
    const provenance = { agentId: "agent-7", messageId: "m-1", seqStart: 4, turnId: "turn-2", timestamp: NOW_ISO, quoted: "you may start Search" };
    const read = async () => {
      const r = await (await s.open(s.P)).read();
      if (r.status !== "ok") throw new Error("store not ok");
      return r.data;
    };
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      d.recordDelegation(draft, { id: "del-f", scope: "feature", featureId: x.featureId, provenance, at: NOW_ISO });
    });
    const first = (await read()).delegations;
    expect(first).toEqual([{ id: "del-f", scope: "feature", featureId: x.featureId, provenance, grantedAt: NOW_ISO }]);
    await (await s.open(s.P)).transact(await s.revision(), (draft) => {
      d.recordDelegation(draft, { id: "del-r", scope: "roadmap", provenance: { ...provenance, quoted: "start anything ready" }, at: NOW_ISO });
    });
    const both = (await read()).delegations;
    expect(both).toHaveLength(2);
    expect(JSON.stringify(both[0])).toBe(JSON.stringify(first[0]));
    expect(both[1]).toEqual({ id: "del-r", scope: "roadmap", provenance: { ...provenance, quoted: "start anything ready" }, grantedAt: NOW_ISO });
    expect("featureId" in both[1]).toBe(false);
    expect("revokedAt" in both[1]).toBe(false);
    // A feature scope without a featureId is not a valid record: the transaction refuses, nothing is written.
    const before = await s.revision();
    await expect(
      (await s.open(s.P)).transact(before, (draft) => {
        d.recordDelegation(draft, { id: "del-bad", scope: "feature", provenance, at: NOW_ISO });
      }),
    ).rejects.toThrow();
    expect(await s.revision()).toBe(before);
    expect((await read()).delegations.map((x) => x.id)).toEqual(["del-f", "del-r"]);
  });
});
