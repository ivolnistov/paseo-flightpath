// The discussion's language (owner choices, 2026-11-08): the chat no longer asks a language question
// first; English is the default; languages beyond English come from settings, and the one the owner
// picks at Discuss is stored with the session and stated in the discussion prompt. A language that is
// not configured is refused before anything is created. Sessions whose language came from a tagged
// language question keep reading it (client/grilling-header.test.ts covers that fallback).
//
// Where the chosen language is stored is left to the implementation; it is read back through the
// session view and the header's `sessionLanguage`.
//
// Real temp store and commands; the host is a synthetic fake recording creations and the prompt.
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionView } from "../shared/rpc";
import { roadmapSettings } from "../shared/settings";
import { openDiscussion, type DiscussionDeps } from "./discussion";
import { createFeatureCommands } from "./features";
import { createRoadmapCommands, UI_ORIGIN, type StoreOpener } from "./sessions";
import { openProjectStore } from "./store-root";
import { fixedClock, nextId } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const WS = "wks_1";
const PROFILES = [{ id: "p-codex", name: "Codex", provider: "codex", model: "synthetic-codex" }];
/** Any instruction to ask the language as a question. */
const ASKS_LANGUAGE = /language question|tag it "language"|tag: ?"language"|ask (the owner )?which language/i;

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup(discussionLanguages?: string[]) {
  project = await makeProject();
  const proj = project;
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: proj.root, projectKind: "git" }], workspaces: [{ id: WS, projectId: P, directory: proj.root }] });
  let clock = fixedClock();
  const now = () => clock;
  const storeOptions = { now, newId: nextId, log: () => undefined };
  const base = { directory: () => dir, now, newId: nextId, storeOptions };
  const commands = createRoadmapCommands(base);
  const features = createFeatureCommands(base);
  const open: StoreOpener = (projectId) => openProjectStore(dir, projectId, storeOptions);
  ok(await commands.init(open, { projectId: P }, UI_ORIGIN));
  const revision = async () => ok(await commands.version(open, { projectId: P }, UI_ORIGIN)).revision!;
  const host = {
    created: 0,
    prompts: [] as string[],
    /** The host created the agent but the call failed (the creation outcome is unknown to Discuss). */
    failAfterCreate: false,
    /** The host refused the creation before processing it (an authentication refusal): no agent exists. */
    refuseCreate: false,
    listed: [] as Array<{ id: string; provider?: string; labels: Record<string, string>; archivedAt: null }>,
    /** The saved profiles the daemon configuration returns now; they may have changed since the creation. */
    profiles: [...PROFILES] as Array<{ id: string; name: string; provider: string; model: string }>,
    /** The daemon configuration cannot be read. */
    configFails: false,
    logs: [] as string[],
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- synthetic host: only the PaseoApi members Discuss uses exist
  const paseo = {
    config: {
      get: async () => {
        if (host.configFails) throw new Error("synthetic config read failure");
        return { revision: "r1", config: { agentProfiles: host.profiles } };
      },
    },
    workspaces: {
      ref: (id: string) => ({
        id,
        agents: {
          create: async () => {
            if (host.refuseCreate) throw Object.assign(new Error("password_required"), { name: "DaemonAuthenticationError" });
            const agentId = `agent-${++host.created}`;
            if (host.failAfterCreate) throw new Error("connection dropped after the agent was created");
            return { id: agentId };
          },
        },
      }),
    },
    agents: { list: async () => ({ requestId: "r", entries: host.listed.map((agent) => ({ agent, project: null })), pageInfo: {} }), ref: (agentId: string) => ({ id: agentId, send: async (text: string) => void host.prompts.push(text) }) },
  } as unknown as PaseoApi;
  const settings = roadmapSettings.schema.parse(discussionLanguages !== undefined ? { discussionLanguages } : {});
  const deps = (): DiscussionDeps => ({
    open, commands, settings: async () => settings, directory: () => dir,
    state: { grantForAgent: async () => null, grantsIssuedSince: async () => 0 }, now, newId: nextId, log: (m: string) => void host.logs.push(m),
  });
  const featureId = ok(await features.create(open, { projectId: P, expectedRevision: await revision(), title: "Login", description: "", kind: "feature" }, UI_ORIGIN)).featureId;
  const discuss = async (language?: string, extra: { retryUnresolved?: true; confirmedNoChat?: true } = {}) =>
    openDiscussion(deps(), paseo, { projectId: P, expectedRevision: await revision(), featureId, workspaceId: WS, profileRef: "p-codex", ...(language !== undefined ? { language } : {}), ...extra });
  const reservationId = async () => {
    const read = await (await open(P)).read();
    if (read.status !== "ok") throw new Error("store not ok");
    const d = read.data.features.find((f) => f.id === featureId)?.discussion;
    if (d === undefined || !("reservationId" in d)) throw new Error("no reservation");
    return d.reservationId;
  };
  const later = (ms: number) => (clock = new Date(fixedClock().getTime() + ms));
  const languageOf = async (sessionId: string) => {
    const view: SessionView = ok(await commands.sessionGet(open, { projectId: P, sessionId }, UI_ORIGIN));
    const headerPath = "../client/grilling-header";
    const mod: unknown = await import(/* @vite-ignore */ headerPath);
    const fn: unknown = typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === "sessionLanguage")?.[1] : undefined;
    if (typeof fn !== "function") throw new Error("missing export: grilling-header.sessionLanguage");
    const out: unknown = Reflect.apply(fn, undefined, [view]);
    return typeof out === "object" && out !== null && "label" in out ? String(out.label) : undefined;
  };
  return { host, discuss, languageOf, reservationId, later };
}

describe("the discussion prompt and language", () => {
  it("without configured languages: no language question, the prompt states English", async () => {
    const t = await setup();
    const out = await t.discuss();
    expect(out.ok).toBe(true);
    expect(t.host.prompts).toHaveLength(1);
    expect(t.host.prompts[0]).not.toMatch(ASKS_LANGUAGE);
    expect(t.host.prompts[0]).toMatch(/\bEnglish\b/);
    if (out.ok) expect(await t.languageOf(out.value.sessionId)).toBe("English");
  });

  it("with a configured language chosen at Discuss: the prompt states it and the session keeps it", async () => {
    const t = await setup(["Русский"]);
    const out = await t.discuss("Русский");
    expect(out.ok, out.ok ? "" : `${out.error.code}: ${out.error.message}`).toBe(true);
    expect(t.host.prompts).toHaveLength(1);
    expect(t.host.prompts[0]).toContain("Русский");
    expect(t.host.prompts[0]).not.toMatch(ASKS_LANGUAGE);
    if (out.ok) expect(await t.languageOf(out.value.sessionId)).toBe("Русский");
  });

  it("with configured languages but none chosen, English is the default", async () => {
    const t = await setup(["Русский"]);
    const out = await t.discuss();
    expect(out.ok).toBe(true);
    expect(t.host.prompts[0]).toMatch(/\bEnglish\b/);
    expect(t.host.prompts[0]).not.toContain("Русский");
    if (out.ok) expect(await t.languageOf(out.value.sessionId)).toBe("English");
  });

  it("a language that is not configured is refused before anything is created or sent", async () => {
    const t = await setup(["Русский"]);
    const out = await t.discuss("Deutsch");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("invalid_input");
    expect(t.host.created).toBe(0);
    expect(t.host.prompts).toEqual([]);
  });
});

// Review regression (KensAI c0004): before the chat gets its prompt, the language the owner selects
// on the press that creates or finds the chat is the one used, not a language from an earlier press
// of the same reservation. The first press here chose "Русский" and its outcome stayed unknown.
describe("the language of a press that completes an uncertain creation", () => {
  it("the owner's confirmed retry with another language: the prompt states it and the session keeps it", async () => {
    const t = await setup(["Русский", "Deutsch"]);
    t.host.failAfterCreate = true;
    expect((await t.discuss("Русский")).ok).toBe(false);
    t.host.failAfterCreate = false;
    t.later(120_000);
    expect((await t.discuss("Русский")).ok).toBe(false);
    const out = await t.discuss("Deutsch", { retryUnresolved: true, confirmedNoChat: true });
    expect(out.ok, out.ok ? "" : `${out.error.code}: ${out.error.message}`).toBe(true);
    expect(t.host.prompts).toHaveLength(1);
    expect(t.host.prompts[0]).toContain("Deutsch");
    expect(t.host.prompts[0]).not.toContain("Русский");
    if (out.ok) expect(await t.languageOf(out.value.sessionId)).toBe("Deutsch");
  });

  it("a chat found by its reservation on a press with another language: the prompt states it and the session keeps it", async () => {
    const t = await setup(["Русский", "Deutsch"]);
    t.host.failAfterCreate = true;
    expect((await t.discuss("Русский")).ok).toBe(false);
    t.host.failAfterCreate = false;
    t.host.listed = [{ id: "agent-1", labels: { "decision-roadmap.reservation": await t.reservationId() }, archivedAt: null }];
    t.later(120_000);
    const out = await t.discuss("Deutsch");
    expect(out.ok, out.ok ? "" : `${out.error.code}: ${out.error.message}`).toBe(true);
    if (out.ok) expect(out.value.agentId).toBe("agent-1");
    expect(t.host.prompts).toHaveLength(1);
    expect(t.host.prompts[0]).toContain("Deutsch");
    if (out.ok) expect(await t.languageOf(out.value.sessionId)).toBe("Deutsch");
  });
});

// Review regression (KensAI c0021): a new reservation on a session no chat has used yet (here after a
// refused creation) takes the language chosen on that press.
describe("the language of a new reservation on an unused session", () => {
  it("after a refused creation in one language, the next press in another language uses it", async () => {
    const t = await setup(["Русский", "Deutsch"]);
    t.host.refuseCreate = true;
    expect((await t.discuss("Русский")).ok).toBe(false);
    t.host.refuseCreate = false;
    const first = await t.reservationId();
    const out = await t.discuss("Deutsch");
    expect(out.ok, out.ok ? "" : `${out.error.code}: ${out.error.message}`).toBe(true);
    expect(await t.reservationId()).not.toBe(first);
    expect(t.host.prompts).toHaveLength(1);
    expect(t.host.prompts[0]).toContain("Deutsch");
    if (out.ok) expect(await t.languageOf(out.value.sessionId)).toBe("Deutsch");
  });
});

// Review regression (KensAI c0058, c0059): a chat found by its reservation already exists, so its
// provider is the chat's own, as the agent listing that found it reports it, not whatever the saved
// profile says now (it may have been changed or removed since the creation, or be unreadable). The
// prompt names the Codex preapproval entry exactly when the chat is a Codex chat.
describe("the prompt of a chat found by its reservation follows the chat's own provider", () => {
  const ALIAS = "decision-roadmap-discuss";
  async function uncertainCodexCreation(t: Awaited<ReturnType<typeof setup>>, actualProvider: string) {
    t.host.failAfterCreate = true;
    expect((await t.discuss()).ok).toBe(false);
    t.host.failAfterCreate = false;
    t.host.listed = [{ id: "agent-1", provider: actualProvider, labels: { "decision-roadmap.reservation": await t.reservationId() }, archivedAt: null }];
    t.later(120_000);
  }

  it("the saved profile now names another provider: a Codex chat is still directed to its entry", async () => {
    const t = await setup();
    await uncertainCodexCreation(t, "codex");
    t.host.profiles = [{ id: "p-codex", name: "Codex", provider: "claude", model: "synthetic-claude" }];
    expect((await t.discuss()).ok).toBe(true);
    expect(t.host.prompts).toHaveLength(1);
    expect(t.host.prompts[0]).toContain(ALIAS);
  });

  it("the saved profile was removed: a Codex chat is still directed to its entry", async () => {
    const t = await setup();
    await uncertainCodexCreation(t, "codex");
    t.host.profiles = [];
    expect((await t.discuss()).ok).toBe(true);
    expect(t.host.prompts[0]).toContain(ALIAS);
  });

  it("the saved profiles cannot be read: the chat's own provider decides, a Codex chat is directed to its entry", async () => {
    const t = await setup();
    await uncertainCodexCreation(t, "codex");
    t.host.configFails = true;
    expect((await t.discuss()).ok).toBe(true);
    expect(t.host.prompts[0]).toContain(ALIAS);
  });

  it("a chat whose own provider is not Codex is not directed to an entry it does not have, whatever the profile says", async () => {
    const t = await setup();
    await uncertainCodexCreation(t, "claude");
    expect((await t.discuss()).ok).toBe(true);
    expect(t.host.prompts).toHaveLength(1);
    expect(t.host.prompts[0]).not.toContain(ALIAS);
  });
});
