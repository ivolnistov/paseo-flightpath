import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { TrackerApply, TrackerList, TrackerPreview, TrackerReconcile, TrackerResolve } from "../../shared/rpc";
import type { createPaseoHolder } from "../paseo-holder";
import type { TrackerService } from "./sync";

/** Contract → tracker service method; covers every STAGE4_CONTRACTS entry. There is no MCP tracker tool. */
const TRACKER_ROUTES: Array<[PluginRpcContract, keyof TrackerService]> = [
  [TrackerPreview, "preview"],
  [TrackerApply, "apply"],
  [TrackerReconcile, "reconcile"],
  [TrackerList, "list"],
  [TrackerResolve, "resolve"],
];

export function registerTrackerHandlers(
  server: Pick<PluginServerContext, "handle">,
  service: TrackerService,
  holder?: ReturnType<typeof createPaseoHolder>,
): void {
  for (const [contract, method] of TRACKER_ROUTES) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
    const call = service[method] as (paseo: PaseoApi, input: unknown) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
    server.handle(contract, ((input: unknown, context: { paseo: PaseoApi }) => {
      holder?.set(context.paseo);
      return call(context.paseo, input);
    }) as never);
  }
}
