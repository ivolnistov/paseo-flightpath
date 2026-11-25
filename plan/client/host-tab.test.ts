// The host tab's kept screen stack (client/host-tab.ts): DeepSeek Flash review 01a1c67a c0031. The
// remount cases in discussion-screen.test.ts only show a stack that round-trips; each guard here would
// pass them if removed. Pure module: no React Native, no host.
import { describe, expect, it } from "vitest";
import { hostTabOf, restoreStack, saveStack, type HostTab, type StoredScreen } from "./host-tab";

const HOST = "srv_host";
const PROJECT = "prj_one";
const STACK: StoredScreen[] = [{ kind: "overview" }, { kind: "session", sessionId: "S" }];

function tab(state: unknown) {
  const box = { state, writes: 0 };
  const t: HostTab = {
    read: () => box.state,
    write: (next) => {
      box.writes++;
      box.state = next;
    },
  };
  return { box, t };
}
const kept = (over: Record<string, unknown> = {}) => ({ decisionRoadmap: { v: 1, hostId: HOST, projectId: PROJECT, stack: STACK, ...over } });

describe("restoreStack", () => {
  it("restores a kept stack for this host and project", () => {
    expect(restoreStack(tab(kept()).t, HOST, PROJECT)).toEqual(STACK);
  });

  it.each([
    ["no tab", null],
    ["no state", tab(undefined).t],
    ["a state that is not a record", tab("someone else's").t],
    ["an array state", tab([kept()]).t],
    ["no kept entry", tab({ other: 1 }).t],
    ["another version", tab(kept({ v: 2 })).t],
    ["another host", tab(kept({ hostId: "srv_other" })).t],
    ["another project", tab(kept({ projectId: "prj_other" })).t],
    ["a stack that is not an array", tab(kept({ stack: { kind: "overview" } })).t],
    ["an empty stack", tab(kept({ stack: [] })).t],
    ["a stack that does not start at the overview", tab(kept({ stack: [{ kind: "session", sessionId: "S" }] })).t],
    ["a screen of an unknown kind", tab(kept({ stack: [{ kind: "overview" }, { kind: "settings" }] })).t],
    ["a session screen without its id", tab(kept({ stack: [{ kind: "overview" }, { kind: "session" }] })).t],
    ["a feature screen with an empty id", tab(kept({ stack: [{ kind: "overview" }, { kind: "feature", featureId: "" }] })).t],
    ["a screen that is not a record", tab(kept({ stack: [{ kind: "overview" }, "plan"] })).t],
  ] as Array<[string, HostTab | null]>)("restores nothing for %s", (_name, t) => {
    expect(restoreStack(t, HOST, PROJECT)).toBeNull();
  });

  // DeepSeek Flash review 01a1c6c1 c0105: every screen kind restores, not only overview and session.
  it("restores a stack of every screen kind: roadmap, feature, plan and session", () => {
    const stack = [{ kind: "overview" }, { kind: "roadmap" }, { kind: "feature", featureId: "f1" }, { kind: "plan", planId: "p1" }, { kind: "session", sessionId: "S" }];
    expect(restoreStack(tab(kept({ stack })).t, HOST, PROJECT)).toEqual(stack);
  });

  it.each([
    ["a plan screen without its id", { kind: "plan" }],
    ["a feature screen with a non-string id", { kind: "feature", featureId: 7 }],
  ])("restores nothing for %s", (_name, screen) => {
    expect(restoreStack(tab(kept({ stack: [{ kind: "overview" }, screen] })).t, HOST, PROJECT)).toBeNull();
  });

  it("keeps only the ids of a screen (one-shot link targets are not restored)", () => {
    const t = tab(kept({ stack: [{ kind: "overview" }, { kind: "session", sessionId: "S", focus: { questionId: "q1" } }] })).t;
    expect(restoreStack(t, HOST, PROJECT)).toEqual([{ kind: "overview" }, { kind: "session", sessionId: "S" }]);
  });
});

describe("saveStack", () => {
  it("writes the stack beside the tab's other keys", () => {
    const { box, t } = tab({ other: { keep: 1 }, flag: true });
    saveStack(t, HOST, PROJECT, STACK);
    expect(box.state).toEqual({ other: { keep: 1 }, flag: true, ...kept() });
    expect(restoreStack(t, HOST, PROJECT)).toEqual(STACK);
  });

  it("writes into an empty tab", () => {
    const { box, t } = tab(undefined);
    saveStack(t, HOST, PROJECT, STACK);
    expect(box.state).toEqual(kept());
  });

  it.each([
    ["a string", "someone else's"],
    ["an array", [1, 2]],
    ["a number", 7],
  ])("leaves a state that is not a record alone (%s)", (_name, state) => {
    const { box, t } = tab(state);
    saveStack(t, HOST, PROJECT, STACK);
    expect(box.writes).toBe(0);
    expect(box.state).toEqual(state);
  });

  it("does not write again when the kept stack is unchanged", () => {
    const { box, t } = tab(kept());
    saveStack(t, HOST, PROJECT, STACK);
    expect(box.writes).toBe(0);
  });

  it("does nothing without a tab", () => {
    expect(() => saveStack(null, HOST, PROJECT, STACK)).not.toThrow();
  });
});

describe("hostTabOf", () => {
  it("reads the host's state and writes through its setState", () => {
    const calls: unknown[] = [];
    const host = { state: { a: 1 }, setState: (v: unknown) => void calls.push(v), setModified: () => undefined };
    const t = hostTabOf({ tab: host });
    expect(t).not.toBeNull();
    expect(t!.read()).toEqual({ a: 1 });
    t!.write({ b: 2 });
    expect(calls).toEqual([{ b: 2 }]);
  });

  it.each([
    ["no tab prop", {}],
    ["a tab that is not a record", { tab: "x" }],
    ["a tab without setState", { tab: { state: {} } }],
    ["a setState that is not a function", { tab: { state: {}, setState: 1 } }],
  ])("is null for %s", (_name, props) => {
    expect(hostTabOf(props)).toBeNull();
  });
});
