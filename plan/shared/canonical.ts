import { DomainError } from "./errors";

// Sorted object keys, arrays in order, no whitespace, `undefined` properties omitted.
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const encode = (v: unknown, path: string): string => {
    if (v === null) return "null";
    switch (typeof v) {
      case "string":
      case "boolean":
        return JSON.stringify(v);
      case "number":
        if (!Number.isFinite(v)) throw new DomainError("invalid_input", `non-finite number at ${path}`);
        return JSON.stringify(v);
      case "object":
        break;
      default:
        throw new DomainError("invalid_input", `unsupported ${typeof v} at ${path}`);
    }
    const obj = v;
    if (seen.has(obj)) throw new DomainError("invalid_input", `cycle at ${path}`);
    seen.add(obj);
    let out: string;
    if (Array.isArray(obj)) {
      out = `[${obj.map((item, i) => (item === undefined ? "null" : encode(item, `${path}[${i}]`))).join(",")}]`;
    } else if (isRecord(obj)) {
      const record = obj;
      const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
      out = `{${keys.map((k) => `${JSON.stringify(k)}:${encode(record[k], `${path}.${k}`)}`).join(",")}}`;
    } else {
      throw new DomainError("invalid_input", `unsupported value at ${path}`); // unreachable: a non-null object
    }
    seen.delete(obj);
    return out;
  };
  return encode(value, "$");
}

/** A non-null object (arrays included), indexable by string keys. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// JSON round-trip of plain data (no structuredClone; Hermes-safe).
export function deepClone<T>(value: T): T {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a JSON round-trip of plain data returns the same shape
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
