// R4.5b production lint (E, errno casts): `errnoCode(e: unknown): string | undefined` in shared/errors.ts
// reads the `code` of a thrown value without a cast. It returns the code only when it is a string,
// and undefined for anything else; null and primitives give undefined without throwing. It keeps the
// former plain `e.code` read of the seven catch sites it replaced: exactly one property read (one
// [[Get]], no `in`/has check), inherited codes included, and a throwing `code` getter still propagates.
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError, errnoCode } from "./errors";

describe("errnoCode", () => {
  it("returns the code of a real Node fs error (ENOENT)", async () => {
    let caught: unknown;
    try {
      await readFile(join(tmpdir(), `dr-errno-missing-${process.pid}-${Date.now()}`, "absent.json"), "utf8");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errnoCode(caught)).toBe("ENOENT");
  });

  it("returns a string code set on an Error or carried by a plain object", () => {
    expect(errnoCode(Object.assign(new Error("in use"), { code: "EADDRINUSE" }))).toBe("EADDRINUSE");
    expect(errnoCode({ code: "EEXIST" })).toBe("EEXIST");
  });

  it("returns undefined for a code that is not a string", () => {
    for (const code of [42, null, undefined, true, {}, ["ENOENT"]]) {
      expect(errnoCode({ code }), JSON.stringify(code) ?? "undefined").toBeUndefined();
      expect(errnoCode(Object.assign(new Error("x"), { code })), `Error with ${JSON.stringify(code) ?? "undefined"}`).toBeUndefined();
    }
  });

  it("returns undefined when there is no code", () => {
    expect(errnoCode(new Error("plain"))).toBeUndefined();
    expect(errnoCode({})).toBeUndefined();
    expect(errnoCode([])).toBeUndefined();
  });

  it("returns undefined, without throwing, for null, undefined and primitives", () => {
    for (const value of [null, undefined, "ENOENT", 0, 42, true, Symbol("ENOENT"), 10n]) {
      expect(() => errnoCode(value), String(value)).not.toThrow();
      expect(errnoCode(value), String(value)).toBeUndefined();
    }
  });

  // Compatibility with the former single plain read `(e as { code?: string } | null)?.code` (R4.5b final verify).
  describe("compatibility with the former plain e.code read", () => {
    it("reads a code getter exactly once and returns that first value", () => {
      let reads = 0;
      const once = { get code(): unknown { reads += 1; if (reads > 1) throw new Error("code read twice"); return "ENOENT"; } };
      expect(errnoCode(once)).toBe("ENOENT");
      expect(reads, "one read").toBe(1);
      let changes = 0;
      const changing = { get code(): unknown { changes += 1; return changes === 1 ? "ENOENT" : 42; } };
      expect(errnoCode(changing)).toBe("ENOENT");
      expect(changes, "one read").toBe(1);
    });

    it("on a Proxy: one get for code and no has check (a get-only string code is returned)", () => {
      const traps = { get: 0, has: 0 };
      const proxy = new Proxy({}, {
        get: (target, prop, receiver): unknown => {
          if (prop === "code") {
            traps.get += 1;
            return "EADDRINUSE";
          }
          const v: unknown = Reflect.get(target, prop, receiver);
          return v;
        },
        has: () => {
          traps.has += 1;
          return false;
        },
      });
      expect(errnoCode(proxy)).toBe("EADDRINUSE");
      expect(traps).toEqual({ get: 1, has: 0 });
    });

    it("controls: an inherited string code and a DomainError code are returned; a throwing getter propagates", () => {
      class Inherits {}
      Object.defineProperty(Inherits.prototype, "code", { value: "ENOENT" });
      expect(errnoCode(new Inherits())).toBe("ENOENT");
      expect(errnoCode(new DomainError("invalid_input", "bad"))).toBe("invalid_input");
      const throwing = { get code(): unknown { throw new Error("getter boom"); } };
      expect(() => errnoCode(throwing)).toThrow("getter boom");
    });
  });
});
