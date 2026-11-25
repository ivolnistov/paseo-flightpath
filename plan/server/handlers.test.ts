import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import { callPluginRpc } from "@getpaseo/plugin/client/host";
import { afterEach, describe, expect, it } from "vitest";
import { QuestionAnswer, QuestionCreate, QuestionUpdate, RoadmapInit, STAGE1_CONTRACTS, SessionCreate, SessionGet } from "../shared/rpc";
import type { Result } from "../shared/rpc-base";
import { BlockAccept } from "../shared/rpc-blocks";
import { registerHandlers } from "./handlers";
import type { RoadmapService } from "./sessions";
import { makeProject, type TestProject } from "./test-support/service";

type Handler = (input: unknown, context: { paseo: PaseoApi }) => unknown;

function recorder() {
  const names: string[] = [];
  const handlers = new Map<string, Handler>();
  const server = {
    handle(contract: PluginRpcContract, handler: Handler) {
      names.push(contract.name);
      handlers.set(contract.name, handler);
    },
  };
  return { server, names, handlers };
}

/** Service whose every method records its call and returns a fixed Result. */
function spyService() {
  const calls: Array<[string, unknown, unknown]> = [];
  const sentinel = { ok: true as const, value: { revision: 2, rev: 1, valueChanged: true, staleMarked: [], visibilityChanged: [] } };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Proxy spy: every method is synthesised by the get trap
  const service = new Proxy({} as RoadmapService, {
    get: (_t, method: string) => async (paseo: unknown, input: unknown) => {
      calls.push([method, paseo, input]);
      return sentinel;
    },
  });
  return { service, calls, sentinel };
}

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

describe("registerHandlers", () => {
  // Automatic grilling S1 (task card §3.2): the router also covers session.planner.set and session.reopen.
  it("registers exactly the Stage 1 contracts plus block.accept, decision.cancel, session.planner.set, session.reopen, question.out_of_scope, session.finish and session.language_notice.ack, once each", () => {
    const rec = recorder();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerHandlers(rec.server as never, spyService().service);
    expect([...rec.names].sort()).toEqual(
      [...STAGE1_CONTRACTS.map((c) => c.name), "block.accept", "decision.cancel", "session.planner.set", "session.reopen", "question.out_of_scope", "session.finish", "session.language_notice.ack"].sort(),
    );
    expect(new Set(rec.names).size).toBe(rec.names.length);
  });

  it("question.answer passes context.paseo to the service and returns its Result unchanged", async () => {
    const rec = recorder();
    const spy = spyService();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerHandlers(rec.server as never, spy.service);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    const paseo = { synthetic: true } as unknown as PaseoApi;
    const input = { projectId: "prj_test", expectedRevision: 1, sessionId: "s1", questionId: "q1", optionId: "a" };
    const out = await rec.handlers.get(QuestionAnswer.name)!(input, { paseo });
    expect(out).toBe(spy.sentinel);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0][0]).toBe("questionAnswer");
    expect(spy.calls[0][1]).toBe(paseo);
    expect(spy.calls[0][2]).toEqual(input);
  });

  it("question.out_of_scope routes to questionOutOfScope with context.paseo and returns its Result unchanged", async () => {
    const rec = recorder();
    const spy = spyService();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerHandlers(rec.server as never, spy.service);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    const paseo = { synthetic: true } as unknown as PaseoApi;
    const input = { projectId: "prj_test", expectedRevision: 1, sessionId: "s1", questionId: "q1", reason: "later" };
    const handler = rec.handlers.get("question.out_of_scope");
    expect(handler).toBeDefined();
    expect(await handler!(input, { paseo })).toBe(spy.sentinel);
    expect(spy.calls).toEqual([["questionOutOfScope", paseo, input]]);
  });

  it("round-trips init → session.create → session.get through callPluginRpc with both schemas validated", async () => {
    project = await makeProject();
    const rec = recorder();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerHandlers(rec.server as never, project.service);
    const paseo = project.paseo;
    const invoke = async (method: string, input: unknown) => rec.handlers.get(method)!(input, { paseo });

    const init = await callPluginRpc(RoadmapInit, invoke, { projectId: "prj_test" });
    expect(init).toEqual({ ok: true, value: { created: true, revision: 1 } });
    const created = await callPluginRpc(SessionCreate, invoke, { projectId: "prj_test", expectedRevision: 1, title: "Round trip" });
    if (!created.ok) throw new Error(created.error.message);
    expect(created.value.revision).toBe(2);
    const view = await callPluginRpc(SessionGet, invoke, { projectId: "prj_test", sessionId: created.value.sessionId });
    if (!view.ok) throw new Error(view.error.message);
    expect(view.value).toMatchObject({ revision: 2, session: { id: created.value.sessionId, title: "Round trip" }, questions: [] });
  });

  it("question.update with recommendedOptionId: null passes the contract and clears the recommendation", async () => {
    project = await makeProject();
    const rec = recorder();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerHandlers(rec.server as never, project.service);
    const paseo = project.paseo;
    const invoke = async (method: string, input: unknown) => rec.handlers.get(method)!(input, { paseo });
    const P = { projectId: "prj_test" };
    await callPluginRpc(RoadmapInit, invoke, P);
    const s = await callPluginRpc(SessionCreate, invoke, { ...P, expectedRevision: 1, title: "Rpc" });
    if (!s.ok) throw new Error(s.error.message);
    const sessionId = s.value.sessionId;
    const c = await callPluginRpc(QuestionCreate, invoke, {
      ...P, expectedRevision: 2, sessionId, title: "Q", context: "", allowFreeText: false,
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], recommendedOptionId: "b", activatedBy: [], invalidatedBy: [],
    });
    if (!c.ok) throw new Error(c.error.message);
    const u = await callPluginRpc(QuestionUpdate, invoke, {
      ...P, expectedRevision: 3, sessionId, questionId: c.value.questionId,
      patch: { recommendedOptionId: null, options: [{ id: "a", label: "A" }] },
    });
    if (!u.ok) throw new Error(`${u.error.code}: ${u.error.message}`);
    expect(u.value).toMatchObject({ revision: 4, definitionRev: 2 });
    const view = await callPluginRpc(SessionGet, invoke, { ...P, sessionId });
    if (!view.ok) throw new Error(view.error.message);
    const question = view.value.questions[0].question;
    expect("recommendedOptionId" in question).toBe(false);
    expect(question.options).toEqual([{ id: "a", label: "A" }]);
  });

  it("question.update with an empty patch is rejected before the service is reached", async () => {
    const rec = recorder();
    const spy = spyService();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerHandlers(rec.server as never, spy.service);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    const paseo = {} as PaseoApi;
    const invoke = async (method: string, input: unknown) => rec.handlers.get(method)!(input, { paseo });
    await expect(
      callPluginRpc(QuestionUpdate, invoke, { projectId: "prj_test", expectedRevision: 1, sessionId: "s1", questionId: "q1", patch: {} }),
    ).rejects.toThrow();
    expect(spy.calls).toEqual([]);
  });

  it("block.accept routes to the service's blockAccept with context.paseo", async () => {
    const rec = recorder();
    const spy = spyService();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerHandlers(rec.server as never, spy.service);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    const paseo = { synthetic: true } as unknown as PaseoApi;
    const input = { projectId: "prj_test", expectedRevision: 3, sessionId: "s1", blockId: "b1" };
    expect(await rec.handlers.get(BlockAccept.name)!(input, { paseo })).toBe(spy.sentinel);
    expect(spy.calls).toEqual([["blockAccept", paseo, input]]);
  });

  it("block.accept round-trips through callPluginRpc as a UI write and session.get returns the blocks", async () => {
    project = await makeProject();
    const rec = recorder();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerHandlers(rec.server as never, project.service);
    const paseo = project.paseo;
    const invoke = async (method: string, input: unknown) => rec.handlers.get(method)!(input, { paseo });
    const P = { projectId: "prj_test" };
    await callPluginRpc(RoadmapInit, invoke, P);
    const s = await callPluginRpc(SessionCreate, invoke, { ...P, expectedRevision: 1, title: "Blocks" });
    if (!s.ok) throw new Error(s.error.message);
    const sessionId = s.value.sessionId;
    const c = await callPluginRpc(QuestionCreate, invoke, {
      ...P, expectedRevision: 2, sessionId, title: "Q", context: "", allowFreeText: false,
      options: [{ id: "a", label: "A" }], activatedBy: [], invalidatedBy: [], blockId: "b1",
    });
    if (!c.ok) throw new Error(c.error.message);
    const accepted = await callPluginRpc(BlockAccept, invoke, { ...P, expectedRevision: 3, sessionId, blockId: "b1" });
    if (!accepted.ok) throw new Error(`${accepted.error.code}: ${accepted.error.message}`);
    expect(accepted.value).toMatchObject({ revision: 4, blockId: "b1" });
    const view = await callPluginRpc(SessionGet, invoke, { ...P, sessionId });
    if (!view.ok) throw new Error(view.error.message);
    const blocks = (view.value.session as { blocks?: Array<{ id: string; state: string; acceptedBy?: { kind: string } }> }).blocks;
    expect(blocks?.map((b) => [b.id, b.state])).toEqual([
      ["b1", "accepted"],
      [accepted.value.nextBlockId, "open"],
    ]);
    expect(blocks?.[0].acceptedBy).toEqual({ kind: "human" });
    expect(view.value.questions[0].question.blockId).toBe("b1");
  });
});

// Stage R1.3a (task card §4.1.1): ROUTES gains decision.cancel, routed to the service's
// decisionCancel with context.paseo, and the UI service passes the UI origin.
describe("R1.3a decision.cancel route", () => {
  it("decision.cancel routes to the service's decisionCancel with context.paseo and returns its Result", async () => {
    const rec = recorder();
    const spy = spyService();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerHandlers(rec.server as never, spy.service);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    const paseo = { synthetic: true } as unknown as PaseoApi;
    const input = { projectId: "prj_test", expectedRevision: 3, sessionId: "s1", questionId: "q1", reason: "Dropped" };
    const handler = rec.handlers.get("decision.cancel");
    expect(handler, "decision.cancel is registered").toBeDefined();
    expect(await handler!(input, { paseo })).toBe(spy.sentinel);
    expect(spy.calls).toEqual([["decisionCancel", paseo, input]]);
  });

  it("the UI service records a cancellation through the real store (UI origin)", async () => {
    project = await makeProject();
    const { service, paseo } = project;
    const P = { projectId: "prj_test" };
    const unwrap = <T>(r: Result<T>): T => {
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      return r.value;
    };
    unwrap(await service.init(paseo, P));
    const version = async () => {
      const { revision } = unwrap(await service.version(paseo, P));
      if (revision === null) throw new Error("store not initialised");
      return revision;
    };
    const sessionId = unwrap(await service.sessionCreate(paseo, { ...P, expectedRevision: await version(), title: "S" })).sessionId;
    const questionId = unwrap(
      await service.questionCreate(paseo, { ...P, expectedRevision: await version(), sessionId, title: "Q", context: "", options: [{ id: "a", label: "A" }], allowFreeText: false, activatedBy: [], invalidatedBy: [] }),
    ).questionId;
    const out = unwrap(await service.decisionCancel(paseo, { ...P, expectedRevision: await version(), sessionId, questionId, reason: "Dropped" }));
    expect(typeof out.cancellationId).toBe("string");
    const view = unwrap(await service.sessionGet(paseo, { ...P, sessionId }));
    const anyString: unknown = expect.any(String); // the matcher is typed any; widened to unknown, matching unchanged
    // The record also lists its dependents for review (none here).
    expect(view.cancellations).toMatchObject([{ id: out.cancellationId, ref: { sessionId, questionId }, reason: "Dropped", at: anyString, actor: { kind: "human" }, dependents: [] }]);
  });
});
