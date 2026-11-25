// `/roadmap` slash command (Stage 5 T5.1, host-compatibility correction): one workspace-context
// command that the host offers in both the workspace draft composer and an existing agent composer,
// and that only opens the roadmap panel — no RPC, no other navigation, no host API use.
//
// The installed Paseo 0.12.0 client host (web UI and desktop bundles, read-only inspection recorded
// in .sdd/…/test-host-stage5-slash-host-test-report.md) applies these rules, MODELLED below (the host
// bundle itself is not loaded):
// - registration: one name set per plugin; the trimmed name is the key regardless of context, so a
//   second `roadmap` throws `Duplicate client slash command: roadmap`; description must be
//   non-empty, context `workspace` or `agent`, `onSubmit` a function;
// - availability: none without a workspace; otherwise offered iff
//   (context !== "agent" || the agent is hydrated) && the workspace exists;
// - dispatch: a workspace or agent action context by the command's context, then
//   `onSubmit({ ...context, args })`.
import { describe, expect, it, vi } from "vitest";
import { roadmapSlashCommands } from "./slash";

const PANEL_ID = "roadmap"; // index.client.tsx PANEL_ID

type Contribution = ReturnType<typeof roadmapSlashCommands>[number];
type Situation = { workspaceId: string | null; agentId: string | null; agents: string[]; workspaces: string[] };

/** Host registration model (per-plugin registry). */
function registerAll(contributions: readonly Contribution[]): Contribution[] {
  const names = new Set<string>();
  return contributions.map((c) => {
    const name = c.name.trim();
    if (!name) throw new Error(`Invalid client slash command name: ${c.name}`);
    if (names.has(name)) throw new Error(`Duplicate client slash command: ${name}`);
    if (!c.description.trim()) throw new Error(`Client slash command ${name} has no description`);
    if (c.context !== "workspace" && c.context !== "agent") throw new Error(`Client slash command ${name} has invalid context`);
    if (typeof c.onSubmit !== "function") throw new Error(`Client slash command ${name} has no callback`);
    names.add(name);
    return { ...c, name, description: c.description.trim(), argumentHint: c.argumentHint.trim() };
  });
}

/** Host composer availability model. */
function offered(registered: readonly Contribution[], s: Situation): Contribution[] {
  if (!s.workspaceId) return [];
  const workspace = s.workspaces.includes(s.workspaceId);
  const agent = s.agentId !== null && s.agents.includes(s.agentId);
  return registered.filter((c) => (c.context !== "agent" || agent) && workspace);
}

/** Host dispatch model: the action context allows only openPanel; anything else throws. */
async function dispatch(command: Contribution, s: Situation, args: string) {
  const forbidden = (name: string) =>
    vi.fn(() => {
      throw new Error(`${name} must not be called`);
    });
  const paseo = new Proxy(
    {},
    {
      get: (_target, prop) => {
        throw new Error(`paseo.${String(prop)} must not be used`);
      },
    },
  );
  const capabilities = {
    paseo,
    openPanel: vi.fn(),
    rpc: forbidden("rpc"),
    openScreen: forbidden("openScreen"),
    openSurface: forbidden("openSurface"),
    openSettings: forbidden("openSettings"),
  };
  const workspace = { id: s.workspaceId };
  // Narrowed per context: onSubmit of the un-narrowed workspace|agent union takes an intersection (never).
  if (command.context === "agent") {
    const ctx = { context: "agent" as const, workspace, agent: { id: s.agentId }, ...capabilities };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PluginAgentCommandContext test stub: no full PaseoApi or workspace snapshot
    await command.onSubmit({ ...ctx, args } as unknown as Parameters<typeof command.onSubmit>[0]);
    return ctx;
  }
  const ctx = { context: "workspace" as const, workspace, ...capabilities };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PluginWorkspaceCommandContext test stub: no full PaseoApi or workspace snapshot
  await command.onSubmit({ ...ctx, args } as unknown as Parameters<typeof command.onSubmit>[0]);
  return ctx;
}

const DRAFT: Situation = { workspaceId: "ws-1", agentId: null, agents: [], workspaces: ["ws-1"] };
const AGENT: Situation = { workspaceId: "ws-1", agentId: "agent-1", agents: ["agent-1"], workspaces: ["ws-1"] };
const NO_WORKSPACE: Situation = { workspaceId: null, agentId: null, agents: [], workspaces: ["ws-1"] };

describe("roadmapSlashCommands contribution (T5.1, host-compatible)", () => {
  it("contributes exactly one workspace command named roadmap", () => {
    const commands = roadmapSlashCommands(PANEL_ID);
    expect(commands).toHaveLength(1);
    const [c] = commands;
    expect(c.name).toBe("roadmap");
    expect(c.context).toBe("workspace");
    expect(c.description.trim()).not.toBe("");
    expect(c.argumentHint).toBe("");
    const names = commands.map((x) => x.name.trim());
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers with the host rules, which key names per plugin regardless of context", () => {
    expect(registerAll(roadmapSlashCommands(PANEL_ID)).map((c) => [c.name, c.context])).toEqual([["roadmap", "workspace"]]);
  });

  it("control: the host rules reject a workspace and an agent command with the same name", () => {
    const [c] = roadmapSlashCommands(PANEL_ID);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- contributions with an alternate context, to test the host registration rules
    const both = [
      { ...c, context: "workspace" },
      { ...c, context: "agent" },
    ] as Contribution[];
    expect(() => registerAll(both)).toThrow("Duplicate client slash command: roadmap");
  });
});

describe("roadmap command in the host composers (T5.1)", () => {
  it("is offered in a workspace draft and in an existing agent composer, not without a workspace", () => {
    const registered = registerAll(roadmapSlashCommands(PANEL_ID));
    expect(offered(registered, DRAFT).map((c) => c.name)).toEqual(["roadmap"]);
    expect(offered(registered, AGENT).map((c) => c.name)).toEqual(["roadmap"]);
    expect(offered(registered, NO_WORKSPACE)).toEqual([]);
  });

  it("control: an agent-only command would be missing from the workspace draft", () => {
    const [c] = roadmapSlashCommands(PANEL_ID);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- contributions with an alternate context, to test the host registration rules
    const agentOnly = registerAll([{ ...c, context: "agent" } as Contribution]);
    expect(offered(agentOnly, DRAFT)).toEqual([]);
    expect(offered(agentOnly, AGENT)).toHaveLength(1);
  });

  for (const [label, situation] of [
    ["workspace draft", DRAFT],
    ["existing agent composer", AGENT],
  ] as const) {
    it(`${label}: submit opens the roadmap panel exactly once and uses no other capability`, async () => {
      const [command] = offered(registerAll(roadmapSlashCommands(PANEL_ID)), situation);
      const ctx = await dispatch(command, situation, "");
      expect(ctx.context).toBe("workspace");
      expect(ctx.openPanel).toHaveBeenCalledTimes(1);
      expect(ctx.openPanel.mock.calls[0][0]).toBe(PANEL_ID);
      expect(ctx.rpc).not.toHaveBeenCalled();
      expect(ctx.openScreen).not.toHaveBeenCalled();
      expect(ctx.openSurface).not.toHaveBeenCalled();
      expect(ctx.openSettings).not.toHaveBeenCalled();
    });

    it(`${label}: args are ignored`, async () => {
      const [command] = offered(registerAll(roadmapSlashCommands(PANEL_ID)), situation);
      const calls = [];
      for (const args of ["", "foo", "  --flag x  "]) calls.push((await dispatch(command, situation, args)).openPanel.mock.calls);
      expect(calls[1]).toEqual(calls[0]);
      expect(calls[2]).toEqual(calls[0]);
    });

    it(`${label}: opens the panel id the factory was given`, async () => {
      const [command] = offered(registerAll(roadmapSlashCommands("other-panel")), situation);
      const ctx = await dispatch(command, situation, "");
      expect(ctx.openPanel).toHaveBeenCalledTimes(1);
      expect(ctx.openPanel.mock.calls[0][0]).toBe("other-panel");
    });
  }
});

// ======================= Stage R4.5a (task card §6.2, G5) =======================
// /roadmap leaves a scoped, one-shot, client-only pending route that the panel consumes; the SDK
// openPanel carries no route. No RPC write. The new exports are loaded from the module namespace.
type Route =
  | { kind: "roadmap" }
  | { kind: "feature"; query: string }
  | { kind: "question"; link: import("../shared/links").ParsedLink }
  | { kind: "question-number"; number: number };
type Scope = { workspaceId: string; projectId: string };
const loadRoutes = async () => {
  const mod = await import("./slash");
  for (const n of ["parseRoadmapArgs", "setPendingRoute", "takePendingRoute", "subscribePendingRoute"] as const) expect(typeof mod[n], `client/slash exports ${n}`).toBe("function");
  expect(mod.PENDING_ROUTE_TTL_MS, "TTL is 30 s").toBe(30_000);
  const routes: {
    parseRoadmapArgs: (a: string) => Route;
    setPendingRoute: (s: Scope, r: Route) => void;
    takePendingRoute: (s: Scope) => Route | null;
    subscribePendingRoute: (l: () => void) => () => void;
  } = mod;
  return routes;
};
const SCOPE: Scope = { workspaceId: "ws-1", projectId: "prj_test" };

describe("R4.5a parseRoadmapArgs", () => {
  it("'', 'features', 'runs' and unknown input → roadmap; 'feature X Y' → feature 'X Y'; 'feature' without a query → roadmap", async () => {
    const m = await loadRoutes();
    for (const a of ["", "   ", "features", "runs", "whatever else"]) expect(m.parseRoadmapArgs(a), JSON.stringify(a)).toEqual({ kind: "roadmap" });
    expect(m.parseRoadmapArgs("feature X Y")).toEqual({ kind: "feature", query: "X Y" });
    expect(m.parseRoadmapArgs("  feature   Search box  ")).toEqual({ kind: "feature", query: "Search box" });
    expect(m.parseRoadmapArgs("feature")).toEqual({ kind: "roadmap" });
    expect(m.parseRoadmapArgs("feature   ")).toEqual({ kind: "roadmap" });
  });
});

describe("R4.5a pending route store", () => {
  it("take is one-shot for the exact scope; another workspace or project gets null and the entry stays for its own scope", async () => {
    const m = await loadRoutes();
    m.setPendingRoute(SCOPE, { kind: "feature", query: "Search" });
    expect(m.takePendingRoute({ workspaceId: "ws-2", projectId: "prj_test" }), "another workspace").toBeNull();
    expect(m.takePendingRoute({ workspaceId: "ws-1", projectId: "prj_other" }), "another project").toBeNull();
    expect(m.takePendingRoute(SCOPE)).toEqual({ kind: "feature", query: "Search" });
    expect(m.takePendingRoute(SCOPE), "one-shot").toBeNull();
  });

  it("a newer route replaces a pending one of the same scope", async () => {
    const m = await loadRoutes();
    m.setPendingRoute(SCOPE, { kind: "feature", query: "Old" });
    m.setPendingRoute(SCOPE, { kind: "roadmap" });
    expect(m.takePendingRoute(SCOPE)).toEqual({ kind: "roadmap" });
  });

  it("expires after the 30 s TTL (fake clock): the expired entry gives null and is deleted", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-30T10:00:00.000Z"));
      const m = await loadRoutes();
      m.setPendingRoute(SCOPE, { kind: "roadmap" });
      vi.setSystemTime(new Date("2026-10-30T10:00:29.000Z"));
      expect(m.takePendingRoute(SCOPE), "still fresh at 29 s").toEqual({ kind: "roadmap" });
      m.setPendingRoute(SCOPE, { kind: "roadmap" });
      vi.setSystemTime(new Date("2026-10-30T10:01:00.000Z"));
      expect(m.takePendingRoute(SCOPE), "expired").toBeNull();
      vi.setSystemTime(new Date("2026-10-30T10:01:01.000Z"));
      expect(m.takePendingRoute(SCOPE)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribers are notified on set and stop after unsubscribe", async () => {
    const m = await loadRoutes();
    let calls = 0;
    const off = m.subscribePendingRoute(() => void (calls += 1));
    m.setPendingRoute(SCOPE, { kind: "roadmap" });
    expect(calls).toBe(1);
    off();
    m.setPendingRoute(SCOPE, { kind: "roadmap" });
    expect(calls).toBe(1);
    m.takePendingRoute(SCOPE);
  });
});

describe("R4.5a /roadmap onSubmit", () => {
  it("sets the parsed route under { ctx.workspace.id, ctx.workspace.projectId } and opens the panel once, with no RPC", async () => {
    const m = await loadRoutes();
    const [cmd] = registerAll(roadmapSlashCommands("roadmap"));
    const openPanel = vi.fn();
    const rpc = vi.fn(() => {
      throw new Error("rpc must not be called");
    });
    if (cmd.context !== "workspace") throw new Error("expected the workspace /roadmap command");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PluginWorkspaceCommandContext test stub: no full PaseoApi or workspace snapshot
    await cmd.onSubmit({ context: "workspace", workspace: { id: "ws-1", projectId: "prj_test" }, openPanel, rpc, args: "feature Search" } as unknown as Parameters<typeof cmd.onSubmit>[0]);
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(openPanel.mock.calls[0][0]).toBe("roadmap");
    expect(rpc).not.toHaveBeenCalled();
    expect(m.takePendingRoute(SCOPE)).toEqual({ kind: "feature", query: "Search" });
  });

  it("no args keeps the current behaviour: opens the panel once with a roadmap route", async () => {
    const m = await loadRoutes();
    const [cmd] = registerAll(roadmapSlashCommands("roadmap"));
    const openPanel = vi.fn();
    if (cmd.context !== "workspace") throw new Error("expected the workspace /roadmap command");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PluginWorkspaceCommandContext test stub: no full PaseoApi or workspace snapshot
    await cmd.onSubmit({ context: "workspace", workspace: { id: "ws-1", projectId: "prj_test" }, openPanel, args: "" } as unknown as Parameters<typeof cmd.onSubmit>[0]);
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(m.takePendingRoute(SCOPE)).toEqual({ kind: "roadmap" });
  });
});

// `/roadmap question <link | Q<n>>`: a question route keeps the whole parsed link (kind and pinned
// revision included); anything else falls back to the roadmap.
describe("question routes", () => {
  const parse = async (args: string): Promise<unknown> => {
    const mod: unknown = await import("./slash");
    const fn: unknown = typeof mod === "object" && mod !== null ? Object.entries(mod).find(([k]) => k === "parseRoadmapArgs")?.[1] : undefined;
    if (typeof fn !== "function") throw new Error("missing export: slash.parseRoadmapArgs");
    const out: unknown = Reflect.apply(fn, undefined, [args]);
    return out;
  };

  it("parses a question, current-answer or pinned link without dropping its kind or revision", async () => {
    expect(await parse("question roadmap://prj_1/s/S1/q/3")).toEqual({ kind: "question", link: { projectId: "prj_1", sessionId: "S1", number: 3, kind: "question" } });
    expect(await parse("question roadmap://prj_1/s/S1/q/3/answer")).toEqual({ kind: "question", link: { projectId: "prj_1", sessionId: "S1", number: 3, kind: "answer" } });
    expect(await parse("question   roadmap://prj_1/s/S1/q/3/answer/r2  ")).toEqual({ kind: "question", link: { projectId: "prj_1", sessionId: "S1", number: 3, kind: "answer", rev: 2 } });
  });

  it("parses a short Q<n> reference, and falls back to the roadmap for anything else", async () => {
    expect(await parse("question Q7")).toEqual({ kind: "question-number", number: 7 });
    for (const args of ["question nonsense", "question", "question Q0", "question https://example.com/q/1"]) expect(await parse(args), args).toEqual({ kind: "roadmap" });
  });

  it("a question route survives the one-shot pending route store for its scope", async () => {
    const mod = await import("./slash");
    const route: unknown = await parse("question roadmap://prj_test/s/S1/q/3/answer");
    Reflect.apply(mod.setPendingRoute, undefined, [{ workspaceId: "ws-q", projectId: "prj_test" }, route]);
    expect(mod.takePendingRoute({ workspaceId: "ws-q", projectId: "prj_test" })).toEqual(route);
  });
});
