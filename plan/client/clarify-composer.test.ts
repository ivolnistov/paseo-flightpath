// Clarify in chat: an explicit question about Q<n> goes to the discussion chat only when the owner
// presses Send, as "Clarify Q<n> "<title>": <text>"; nothing is answered, no roadmap RPC is called,
// and nothing is sent on mount. "Open chat" appears only when the host can open the agent.
//
// Node harness: the REAL ClarifyComposer; React Native and host UI are inert markers; the host's
// agent send is a recording stub. Child components are not rendered; assertions read element props.
import { beforeEach, describe, expect, it, vi } from "vitest";

type El = { type: unknown; props: Record<string, unknown> };

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
    sends: [] as Array<{ agentId: string; text: string; options: unknown }>,
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
  usePaseo: () => (
    h.state.paseoReads++,
    { agents: { ref: (agentId: string) => ({ send: async (text: string, options?: unknown) => void h.state.sends.push({ agentId, text, options }) }) } }
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isError: false }),
  useQueryClient: () => ({ getQueryData: () => undefined, getQueriesData: () => [], invalidateQueries: async () => undefined }),
}));
vi.mock("./hooks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProfiles: () => ({ data: h.state.profiles, isPending: false, isError: false }),
}));

const theme = { colors: new Proxy({}, { get: () => "#000" }) };
const HOST = "h1";
const PROFILES = [{ id: "team-research", label: "Research" }];

beforeEach(() => {
  h.state.calls = [];
  h.state.toasts = [];
  h.state.answers = {};
  h.state.profiles = PROFILES;
  h.state.paseoReads = 0;
  h.state.sends = [];
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

const modulePath = "./clarify-composer";
async function load(): Promise<{ clarifyText: (n: number, title: string, text: string) => unknown; ClarifyComposer: (props: Record<string, unknown>) => unknown }> {
  const mod: unknown = await import(/* @vite-ignore */ modulePath);
  const pick = (name: string): ((...args: unknown[]) => unknown) => {
    const fn: unknown = isRecord(mod) ? mod[name] : undefined;
    if (typeof fn !== "function") throw new Error(`missing export: clarify-composer.${name}`);
    return (...args: unknown[]) => {
      const out: unknown = Reflect.apply(fn, undefined, args);
      return out;
    };
  };
  return { clarifyText: pick("clarifyText"), ClarifyComposer: pick("ClarifyComposer") };
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
const textInput = (tree: unknown): El => {
  const found = all(tree, (el) => nameOf(el) === "TextInput");
  expect(found).toHaveLength(1);
  return found[0];
};
const type = (tree: unknown, text: string) => {
  const onChange = textInput(tree).props.onChangeText;
  if (typeof onChange !== "function") throw new Error("not editable");
  Reflect.apply(onChange, undefined, [text]);
};

describe("clarifyText", () => {
  it("anchors the owner's question to the question number and title", async () => {
    const { clarifyText } = await load();
    expect(clarifyText(4, "Scope", "which hosts?")).toBe('Clarify Q4 "Scope": which hosts?');
    expect(clarifyText(4, "Scope", "  which hosts?  ")).toBe('Clarify Q4 "Scope": which hosts?');
  });
});

describe("ClarifyComposer", () => {
  const composer = async (extra: Record<string, unknown> = {}) => {
    const m = await load();
    return mount(m.ClarifyComposer, { hostId: HOST, agentId: "agent-1", number: 4, title: "Scope", theme, ...extra });
  };

  it("sends nothing on mount, and nothing for empty text", async () => {
    const render = await composer();
    const tree = render();
    expect(h.state.sends).toEqual([]);
    const send = button(tree, /send/i);
    expect(send.props.disabled).toBe(true);
    expect(h.state.calls).toEqual([]);
  });

  it("sends the anchored text to the discussion chat once, on an explicit press, and calls no roadmap RPC", async () => {
    const render = await composer();
    type(render(), "which hosts?");
    await press(button(render(), /send/i));
    expect(h.state.sends).toEqual([{ agentId: "agent-1", text: 'Clarify Q4 "Scope": which hosts?', options: undefined }]);
    expect(h.state.calls).toEqual([]);
    expect(allText(render())).toMatch(/nothing is answered/i);
  });

  it("Open chat appears only when the host can open the agent, and opens it", async () => {
    expect(buttons((await composer())()).filter((b) => /open chat/i.test(String(b.props.label)))).toEqual([]);
    let opened = 0;
    const render = await composer({ openAgent: () => void opened++ });
    await press(button(render(), /open chat/i));
    expect(opened).toBe(1);
    expect(h.state.sends).toEqual([]);
  });

  it("its controls are labelled buttons", async () => {
    const render = await composer({ openAgent: () => undefined });
    expect(buttons(render()).every((b) => typeof b.props.label === "string" && b.props.label !== "")).toBe(true);
  });
});
