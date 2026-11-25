import { PipelineError } from "./errors";

/**
 * Deterministic JSON: object keys sorted by UTF-16 code units, no whitespace, `undefined`
 * object members omitted. Non-finite numbers, cycles, `undefined` array items and values
 * without a JSON form are rejected.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, [], "$");
}

function fail(path: string, reason: string): never {
  throw new PipelineError("canonical_invalid", `${path}: ${reason}`);
}

function encode(value: unknown, ancestors: object[], path: string): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) fail(path, "non-finite number");
      return JSON.stringify(value);
    case "object":
      if (value === null) return "null";
      return encodeObject(value, ancestors, path);
    case "undefined":
      return fail(path, "undefined has no JSON form");
    case "bigint":
    case "symbol":
    case "function":
      return fail(path, `${typeof value} has no JSON form`);
  }
}

function encodeObject(value: object, ancestors: object[], path: string): string {
  if (ancestors.includes(value)) fail(path, "cycle");
  const inner = [...ancestors, value];
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return `[${items.map((item, index) => encode(item, inner, `${path}[${index}]`)).join(",")}]`;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(path, "only plain objects are allowed");
  const entries = Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${encode(member, inner, `${path}.${key}`)}`).join(",")}}`;
}
