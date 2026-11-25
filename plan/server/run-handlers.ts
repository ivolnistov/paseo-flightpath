// Run RPC routes (Stage R3.1), registered with the other routes since Stage R3.5.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  CoordinatorReplace,
  DelegationRevoke,
  RunBudgetGrant,
  RunEvidenceList,
  RunGet,
  RunList,
  RunPause,
  RunResume,
  RunStart,
  TaskAccept,
} from "../shared/rpc-runs";
import type { createPaseoHolder } from "./paseo-holder";
import type { RunService } from "./runs";

/** Contract → run service method; covers every STAGE_R3_CONTRACTS entry exactly once. */
export const RUN_ROUTES: Array<[PluginRpcContract, keyof RunService]> = [
  [RunStart, "start"],
  [RunPause, "pause"],
  [RunResume, "resume"],
  [RunBudgetGrant, "budgetGrant"],
  [DelegationRevoke, "revokeDelegation"],
  [RunGet, "get"],
  [RunList, "list"],
  [CoordinatorReplace, "replaceCoordinator"],
  [TaskAccept, "accept"],
  [RunEvidenceList, "evidenceList"],
];

export function registerRunHandlers(
  server: Pick<PluginServerContext, "handle">,
  service: RunService,
  holder?: ReturnType<typeof createPaseoHolder>,
): void {
  for (const [contract, method] of RUN_ROUTES) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
    const call = service[method] as (paseo: PaseoApi, input: unknown) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
    server.handle(contract, ((input: unknown, context: { paseo: PaseoApi }) => {
      holder?.set(context.paseo);
      return call(context.paseo, input);
    }) as never);
  }
}
