import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { PlanApprove, PlanDraft, PlanGet, PlanList, TaskUpdate } from "../shared/rpc";
import { PlanRework } from "../shared/rpc-features";
import type { createPaseoHolder } from "./paseo-holder";
import type { PlanService } from "./plans";

/** Contract → plan service method; covers every STAGE3_CONTRACTS entry and plan.rework (STAGE_R2_CONTRACTS). */
const PLAN_ROUTES: Array<[PluginRpcContract, keyof PlanService]> = [
  [PlanList, "list"],
  [PlanGet, "get"],
  [PlanDraft, "draft"],
  [PlanApprove, "approve"],
  [TaskUpdate, "taskUpdate"],
  [PlanRework, "rework"],
];

export function registerPlanHandlers(
  server: Pick<PluginServerContext, "handle">,
  service: PlanService,
  holder?: ReturnType<typeof createPaseoHolder>,
): void {
  for (const [contract, method] of PLAN_ROUTES) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
    const call = service[method] as (paseo: PaseoApi, input: unknown) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
    server.handle(contract, ((input: unknown, context: { paseo: PaseoApi }) => {
      holder?.set(context.paseo);
      return call(context.paseo, input);
    }) as never);
  }
}
