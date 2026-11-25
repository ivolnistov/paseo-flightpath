// Question editor create path against grilling blocks (R0 closeout, card §10, KensAI c0079), in node.
// Minimal harness, following client/tracker-settings.test.ts: `react` keeps its real elements, but
// its state hooks are a tiny slot implementation; React Native and host UI are inert markers. The
// REAL QuestionEditor and the REAL useRoadmapMutation (client/hooks.ts) run. Only `useRpc` is
// replaced: it records each call and forwards it to the REAL createRoadmapService over a real temp
// project store, so the server's answer reaches the editor exactly as the contract would return it.
// Limitations: no reconciler, layout or host behaviour; child components are not rendered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type El = { type: unknown; props: Record<string, any> };
type Call = { name: string; input: Record<string, unknown>; result: any };

const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    dirty: false,
    calls: [] as Array<{ name: string; input: Record<string, unknown>; result: any }>,
    inflight: [] as Array<Promise<unknown>>,
    toasts: [] as string[],
    cacheRevision: null as number | null,
    service: null as any,
    paseo: null as any,
  };
  const useState = (init: unknown) => {
    const i = state.index++;
    if (!(i in state.slots)) state.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(state.slots[i]) : v;
      if (next !== state.slots[i]) {
        state.slots[i] = next;
        state.dirty = true;
      }
    };
    return [state.slots[i], set];
  };
  const marker = (name: string) => Object.assign(() => null, { displayName: name });
  const METHODS: Record<string, string> = { "question.create": "questionCreate", "question.update": "questionUpdate" };
  const useRpc = (contract: { name: string }) => (input: Record<string, unknown>) => {
    const method = METHODS[contract.name];
    if (!method) throw new Error(`unexpected RPC ${contract.name}`);
    const p = (state.service[method](state.paseo, input) as Promise<unknown>).then((result) => {
      state.calls.push({ name: contract.name, input, result });
      return result;
    });
    state.inflight.push(p);
    return p;
  };
  return { state, useState, marker, useRpc };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const passthrough = { useState: h.useState, useEffect: () => undefined, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (v: unknown) => ({ current: v }) };
  return { ...real, ...passthrough, default: { ...(real.default as object), ...passthrough } };
});
vi.mock("react-native", () => ({ Text: h.marker("Text"), View: h.marker("View"), Pressable: h.marker("Pressable") }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: h.marker("TextInput"),
  useToast: () => ({ show: (m: string) => void h.state.toasts.push(m), error: (m: string) => void h.state.toasts.push(m) }),
}));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: h.useRpc, useWorkspace: () => ({}) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({}),
  useQueryClient: () => ({
    getQueryData: (key: unknown[]) => (key.at(-1) === "version" && h.state.cacheRevision !== null ? { status: "ok", revision: h.state.cacheRevision } : undefined),
    getQueriesData: () => [],
    invalidateQueries: async () => undefined,
  }),
}));

// Non-literal specifiers keep the client and server programs out of each other's type graphs;
// Vitest resolves them at runtime.
const editorPath = "./question-editor";
const servicePath = "../server/test-support/service";
const canonicalPath = "../shared/canonical";
const { QuestionEditor } = (await import(/* @vite-ignore */ editorPath)) as { QuestionEditor: (props: unknown) => unknown };
const { makeProject, ok } = (await import(/* @vite-ignore */ servicePath));
const { canonicalJson } = (await import(/* @vite-ignore */ canonicalPath)) as { canonicalJson: (v: unknown) => string };

const P = "prj_test";
const theme = { colors: new Proxy({}, { get: () => "#000" }) } as never;
let project: any;

beforeEach(() => {
  h.state.calls = [];
  h.state.inflight = [];
  h.state.toasts = [];
  h.state.cacheRevision = null;
});
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

// ---------------------------------------------------------------------------------------------
// Harness

/** One mounted editor: its own hook slots, re-rendered with whatever props the caller passes. */
function mount(initial: Record<string, unknown>) {
  const slots: unknown[] = [];
  let props = initial;
  const render = (next?: Record<string, unknown>): El => {
    if (next) props = next;
    h.state.slots = slots;
    for (let pass = 0; pass < 20; pass++) {
      h.state.index = 0;
      h.state.dirty = false;
      const tree = QuestionEditor(props) as El;
      if (!h.state.dirty) return tree;
    }
    throw new Error("editor did not settle");
  };
  return { render };
}

function all(tree: unknown, pred: (el: El) => boolean): El[] {
  const out: El[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const el = n as El;
    if (el.props && pred(el)) out.push(el);
    walk(el.props?.children);
  };
  walk(tree);
  return out;
}
const one = (tree: unknown, pred: (el: El) => boolean, what: string): El => {
  const found = all(tree, pred);
  if (found.length !== 1) throw new Error(`expected one ${what}, found ${found.length}`);
  return found[0];
};
const byLabel = (label: string) => (el: El) => el.props.label === label || el.props.accessibilityLabel === label;

/** Settle every forwarded RPC and the editor's own continuation, then re-render. */
async function settle(m: ReturnType<typeof mount>): Promise<El> {
  for (let i = 0; i < 5; i++) {
    await Promise.all(h.state.inflight);
    await new Promise((r) => setTimeout(r, 0));
  }
  return m.render();
}

/** Fills a minimal valid new question (title + free text) and presses Create. */
async function createThrough(m: ReturnType<typeof mount>, title: string): Promise<El> {
  let tree = m.render();
  one(tree, byLabel("Question title"), "title input").props.onChangeText(title);
  tree = m.render();
  one(tree, byLabel("Allow a free-text answer"), "free-text toggle").props.onChange(true);
  tree = m.render();
  one(tree, byLabel("Create question"), "create button").props.onPress();
  return settle(m);
}

async function setup() {
  project = await makeProject();
  h.state.service = project.service;
  h.state.paseo = project.paseo;
  const s = project.service;
  ok(await s.init(project.paseo, { projectId: P }));
  const revision = async () => ok(await s.version(project.paseo, { projectId: P })).revision as number;
  const view = async (sessionId: string) => ok(await s.sessionGet(project.paseo, { projectId: P, sessionId }));
  const snapshot = async () => {
    const read = await (await import(/* @vite-ignore */ "../server/store")).openStore({ storeRoot: project.root, projectId: P }).read();
    return canonicalJson(read);
  };
  const newSession = async (title: string) =>
    ok(await s.sessionCreate(project.paseo, { projectId: P, expectedRevision: await revision(), title })).sessionId as string;
  const addQuestion = async (sessionId: string, title: string, blockId?: string) =>
    ok(
      await s.questionCreate(project.paseo, {
        projectId: P, expectedRevision: await revision(), sessionId, title, context: "", options: [{ id: "a", label: "A" }],
        allowFreeText: false, activatedBy: [], invalidatedBy: [], ...(blockId !== undefined ? { blockId } : {}),
      }),
    ).questionId as string;
  const accept = async (sessionId: string, blockId: string) =>
    ok(await s.blockAccept(project.paseo, { projectId: P, expectedRevision: await revision(), sessionId, blockId }));
  const editor = (v: any, mode: "create" | "edit" = "create", question?: unknown) =>
    mount({ mode, hostId: "host-1", projectId: P, view: v, theme, question, onDone: () => undefined });
  return { s, revision, view, snapshot, newSession, addQuestion, accept, editor };
}

const openBlockOf = (v: any) => (v.session.blocks as Array<{ id: string; state: string }>).find((b) => b.state === "open")!.id;
const lastCreate = (): Call => {
  const c = h.state.calls.filter((x) => x.name === "question.create");
  if (c.length !== 1) throw new Error(`expected one question.create call, found ${c.length}`);
  return c[0];
};

// ---------------------------------------------------------------------------------------------

describe("QuestionEditor create on a session with blocks (c0079)", () => {
  it("sends the open block id with the revision of the same view, and the question joins that block", async () => {
    const t = await setup();
    const sid = await t.newSession("Blocked");
    await t.addQuestion(sid, "Q0", "b1");
    const v = await t.view(sid);
    h.state.cacheRevision = v.revision;
    await createThrough(t.editor(v), "From the UI");
    const call = lastCreate();
    expect(call.input).toMatchObject({ projectId: P, sessionId: sid, blockId: "b1", expectedRevision: v.revision });
    expect(call.result.ok, JSON.stringify(call.result)).toBe(true);
    const after = await t.view(sid);
    const created = after.questions.find((q: any) => q.question.id === call.result.value.questionId).question;
    expect(created.blockId).toBe("b1");
  });

  it("after the block is accepted, a refreshed view sends the successor block and its revision", async () => {
    const t = await setup();
    const sid = await t.newSession("Blocked");
    await t.addQuestion(sid, "Q0", "b1");
    const next = (await t.accept(sid, "b1")).nextBlockId as string;
    const v = await t.view(sid);
    expect(openBlockOf(v)).toBe(next);
    h.state.cacheRevision = v.revision;
    await createThrough(t.editor(v), "Next block question");
    const call = lastCreate();
    expect(call.input).toMatchObject({ blockId: next, expectedRevision: v.revision });
    expect(call.result.ok, JSON.stringify(call.result)).toBe(true);
  });

  it("an editor opened before the acceptance keeps its pinned block and revision, even after a view refresh and a newer cache, and is refused without a write", async () => {
    const t = await setup();
    const sid = await t.newSession("Blocked");
    await t.addQuestion(sid, "Q0", "b1");
    const old = await t.view(sid);
    const m = t.editor(old);
    m.render();
    const next = (await t.accept(sid, "b1")).nextBlockId as string;
    const fresh = await t.view(sid);
    expect(fresh.revision).toBeGreaterThan(old.revision);
    // A background refresh hands the open editor the new view; the cache also knows the new revision.
    m.render({ mode: "create", hostId: "host-1", projectId: P, view: fresh, theme, onDone: () => undefined });
    h.state.cacheRevision = fresh.revision;
    const before = await t.snapshot();
    await createThrough(m, "Stale draft");
    const call = lastCreate();
    // Block and revision are pinned together from the view the editor opened with.
    expect(call.input).toMatchObject({ blockId: "b1", expectedRevision: old.revision });
    expect(call.input.blockId).not.toBe(next);
    expect(call.result.ok).toBe(false);
    expect(call.result.error.code).toBe("revision_conflict");
    expect(await t.snapshot()).toBe(before);
  });

  it("a view that lists blocks but no open one sends nothing", async () => {
    const t = await setup();
    const sid = await t.newSession("Blocked");
    await t.addQuestion(sid, "Q0", "b1");
    const v = await t.view(sid);
    // Not a valid stored state since c0045; built here to isolate the editor's own guard.
    const invalid = { ...v, session: { ...v.session, blocks: v.session.blocks.map((b: any) => ({ ...b, state: "accepted", acceptedAt: b.openedAt, acceptedBy: { kind: "human" } })) } };
    h.state.cacheRevision = v.revision;
    const before = await t.snapshot();
    const tree = await createThrough(t.editor(invalid), "Nowhere to go");
    expect(h.state.calls.filter((c) => c.name === "question.create")).toEqual([]);
    expect(await t.snapshot()).toBe(before);
    const texts = all(tree, (el) => (el.type as { displayName?: string })?.displayName === "Text" && typeof el.props.children === "string");
    expect(texts.map((x) => x.props.children).filter((s: string) => s !== "Options").length).toBeGreaterThan(0);
  });
});

describe("QuestionEditor create on a legacy session", () => {
  it("sends exactly the shipped payload: no blockId key, the cached revision, and a legacy question", async () => {
    const t = await setup();
    const sid = await t.newSession("Legacy");
    await t.addQuestion(sid, "Q0");
    const v = await t.view(sid);
    expect("blocks" in v.session).toBe(false);
    h.state.cacheRevision = v.revision;
    await createThrough(t.editor(v), "Legacy add");
    const call = lastCreate();
    expect(Object.prototype.hasOwnProperty.call(call.input, "blockId")).toBe(false);
    expect(Object.keys(call.input).sort()).toEqual(
      ["activatedBy", "allowFreeText", "context", "expectedRevision", "invalidatedBy", "options", "projectId", "sessionId", "title"].sort(),
    );
    expect(call.input.expectedRevision).toBe(v.revision);
    expect(call.result.ok, JSON.stringify(call.result)).toBe(true);
    const after = await t.view(sid);
    expect("blocks" in after.session).toBe(false);
    expect(after.questions.find((q: any) => q.question.id === call.result.value.questionId).question).not.toHaveProperty("blockId");
  });
});

describe("QuestionEditor edit (control)", () => {
  it("the edit payload is unchanged: the definition patch at the pinned revision, no blockId", async () => {
    const t = await setup();
    const sid = await t.newSession("Blocked");
    const qid = await t.addQuestion(sid, "Q0", "b1");
    const v = await t.view(sid);
    const question = v.questions.find((q: any) => q.question.id === qid).question;
    const m = t.editor(v, "edit", question);
    let tree = m.render();
    one(tree, byLabel("Question title"), "title input").props.onChangeText("Q0 renamed");
    tree = m.render();
    one(tree, byLabel("Save"), "save button").props.onPress();
    await settle(m);
    const calls = h.state.calls.filter((c) => c.name === "question.update");
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ projectId: P, sessionId: sid, questionId: qid, patch: { title: "Q0 renamed" }, expectedRevision: v.revision });
    expect(calls[0].result.ok, JSON.stringify(calls[0].result)).toBe(true);
  });
});
