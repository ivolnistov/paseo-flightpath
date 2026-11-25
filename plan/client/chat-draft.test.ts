// "Discuss in chat" adapter (useChatDraft / useDiscussInChat) against a composer modelled on the
// 0.16 host: `prompt` is the snapshot taken when the composer was resolved, while focus/insertText
// act on the live draft (cursor + selection; insertText replaces the selection; focus applies the
// requested selection clamped to the text). A re-render resolves a fresh snapshot.
//
// Node harness: React hooks are replaced by a small slot-based implementation with persistent refs,
// dependency-keyed callbacks/memos and effects, so stale-closure races behave as in React.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Selection = { start: number; end: number };
type Snapshot = {
  readonly prompt: string;
  insertText(text: string): void;
  focus(options?: { selection?: Selection }): Promise<void>;
  [k: string]: unknown;
};

/** One hook's state in the node harness, by kind. */
type HarnessSlot =
  | { kind: "state"; value: unknown }
  | { kind: "ref"; ref: { current: unknown } }
  | { kind: "memo"; value: unknown; deps: unknown[] | undefined }
  | { kind: "effect"; deps: unknown[] | undefined; cleanup: unknown; fresh: boolean };

const h = vi.hoisted(() => {
  const state = {
    slots: [] as HarnessSlot[],
    index: 0,
    dirty: false,
    effects: [] as Array<() => void>,
    toasts: [] as Array<{ kind: "show" | "error"; text: string }>,
    useComposers: ((selector: unknown) => {
      void selector;
      return [] as unknown[];
    }) as (selector: unknown) => readonly unknown[],
    selectors: [] as unknown[],
    paseoReads: 0,
  };
  const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) => a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const call = (fn: unknown, ...args: unknown[]): unknown => {
    if (typeof fn !== "function") return fn;
    const out: unknown = Reflect.apply(fn, undefined, args);
    return out;
  };
  const next = <K extends HarnessSlot["kind"]>(kind: K): HarnessSlot | undefined => {
    const i = state.index++;
    const found = state.slots[i];
    if (found !== undefined && found.kind !== kind) throw new Error(`hook order changed at ${i}`);
    return found;
  };
  const put = (slot: HarnessSlot) => {
    state.slots[state.index - 1] = slot;
  };
  const react = {
    useState(init: unknown): [unknown, (value: unknown) => void] {
      let s = next("state");
      if (s?.kind !== "state") {
        s = { kind: "state", value: typeof init === "function" ? call(init) : init };
        put(s);
      }
      const slot = s;
      const set = (value: unknown) => {
        const v = typeof value === "function" ? call(value, slot.value) : value;
        if (!Object.is(v, slot.value)) {
          slot.value = v;
          state.dirty = true;
        }
      };
      return [slot.value, set];
    },
    useRef(init: unknown): { current: unknown } {
      let s = next("ref");
      if (s?.kind !== "ref") {
        s = { kind: "ref", ref: { current: init } };
        put(s);
      }
      return s.ref;
    },
    useMemo(fn: () => unknown, deps?: unknown[]): unknown {
      let s = next("memo");
      if (s?.kind !== "memo" || !sameDeps(s.deps, deps)) {
        s = { kind: "memo", value: fn(), deps };
        put(s);
      }
      return s.value;
    },
    useCallback(fn: unknown, deps?: unknown[]): unknown {
      return react.useMemo(() => fn, deps);
    },
    useEffect(fn: () => unknown, deps?: unknown[]): void {
      let s = next("effect");
      if (s?.kind !== "effect") {
        s = { kind: "effect", deps: undefined, cleanup: undefined, fresh: true };
        put(s);
      }
      const slot = s;
      if (slot.fresh || !sameDeps(slot.deps, deps)) {
        state.effects.push(() => {
          if (typeof slot.cleanup === "function") call(slot.cleanup);
          slot.deps = deps;
          slot.fresh = false;
          slot.cleanup = fn();
        });
      }
    },
  };
  return { state, react };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const original: unknown = real.default;
  return { ...real, ...h.react, default: { ...(typeof original === "object" && original !== null ? original : {}), ...h.react } };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  useToast: () => ({
    show: (text: string) => void h.state.toasts.push({ kind: "show", text }),
    error: (text: string) => void h.state.toasts.push({ kind: "error", text }),
  }),
}));
vi.mock("@getpaseo/plugin/client", () => {
  const base = {
    usePaseo: () => {
      h.state.paseoReads++;
      return {};
    },
  };
  return {
    ...base,
    useComposers: (selector: unknown) => {
      h.state.selectors.push(selector);
      return h.state.useComposers(selector);
    },
  };
});

/**
 * A host composer for one agent, after the 0.16 web app: `prompt` is the draft store's text when the
 * composer was resolved; the live input has its own text and selection, `focus` applies the
 * requested selection to the live text (clamped), and `insertText` inserts at the live selection
 * (the host's insertAtSelection on the input snapshot). Typed text reaches the store when published.
 */
function hostComposer(agentId: string, initial: { text: string; selection?: Selection }) {
  const live = { text: initial.text, selection: initial.selection ?? { start: initial.text.length, end: initial.text.length } };
  const store = { text: initial.text };
  const log: string[] = [];
  let focusGate: { promise: Promise<void>; resolve(): void; reject(e: unknown): void } | null = null;
  let focusError: unknown = null;
  let insertError: unknown = null;
  let focusCount = 0;
  const focusRequests: Array<{ selection?: Selection }> = [];
  const hooks: { beforeSelection: ((n: number) => void) | null; afterSelection: ((n: number) => void) | null } = { beforeSelection: null, afterSelection: null };
  const forbidden = ["setPrompt", "setProvider", "setModel", "setMode", "setThinking", "setOptions", "setMetadata", "addAttachment", "removeAttachment"];
  let current: Snapshot | null = null;
  const snapshot = (): Snapshot => {
    const s: Snapshot = {
      context: "agent",
      prompt: store.text,
      attachments: [],
      agent: { provider: "p", model: "m", mode: "default", thinking: null, options: {}, metadata: {} },
      insertText(text: string) {
        log.push(`insert ${JSON.stringify(text)}`);
        if (insertError !== null) throw insertError;
        const { start, end } = live.selection;
        live.text = live.text.slice(0, start) + text + live.text.slice(end);
        const at = start + text.length;
        live.selection = { start: at, end: at };
        store.text = live.text;
      },
      async focus(options?: { selection?: Selection }) {
        const n = ++focusCount;
        focusRequests.push({ ...options });
        log.push(`focus ${JSON.stringify(options ?? null)}`);
        if (focusGate !== null) await focusGate.promise;
        if (focusError !== null) throw focusError;
        hooks.beforeSelection?.(n);
        if (options?.selection !== undefined) {
          const clamp = (x: number) => Math.max(0, Math.min(x, live.text.length));
          live.selection = { start: clamp(options.selection.start), end: clamp(options.selection.end) };
        }
        hooks.afterSelection?.(n);
      },
    };
    for (const name of forbidden) s[name] = (..._args: unknown[]) => void log.push(`FORBIDDEN ${name}`);
    return s;
  };
  return {
    agentId,
    live,
    store,
    log,
    hooks,
    focusCount: () => focusCount,
    focusRequests,
    /** The composer the host resolves now (a new snapshot whenever the stored draft changed). */
    resolve(): Snapshot {
      if (current === null || current.prompt !== store.text) current = snapshot();
      return current;
    },
    /** The person types at the cursor; the store sees it at once unless `unpublished`. */
    type(text: string, opts: { unpublished?: boolean } = {}) {
      const { start, end } = live.selection;
      live.text = live.text.slice(0, start) + text + live.text.slice(end);
      live.selection = { start: start + text.length, end: start + text.length };
      if (opts.unpublished !== true) store.text = live.text;
    },
    /** The input mounts with another saved draft (store and input agree on it). */
    hydrate(text: string) {
      live.text = text;
      live.selection = { start: text.length, end: text.length };
      store.text = text;
    },
    holdFocus() {
      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
      focusGate = { promise, resolve, reject };
      return {
        release: () => {
          focusGate = null;
          resolve();
        },
        fail: (e: unknown) => {
          focusGate = null;
          reject(e);
        },
      };
    },
    failFocus(e: unknown) {
      focusError = e;
    },
    failInsert(e: unknown) {
      insertError = e;
    },
  };
}
type HostComposer = ReturnType<typeof hostComposer>;

function hostWith(...composers: HostComposer[]) {
  h.state.useComposers = (selector: unknown) => {
    const id = typeof selector === "object" && selector !== null && "agentId" in selector ? (selector as { agentId: unknown }).agentId : undefined;
    return composers.filter((c) => c.agentId === id).map((c) => c.resolve());
  };
}

function mount<P, R>(hook: (props: P) => R, initial: NoInfer<P>) {
  const slots: HarnessSlot[] = [];
  let props = initial;
  let out!: R;
  const render = (next?: P): R => {
    if (next !== undefined) props = next;
    h.state.slots = slots;
    for (let pass = 0; pass < 30; pass++) {
      h.state.index = 0;
      h.state.dirty = false;
      h.state.effects = [];
      out = hook(props);
      for (const fn of h.state.effects) fn();
      if (!h.state.dirty) return out;
    }
    throw new Error("did not settle");
  };
  render();
  return { render, current: () => out };
}

const BLOCK = "--- Roadmap question Q3 ---\nQuestion: Q3 \"Pick a database\"\nCurrent answer: none (status: Open)\nLink: roadmap://prj/s/S/q/3\n--- End of roadmap question Q3 ---";
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

type PlaceResult = { ok: true } | { ok: false; reason: string; message: string };
/** The module's surface under test, checked at run time: a variable-path import keeps the client module out of the node type check. */
interface ChatDraftApi {
  useChatDraft(agentId: string | null): { availability: string; place(block: string): Promise<PlaceResult> };
  useDiscussInChat(agentId: string | null): { availability: string; discuss(block: string): Promise<boolean> };
  UNSUPPORTED_MESSAGE: string;
  UNAVAILABLE_MESSAGE: string;
  PLACED_MESSAGE: string;
}
const isChatDraftApi = (m: unknown): m is ChatDraftApi =>
  typeof m === "object" &&
  m !== null &&
  ["useChatDraft", "useDiscussInChat"].every((k) => typeof Reflect.get(m, k) === "function") &&
  ["UNSUPPORTED_MESSAGE", "UNAVAILABLE_MESSAGE", "PLACED_MESSAGE"].every((k) => typeof Reflect.get(m, k) === "string");
const modulePath = "./chat-draft";
async function load(): Promise<ChatDraftApi> {
  const mod: unknown = await import(/* @vite-ignore */ modulePath);
  if (!isChatDraftApi(mod)) throw new Error("client/chat-draft does not export the expected API");
  return mod;
}

beforeEach(() => {
  h.state.toasts = [];
  h.state.selectors = [];
  h.state.paseoReads = 0;
  hostWith();
});

describe("useChatDraft: target", () => {
  it("asks the host for exactly the bound agent's composer, never the focused one", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "" });
    const b = hostComposer("agent-b", { text: "" });
    hostWith(a, b);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-b");
    expect(view.current().availability).toBe("ready");
    expect(h.state.selectors.every((s) => JSON.stringify(s) === JSON.stringify({ agentId: "agent-b" }))).toBe(true);
    await expect(view.current().place(BLOCK)).resolves.toEqual({ ok: true });
    // The block always starts after a blank line, an empty draft included.
    expect(b.live.text).toBe(`\n\n${BLOCK}`);
    expect(a.live.text).toBe("");
    expect(a.log).toEqual([]);
  });

  it("no planner: names no agent, is unavailable, and touches no composer", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "mine" });
    // A host that would hand out a composer for any selector must still not be used.
    h.state.useComposers = () => [a.resolve()];
    const view = mount((id: string | null) => m.useChatDraft(id), null);
    expect(h.state.selectors).toEqual([{ agentId: "" }]);
    expect(view.current().availability).toBe("unavailable");
    const out = await view.current().place(BLOCK);
    expect(out).toEqual({ ok: false, reason: "unavailable", message: m.UNAVAILABLE_MESSAGE });
    expect(a.log).toEqual([]);
    expect(a.live.text).toBe("mine");
  });

  it("an unknown or archived agent (no composer) is unavailable and nothing is changed", async () => {
    const m = await load();
    const other = hostComposer("agent-other", { text: "keep" });
    hostWith(other);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-gone");
    expect(view.current().availability).toBe("unavailable");
    expect(await view.current().place(BLOCK)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(other.log).toEqual([]);
  });

  it("more than one composer for the selector is not guessed between", async () => {
    const m = await load();
    const one = hostComposer("agent-a", { text: "1" });
    const two = hostComposer("agent-a", { text: "2" });
    hostWith(one, two);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    expect(view.current().availability).toBe("unavailable");
    expect(await view.current().place(BLOCK)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(one.log).toEqual([]);
    expect(two.log).toEqual([]);
  });

  it("a surface outside the host's composer source (the hook throws) is unsupported", async () => {
    const m = await load();
    h.state.useComposers = () => {
      throw new Error("useComposers must run inside a plugin component");
    };
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    expect(view.current().availability).toBe("unsupported");
    expect(await view.current().place(BLOCK)).toEqual({ ok: false, reason: "unsupported", message: m.UNSUPPORTED_MESSAGE });
  });

  it("the planner changing between renders retargets: a press after the change uses the new chat only", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "A draft" });
    const b = hostComposer("agent-b", { text: "B draft" });
    hostWith(a, b);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    const pressedEarlier = view.current().place;
    view.render("agent-b");
    await pressedEarlier(BLOCK);
    expect(a.log).toEqual([]);
    expect(b.live.text).toBe(`B draft\n\n${BLOCK}`);
  });

  it("the planner removed after render: an earlier-captured place does not write anywhere", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "A draft" });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    const captured = view.current().place;
    view.render(null);
    expect(await captured(BLOCK)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(a.log).toEqual([]);
  });
});

describe("useChatDraft: the draft is preserved", () => {
  it("existing text with a non-empty selection survives; the cursor is moved to the end before inserting", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "Please compare these two", selection: { start: 7, end: 14 } });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    await expect(view.current().place(BLOCK)).resolves.toEqual({ ok: true });
    expect(a.live.text).toBe(`Please compare these two\n\n${BLOCK}`);
    // Observable placement, not a specific offset: one focus that collapses the cursor at or past
    // the draft's end (the host clamps offsets to the text), then one insert of the separated block.
    expect(a.log.map((l) => l.split(" ")[0])).toEqual(["focus", "insert"]);
    expect(a.focusRequests).toHaveLength(1);
    const sel = a.focusRequests[0]?.selection;
    if (sel === undefined) throw new Error("focus requested no selection");
    expect(sel.start).toBe(sel.end);
    expect(sel.start).toBeGreaterThanOrEqual("Please compare these two".length);
    expect(a.log[1]).toBe(`insert ${JSON.stringify(`\n\n${BLOCK}`)}`);
    expect(a.live.selection).toEqual({ start: a.live.text.length, end: a.live.text.length });
  });

  it("always inserts a blank line and then the block, once, keeping every draft character for each draft ending", async () => {
    const m = await load();
    for (const text of ["", "one line", "ends with newline\n", "ends with paragraph\n\n"]) {
      const a = hostComposer("agent-a", { text, selection: { start: 0, end: 0 } });
      hostWith(a);
      const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
      await view.current().place(BLOCK);
      // Extra blank lines are acceptable; a missing separator or a lost draft character is not.
      expect(a.live.text, JSON.stringify(text)).toBe(`${text}\n\n${BLOCK}`);
      expect(a.log.filter((l) => l.startsWith("insert")), JSON.stringify(text)).toEqual([`insert ${JSON.stringify(`\n\n${BLOCK}`)}`]);
    }
  });

  it("a second Discuss appends a second block after the first, keeping both", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "start" });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    await view.current().place("BLOCK-1");
    view.render();
    await view.current().place("BLOCK-2");
    expect(a.live.text).toBe("start\n\nBLOCK-1\n\nBLOCK-2");
  });

  it("nothing is sent and no agent setting is changed", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "x" });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    await view.current().place(BLOCK);
    expect(a.log.filter((l) => l.startsWith("FORBIDDEN"))).toEqual([]);
    expect(h.state.paseoReads).toBe(0);
  });

  it("a failed focus leaves the draft unchanged, inserts nothing and says so", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "keep me", selection: { start: 0, end: 4 } });
    a.failFocus(new Error("The composer did not come on screen."));
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    const out = await view.current().place(BLOCK);
    expect(out).toMatchObject({ ok: false, reason: "focus" });
    expect(out.ok ? "" : out.message).toMatch(/could not be focused \(The composer did not come on screen\.\)\. The draft was not changed\./);
    expect(a.live.text).toBe("keep me");
    expect(a.log.some((l) => l.startsWith("insert"))).toBe(false);
  });

  it("a failed insert reports an accurate error and sends nothing", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "keep me" });
    a.failInsert(new Error("locked"));
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    const out = await view.current().place(BLOCK);
    expect(out).toMatchObject({ ok: false, reason: "insert" });
    expect(out.ok ? "" : out.message).toMatch(/\(locked\)\. Check the draft before sending\./);
    expect(a.live.text).toBe("keep me");
    expect(h.state.paseoReads).toBe(0);
  });

  it("a press while a placement waits for focus is refused as busy; one block is placed", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "draft" });
    const gate = a.holdFocus();
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    const first = view.current().place(BLOCK);
    await flush();
    expect(await view.current().place(BLOCK)).toMatchObject({ ok: false, reason: "busy" });
    gate.release();
    expect(await first).toEqual({ ok: true });
    expect(a.live.text).toBe(`draft\n\n${BLOCK}`);
    // After it settles, another press works again.
    view.render();
    expect(await view.current().place("again")).toEqual({ ok: true });
  });

  it("a rejected focus wait releases the busy guard", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "draft" });
    const gate = a.holdFocus();
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    const first = view.current().place(BLOCK);
    await flush();
    gate.fail(new Error("gone"));
    expect(await first).toMatchObject({ ok: false, reason: "focus" });
    expect(a.live.text).toBe("draft");
    expect(await view.current().place(BLOCK)).toEqual({ ok: true });
    expect(a.live.text).toBe(`draft\n\n${BLOCK}`);
  });

  it("the person types while the chat is being focused: the newer draft stays whole and the block goes after it", async () => {
    // Race: the prompt is read at the press, the host reveals and focuses the chat, and the draft
    // grows meanwhile (typing, or the input hydrating a newer draft). Placing the cursor at the old
    // prompt's length then inserts the block in the middle of the newer draft.
    const m = await load();
    const a = hostComposer("agent-a", { text: "Draft" });
    const gate = a.holdFocus();
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    const placing = view.current().place(BLOCK);
    await flush();
    a.type(" and more");
    view.render();
    gate.release();
    expect(await placing).toEqual({ ok: true });
    expect(a.live.text).toBe(`Draft and more\n\n${BLOCK}`);
  });
});

// The draft changing between the press and the insert. Host facts these cases rely on (0.16 web
// app): `focus` on a chat that is not on screen navigates to the agent's tab and applies the
// requested selection when the input attaches; the selection is clamped to the live text;
// `insertText` inserts at the input's live selection; a panel that is no longer rendered sees no
// newer composer (useComposers is a hook, and panels get no other composer source).
describe("useChatDraft: the draft changes while the chat is being focused", () => {
  it("a newline-ended growth keeps every draft character and the block still follows a blank line", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "Draft" });
    const gate = a.holdFocus();
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    const placing = view.current().place(BLOCK);
    await flush();
    a.type(" line\n");
    view.render();
    gate.release();
    expect(await placing).toEqual({ ok: true });
    expect(a.live.text).toBe(`Draft line\n\n\n${BLOCK}`);
  });

  it("text typed after the cursor was placed is kept before the block (the insert follows the live cursor)", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "Draft" });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    a.hooks.afterSelection = (n) => {
      if (n === 1) {
        a.type(" typed");
        view.render();
      }
    };
    expect(await view.current().place(BLOCK)).toEqual({ ok: true });
    expect(a.live.text).toBe(`Draft typed\n\n${BLOCK}`);
  });

  it("text typed after the cursor was placed is kept even when the panel saw no newer draft", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "Draft" });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    a.hooks.afterSelection = (n) => {
      if (n === 1) a.type(" typed", { unpublished: true });
    };
    expect(await view.current().place(BLOCK)).toEqual({ ok: true });
    // The block is always prefixed with a blank line, whatever the panel last saw.
    expect(a.live.text).toBe(`Draft typed\n\n${BLOCK}`);
  });

  it("a draft that settles within the bound: four focus calls, then the block after the final text", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "v0" });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    a.hooks.beforeSelection = (n) => {
      if (n <= 3) {
        a.hydrate(`v${n}`);
        view.render();
      }
    };
    expect(await view.current().place(BLOCK)).toEqual({ ok: true });
    expect(a.focusCount()).toBe(4);
    expect(a.live.text).toBe(`v3\n\n${BLOCK}`);
    expect(a.log.filter((l) => l.startsWith("insert"))).toHaveLength(1);
  });

  it("a draft that keeps changing: at most four focus calls, nothing inserted, an accurate message", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "v0" });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    a.hooks.beforeSelection = (n) => {
      a.hydrate(`v${n}`);
      view.render();
    };
    const out = await view.current().place(BLOCK);
    expect(out).toMatchObject({ ok: false, reason: "changed" });
    expect(out.ok ? "" : out.message).toMatch(/kept changing.*not changed/);
    expect(a.focusCount()).toBe(4);
    expect(a.log.some((l) => l.startsWith("insert"))).toBe(false);
    expect(a.live.text).toBe("v4");
    // The guard is released: a later press with a quiet draft works.
    a.hooks.beforeSelection = null;
    view.render();
    expect(await view.current().place(BLOCK)).toEqual({ ok: true });
  });

  it("the planner rebinds to another chat during focus: nothing is inserted in either chat", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "A" });
    const b = hostComposer("agent-b", { text: "B" });
    const gate = a.holdFocus();
    hostWith(a, b);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    const placing = view.current().place(BLOCK);
    await flush();
    view.render("agent-b");
    gate.release();
    const out = await placing;
    expect(out).toMatchObject({ ok: false, reason: "unavailable" });
    expect(out.ok ? "" : out.message).toMatch(/changed or became unavailable.*not changed/);
    expect(a.live.text).toBe("A");
    expect(b.live.text).toBe("B");
    expect(b.log).toEqual([]);
  });

  it("the planner unbound during focus: nothing is inserted", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "A" });
    const gate = a.holdFocus();
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    const placing = view.current().place(BLOCK);
    await flush();
    view.render(null);
    gate.release();
    expect(await placing).toMatchObject({ ok: false, reason: "unavailable" });
    expect(a.live.text).toBe("A");
  });

  it("the chat archived during focus (no composer any more): nothing is inserted", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "A" });
    const gate = a.holdFocus();
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    const placing = view.current().place(BLOCK);
    await flush();
    hostWith();
    view.render();
    gate.release();
    expect(await placing).toMatchObject({ ok: false, reason: "unavailable" });
    expect(a.log.some((l) => l.startsWith("insert"))).toBe(false);
  });

  it("the panel unmounts when the chat is revealed and the draft is unchanged: the block is still placed after it", async () => {
    // Compact layouts: revealing the chat navigates away and the panel is no longer rendered.
    const m = await load();
    const a = hostComposer("agent-a", { text: "Draft", selection: { start: 0, end: 2 } });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    expect(await view.current().place(BLOCK)).toEqual({ ok: true });
    expect(a.live.text).toBe(`Draft\n\n${BLOCK}`);
  });

  it("the panel unmounts when the chat is revealed and the input loads a newer saved draft: the block goes after the newer draft", async () => {
    // Revealing navigates to the agent's tab; the panel is not rendered again, so the plugin's last
    // resolved composer keeps the old prompt. The input attaches with the newer draft and the
    // pending selection (the old prompt's length) is applied to it.
    const m = await load();
    const a = hostComposer("agent-a", { text: "Draft" });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    a.hooks.beforeSelection = (n) => {
      if (n === 1) a.hydrate("Draft saved on another device");
    };
    expect(await view.current().place(BLOCK)).toEqual({ ok: true });
    expect(a.live.text).toBe(`Draft saved on another device\n\n${BLOCK}`);
  });

  it("the panel unmounts on reveal and an empty prompt becomes a saved draft: the block is still its own paragraph", async () => {
    // The panel last saw an empty prompt; the cursor goes to the live end and the block must still be its own paragraph.
    const m = await load();
    const a = hostComposer("agent-a", { text: "" });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    a.hooks.beforeSelection = (n) => {
      if (n === 1) a.hydrate("Saved draft");
    };
    expect(await view.current().place(BLOCK)).toEqual({ ok: true });
    expect(a.live.text).toBe(`Saved draft\n\n${BLOCK}`);
  });

  it("unpublished typed text after a paragraph-ended prompt: the block is still its own paragraph", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "Intro\n\n" });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    a.type("more", { unpublished: true });
    expect(await view.current().place(BLOCK)).toEqual({ ok: true });
    expect(a.live.text).toBe(`Intro\n\nmore\n\n${BLOCK}`);
  });

  it("typed text not yet published to the draft store when the cursor is placed: the block goes after it", async () => {
    // On the web the input publishes typed text to the draft store after paint; until then the
    // composer's prompt, and so the plugin's cursor offset, is shorter than the live text.
    const m = await load();
    const a = hostComposer("agent-a", { text: "Draft" });
    hostWith(a);
    const view = mount((id: string | null) => m.useChatDraft(id), "agent-a");
    a.type(" and more", { unpublished: true });
    expect(await view.current().place(BLOCK)).toEqual({ ok: true });
    expect(a.live.text).toBe(`Draft and more\n\n${BLOCK}`);
  });
});

describe("useDiscussInChat: outcome reporting", () => {
  it("success shows the placed message and returns true", async () => {
    const m = await load();
    const a = hostComposer("agent-a", { text: "" });
    hostWith(a);
    const view = mount((id: string | null) => m.useDiscussInChat(id), "agent-a");
    expect(view.current().availability).toBe("ready");
    expect(await view.current().discuss(BLOCK)).toBe(true);
    expect(h.state.toasts).toEqual([{ kind: "show", text: m.PLACED_MESSAGE }]);
  });

  it("each failure is an error toast with its message and returns false", async () => {
    const m = await load();
    const view = mount((id: string | null) => m.useDiscussInChat(id), null);
    expect(await view.current().discuss(BLOCK)).toBe(false);
    expect(h.state.toasts).toEqual([{ kind: "error", text: m.UNAVAILABLE_MESSAGE }]);
  });
});

describe("hosts without the composer API", () => {
  it("a 0.15 SDK (no useComposers export) loads, is unsupported, and changes nothing", async () => {
    vi.resetModules();
    vi.doMock("@getpaseo/plugin/client", () => ({
      usePaseo: () => {
        h.state.paseoReads++;
        return {};
      },
    }));
    try {
      const m = await load();
      const view = mount((id: string | null) => m.useDiscussInChat(id), "agent-a");
      expect(view.current().availability).toBe("unsupported");
      expect(await view.current().discuss(BLOCK)).toBe(false);
      expect(h.state.toasts).toEqual([{ kind: "error", text: m.UNSUPPORTED_MESSAGE }]);
      expect(h.state.selectors).toEqual([]);
      expect(h.state.paseoReads).toBe(0);
    } finally {
      vi.doUnmock("@getpaseo/plugin/client");
      vi.resetModules();
    }
  });
});
