import { describe, expect, it } from "vitest";
import { canonicalJson, deepClone } from "./canonical";
import { DomainError } from "./errors";

describe("canonicalJson", () => {
  it("is independent of object key order, at every depth", () => {
    const a = canonicalJson({ a: 1, b: { c: [1, { e: 2, d: 3 }], x: "y" } });
    const b = canonicalJson({ b: { x: "y", c: [1, { d: 3, e: 2 }] }, a: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":{"c":[1,{"d":3,"e":2}],"x":"y"}}');
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ l: ["b", "a"] })).toBe('{"l":["b","a"]}');
  });

  it("omits undefined properties", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("throws invalid_input on NaN and other non-finite numbers", () => {
    for (const bad of [NaN, Infinity, { nested: [NaN] }]) {
      let caught: unknown;
      try {
        canonicalJson(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect(caught instanceof DomainError ? caught.code : caught).toBe("invalid_input");
    }
  });

  it("deepClone returns equal data that shares no references", () => {
    const value = { a: [{ b: 1 }], c: "d" };
    const copy = deepClone(value);
    expect(copy).toEqual(value);
    expect(copy).not.toBe(value);
    expect(copy.a[0]).not.toBe(value.a[0]);
  });
});
