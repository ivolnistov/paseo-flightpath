#!/usr/bin/env node
// The harness's own check, with no browser, host, daemon or network: every e2e module parses, and
// the guard tests pass. Run: npm run test:e2e-guards (or node e2e/check.mjs).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = [...readdirSync(here).filter((f) => f.endsWith(".mjs")).map((f) => path.join(here, f)), ...readdirSync(path.join(here, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => path.join(here, "lib", f))];
let failed = false;
for (const m of modules) {
  const r = spawnSync(process.execPath, ["--check", m], { encoding: "utf8" });
  if (r.status !== 0) {
    failed = true;
    console.error(`syntax: ${path.relative(here, m)}\n${r.stderr}`);
  }
}
console.log(`syntax: ${modules.length} modules checked`);
const t = spawnSync(process.execPath, ["--test", path.join(here, "guards.test.mjs")], { stdio: "inherit" });
if (t.status !== 0) failed = true;
process.exit(failed ? 1 : 0);
