import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  FeatureCreate,
  FeatureDelete,
  FeatureDependenciesSet,
  FeatureList,
  FeatureReorder,
  FeatureStatusSet,
  FeatureUpdate,
} from "../shared/rpc-features";
import type { FeatureService } from "./features";
import type { createPaseoHolder } from "./paseo-holder";

/** Contract → feature service method; covers every FEATURE_CONTRACTS entry. */
const FEATURE_ROUTES: Array<[PluginRpcContract, keyof FeatureService]> = [
  [FeatureList, "list"],
  [FeatureCreate, "create"],
  [FeatureUpdate, "update"],
  [FeatureReorder, "reorder"],
  [FeatureDependenciesSet, "dependenciesSet"],
  [FeatureDelete, "delete"],
  [FeatureStatusSet, "statusSet"],
];

export function registerFeatureHandlers(
  server: Pick<PluginServerContext, "handle">,
  service: FeatureService,
  holder?: ReturnType<typeof createPaseoHolder>,
): void {
  for (const [contract, method] of FEATURE_ROUTES) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
    const call = service[method] as (paseo: PaseoApi, input: unknown) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
    server.handle(contract, ((input: unknown, context: { paseo: PaseoApi }) => {
      holder?.set(context.paseo);
      return call(context.paseo, input);
    }) as never);
  }
}
