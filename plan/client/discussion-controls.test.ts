// Discuss controls on a feature card: features only; one click with the default profile, an
// optional "Discuss with…" choice, and the choice with a settings hint when no default exists. Each
// creation is one feature.discussion.open call; a bound chat opens without any call; refusals (a
// creation in progress or unresolved) are shown as the server words them and open nothing.
//
// Node harness: the REAL DiscussionControls and useRoadmapMutation over a recording useRpc; React
// Native and host UI are inert markers; profiles come from a stubbed useProfiles. Child components
// are not rendered; assertions read element props. Nothing reaches a host or a model.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature } from "../shared/model";

type El = { type: unknown; props: Record<string, unknown> };
type Answer = (input: Record<string, unknown>) => unknown;

const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    dirty: false,
    effects: [] as Array<() => unknown>,
    calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
    toasts: [] as string[],
    answers: {} as Record<string, (input: Record<string, unknown>) => unknown>,
    profiles: [] as Array<{ id: string; label: string }>,
    paseoReads: 0,
    invalidations: 0,
  };
  const useState = (init: unknown) => {
    const i = state.index++;
    if (!(i in state.slots)) {
      const first: unknown = typeof init === "function" ? Reflect.apply(init, undefined, []) : init;
      state.slots[i] = first;
    }
    const set = (v: unknown) => {
      const next: unknown = typeof v === "function" ? Reflect.apply(v, undefined, [state.slots[i]]) : v;
      if (next !== state.slots[i]) {
        state.slots[i] = next;
        state.dirty = true;
      }
    };
    return [state.slots[i], set];
  };
  const useEffect = (fn: () => unknown) => void state.effects.push(fn);
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  const useRpc = (contract: { name: string }) => (input: Record<string, unknown>) => {
    state.calls.push({ name: contract.name, input });
    const answer = state.answers[contract.name];
    return Promise.resolve(answer ? answer(input) : { ok: true, value: { revision: 1 } });
  };
  return { state, useState, useEffect, marker, useRpc };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const passthrough = { useState: h.useState, useEffect: h.useEffect, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (v: unknown) => ({ current: v }) };
  const original: unknown = real.default;
  return { ...real, ...passthrough, default: { ...(typeof original === "object" && original !== null ? original : {}), ...passthrough } };
});
vi.mock("react-native", () => ({ Text: h.marker("Text"), View: h.marker("View"), Pressable: h.marker("Pressable"), ScrollView: h.marker("RNScrollView") }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: h.marker("TextInput"),
  ScrollView: h.marker("ScrollView"),
  Modal: Object.assign(h.marker("Modal"), { Content: h.marker("ModalContent") }),
  useToast: () => ({ show: (m: string) => void h.state.toasts.push(m), error: (m: string) => void h.state.toasts.push(m) }),
  copyText: async () => undefined,
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: h.useRpc,
  useWorkspace: () => ({}),
  useSettings: () => ({ status: "loading" }),
  usePaseo: () => (h.state.paseoReads++, null),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isError: false }),
  useQueryClient: () => ({ getQueryData: () => undefined, getQueriesData: () => [], invalidateQueries: async () => void h.state.invalidations++ }),
}));
vi.mock("./hooks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProfiles: () => ({ data: h.state.profiles, isPending: false, isError: false }),
}));

const theme = { colors: new Proxy({}, { get: () => "#000" }) };
const HOST = "h1";
const P = "prj_test";
const WS = "wks_1";
const AT = "2026-10-20T10:00:00.000Z";
const PROFILES = [{ id: "team-research", label: "Research" }, { id: "team-planner", label: "Planner" }];

beforeEach(() => {
  h.state.calls = [];
  h.state.toasts = [];
  h.state.answers = {};
  h.state.profiles = PROFILES;
  h.state.paseoReads = 0;
  h.state.invalidations = 0;
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isEl = (v: unknown): v is El => isRecord(v) && "type" in v && isRecord(v.props);
const nameOf = (el: El): string => {
  const t = el.type;
  if (typeof t !== "function") return "";
  const named: unknown = Reflect.get(t, "displayName") ?? Reflect.get(t, "name");
  return typeof named === "string" ? named : "";
};
function all(tree: unknown, pred: (el: El) => boolean): El[] {
  const out: El[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isEl(n)) return;
    if (pred(n)) out.push(n);
    walk(n.props.children);
  };
  walk(tree);
  return out;
}
const textOf = (n: unknown): string => {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  return isEl(n) ? textOf(n.props.children) : "";
};
const allText = (tree: unknown) => all(tree, () => true).map((el) => [typeof el.props.label === "string" ? el.props.label : "", textOf(el.props.children)].join(" ")).join("\n");
const buttons = (tree: unknown) => all(tree, (el) => nameOf(el) === "ActionButton");
const button = (tree: unknown, label: RegExp): El => {
  const found = buttons(tree).filter((el) => typeof el.props.label === "string" && label.test(el.props.label));
  expect(found.length, `one ActionButton ${String(label)} (have: ${buttons(tree).map((b) => String(b.props.label)).join(" | ")})`).toBe(1);
  return found[0];
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const press = async (el: El) => {
  const onPress = el.props.onPress;
  if (typeof onPress !== "function") throw new Error("not pressable");
  Reflect.apply(onPress, undefined, []);
  await flush();
};

function feature(over: Partial<Feature> = {}): Feature {
  return {
    id: "f1", title: "Login", description: "Sign in", kind: "feature", status: "created", dependsOn: [], relatedTo: [], everStarted: false,
    createdAt: AT, createdBy: { kind: "human" }, coordinatorHistory: [], events: [], ...over,
  };
}
const bound = (): Partial<Feature> => ({ grillSessionId: "S1", discussion: { state: "bound", reservationId: "r1", agentId: "agent-1", workspaceId: WS, boundAt: AT, profileRef: "team-research" } });

const modulePath = "./discussion-controls";
async function load(): Promise<{ discussAvailability: (f: Feature) => unknown; DiscussionControls: (props: Record<string, unknown>) => unknown }> {
  const mod: unknown = await import(/* @vite-ignore */ modulePath);
  const pick = (name: string): ((...args: unknown[]) => unknown) => {
    const fn: unknown = isRecord(mod) ? mod[name] : undefined;
    if (typeof fn !== "function") throw new Error(`missing export: discussion-controls.${name}`);
    return (...args: unknown[]) => {
      const out: unknown = Reflect.apply(fn, undefined, args);
      return out;
    };
  };
  return { discussAvailability: pick("discussAvailability"), DiscussionControls: pick("DiscussionControls") };
}

function mount(component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) {
  const slots: unknown[] = [];
  return () => {
    h.state.slots = slots;
    for (let pass = 0; pass < 30; pass++) {
      h.state.index = 0;
      h.state.dirty = false;
      h.state.effects = [];
      const tree = component(props);
      for (const fn of h.state.effects) fn();
      if (!h.state.dirty) return tree;
    }
    throw new Error("component did not settle");
  };
}
function controls(m: Awaited<ReturnType<typeof load>>, f: Feature, defaultProfile: string | undefined) {
  const opened: string[] = [];
  const render = mount(m.DiscussionControls, { hostId: HOST, projectId: P, workspaceId: WS, feature: f, revision: 9, defaultProfile, theme, onOpened: (id: string) => void opened.push(id) });
  return { render, opened };
}
const created = (sessionId = "S1"): Answer => () => ({ ok: true, value: { revision: 11, sessionId, agentId: "agent-1", workspaceId: WS, created: true, tools: "pending" } });

describe("discussAvailability", () => {
  it("offers Discuss on features, opens a bound chat, and nothing for bugs or finished cards", async () => {
    const { discussAvailability } = await load();
    expect(discussAvailability(feature())).toBe("discuss");
    expect(discussAvailability(feature({ status: "planned" }))).toBe("discuss");
    expect(discussAvailability(feature(bound()))).toBe("open");
    expect(discussAvailability(feature({ kind: "bug" }))).toBeNull();
    expect(discussAvailability(feature({ status: "done" }))).toBeNull();
    expect(discussAvailability(feature({ status: "cancelled" }))).toBeNull();
  });

  it("a creation that is in progress, unresolved or failed is never offered as an open chat", async () => {
    const { discussAvailability } = await load();
    const d = { reservationId: "r1", profileRef: "team-research", workspaceId: WS, at: AT };
    for (const discussion of [{ state: "creating" as const, ...d }, { state: "unresolved" as const, ...d, checkedAt: AT }, { state: "failed" as const, ...d, error: "refused" }]) {
      expect(discussAvailability(feature({ grillSessionId: "S1", discussion })), discussion.state).not.toBe("open");
    }
  });
});

describe("DiscussionControls", () => {
  it("one click with a default profile calls feature.discussion.open once, without a profile, then opens the session", async () => {
    const m = await load();
    h.state.answers["feature.discussion.open"] = created("S1");
    const c = controls(m, feature(), "team-research");
    await press(button(c.render(), /^Discuss$/));
    expect(h.state.calls).toEqual([{ name: "feature.discussion.open", input: { projectId: P, featureId: "f1", workspaceId: WS, expectedRevision: 9 } }]);
    expect(c.opened).toEqual(["S1"]);
  });

  it("Discuss with… offers the saved profiles and passes the chosen one", async () => {
    const m = await load();
    h.state.answers["feature.discussion.open"] = created("S2");
    const c = controls(m, feature(), "team-research");
    await press(button(c.render(), /^Discuss with/));
    expect(h.state.calls).toEqual([]);
    await press(button(c.render(), /^Planner$/));
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.calls[0].input).toMatchObject({ featureId: "f1", workspaceId: WS, profileRef: "team-planner" });
    expect(c.opened).toEqual(["S2"]);
  });

  it("without a default, Discuss shows the choice with the settings hint and calls nothing until a profile is chosen", async () => {
    const m = await load();
    h.state.answers["feature.discussion.open"] = created("S3");
    const c = controls(m, feature(), undefined);
    await press(button(c.render(), /^Discuss$/));
    expect(h.state.calls).toEqual([]);
    const tree = c.render();
    expect(allText(tree)).toMatch(/Set a default under Settings/);
    await press(button(tree, /^Research$/));
    expect(h.state.calls[0].input).toMatchObject({ profileRef: "team-research" });
  });

  it("a bound chat opens its session with no call", async () => {
    const m = await load();
    const c = controls(m, feature(bound()), "team-research");
    const candidates = buttons(c.render()).filter((b) => typeof b.props.label === "string" && /discuss|open/i.test(b.props.label));
    expect(candidates).toHaveLength(1);
    await press(candidates[0]);
    expect(h.state.calls).toEqual([]);
    expect(c.opened).toEqual(["S1"]);
  });

  it("while a creation is pending the controls are disabled, so a second press cannot start another", async () => {
    const m = await load();
    let release: (v: unknown) => void = () => undefined;
    h.state.answers["feature.discussion.open"] = () => new Promise((resolve) => (release = resolve));
    const c = controls(m, feature(), "team-research");
    await press(button(c.render(), /^Discuss$/));
    const during = buttons(c.render()).filter((b) => typeof b.props.label === "string" && /^Discuss/.test(b.props.label));
    expect(during.length).toBeGreaterThan(0);
    for (const b of during) expect(b.props.disabled, String(b.props.label)).toBe(true);
    release({ ok: true, value: { revision: 11, sessionId: "S1", agentId: "agent-1", workspaceId: WS, created: true, tools: "attached" } });
    await flush();
    expect(h.state.calls).toHaveLength(1);
  });

  it("a refusal is shown as the server words it and opens nothing", async () => {
    const m = await load();
    const message = "the discussion chat's creation is unresolved: no agent with its reservation was found, which does not prove none was created.";
    h.state.answers["feature.discussion.open"] = () => ({ ok: false, error: { code: "invalid_input", message } });
    const c = controls(m, feature({ discussion: { state: "unresolved", reservationId: "r1", profileRef: "team-research", workspaceId: WS, at: AT, checkedAt: AT }, grillSessionId: "S1" }), "team-research");
    await press(button(c.render(), /^Discuss$/));
    expect(c.opened).toEqual([]);
    expect(h.state.toasts.join("\n")).toContain("unresolved");
  });

  it("renders nothing for a bug card", async () => {
    const m = await load();
    const c = controls(m, feature({ kind: "bug" }), "team-research");
    expect(buttons(c.render())).toEqual([]);
  });

  it("the controls are accessible buttons in wrapping rows, and nothing reads the host directly", async () => {
    const m = await load();
    const c = controls(m, feature(), "team-research");
    await press(button(c.render(), /^Discuss with/));
    const tree = c.render();
    for (const row of all(tree, (el) => nameOf(el) === "View" && all(el.props.children, (x) => nameOf(x) === "ActionButton").length > 1 && Array.isArray(el.props.children))) {
      const style = [row.props.style].flat().find((s): s is Record<string, unknown> => isRecord(s) && "flexWrap" in s);
      expect(style?.flexWrap, "a row of controls wraps on narrow screens").toBe("wrap");
    }
    expect(buttons(tree).every((b) => typeof b.props.label === "string" && b.props.label !== "")).toBe(true);
    expect(h.state.paseoReads).toBe(0);
  });
});

// Owner decision: an unresolved creation is created again only after the owner explicitly confirms
// that no chat was created; a plain Discuss press never carries that confirmation.
describe("DiscussionControls on an unresolved creation", () => {
  const unresolved = () => feature({ grillSessionId: "S1", discussion: { state: "unresolved", reservationId: "r1", profileRef: "team-research", workspaceId: WS, at: AT, checkedAt: AT } });
  const confirmControl = (tree: unknown) => buttons(tree).filter((b) => typeof b.props.label === "string" && /no chat|confirm/i.test(b.props.label));

  it("a plain Discuss press carries no confirmation", async () => {
    const m = await load();
    h.state.answers["feature.discussion.open"] = () => ({ ok: false, error: { code: "invalid_input", message: "the discussion chat's creation is unresolved" } });
    const c = controls(m, unresolved(), "team-research");
    await press(button(c.render(), /^Discuss$/));
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.calls[0].input).not.toHaveProperty("confirmedNoChat");
    expect(c.opened).toEqual([]);
  });

  it("offers an explicit, labelled confirmation that no chat was created; only it creates again", async () => {
    const m = await load();
    h.state.answers["feature.discussion.open"] = created("S9");
    const c = controls(m, unresolved(), "team-research");
    const tree = c.render();
    const confirm = confirmControl(tree);
    expect(confirm).toHaveLength(1);
    expect(h.state.calls).toEqual([]);
    await press(confirm[0]);
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.calls[0]).toMatchObject({ name: "feature.discussion.open", input: { featureId: "f1", workspaceId: WS, expectedRevision: 9, retryUnresolved: true, confirmedNoChat: true } });
    expect(c.opened).toEqual(["S9"]);
  });

  it("no confirmation is offered for a new, creating or bound discussion", async () => {
    const m = await load();
    const d = { reservationId: "r1", profileRef: "team-research", workspaceId: WS, at: AT };
    for (const f of [feature(), feature({ grillSessionId: "S1", discussion: { state: "creating", ...d } }), feature(bound())]) {
      expect(confirmControl(controls(m, f, "team-research").render()), String(f.discussion?.state ?? "none")).toEqual([]);
    }
  });

  it("the confirmation is disabled while it is being sent, so it cannot create twice", async () => {
    const m = await load();
    let release: (v: unknown) => void = () => undefined;
    h.state.answers["feature.discussion.open"] = () => new Promise((resolve) => (release = resolve));
    const c = controls(m, unresolved(), "team-research");
    await press(confirmControl(c.render())[0]);
    for (const b of confirmControl(c.render())) expect(b.props.disabled).toBe(true);
    release({ ok: true, value: { revision: 11, sessionId: "S9", agentId: "agent-2", workspaceId: WS, created: true, tools: "pending" } });
    await flush();
    expect(h.state.calls).toHaveLength(1);
  });
});

// Review regression: a press on a stale "creating" reservation is where the server records the
// creation as unresolved and refuses; the panel must refetch then, so it shows the unresolved state
// (and the owner's confirmation) at the store's new revision instead of a stale "creating".
describe("DiscussionControls after a refusal that changed the record", () => {
  it("refetches the roadmap after the server refuses a press on a creation that turned out unresolved", async () => {
    const m = await load();
    h.state.answers["feature.discussion.open"] = () => ({ ok: false, error: { code: "invalid_input", message: "the discussion chat's creation is unresolved: no agent with its reservation was found" } });
    const c = controls(m, feature({ grillSessionId: "S1", discussion: { state: "creating", reservationId: "r1", profileRef: "team-research", workspaceId: WS, at: AT } }), "team-research");
    await press(button(c.render(), /^Discuss$/));
    expect(h.state.invalidations).toBeGreaterThan(0);
  });
});

// Review regression: "not attached" is also reported for a chat whose grant was issued and later
// invalidated (the MCP endpoint's port rotation marks earlier grants stale; see
// server/discussion-tools-accuracy.test.ts), so the note after Discuss never claims that none was
// ever issued. It may still say the chat has no roadmap tools.
const CLAIMS_NONE_ISSUED = /none (were|was) issued|never issued|(were|was) not issued|no (grant|tools?) (were|was) (ever )?issued/i;
describe("toolsNote for a chat without its roadmap tools", () => {
  it("does not claim that none were ever issued", async () => {
    const mod: unknown = await import(/* @vite-ignore */ modulePath);
    const note: unknown = isRecord(mod) ? mod.toolsNote : undefined;
    if (typeof note !== "function") throw new Error("missing export: discussion-controls.toolsNote");
    const text: unknown = Reflect.apply(note, undefined, ["not_attached"]);
    expect(typeof text).toBe("string");
    expect(String(text)).not.toMatch(CLAIMS_NONE_ISSUED);
    expect(String(text)).toMatch(/no roadmap tools|not attached|does not have/i);
  });
});

// Discussion language (owner choices, 2026-11-08): no picker while English is the only language;
// with additional languages from settings (the `languages` prop, English first, as the planner
// addendum names it) a simple picker shows them, English by default, and the chosen one is passed
// to feature.discussion.open, also through "Discuss with…".
describe("DiscussionControls language picker", () => {
  const pressables = (tree: unknown) => all(tree, (el) => typeof el.props.onPress === "function");
  const labelled = (tree: unknown, label: RegExp) =>
    pressables(tree).filter((el) => label.test(typeof el.props.label === "string" ? el.props.label : textOf(el.props.children)));
  const render = (m: Awaited<ReturnType<typeof load>>, languages: string[]) => {
    const opened: string[] = [];
    const r = mount(m.DiscussionControls, { hostId: HOST, projectId: P, workspaceId: WS, feature: feature(), revision: 9, defaultProfile: "team-research", languages, theme, onOpened: (id: string) => void opened.push(id) });
    return { render: r, opened };
  };

  it("with English alone there is no picker and the call carries no other language", async () => {
    const m = await load();
    h.state.answers["feature.discussion.open"] = created("S1");
    const c = render(m, ["English"]);
    const tree = c.render();
    expect(allText(tree)).not.toMatch(/language/i);
    await press(button(tree, /^Discuss$/));
    expect(h.state.calls).toHaveLength(1);
    const language: unknown = h.state.calls[0].input.language;
    expect(language === undefined || (typeof language === "string" && /^(en|english)$/i.test(language))).toBe(true);
  });

  it("with an additional language the picker shows both; Discuss passes English by default", async () => {
    const m = await load();
    h.state.answers["feature.discussion.open"] = created("S1");
    const c = render(m, ["English", "Русский"]);
    const tree = c.render();
    expect(labelled(tree, /^English$/)).toHaveLength(1);
    expect(labelled(tree, /^Русский$/)).toHaveLength(1);
    // Review regression (KensAI c0027): the owner sees which language is selected.
    expect(labelled(tree, /^English$/)[0].props.selected).toBe(true);
    expect(labelled(tree, /^Русский$/)[0].props.selected).not.toBe(true);
    await press(labelled(tree, /^Русский$/)[0]);
    expect(labelled(c.render(), /^Русский$/)[0].props.selected).toBe(true);
    expect(labelled(c.render(), /^English$/)[0].props.selected).not.toBe(true);
    await press(labelled(c.render(), /^English$/)[0]);
    await press(button(c.render(), /^Discuss$/));
    const language: unknown = h.state.calls[0].input.language;
    expect(language === undefined || (typeof language === "string" && /^(en|english)$/i.test(language))).toBe(true);
  });

  it("the chosen language is passed by Discuss and by Discuss with…", async () => {
    const m = await load();
    h.state.answers["feature.discussion.open"] = created("S1");
    const c = render(m, ["English", "Русский"]);
    expect(labelled(c.render(), /^Русский$/)).toHaveLength(1);
    await press(labelled(c.render(), /^Русский$/)[0]);
    await press(button(c.render(), /^Discuss$/));
    expect(h.state.calls[0].input).toMatchObject({ language: "Русский" });

    const d = render(m, ["English", "Русский"]);
    await press(labelled(d.render(), /^Русский$/)[0]);
    await press(button(d.render(), /^Discuss with/));
    await press(button(d.render(), /^Planner$/));
    expect(h.state.calls[1].input).toMatchObject({ language: "Русский", profileRef: "team-planner" });
  });
});

// Review regression (KensAI c0004), client side: the confirmed retry of an unresolved creation sends
// the language selected on the card, in the one call, with no extra prompt.
describe("DiscussionControls confirmed retry language", () => {
  it("the confirmed retry passes the selected language in its single call", async () => {
    const m = await load();
    h.state.answers["feature.discussion.open"] = created("S1");
    const unresolved = feature({ grillSessionId: "S1", discussion: { state: "unresolved", reservationId: "r1", profileRef: "team-research", workspaceId: WS, at: AT, checkedAt: AT } });
    const c = mount(m.DiscussionControls, { hostId: HOST, projectId: P, workspaceId: WS, feature: unresolved, revision: 9, defaultProfile: "team-research", languages: ["English", "Русский"], theme, onOpened: () => undefined });
    await press(button(c(), /^Русский$/));
    await press(button(c(), /no chat was created/i));
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.calls[0].input).toMatchObject({ language: "Русский", retryUnresolved: true, confirmedNoChat: true });
  });
});
