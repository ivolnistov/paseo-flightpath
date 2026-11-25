import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SHARED = fileURLToPath(new URL(".", import.meta.url));
const FORBIDDEN_EXACT = new Set(["fs", "path", "crypto", "react", "react-native"]);
const forbidden = (spec: string) =>
  spec.startsWith("node:") || FORBIDDEN_EXACT.has(spec) || spec.startsWith("@getpaseo/plugin/client");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

describe("shared/ purity", () => {
  it("imports neither Node built-ins nor React, React Native or the plugin client SDK", () => {
    const files = sources(SHARED);
    expect(files.map((f) => relative(SHARED, f))).toEqual(
      expect.arrayContaining(["canonical.ts", "errors.ts", "graph.ts", "model.ts"]),
    );
    const offenders = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(SPECIFIER)]
        .map((m) => m[1])
        .filter(forbidden)
        .map((spec) => `${relative(SHARED, file)}: ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});
