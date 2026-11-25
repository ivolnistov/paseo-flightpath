// Fixture setup and read-only verification through the plugin's own RPCs, the way the app reaches
// them: the installed Paseo CLI's daemon connection (connectToDaemon) and invokePluginRpc, for the
// sandbox's synthetic project only. guards.buildRpcInput decides every call: the project is pinned,
// writes are limited to its WRITES on "[e2e] …" sessions this run created (every session a write
// names, relations included), and none creates, prompts or contacts an agent (no planner is bound
// to these sessions). Every call is bounded in time and recorded in `transcript`.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCaller } from "./caller.mjs";
import { E2E_PREFIX, withTimeout } from "./guards.mjs";
import { app, PASEO_HOME, PROJECT } from "./sandbox.mjs";

export { E2E_PREFIX };
export const RPC_TIMEOUT_MS = 30_000;

/**
 * `halt` is the run's shared stop: { reason, trigger(why) }. Once it has a reason every call is
 * refused except reads marked `final` (the closing evidence); a call that gets no answer in time
 * triggers it, so nothing after an ambiguous write can write again.
 */
export async function connect({ halt, writeGuard, plannerAgentId = null }) {
  if (process.env.PASEO_HOME !== PASEO_HOME) throw new Error(`PASEO_HOME must be the sandbox's (${PASEO_HOME})`);
  const listed = spawnSync(app.node, [app.paseoCli, "project", "ls", "--json", "--home", PASEO_HOME], { env: process.env, encoding: "utf8", timeout: 60_000 });
  if (listed.status !== 0 || listed.error) throw new Error(`project ls failed (status ${listed.status}${listed.error ? `, ${listed.error.message}` : ""})`);
  const projects = JSON.parse(listed.stdout);
  const rows = Array.isArray(projects) ? projects : (projects?.projects ?? []);
  const rootOf = (p) => p.projectRootPath ?? p.rootPath ?? p.path ?? p.root ?? "";
  const matches = rows.filter((p) => {
    try {
      return realpathSync.native(rootOf(p)) === PROJECT;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) throw new Error(`expected exactly one registered project at ${PROJECT}, found ${matches.length}`);
  const projectId = matches[0].projectId ?? matches[0].id;
  if (typeof projectId !== "string" || projectId === "") throw new Error("the synthetic project has no id");
  const cliRoot = path.dirname(path.dirname(app.paseoCli));
  const { connectToDaemon } = await import(pathToFileURL(path.join(cliRoot, "dist", "utils", "client.js")).href);
  const client = await withTimeout(connectToDaemon({ target: { kind: "instance", home: PASEO_HOME }, timeout: 15_000 }), 20_000, "connectToDaemon");
  const { call, transcript } = createCaller({ client, pluginId: app.pluginId, projectId, halt, timeoutMs: RPC_TIMEOUT_MS, writeGuard, plannerAgentId });

  return {
    projectId,
    call,
    transcript,
    close: async () => {
      try {
        await withTimeout(Promise.resolve(client.close?.()), 5_000, "client.close");
      } catch {
        // the daemon connection is dropped with the process anyway
      }
    },
  };
}
