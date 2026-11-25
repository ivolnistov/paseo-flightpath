// Plugin wiring (redesign Stage R0.6, task card §7.2/§7.3, §9 item 16): `contribute` registers every
// RPC contract of stages 1, 3, 4 and R0 exactly once, both host settings, and the full MCP tool
// table. The MCP endpoint, agent injection and timeline observer modules are replaced before the
// index is imported, so no listener, socket, hook or daemon call happens. Every other module is
// real and only constructed (their I/O is lazy and never triggered here).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAGE1_CONTRACTS, STAGE3_CONTRACTS, STAGE4_CONTRACTS, STAGE_R0_CONTRACTS, STAGE_R1_CONTRACTS } from "../shared/rpc";
import { FEATURE_TOOL_NAMES } from "./feature-tools";
import { TOOL_NAMES } from "./mcp-tools";
import { STAGE3_TOOL_NAMES } from "./plan-tools";

const captured = vi.hoisted(() => ({
  tools: undefined as undefined | import("./mcp-tools").McpToolTable,
  endpointStarts: 0,
  injections: 0,
  observers: 0,
  closed: 0,
  // R0 closeout c0078: the project directory the DoD handler resolves; unset leaves the real one.
  directory: undefined as unknown,
  // R3.5: createRunners compositions and runner disposals seen through the ./runs wrapper below.
  runnersCreated: 0,
  // R4.3: the deps each feature and plan factory was composed with.
  featureDeps: [] as Array<Record<string, unknown>>,
  planDeps: [] as Array<Record<string, unknown>>,
  runnersDisposed: 0,
  // S2 KensAI c8/c24: the pause engine index.server.ts composes, observed through the ./pause wrapper below.
  pauseAfterAccept: [] as Array<unknown>,
  pauseIdle: [] as Array<{ aborted: boolean }>,
  pauseIdleGate: undefined as undefined | Promise<void>,
  // S2 successor KensAI c61: host contexts the composed engine was asked to reconcile.
  pauseReconcile: [] as Array<unknown>,
}));

// S2 KensAI c8/c24: wraps the real createPauseEngine to observe afterAccept deliveries and how dispose
// drains the engine (whether idle() runs after the abort and is awaited). The engine itself is real.
vi.mock("./pause", async (importOriginal) => {
  const real = await importOriginal<typeof import("./pause")>();
  return {
    ...real,
    createPauseEngine: (deps: Parameters<typeof real.createPauseEngine>[0]) => {
      const engine = real.createPauseEngine(deps);
      return {
        ...engine,
        afterAccept: (x: { projectId: string; sessionId: string; operationId: string }) => {
          captured.pauseAfterAccept.push(x);
          return engine.afterAccept(x);
        },
        reconcileAll: (paseo: Parameters<typeof engine.reconcileAll>[0]) => {
          captured.pauseReconcile.push(paseo);
          return engine.reconcileAll(paseo);
        },
        idle: async () => {
          captured.pauseIdle.push({ aborted: deps.signal?.aborted === true });
          await captured.pauseIdleGate;
          return engine.idle();
        },
      };
    },
  };
});

// R3.5 (card §6.2a): wraps the real createRunners (when it exists) to observe composition and the
// plugin-cleanup dispose; no process is started (no cycle is opened in these tests).
// R4.3 (card §4): observe the deps index.server.ts composes into the feature and plan factories.
vi.mock("./features", async (importOriginal) => {
  const real = await importOriginal<Record<string, (d: Record<string, unknown>) => unknown>>();
  const wrap = (name: string) => (d: Record<string, unknown>) => {
    captured.featureDeps.push({ factory: name, ...d });
    return real[name](d);
  };
  return { ...real, createFeatureCommands: wrap("createFeatureCommands"), ...(real.createFeatureService ? { createFeatureService: wrap("createFeatureService") } : {}) };
});
vi.mock("./plans", async (importOriginal) => {
  const real = await importOriginal<Record<string, (d: Record<string, unknown>) => unknown>>();
  const wrap = (name: string) => (d: Record<string, unknown>) => {
    captured.planDeps.push({ factory: name, ...d });
    return real[name](d);
  };
  return { ...real, createPlanCommands: wrap("createPlanCommands"), ...(real.createPlanService ? { createPlanService: wrap("createPlanService") } : {}) };
});
vi.mock("./runs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  if (typeof real.createRunners !== "function") return real;
  const create = real.createRunners as (deps: unknown) => { start: unknown; cancel: unknown; dispose: () => Promise<void> };
  return {
    ...real,
    createRunners: (deps: unknown) => {
      captured.runnersCreated += 1;
      const r = create(deps);
      return { ...r, dispose: async () => { captured.runnersDisposed += 1; await r.dispose(); } };
    },
  };
});

vi.mock("./store-root", async (importOriginal) => {
  const real = await importOriginal<typeof import("./store-root")>();
  return { ...real, projectDirectoryFromPaseo: (paseo: never) => (captured.directory ?? real.projectDirectoryFromPaseo(paseo)) as never };
});

vi.mock("./mcp-endpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-endpoint")>()),
  startMcpEndpoint: (opts: { tools: import("./mcp-tools").McpToolTable }) => {
    captured.endpointStarts += 1;
    captured.tools = opts.tools;
    return Promise.resolve({
      close: async () => {
        captured.closed += 1;
      },
    });
  },
}));
vi.mock("./injection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./injection")>()),
  registerInjection: () => {
    captured.injections += 1;
    return () => undefined;
  },
}));
vi.mock("./timeline-rows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./timeline-rows")>()),
  registerTimelineObserver: () => {
    captured.observers += 1;
    return async () => undefined;
  },
}));

// Every test starts from clean captures, so results do not depend on test order (c0104).
beforeEach(() => {
  captured.tools = undefined;
  captured.endpointStarts = 0;
  captured.injections = 0;
  captured.observers = 0;
  captured.closed = 0;
  captured.directory = undefined;
  captured.pauseAfterAccept = [];
  captured.pauseIdle = [];
  captured.pauseIdleGate = undefined;
  captured.pauseReconcile = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A contract list: an array whose every element carries a string name (runtime-checked type guard). */
const isContractList = (v: unknown): v is ReadonlyArray<{ name: string }> =>
  Array.isArray(v) && v.every((c: unknown) => typeof c === "object" && c !== null && "name" in c && typeof c.name === "string");

/**
 * A server context that records handled contracts, registered settings and lifecycle hook
 * registrations (automatic grilling S2, TR17: `on` returns an unsubscribe that is recorded too).
 */
function recordingServer() {
  const handled: string[] = [];
  const settings: string[] = [];
  const hooks: string[] = [];
  const unhooked: string[] = [];
  const server = {
    handle(contract: { name: string }) {
      handled.push(contract.name);
    },
    registerSettings(definition: { id: string }) {
      settings.push(definition.id);
      return { read: async () => ({ status: "invalid" as const, revision: "r0", error: "stub" }) };
    },
    on(name: string) {
      hooks.push(name);
      return () => void unhooked.push(name);
    },
  };
  return { server, handled, settings, hooks, unhooked };
}

describe("contribute wiring", () => {
  it("registers every stage 1, 3, 4, R0 and R1 contract exactly once, both settings and the full tool table, with no live side effect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { default: contribute } = await import("../index.server");
    const rec = recordingServer();
    const dispose = contribute(rec.server as never);

    // R2.4 (card §5): plan.rework joins the registered contracts; every exported stage list counts.
    const rpc = await import("../shared/rpc");
    const stageKeys = Object.keys(rpc).filter((k) => /^STAGE.*_CONTRACTS$/.test(k));
    const stageLists = Object.entries(rpc).flatMap(([k, v]) => (/^STAGE.*_CONTRACTS$/.test(k) && isContractList(v) ? [v] : []));
    expect(stageLists.length, "every STAGE*_CONTRACTS export is a contract list").toBe(stageKeys.length);
    expect(stageLists.length).toBeGreaterThanOrEqual(5);
    for (const list of [STAGE1_CONTRACTS, STAGE3_CONTRACTS, STAGE4_CONTRACTS, STAGE_R0_CONTRACTS, STAGE_R1_CONTRACTS]) expect(stageLists).toContain(list);
    const expected = stageLists.flat().map((c) => c.name);
    expect(expected).toContain("decision.cancel");
    expect(expected.filter((n) => n === "plan.rework"), "plan.rework is in exactly one stage list").toEqual(["plan.rework"]);
    expect(new Set(expected).size).toBe(expected.length);
    expect([...rec.handled].sort()).toEqual([...expected].sort());
    expect(new Set(rec.handled).size).toBe(rec.handled.length);

    expect([...rec.settings].sort()).toEqual(["roadmap", "tracker"]);

    expect(captured.endpointStarts).toBe(1);
    const toolNames = (captured.tools ?? []).map((t) => t.name);
    // R2.4 (card §3.2, §5): roadmap_dod_template is live in the endpoint table.
    // R3.5 (card §6.2a "Tables"): the endpoint table also carries the six MCP run tools.
    const RUN_TOOL_NAMES = ["roadmap_run_next", "roadmap_task_claim", "roadmap_task_progress", "roadmap_run_ack", "roadmap_start", "roadmap_feature_bind"];
    expect([...toolNames].sort()).toEqual([...TOOL_NAMES, ...STAGE3_TOOL_NAMES, ...FEATURE_TOOL_NAMES, "roadmap_dod_template", ...RUN_TOOL_NAMES].sort());
    expect(toolNames).toContain("roadmap_feature_list");
    expect(new Set(toolNames).size).toBe(toolNames.length);
    // roadmap_cancel_question (agent-cancellation rule) and roadmap_block_accept (quoted chat consent)
    // are the only cancel and accept tools; no tool may approve, delete, reorder, set status or rework.
    const allowed = new Set(["roadmap_cancel_question", "roadmap_block_accept"]);
    for (const n of toolNames.filter((x) => !allowed.has(x))) expect(n).not.toMatch(/accept|approve|delete|reorder|status_set|rework|cancel/);
    expect(toolNames.filter((x) => /cancel/.test(x))).toEqual(["roadmap_cancel_question"]);
    expect(toolNames.filter((x) => /accept/.test(x))).toEqual(["roadmap_block_accept"]);
    for (const n of toolNames) expect(n).not.toMatch(/approve|delete|reorder|status_set|rework/);

    expect(captured.injections).toBe(1);
    expect(captured.observers).toBe(1);

    await dispose();
    expect(captured.closed).toBe(1);
  });

  // Automatic grilling S2 (task card §4.3 index wiring): the pause engine's five 0.12 lifecycle
  // hooks are registered once each, nothing is answered at registration, and dispose unregisters them.
  it("registers the five pause-engine hooks exactly once each and unregisters them on dispose", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { default: contribute } = await import("../index.server");
    const rec = recordingServer();
    const dispose = contribute(rec.server as never);
    const PAUSE_HOOKS = ["agent.permission_requested", "agent.permission_resolved", "agent.turn_ended", "agent.archived", "agent.closed"];
    for (const name of PAUSE_HOOKS) expect(rec.hooks.filter((h) => h === name), name).toEqual([name]);
    expect(rec.unhooked).toEqual([]);
    await dispose();
    for (const name of PAUSE_HOOKS) expect(rec.unhooked.filter((h) => h === name), name).toEqual([name]);
  });

  // S2 KensAI c8: cleanup drains the engine; nothing it started may outlive the plugin.
  it("c8: dispose aborts the pause engine and resolves only after the engine's idle() has resolved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { default: contribute } = await import("../index.server");
    const dispose = contribute(recordingServer().server as never);
    let release: () => void = () => undefined;
    captured.pauseIdleGate = new Promise<void>((r) => {
      release = r;
    });
    let done = false;
    const disposed = dispose().then(() => {
      done = true;
    });
    try {
      // Observed, not timed: the turns only let dispose reach its awaits (the mocked modules are synchronous).
      for (let i = 0; i < 1000 && captured.pauseIdle.length === 0; i++) await new Promise<void>((r) => setImmediate(r));
      expect(captured.pauseIdle, "dispose calls the engine's idle() after aborting it").toEqual([{ aborted: true }]);
      expect(done, "dispose has not resolved while idle() is pending").toBe(false);
    } finally {
      release();
      await disposed;
    }
    expect(done).toBe(true);
  });
});

// S2 successor KensAI c61 (guard): the first host context a registered handler sees starts one reconcile.
describe("contribute: host context → pause engine reconcile", () => {
  it("c61: a registered RPC handler call with { paseo } makes the engine reconcile that host context once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = new Map<string, (input: unknown, ctx: { paseo: unknown }) => Promise<unknown>>();
    const server = {
      handle(contract: { name: string }, fn: (input: unknown, ctx: { paseo: unknown }) => Promise<unknown>) {
        handlers.set(contract.name, fn);
      },
      registerSettings: () => ({ read: async () => ({ status: "invalid", revision: "r0", error: "stub" }) }),
      on: () => () => undefined,
    };
    const { default: contribute } = await import("../index.server");
    const dispose = contribute(server as never);
    try {
      expect(captured.pauseReconcile).toEqual([]);
      const paseo = { synthetic: "host-context" };
      await handlers.get("roadmap.version")!({ projectId: "prj_test" }, { paseo });
      await handlers.get("roadmap.version")!({ projectId: "prj_test" }, { paseo });
      expect(captured.pauseReconcile).toEqual([paseo]);
    } finally {
      await dispose();
    }
  });
});

// S2 KensAI c24: the central automatic path as composed by index.server.ts: a UI Accept through the
// registered block.accept handler (the real service over a real temp store) reaches the pause engine.
describe("contribute: Accept → afterAccept → pause engine", () => {
  it("c24: accepting the block of an awaiting operation delivers { projectId, sessionId, operationId } to the engine once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { makeProject, ok } = await import("./test-support/service");
    const { fakeDirectory } = await import("./test-support/fake-dir");
    const { binding, BLK_OPEN, continuationIn, OP, seedGrilling } = await import("./test-support/grilling");
    const { openProjectStore } = await import("./store-root");
    const project = await makeProject();
    let dispose: (() => Promise<void>) | undefined;
    try {
      const P = "prj_test";
      ok(await project.service.init(project.paseo, { projectId: P }));
      captured.directory = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
      const revision = async () => ok(await project.service.version(project.paseo, { projectId: P })).revision!;
      const sessionId = ok(await project.service.sessionCreate(project.paseo, { projectId: P, expectedRevision: await revision(), title: "Grilling" })).sessionId;
      ok(
        await project.service.questionCreate(project.paseo, {
          projectId: P, expectedRevision: await revision(), sessionId, blockId: BLK_OPEN, title: "Q", context: "",
          options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [],
        }),
      );
      await seedGrilling((id) => openProjectStore(captured.directory as never, id), P, sessionId, { planner: binding(), continuation: continuationIn("awaiting_pause") });
      const handlers = new Map<string, (input: unknown, ctx: { paseo: unknown }) => Promise<unknown>>();
      const server = {
        handle(contract: { name: string }, fn: (input: unknown, ctx: { paseo: unknown }) => Promise<unknown>) {
          handlers.set(contract.name, fn);
        },
        registerSettings: () => ({ read: async () => ({ status: "invalid", revision: "r0", error: "stub" }) }),
        on: () => () => undefined,
      };
      const { default: contribute } = await import("../index.server");
      dispose = contribute(server as never);
      const accept = handlers.get("block.accept");
      expect(accept, "block.accept is registered").toBeDefined();
      const out = await accept!({ projectId: P, sessionId, blockId: BLK_OPEN, expectedRevision: await revision() }, { paseo: project.paseo });
      expect(out).toMatchObject({ ok: true });
      expect(captured.pauseAfterAccept).toEqual([{ projectId: P, sessionId, operationId: OP }]);
    } finally {
      await dispose?.();
      await project.cleanup();
    }
  });
});

// R0 closeout (card §10.2, KensAI c0078): the dod.template.get handler that contribute registers
// reads the roadmap host settings through the same registerSettings handle; when that read is not
// ready it falls back to defaults (no global source) and logs one line. Real temp project store; the
// project directory is a fake; still no listener, network or daemon.
describe("contribute: dod.template.get through the registered handler", () => {
  it("falls back to no global source when the roadmap settings read is invalid, and uses the global text when it is ready", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { makeProject, ok } = await import("./test-support/service");
    const { fakeDirectory } = await import("./test-support/fake-dir");
    const { roadmapSettings } = await import("../shared/settings");
    const project = await makeProject();
    try {
      ok(await project.service.init(project.paseo, { projectId: "prj_test" }));
      captured.directory = fakeDirectory({ projects: [{ projectId: "prj_test", projectRootPath: project.root, projectKind: "git" }] });

      let roadmapRead: () => Promise<unknown> = async () => ({ status: "invalid", revision: "r0", error: "stub" });
      const handlers = new Map<string, (input: unknown, ctx: { paseo: unknown }) => Promise<unknown>>();
      const server = {
        handle(contract: { name: string }, fn: (input: unknown, ctx: { paseo: unknown }) => Promise<unknown>) {
          handlers.set(contract.name, fn);
        },
        registerSettings(definition: { id: string }) {
          return {
            read: async () => (definition.id === "roadmap" ? roadmapRead() : { status: "invalid", revision: "r0", error: "stub" }),
          };
        },
        // Automatic grilling S2 (TR17): contribute registers lifecycle hooks; nothing is emitted here.
        on: () => () => undefined,
      };
      const { default: contribute } = await import("../index.server");
      const dispose = contribute(server as never);
      const get = handlers.get("dod.template.get");
      expect(get, "dod.template.get is registered").toBeDefined();
      const call = () => get!({ projectId: "prj_test" }, { paseo: project.paseo });

      // Not ready: no global source, and the fallback is logged.
      errors.mockClear();
      expect(await call()).toEqual({ ok: true, value: { source: "none", text: "" } });
      expect(errors.mock.calls.some((c) => String(c[0]).includes("roadmap settings"))).toBe(true);

      // Not ready, with project text present: the project source still applies.
      const { openProjectStore } = await import("./store-root");
      const store = await openProjectStore(captured.directory as never, "prj_test");
      await store.transact((await store.version()).revision!, (d) => {
        d.meta.settings.dodTemplate = "Project criterion";
      });
      expect(await call()).toEqual({ ok: true, value: { source: "project", text: "Project criterion" } });

      // Ready with a global template (control): the global text is used once the project text is gone.
      await store.transact((await store.version()).revision!, (d) => {
        delete d.meta.settings.dodTemplate;
      });
      roadmapRead = async () => ({ status: "ready", revision: "r1", values: roadmapSettings.schema.parse({ dodTemplate: "Global criterion" }) });
      expect(await call()).toEqual({ ok: true, value: { source: "global", text: "Global criterion" } });

      await dispose();
    } finally {
      captured.directory = undefined;
      await project.cleanup();
    }
  });
});

// Stage R2.4 (task card 2026-10-29 §3.2, §4.2, §5): contribute registers plan.rework through the plan
// route table and makes roadmap_dod_template live, resolved by the same DoD template service,
// roadmap settings handle, Paseo holder and project directory as dod.template.get. Real temp project
// store; the plugin-data dir (approval receipts) is a temp PASEO_HOME; no listener, network or daemon.
describe("R2.4 contribute: plan.rework route and the live DoD template tool", () => {
  type Handler = (input: unknown, ctx: { paseo: unknown }) => Promise<unknown>;

  async function wired() {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await mkdtemp(join(tmpdir(), "dr-r24-home-"));
    vi.stubEnv("PASEO_HOME", home);
    const { makeProject, ok } = await import("./test-support/service");
    const { fakeDirectory } = await import("./test-support/fake-dir");
    const project = await makeProject();
    ok(await project.service.init(project.paseo, { projectId: "prj_test" }));
    const dir = fakeDirectory({ projects: [{ projectId: "prj_test", projectRootPath: project.root, projectKind: "git" }] });
    captured.directory = dir;
    let roadmapRead: () => Promise<unknown> = async () => ({ status: "invalid", revision: "r0", error: "stub" });
    const handlers = new Map<string, Handler>();
    const handledNames: string[] = [];
    const server = {
      handle(contract: { name: string }, fn: Handler) {
        handledNames.push(contract.name);
        handlers.set(contract.name, fn);
      },
      registerSettings(definition: { id: string }) {
        return { read: async () => (definition.id === "roadmap" ? roadmapRead() : { status: "invalid", revision: "r0", error: "stub" }) };
      },
      // Automatic grilling S2 (TR17): contribute registers lifecycle hooks; nothing is emitted here.
      on: () => () => undefined,
    };
    const { default: contribute } = await import("../index.server");
    const dispose = contribute(server as never);
    const { openProjectStore } = await import("./store-root");
    const open = (projectId: string) => openProjectStore(dir, projectId);
    const version = async () => (await (await open("prj_test")).version()).revision!;
    const call = (name: string, input: unknown) => {
      const h = handlers.get(name);
      expect(h, `${name} is registered`).toBeDefined();
      return h!(input, { paseo: project.paseo });
    };
    const tools = captured.tools ?? [];
    const dodTool = () => {
      const found = tools.filter((x) => x.name === "roadmap_dod_template");
      expect(found.length, "roadmap_dod_template is in the endpoint table exactly once").toBe(1);
      return found[0];
    };
    const runDod = async () => {
      const tool = dodTool();
      return tool.run(tool.input.parse({}), { open, projectId: "prj_test", origin: { source: "chat", actor: { kind: "agent" } } });
    };
    const setRoadmap = (fn: () => Promise<unknown>) => {
      roadmapRead = fn;
    };
    const cleanup = async () => {
      await dispose();
      captured.directory = undefined;
      vi.unstubAllEnvs();
      await project.cleanup();
      await rm(home, { recursive: true, force: true });
    };
    return { project, ok, handledNames, call, open, version, runDod, dodTool, setRoadmap, cleanup, home };
  }

  it("plan.rework is handled exactly once and delegates to the real rework command (missing plan, unbound plan, no write)", async () => {
    const w = await wired();
    try {
      expect(w.handledNames.filter((n) => n === "plan.rework"), "registered exactly once").toEqual(["plan.rework"]);
      const before = await w.version();
      const missing = await w.call("plan.rework", { projectId: "prj_test", expectedRevision: before, planId: "ghost", planRev: 1, reason: "Scope changed" });
      expect(missing).toMatchObject({ ok: false, error: { code: "not_found", details: { planId: "ghost" } } });
      // A real legacy (unbound) plan drafted through the registered plan.draft route.
      const { service, paseo } = w.project;
      const sessionId = w.ok(await service.sessionCreate(paseo, { projectId: "prj_test", expectedRevision: await w.version(), title: "Basis" })).sessionId;
      // One active, valid, answered question, so the basis is eligible for a draft.
      const questionId = w.ok(
        await service.questionCreate(paseo, {
          projectId: "prj_test", expectedRevision: await w.version(), sessionId, title: "Q", context: "",
          options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [],
        }),
      ).questionId;
      w.ok(await service.questionAnswer(paseo, { projectId: "prj_test", expectedRevision: await w.version(), sessionId, questionId, optionId: "a" }));
      const { PlanDraft } = await import("../shared/rpc");
      const drafted = PlanDraft.output.parse(
        await w.call("plan.draft", { projectId: "prj_test", expectedRevision: await w.version(), title: "Legacy", sessionIds: [sessionId], markdown: "# L", tasks: [{ id: "t1", title: "T", description: "" }] }),
      );
      if (!drafted.ok) throw new Error(`draft failed: ${drafted.error.code}`);
      const planId = drafted.value.planId;
      const at = await w.version();
      const unbound = await w.call("plan.rework", { projectId: "prj_test", expectedRevision: at, planId, planRev: 1, reason: "Scope changed" });
      expect(unbound).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await w.version(), "a refused rework writes nothing").toBe(at);
    } finally {
      await w.cleanup();
    }
  });

  it("roadmap_dod_template returns exactly what dod.template.get returns for none, project, global, file and an empty file, and writes nothing", async () => {
    const w = await wired();
    try {
      const { roadmapSettings } = await import("../shared/settings");
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      w.dodTool();
      // The registered handler sets the holder from context.paseo; the tool then resolves the same way.
      const both = async () => {
        const viaRpc = await w.call("dod.template.get", { projectId: "prj_test" });
        const viaTool = await w.runDod();
        expect(viaTool).toEqual(viaRpc);
        return viaTool;
      };
      const start = await w.version();
      expect(await both(), "settings not ready: fallback, no source").toEqual({ ok: true, value: { source: "none", text: "" } });
      const store = await w.open("prj_test");
      await store.transact((await store.version()).revision!, (d) => {
        d.meta.settings.dodTemplate = "Project criterion";
      });
      expect(await both()).toEqual({ ok: true, value: { source: "project", text: "Project criterion" } });
      await store.transact((await store.version()).revision!, (d) => {
        delete d.meta.settings.dodTemplate;
      });
      w.setRoadmap(async () => ({ status: "ready", revision: "r1", values: roadmapSettings.schema.parse({ dodTemplate: "Global criterion" }) }));
      expect(await both()).toEqual({ ok: true, value: { source: "global", text: "Global criterion" } });
      await writeFile(join(w.project.root, "dod template.md"), "- [check] npm test");
      expect(await both()).toEqual({ ok: true, value: { source: "file", text: "- [check] npm test" } });
      await writeFile(join(w.project.root, "dod template.md"), "");
      expect(await both(), "an empty regular file still overrides").toEqual({ ok: true, value: { source: "file", text: "" } });
      const end = await w.version();
      expect(end - start, "only the two test transactions wrote").toBe(2);
      const v = await w.version();
      await w.runDod();
      expect(await w.version(), "the tool writes nothing").toBe(v);
    } finally {
      await w.cleanup();
    }
  });
});

// Stage R3.5 (card §6.2a "Tables"): contribute registers the run routes plus task.accept and
// run.evidence.list exactly once, and the endpoint tool table carries the six run tools once each.
describe("R3.5 contribute: run routes and run tools", () => {
  it("every STAGE_R3 contract is handled exactly once and the run tools are in the endpoint table", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { default: contribute } = await import("../index.server");
    const rec = recordingServer();
    const dispose = contribute(rec.server as never);
    const rpc: Record<string, unknown> = await import("../shared/rpc");
    expect(isContractList(rpc.STAGE_R3_CONTRACTS), "STAGE_R3_CONTRACTS exists").toBe(true);
    for (const c of rpc.STAGE_R3_CONTRACTS as ReadonlyArray<{ name: string }>) {
      expect(rec.handled.filter((n) => n === c.name), c.name).toEqual([c.name]);
    }
    for (const n of ["run.start", "run.pause", "run.resume", "run.budget.grant", "delegation.revoke", "run.get", "run.list", "task.accept", "run.evidence.list", "coordinator.replace"]) {
      expect(rec.handled, n).toContain(n);
    }
    const toolNames = (captured.tools ?? []).map((t) => t.name);
    for (const n of ["roadmap_run_next", "roadmap_task_claim", "roadmap_task_progress", "roadmap_run_ack", "roadmap_start", "roadmap_feature_bind"]) {
      expect(toolNames.filter((x) => x === n), n).toEqual([n]);
    }
    expect(toolNames.some((n) => /coordinator_replace|replace/.test(n)), "no MCP replacement tool").toBe(false);
    await dispose();
    expect(captured.closed).toBe(1);
  });

  it("contribute composes the runners once and the plugin cleanup disposes them", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mod: Record<string, unknown> = await import("./runs");
    expect(typeof mod.createRunners, "server/runs exports createRunners").toBe("function");
    const created = captured.runnersCreated;
    const disposed = captured.runnersDisposed;
    const { default: contribute } = await import("../index.server");
    const dispose = contribute(recordingServer().server as never);
    expect(captured.runnersCreated - created).toBe(1);
    expect(captured.runnersDisposed - disposed).toBe(0);
    await dispose();
    expect(captured.runnersDisposed - disposed).toBe(1);
  });
});

// Stage R4.3 (task card §4 "Wiring"): index.server.ts composes the approvals reader (the
// ApprovalStore) into the feature deps and the replacement hook (afterReplacementRequest) into the
// feature and plan deps, so cancel/undefer pre-read receipts and approvals deliver the steer.
describe("R4.3 contribute: approvals reader and replacement hook composition", () => {
  it("every feature factory gets the ApprovalStore and the replacement hook; the plan commands get the replacement hook", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    captured.featureDeps = [];
    captured.planDeps = [];
    const { default: contribute } = await import("../index.server");
    const dispose = contribute(recordingServer().server as never);
    const featureCmds = captured.featureDeps.filter((d) => d.factory === "createFeatureCommands");
    expect(featureCmds.length, "feature commands composed").toBeGreaterThanOrEqual(1);
    for (const d of captured.featureDeps) {
      expect(typeof (d.approvals as { read?: unknown })?.read, `${String(d.factory)} gets the approvals reader`).toBe("function");
      expect(typeof d.afterReplacementRequest, `${String(d.factory)} gets the replacement hook`).toBe("function");
    }
    const planCmds = captured.planDeps.filter((d) => d.factory === "createPlanCommands");
    expect(planCmds.length, "plan commands composed").toBeGreaterThanOrEqual(1);
    for (const d of planCmds) expect(typeof d.afterReplacementRequest, "plan commands get the replacement hook").toBe("function");
    const hooks = new Set([...captured.featureDeps, ...planCmds].map((d) => d.afterReplacementRequest));
    expect(hooks.size, "one replacement hook composed once and shared").toBe(1);
    await dispose();
  });
});
