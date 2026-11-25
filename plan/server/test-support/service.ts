// Temp project registered in a fake directory, with a RoadmapService over a real store.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { Result } from "../../shared/rpc";
import type { StoreFs } from "../fs-port";
import { createRoadmapService, type RoadmapService } from "../sessions";
import { fixedClock, nextId } from "./build";
import { fakeDirectory } from "./fake-dir";

export type RpcErrorValue = Extract<Result<unknown>, { ok: false }>["error"];

export interface TestProject {
  /** Temp directory holding `root`; nothing may appear in it besides `project/`. */
  parent: string;
  root: string;
  projectId: "prj_test";
  paseo: PaseoApi;
  service: RoadmapService;
  logs: Array<[string, unknown]>;
  /** Another service instance (separate store objects) over the same project. */
  makeService(opts?: { fs?: StoreFs }): RoadmapService;
  cleanup(): Promise<void>;
}

export async function makeProject(): Promise<TestProject> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "dr-svc-")));
  const root = join(parent, "project");
  await mkdir(root);
  const logs: Array<[string, unknown]> = [];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- opaque PaseoApi identity token: only passed through and compared, never called
  const paseo = { synthetic: "paseo-stub" } as unknown as PaseoApi;
  const dir = fakeDirectory({ projects: [{ projectId: "prj_test", projectRootPath: root, projectKind: "git" }] });
  const makeService = (opts: { fs?: StoreFs } = {}) =>
    createRoadmapService({
      directory: (p: PaseoApi) => {
        if (p !== paseo) throw new Error("service did not pass the handler's paseo through");
        return dir;
      },
      now: fixedClock,
      newId: nextId,
      storeOptions: {
        now: fixedClock,
        newId: nextId,
        log: (message: string, error?: unknown) => void logs.push([message, error]),
        ...(opts.fs ? { fs: opts.fs } : {}),
      },
    });
  return {
    parent,
    root,
    projectId: "prj_test",
    paseo,
    service: makeService(),
    logs,
    makeService,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

export function ok<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

export function err<T>(r: Result<T>): RpcErrorValue {
  if (r.ok) throw new Error(`expected an error, got ok: ${JSON.stringify(r.value)}`);
  return r.error;
}
