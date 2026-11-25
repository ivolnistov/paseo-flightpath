import { describe, expect, it } from "vitest";
import { classifyProviderFailure } from "./provider-failure";

describe("classifyProviderFailure", () => {
  it.each([
    [{ message: "boom", code: "rate_limit_exceeded" }, "quota"],
    [{ message: "You have hit your usage limit." }, "quota"],
    [{ status: 429, message: "slow down" }, "quota"],
    [{ message: "401 Unauthorized" }, "auth"],
    [{ code: "invalid_api_key", message: "bad key" }, "auth"],
    [new Error("Not logged in. Please run login."), "auth"],
    [{ message: "Overloaded" }, "unavailable"],
    [{ error: { message: "model claude-x was not found" } }, "unavailable"],
    [{ statusCode: 503, message: "upstream" }, "unavailable"],
    [{ message: "x", providerUnavailable: true }, "unavailable"],
    [new Error("wrapper", { cause: { code: "insufficient_quota" } }), "quota"],
  ] as const)("classifies %j as %s", (error, expected) => {
    expect(classifyProviderFailure(error)).toBe(expected);
  });

  it.each([
    [{ message: "Tool call failed: ENOENT" }],
    [{ message: "TypeError: cannot read properties of undefined" }],
    [{ code: "permission_denied", message: "user denied the edit" }],
    [new Error("The process exited with code 1")],
    ["something else"],
    [null],
    [undefined],
  ])("returns null for an ordinary task failure %j", (error) => {
    expect(classifyProviderFailure(error)).toBeNull();
  });
});
