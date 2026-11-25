// DoD template service and handler (redesign Stage R0.6, task card §7.2/§7.3): `dod.template.get`
// resolves `<storeRoot>/dod template.md` > project `meta.settings.dodTemplate` > global host
// setting > none, over a real temp project store and a host-settings stub.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Result, ValueOf } from "../shared/rpc";
import { DodTemplateGet } from "../shared/rpc-dod";
import { roadmapSettings, type RoadmapSettings } from "../shared/settings";
import { createDodTemplateService, registerDodHandlers } from "./dod-handlers";
import { fixedClock, nextId } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { err, makeProject, ok, type TestProject } from "./test-support/service";

const P = "prj_test";
const FILE_TEXT = "- [check] npm test\nFile criterion";
const PROJECT_TEXT = "Project criterion";
const GLOBAL_TEXT = "Global criterion";

type Value = ValueOf<typeof DodTemplateGet>;

let project: TestProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** A registered temp project; `init` creates its store. `global` feeds the host-settings stub. */
async function setup(opts: { init?: boolean; global?: string } = {}) {
  project = await makeProject();
  const root = project.root;
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: root, projectKind: "git" }] });
  const logs: string[] = [];
  const storeOptions = { now: fixedClock, newId: nextId, log: () => undefined };
  const settings = async (): Promise<RoadmapSettings> => roadmapSettings.schema.parse(opts.global === undefined ? {} : { dodTemplate: opts.global });
  const service = createDodTemplateService({ directory: () => dir, storeOptions, settings, log: (m: string) => void logs.push(m) });
  if (opts.init !== false) ok(await project.service.init(project.paseo, { projectId: P }));
  const setProjectText = async (text: string) => {
    const { openProjectStore } = await import("./store-root");
    const store = await openProjectStore(dir, P, storeOptions);
    const version = await store.version();
    await store.transact(version.revision!, (d) => {
      d.meta.settings.dodTemplate = text;
    });
  };
  const writeTemplateFile = (text: string) => writeFile(join(root, "dod template.md"), text);
  const get = (): Promise<Result<Value>> => service.get(project!.paseo, { projectId: P });
  return { service, get, setProjectText, writeTemplateFile, logs, paseo: project.paseo };
}

describe("dod.template.get service", () => {
  it("the regular file wins over project and global text", async () => {
    const t = await setup({ global: GLOBAL_TEXT });
    await t.setProjectText(PROJECT_TEXT);
    await t.writeTemplateFile(FILE_TEXT);
    expect(ok(await t.get())).toEqual({ source: "file", text: FILE_TEXT });
  });

  it("without the file, project text from the store wins over global", async () => {
    const t = await setup({ global: GLOBAL_TEXT });
    await t.setProjectText(PROJECT_TEXT);
    expect(ok(await t.get())).toEqual({ source: "project", text: PROJECT_TEXT });
  });

  it("without file and project text, the global host setting is used", async () => {
    const t = await setup({ global: GLOBAL_TEXT });
    expect(ok(await t.get())).toEqual({ source: "global", text: GLOBAL_TEXT });
  });

  it("with no source at all the result is none", async () => {
    const t = await setup();
    expect(ok(await t.get())).toEqual({ source: "none", text: "" });
  });

  it("default host settings (no dodTemplate) and whitespace-only project text resolve to none", async () => {
    const t = await setup();
    await t.setProjectText("   ");
    expect(ok(await t.get())).toEqual({ source: "none", text: "" });
  });

  it("a missing store is store_missing", async () => {
    const t = await setup({ init: false, global: GLOBAL_TEXT });
    expect(err(await t.get()).code).toBe("store_missing");
  });

  it("every result satisfies the dod.template.get output contract", async () => {
    const t = await setup({ global: GLOBAL_TEXT });
    expect(DodTemplateGet.output.safeParse(await t.get()).success).toBe(true);
  });
});

describe("registerDodHandlers", () => {
  it("registers exactly dod.template.get and routes it to the service with context.paseo", async () => {
    const t = await setup({ global: GLOBAL_TEXT });
    const names: string[] = [];
    const handlers = new Map<string, (input: unknown, ctx: { paseo: PaseoApi }) => Promise<unknown>>();
    const server = {
      handle(contract: PluginRpcContract, handler: (input: unknown, ctx: { paseo: PaseoApi }) => Promise<unknown>) {
        names.push(contract.name);
        handlers.set(contract.name, handler);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic handle(): one handler map for all contracts
    registerDodHandlers(server as never, t.service);
    expect(names).toEqual(["dod.template.get"]);
    const out = await handlers.get("dod.template.get")!({ projectId: P }, { paseo: t.paseo });
    expect(out).toEqual({ ok: true, value: { source: "global", text: GLOBAL_TEXT } });
  });
});
