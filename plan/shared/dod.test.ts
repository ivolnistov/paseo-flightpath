// DoD text parser (redesign Stage R0.3, task card §4): line grammar, CRLF, blank lines, indexes.
// The card leaves `text` of a check item unspecified, so check items are asserted on kind, index and
// command only.
import { describe, expect, it } from "vitest";
import { parseDod } from "./dod";

const criterion = (index: number, text: string) => ({ index, kind: "criterion", text });

/** Check items without their unspecified `text`. */
const checks = (text: string) =>
  parseDod(text)
    .items.filter((i) => i.kind === "check")
    .map((i) => ({ index: i.index, command: i.command }));

describe("parseDod", () => {
  it("returns no items for empty or blank-only text", () => {
    expect(parseDod("")).toEqual({ items: [] });
    expect(parseDod("\n\n   \n\t\n")).toEqual({ items: [] });
    expect(parseDod("\r\n \r\n")).toEqual({ items: [] });
  });

  it("classifies `- [check] <command>` as a check with the trimmed command", () => {
    const { items } = parseDod("- [check] npm test");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ index: 0, kind: "check", command: "npm test" });
    expect(typeof items[0].text).toBe("string");
  });

  it("keeps the command's inner spacing and trims its ends", () => {
    expect(checks("- [check]    npm  run   typecheck   ")).toEqual([{ index: 0, command: "npm  run   typecheck" }]);
    expect(checks("- [check]\tnpm test")).toEqual([{ index: 0, command: "npm test" }]);
  });

  it("trims the line before matching, so indented check lines are checks", () => {
    expect(checks("   - [check] npm test  ")).toEqual([{ index: 0, command: "npm test" }]);
  });

  it("treats `- [check]` without a command as a criterion", () => {
    expect(parseDod("- [check]")).toEqual({ items: [criterion(0, "- [check]")] });
    expect(parseDod("- [check]   ")).toEqual({ items: [criterion(0, "- [check]")] });
    expect(parseDod("  - [check]\t \r")).toEqual({ items: [criterion(0, "- [check]")] });
  });

  it("treats every line that does not match the check grammar exactly as a criterion", () => {
    const lines = [
      "- [check]npm test", // no whitespace after the marker
      "- [Check] npm test", // case-sensitive marker
      "- [CHECK] npm test",
      "-  [check] npm test", // two spaces after the dash
      "* [check] npm test",
      "[check] npm test",
      "- [ ] npm test",
      "- [x] npm test",
      "- check npm test",
      "## Acceptance",
      "All endpoints documented",
    ];
    expect(parseDod(lines.join("\n"))).toEqual({ items: lines.map((l, i) => criterion(i, l)) });
  });

  it("trims criterion text and preserves its content", () => {
    expect(parseDod("   Error messages are actionable.  \t")).toEqual({ items: [criterion(0, "Error messages are actionable.")] });
    expect(parseDod("Résumé view renders ✓ on 320 px")).toEqual({ items: [criterion(0, "Résumé view renders ✓ on 320 px")] });
  });

  it("strips CR from CRLF line endings for checks and criteria", () => {
    const parsed = parseDod("First criterion\r\n- [check] npm test\r\nSecond criterion\r\n");
    expect(parsed.items.map((i) => i.kind)).toEqual(["criterion", "check", "criterion"]);
    expect(parsed.items[0]).toEqual(criterion(0, "First criterion"));
    expect(parsed.items[1]).toMatchObject({ index: 1, kind: "check", command: "npm test" });
    expect(parsed.items[2]).toEqual(criterion(2, "Second criterion"));
    for (const item of parsed.items) {
      expect(item.text).not.toContain("\r");
      if (item.command !== undefined) expect(item.command).not.toContain("\r");
    }
  });

  it("numbers emitted items 0..n-1 in order, skipping blank lines", () => {
    const text = "\n\nAlpha\n\n   \n- [check] npm test\n\n- [check]\nBeta\n- [check] npm run typecheck\n\n";
    const { items } = parseDod(text);
    expect(items.map((i) => [i.index, i.kind])).toEqual([
      [0, "criterion"],
      [1, "check"],
      [2, "criterion"],
      [3, "criterion"],
      [4, "check"],
    ]);
    expect(items[0].text).toBe("Alpha");
    expect(items[1].command).toBe("npm test");
    expect(items[2].text).toBe("- [check]");
    expect(items[3].text).toBe("Beta");
    expect(items[4].command).toBe("npm run typecheck");
  });

  it("criterion items carry no command", () => {
    for (const item of parseDod("Alpha\n- [check]\n- [ ] npm test").items) {
      expect(item.kind).toBe("criterion");
      expect(item.command).toBeUndefined();
    }
  });

  it("is deterministic and does not share state between calls", () => {
    const text = "Alpha\n- [check] npm test\nBeta";
    const a = parseDod(text);
    const b = parseDod(text);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.items.push({ index: 9, kind: "criterion", text: "mutated" });
    expect(parseDod(text)).toEqual(b);
  });
});
