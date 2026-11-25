import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { optionalExport } from "../shared/host-features";
import { RoadmapRevisionWatch, type RevisionEvent } from "../shared/rpc-live";
import type { createPaseoHolder } from "./paseo-holder";
import { watchRevisions, type DirIdentity, type DirWatch } from "./revision-watcher";
import { openProjectStore, resolveProject, type ProjectDirectory } from "./store-root";
import type { StoreOptions } from "./store";

export interface RevisionWatchDeps {
  directory(paseo: PaseoApi): ProjectDirectory;
  storeOptions?: Omit<StoreOptions, "storeRoot" | "projectId">;
  holder?: ReturnType<typeof createPaseoHolder>;
  watch?: DirWatch;
  identity?: DirIdentity;
  settleMs?: number;
}

type SubscriptionContext = { paseo: PaseoApi; signal: AbortSignal; push(event: RevisionEvent): Promise<void> };
type SubscriptionServer = { handle(contract: typeof RoadmapRevisionWatch, handler: (input: { projectId: string }, context: SubscriptionContext) => Promise<void>): void };

/**
 * Serves `roadmap.revision.watch` when the host supports subscriptions; returns a stop function
 * that ends every open watch (plugin shutdown). Without support nothing is registered and the
 * panel keeps polling.
 */
export function registerRevisionWatch(server: Pick<PluginServerContext, "handle">, deps: RevisionWatchDeps, supported: boolean): () => void {
  const active = new Set<AbortController>();
  if (supported) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the subscription overload of `handle` is newer than the SDK types this plugin builds against
    const subscriptions = server as unknown as SubscriptionServer;
    subscriptions.handle(RoadmapRevisionWatch, async (input, context) => {
      deps.holder?.set(context.paseo);
      const directory = deps.directory(context.paseo);
      // The same trusted host mapping and root checks as roadmap.version; a refusal fails the subscription.
      const { decisionsDir } = await resolveProject(directory, input.projectId, deps.storeOptions?.fs);
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (context.signal.aborted) return;
      context.signal.addEventListener("abort", abort, { once: true });
      active.add(controller);
      try {
        await watchRevisions({
          decisionsDir,
          // Every read resolves the project again, exactly as each roadmap.version call does.
          read: async () => {
            const v = await (await openProjectStore(directory, input.projectId, deps.storeOptions)).version();
            return { exists: v.exists, status: v.status, revision: v.revision, schemaVersion: v.schemaVersion };
          },
          push: (facts) => context.push({ ...facts, projectId: input.projectId }),
          signal: controller.signal,
          ...(deps.watch !== undefined ? { watch: deps.watch } : {}),
          ...(deps.identity !== undefined ? { identity: deps.identity } : {}),
          ...(deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {}),
        });
      } finally {
        active.delete(controller);
        context.signal.removeEventListener("abort", abort);
      }
    });
  }
  return () => {
    for (const controller of [...active]) controller.abort();
    active.clear();
  };
}

/**
 * Whether the daemon serves plugin subscriptions: its shared SDK exports `defineSubscription`
 * exactly when `handle` accepts a subscription contract.
 */
export function hostSupportsSubscriptions(sharedSdk: object): boolean {
  return typeof optionalExport(sharedSdk, "defineSubscription") === "function";
}
