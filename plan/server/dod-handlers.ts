// `dod.template.get` (Stage R0.6): the effective DoD template of a project, resolved from
// `<storeRoot>/dod template.md`, the project text in the store and the global host setting.
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DomainError, isDomainError } from "../shared/errors";
import type { Result, ValueOf } from "../shared/rpc";
import { DodTemplateGet } from "../shared/rpc-dod";
import type { RoadmapSettings } from "../shared/settings";
import { resolveDodTemplate } from "./dod-template";
import { nodeStoreFs, type StoreFs } from "./fs-port";
import type { createPaseoHolder } from "./paseo-holder";
import type { RoadmapServiceDeps } from "./sessions";
import { openProjectStore } from "./store-root";

export type DodTemplateDeps = Pick<RoadmapServiceDeps, "directory" | "storeOptions"> & {
  /** Current host `roadmap` settings; the caller falls back to defaults when they are not ready. */
  settings: () => Promise<RoadmapSettings>;
  fs?: StoreFs;
  log: (message: string) => void;
};

export interface DodTemplateService {
  get(paseo: PaseoApi, input: RpcInput<typeof DodTemplateGet>): Promise<Result<ValueOf<typeof DodTemplateGet>>>;
}

export function createDodTemplateService(deps: DodTemplateDeps): DodTemplateService {
  return {
    async get(paseo, i) {
      try {
        const store = await openProjectStore(deps.directory(paseo), i.projectId, deps.storeOptions);
        const read = await store.read();
        if (read.status === "missing") throw new DomainError("store_missing", "No decision roadmap in this project.");
        if (read.status === "invalid") throw new DomainError("store_invalid", read.error.message, read.error);
        const value = await resolveDodTemplate({
          fs: deps.fs ?? nodeStoreFs,
          storeRoot: store.storeRoot,
          project: read.data.meta.settings.dodTemplate,
          global: (await deps.settings()).dodTemplate,
          log: deps.log,
        });
        return { ok: true, value };
      } catch (e) {
        if (isDomainError(e)) {
          return { ok: false, error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
        }
        deps.log(`decision-roadmap: unexpected DoD template error: ${e instanceof Error ? e.name : "error"}`);
        return { ok: false, error: { code: "internal", message: "Unexpected error; see plugin logs." } };
      }
    },
  };
}

export function registerDodHandlers(
  server: Pick<PluginServerContext, "handle">,
  service: DodTemplateService,
  holder?: ReturnType<typeof createPaseoHolder>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- heterogeneous SDK contract dispatch; the generic handler cannot type each method
  server.handle(DodTemplateGet, ((input: unknown, context: { paseo: PaseoApi }) => {
    holder?.set(context.paseo);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the SDK validated the input against DodTemplateGet before this handler runs
    return service.get(context.paseo, input as RpcInput<typeof DodTemplateGet>);
  }) as never);
}
