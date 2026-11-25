import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical";
import { PipelineError } from "./errors";

describe("canonicalJson", () => {
  it("sorts keys at every level and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x y" } })).toBe('{"a":{"c":"x y","d":[3,{"y":null,"z":true}]},"b":1}');
  });

  it("orders keys by UTF-16 code units", () => {
    expect(canonicalJson({ b: 0, B: 0, a: 0, "é": 0 })).toBe('{"B":0,"a":0,"b":0,"é":0}');
  });

  it("omits undefined members", () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });

  it("is stable regardless of insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("escapes strings as JSON", () => {
    expect(canonicalJson('quote " and \n')).toBe('"quote \\" and \\n"');
  });

  it("accepts repeated references that are not cycles", () => {
    const shared = { v: 1 };
    expect(canonicalJson({ a: shared, b: [shared] })).toBe('{"a":{"v":1},"b":[{"v":1}]}');
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity in a list", [Number.NEGATIVE_INFINITY]],
    ["an undefined list item", [undefined]],
    ["top-level undefined", undefined],
    ["a bigint", 1n],
    ["a function", () => 1],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
  ])("rejects %s", (_label, value: unknown) => {
    expect(() => canonicalJson(value)).toThrow(PipelineError);
  });

  it("rejects cycles", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/);
    const list: unknown[] = [];
    list.push(list);
    expect(() => canonicalJson(list)).toThrow(/cycle/);
  });
});
