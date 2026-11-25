// Pure tracker display helpers (Stage 4 P4.5); node environment, no React Native import.
import { describe, expect, it } from "vitest";
import { actionLabel, intentRowLabel, payloadText, stateLabel } from "./tracker-format";

describe("tracker-format", () => {
  it("labels every action kind distinctly", () => {
    const labels = (["create", "close", "skip"] as const).map((k) => actionLabel(k));
    for (const l of labels) expect(typeof l === "string" && l.length > 0).toBe(true);
    expect(new Set(labels).size).toBe(3);
  });

  it("labels every apply/intent state distinctly, including dry_run and interrupted", () => {
    const states = ["dry_run", "confirmed", "unknown", "failed", "not_attempted", "pending", "sent", "interrupted"] as const;
    const labels = states.map((s) => stateLabel(s));
    for (const l of labels) expect(typeof l === "string" && l.length > 0).toBe(true);
    expect(new Set(labels).size).toBe(states.length);
    expect(stateLabel("dry_run")).not.toBe(stateLabel("confirmed"));
  });

  it("payloadText is canonical (sorted keys) JSON with 2-space indent, independent of key order", () => {
    const expected = '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": "x\\ny"\n}';
    expect(payloadText({ b: "x\ny", a: { d: 2, c: 3 } })).toBe(expected);
    expect(payloadText({ a: { c: 3, d: 2 }, b: "x\ny" })).toBe(expected);
    expect(payloadText({ title: "T", body: "B" })).toBe('{\n  "body": "B",\n  "title": "T"\n}');
    expect(payloadText(null)).toBe("null");
  });

  it("intentRowLabel labels every attention state, and interrupted pending/sent rows differ from live ones", () => {
    const rows = (["pending", "sent", "unknown", "failed"] as const).flatMap((state) => [false, true].map((interrupted) => [state, interrupted] as const));
    const labels = rows.map(([state, interrupted]) => intentRowLabel(state, interrupted));
    for (const l of labels) expect(typeof l === "string" && l.length > 0).toBe(true);
    for (const state of ["pending", "sent"] as const) expect(intentRowLabel(state, true)).not.toBe(intentRowLabel(state, false));
    expect(new Set([intentRowLabel("pending", false), intentRowLabel("sent", false), intentRowLabel("unknown", false), intentRowLabel("failed", false)]).size).toBe(4);
  });

  it("a confirmed create reads Created and a confirmed close reads Closed (optional kind)", () => {
    expect(stateLabel("confirmed")).toBe("Created");
    expect(stateLabel("confirmed", "create")).toBe("Created");
    expect(stateLabel("confirmed", "close")).toBe("Closed");
  });
});
