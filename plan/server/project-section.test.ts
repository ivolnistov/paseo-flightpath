// R4 final DeepSeek c0082 (T): the per-project critical section contract. Behaviour only, through the
// public API (`createProjectSection`, the process default `projectSection`, `projectSectionKey`) and
// the real feature/plan commands; no private registry state is inspected. No timers: every wait is a
// promise gate, and "has not started yet" is checked after an unrelated key's section has completed
// (a section that did not wait for its key would have run before that later-enqueued probe).
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "./store";
import { UI_ORIGIN, type StoreOpener } from "./sessions";
import { fixedClock, nextId } from "./test-support/build";
import { makePlanProject, type PlanProject } from "./test-support/plans";

const loadSection = async () => await import("./project-section");

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe("createProjectSection: one key at a time, in arrival order", () => {
  it("same key: exclusive and FIFO; an unrelated key runs while it is held", async () => {
    const { createProjectSection } = await loadSection();
    const section = createProjectSection();
    const log: string[] = [];
    const g1 = gate();
    const g2 = gate();
    const a = section("k", async () => {
      log.push("a start");
      await g1.p;
      log.push("a end");
      return "A";
    });
    const b = section("k", async () => {
      log.push("b start");
      await g2.p;
      log.push("b end");
      return "B";
    });
    const c = section("k", async () => {
      log.push("c start");
      return "C";
    });
    // An unrelated key proceeds and completes while "k" is held.
    expect(await section("other", async () => (log.push("other"), "O"))).toBe("O");
    expect(log, "only the first caller of k has started").toEqual(["a start", "other"]);
    g1.open();
    expect(await a).toBe("A");
    await section("other-2", async () => undefined);
    expect(log.slice(2), "b runs after a ends; c still waits for b").toEqual(["a end", "b start"]);
    g2.open();
    expect(await Promise.all([b, c])).toEqual(["B", "C"]);
    expect(log).toEqual(["a start", "other", "a end", "b start", "b end", "c start"]);
  });

  it("a rejection reaches its own caller unchanged and releases the key; the next caller gets its own value", async () => {
    const { createProjectSection } = await loadSection();
    const section = createProjectSection();
    const failure = new Error("inside the section");
    const g = gate();
    const first = section("k", async () => {
      await g.p;
      throw failure;
    });
    const second = section("k", async () => "after");
    g.open();
    await expect(first).rejects.toBe(failure);
    expect(await second, "the waiting caller runs and is not rejected").toBe("after");
    expect(await section("k", async () => "again"), "the key stays usable").toBe("again");
  });

  it("independent registries do not block each other on the same key", async () => {
    const { createProjectSection } = await loadSection();
    const one = createProjectSection();
    const two = createProjectSection();
    const g = gate();
    const held = one("k", async () => g.p);
    expect(await two("k", async () => "free"), "another registry is not blocked").toBe("free");
    g.open();
    await held;
  });
});

describe("projectSectionKey: the store root and the project id", () => {
  it("equal for the same root and project; different for another root or another project", async () => {
    const { projectSectionKey } = await loadSection();
    const key = (storeRoot: string, projectId: string) => projectSectionKey({ storeRoot, projectId });
    expect(key("/r/one", "prj_a")).toBe(key("/r/one", "prj_a"));
    expect(key("/r/one", "prj_a")).not.toBe(key("/r/two", "prj_a"));
    expect(key("/r/one", "prj_a")).not.toBe(key("/r/one", "prj_b"));
    // A root/id boundary shift cannot produce the same key.
    expect(key("/r/one", "prj_a")).not.toBe(key("/r/on", "eprj_a"));
  });
});

// Default sharing: commands built WITHOUT a projectSection use the process default. The test holds
// the default on the project's key, starts the command, and learns the exact moment the command asks
// for its section: the key is computed from `store.storeRoot`, read through a wrapped store
// immediately before the synchronous section call. A probe queued on the default after that moment
// must run only after the command's section work, which itself starts only after the hold is released.
describe("default projectSection is shared by feature and plan commands", () => {
  let t: PlanProject | undefined;
  afterEach(async () => {
    await t?.cleanup();
    t = undefined;
  });

  async function harness() {
    t = await makePlanProject();
    const s = t;
    const { projectSection, projectSectionKey } = await loadSection();
    const store = await s.open(s.P);
    const key = projectSectionKey(store);
    const log: string[] = [];
    const keyRead = gate();
    const wrapStore = (real: Store, label: string): Store =>
      new Proxy(real, {
        get: (target, prop) => {
          if (prop === "storeRoot") keyRead.open();
          if (prop === "read") {
            const read = target.read.bind(target);
            return async () => {
              log.push(`${label} store read`);
              return read();
            };
          }
          return Reflect.get(target, prop) as unknown;
        },
      });
    const opener = (label: string): StoreOpener => async (projectId) => wrapStore(await s.open(projectId), label);
    const base = { directory: () => { throw new Error("unused"); }, now: fixedClock, newId: nextId, storeOptions: { now: fixedClock, newId: nextId }, approvals: s.approvals };
    /** Holds the default section on the project key, runs `start`, queues a probe once the command asked for its section, then releases. */
    const contend = async <T,>(start: () => Promise<T>) => {
      const hold = gate();
      const held = projectSection(key, async () => {
        await hold.p;
        log.push("hold released");
      });
      let probe: Promise<void> | undefined;
      let command: Promise<T> | undefined;
      try {
        command = start();
        await Promise.race([keyRead.p, command]);
        probe = projectSection(key, async () => void log.push("probe"));
      } finally {
        hold.open();
      }
      await held;
      await probe;
      // The command's own post-section work finishes before the log is read or the project cleaned up.
      await command;
      return log;
    };
    return { s, base, opener, contend, log };
  }

  it("a UI cancel's section (default) waits for the held key, and a later probe waits for the cancel's section work", async () => {
    const { s, base, opener, contend } = await harness();
    const { createFeatureCommands } = await import("./features");
    const features = createFeatureCommands(base as Parameters<typeof createFeatureCommands>[0]);
    const created = await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Alpha", description: "", kind: "feature" }, UI_ORIGIN);
    if (!created.ok) throw new Error(created.error.message);
    let result: Awaited<ReturnType<typeof features.statusSet>> | undefined;
    const log = await contend(async () => {
      result = await features.statusSet(opener("cancel"), { projectId: s.P, expectedRevision: await s.revision(), featureId: created.value.featureId, status: "cancelled" }, UI_ORIGIN);
      return result;
    });
    const order = log.filter((l) => l === "hold released" || l === "probe" || l === "cancel store read");
    expect(order.slice(0, 2), "the cancel's section work starts only after the held default is released").toEqual(["hold released", "cancel store read"]);
    expect(order.at(-1), "the probe queued after the cancel asked for the key runs after the cancel's section").toBe("probe");
    expect(result?.ok, "the cancel itself succeeds").toBe(true);
  });

  it("control: a cancel given its own registry (projectSection injected) completes while the default key is held", async () => {
    const { s, base, opener, log } = await harness();
    const { createProjectSection, projectSection, projectSectionKey } = await loadSection();
    const { createFeatureCommands } = await import("./features");
    const deps = { ...base, projectSection: createProjectSection() };
    const features = createFeatureCommands(deps as Parameters<typeof createFeatureCommands>[0]);
    const created = await features.create(s.open, { projectId: s.P, expectedRevision: await s.revision(), title: "Alpha", description: "", kind: "feature" }, UI_ORIGIN);
    if (!created.ok) throw new Error(created.error.message);
    const hold = gate();
    const held = projectSection(projectSectionKey(await s.open(s.P)), async () => {
      await hold.p;
      log.push("hold released");
    });
    try {
      const out = await features.statusSet(opener("cancel"), { projectId: s.P, expectedRevision: await s.revision(), featureId: created.value.featureId, status: "cancelled" }, UI_ORIGIN);
      expect(out.ok).toBe(true);
      expect(log.includes("cancel store read") && !log.includes("hold released"), "the injected registry is used instead of the default").toBe(true);
    } finally {
      hold.open();
    }
    await held;
  });

  it("a plan approval's section (default) waits for the held key; its in-section failure is returned and releases the key", async () => {
    const { s, base, opener, contend } = await harness();
    const { createPlanCommands } = await import("./plans");
    const plans = createPlanCommands(base as Parameters<typeof createPlanCommands>[0]);
    let result: Awaited<ReturnType<typeof plans.approve>> | undefined;
    const log = await contend(async () => {
      // An unknown plan fails inside the section (after its store read).
      result = await plans.approve(opener("approve"), { projectId: s.P, planId: "plan_missing", rev: 1, contentHash: "a".repeat(64) }, UI_ORIGIN);
      return result;
    });
    expect(log.filter((l) => l === "hold released" || l === "probe" || l === "approve store read")).toEqual(["hold released", "approve store read", "probe"]);
    expect(result?.ok, "the in-section failure is returned to the caller").toBe(false);
  });
});
