// Tracker handler registration and absence of tracker powers from MCP (Stage 4 T4.6).
import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";
import { STAGE1_CONTRACTS, STAGE3_CONTRACTS, STAGE4_CONTRACTS, STAGE_R2_CONTRACTS } from "../../shared/rpc";
import { registerHandlers } from "../handlers";
import { buildTools } from "../mcp-tools";
import { registerPlanHandlers } from "../plan-handlers";
import { buildPlanTools } from "../plan-tools";
import type { PlanCommands, PlanService } from "../plans";
import type { RoadmapCommands, RoadmapService } from "../sessions";
import { registerTrackerHandlers } from "./handlers";
import type { TrackerService } from "./sync";

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
/** Any-method service that records calls and returns a fixed Result. */
function spy<T extends object>() {
  const calls: Array<[string, unknown, unknown]> = [];
  const sentinel = { ok: true as const, value: {} };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Proxy spy: every method is synthesised by the get trap
  const service = new Proxy({} as T, {
    get: (_t, method: string) => async (paseo: unknown, input: unknown) => {
      calls.push([method, paseo, input]);
      return sentinel;
    },
  });
  return { service, calls, sentinel };
}

describe("tracker handlers", () => {
  it("registers exactly STAGE4_CONTRACTS next to unchanged Stage 1 and Stage 3 registrations", () => {
    const rec = recorder();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerHandlers(rec.server as never, spy<RoadmapService>().service);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerPlanHandlers(rec.server as never, spy<PlanService>().service);
    const before = [...rec.names];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerTrackerHandlers(rec.server as never, spy<TrackerService>().service);
    const added = rec.names.slice(before.length);
    expect([...added].sort()).toEqual(STAGE4_CONTRACTS.map((c) => c.name).sort());
    expect(new Set(rec.names).size).toBe(rec.names.length);
    // Stage R2.4: the plan routes also register plan.rework (STAGE_R2_CONTRACTS).
    // Automatic grilling S1 (task card §3.2): the session routes also register session.planner.set and session.reopen.
    expect([...before].sort()).toEqual(
      [
        ...[...STAGE1_CONTRACTS, ...STAGE3_CONTRACTS, ...STAGE_R2_CONTRACTS].map((c) => c.name),
        "block.accept",
        "decision.cancel",
        "session.planner.set",
        "session.reopen",
        "question.out_of_scope",
        "session.finish",
        "session.language_notice.ack",
      ].sort(),
    );
    // 3 → 4 (P4.8 tracker.list) → 5 (P4.7 tracker.resolve): intentional contract additions.
    expect(STAGE4_CONTRACTS.map((c) => c.name).sort()).toEqual(["tracker.apply", "tracker.list", "tracker.preview", "tracker.reconcile", "tracker.resolve"]);
  });

  it("passes context.paseo through and returns the service Result unchanged", async () => {
    const rec = recorder();
    const s = spy<TrackerService>();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerTrackerHandlers(rec.server as never, s.service);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    const paseo = { synthetic: true } as unknown as PaseoApi;
    const input = { projectId: "prj_test", planId: "plan-1" };
    expect(await rec.handlers.get("tracker.preview")!(input, { paseo })).toBe(s.sentinel);
    expect(s.calls[0][1]).toBe(paseo);
    expect(s.calls[0][2]).toEqual(input);
  });

  it("tracker.list passes context.paseo and the input through to service.list and returns its Result unchanged", async () => {
    const rec = recorder();
    const s = spy<TrackerService>();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerTrackerHandlers(rec.server as never, s.service);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
    const paseo = { synthetic: true } as unknown as PaseoApi;
    const input = { projectId: "prj_test", planId: "plan-1" };
    expect(await rec.handlers.get("tracker.list")!(input, { paseo })).toBe(s.sentinel);
    expect(s.calls).toEqual([["list", paseo, input]]);
  });

  it("the MCP tool table, with plan tools, exposes no tracker, ticket or issue tool", () => {
    const tools = buildTools(spy<RoadmapCommands>().service, buildPlanTools(spy<PlanCommands>().service));
    // Automatic grilling S2 (task card §4.2): 12 base tools (+ pause instructions, grill complete) and 3 plan tools.
    // Feature discussion: + roadmap_resolve_link, roadmap_out_of_scope, roadmap_cancel_question, roadmap_block_accept
    // and roadmap_grill_propose_finish.
    expect(tools).toHaveLength(20);
    // roadmap_resolve_link only reads roadmap:// links; no tool may resolve tracker state.
    for (const tool of tools) expect(tool.name.replace(/^roadmap_resolve_link$/, "roadmap_link_lookup")).not.toMatch(/tracker|ticket|issue|resolve/);
  });
});

// Stage R3.5 (card §6.2a "Tables"): the R3 run contracts join the registered union; tracker contracts
// stay their own list and no name is shared.
describe("R3.5 contract union", () => {
  it("STAGE_R3_CONTRACTS is disjoint from STAGE4_CONTRACTS and the tracker routes register only STAGE4", async () => {
    const rpc = await import("../../shared/rpc");
    expect(Array.isArray(rpc.STAGE_R3_CONTRACTS), "STAGE_R3_CONTRACTS exists").toBe(true);
    const r3 = rpc.STAGE_R3_CONTRACTS.map((c) => c.name);
    const tracker = STAGE4_CONTRACTS.map((c) => c.name);
    expect(r3.filter((n) => tracker.includes(n))).toEqual([]);
    const rec = recorder();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerTrackerHandlers(rec.server as never, spy<TrackerService>().service);
    expect([...rec.names].sort()).toEqual([...tracker].sort());
  });
});
