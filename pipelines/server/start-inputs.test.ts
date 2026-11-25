import { describe, expect, it } from "vitest";
import type { InputDecl } from "../shared/workflow";
import { parseStartInputs, parseTasks } from "./start-inputs";
import { positionOf } from "./test-fixtures";

const decls: Record<string, InputDecl> = {
  goal: { type: "string", required: true },
  count: { type: "number", required: false, default: 3 },
  dry: { type: "boolean", required: false },
  tasks: { type: "tasks", required: false },
};

function codes(raw: Record<string, unknown>): string[] {
  const result = parseStartInputs(decls, raw);
  return result.ok ? [] : result.diagnostics.map((d) => d.code);
}

type Located = { code: string; line: number; column: number; range: { start: number; end: number } | null };

function located(text: string): Located[] {
  const result = parseTasks(text);
  return result.ok ? [] : result.diagnostics.map((d) => ({ code: d.code, line: d.line, column: d.column, range: d.range }));
}

/** The location of the `occurrence`-th `needle` in `text`, from plain string search. */
function at(code: string, text: string, needle: string, occurrence = 1): Located {
  let offset = -1;
  for (let i = 0; i < occurrence; i += 1) offset = text.indexOf(needle, offset + 1);
  if (offset < 0) throw new Error(`needle ${needle} not found`);
  return { code, ...positionOf(text, offset), range: { start: offset, end: offset + needle.length } };
}

function taskDiagnostics(text: string): Array<{ code: string; at: string }> {
  const result = parseTasks(text);
  if (result.ok) return [];
  return result.diagnostics.map((d) => ({ code: d.code, at: d.range ? text.slice(d.range.start, d.range.end) : "" }));
}

describe("parseStartInputs", () => {
  it("applies defaults and keeps typed values", () => {
    expect(parseStartInputs(decls, { goal: "ship", dry: true })).toEqual({ ok: true, values: { goal: "ship", count: 3, dry: true } });
  });

  it("reports a missing required input", () => {
    const result = parseStartInputs(decls, {});
    expect(result).toEqual({ ok: false, diagnostics: [expect.objectContaining({ code: "input_missing", input: "goal", line: 0, column: 0, range: null })] });
  });

  it.each([
    ["a number for a string", { goal: 1 }, "goal"],
    ["a numeric string for a number", { goal: "x", count: "4" }, "count"],
    ["NaN for a number", { goal: "x", count: Number.NaN }, "count"],
    ["a string for a boolean", { goal: "x", dry: "true" }, "dry"],
    ["a parsed list for tasks", { goal: "x", tasks: [] }, "tasks"],
  ])("reports input_type for %s on the field without a text location", (_label, raw, input) => {
    const result = parseStartInputs(decls, raw);
    expect(result.ok ? [] : result.diagnostics.map((d) => ({ code: d.code, input: d.input, line: d.line, column: d.column, range: d.range }))).toEqual([
      { code: "input_type", input, line: 0, column: 0, range: null },
    ]);
  });

  it("rejects undeclared inputs", () => {
    expect(codes({ goal: "x", extra: 1 })).toEqual(["unknown_key"]);
  });

  it("treats blank task text as no task list", () => {
    expect(parseStartInputs(decls, { goal: "x", tasks: "  \n" })).toEqual({ ok: true, values: { goal: "x", count: 3 } });
  });

  it("parses YAML and JSON task lists to the same tasks", () => {
    const yaml = "- id: t1\n  title: First\n  done:\n    - run: [npm, test]\n    - criterion: Works\n- { id: t2, title: Second, needs: [t1], acceptance: human }\n";
    const json = JSON.stringify([
      { id: "t1", title: "First", done: [{ run: ["npm", "test"] }, { criterion: "Works" }] },
      { id: "t2", title: "Second", needs: ["t1"], acceptance: "human" },
    ]);
    const expected = [
      { id: "t1", title: "First", needs: [], done: [{ run: ["npm", "test"] }, { criterion: "Works" }], acceptance: "auto" },
      { id: "t2", title: "Second", needs: ["t1"], done: [], acceptance: "human" },
    ];
    expect(parseTasks(yaml)).toEqual({ ok: true, tasks: expected });
    expect(parseTasks(json)).toEqual({ ok: true, tasks: expected });
    const result = parseStartInputs(decls, { goal: "x", tasks: yaml });
    expect(result.ok && result.values.tasks).toEqual(expected);
  });

  it("attaches the input name to task diagnostics", () => {
    const result = parseStartInputs(decls, { goal: "x", tasks: "- { id: T1, title: x }\n" });
    expect(result.ok ? [] : result.diagnostics.map((d) => [d.code, d.input])).toEqual([["tasks_schema", "tasks"]]);
  });
});

describe("parseTasks", () => {
  it("reports tasks_schema at the offending value", () => {
    const text = "- id: t1\n  title: One\n- id: Bad_Id\n  title: Two\n";
    const result = parseTasks(text);
    expect(result.ok).toBe(false);
    const diagnostic = result.ok ? undefined : result.diagnostics[0];
    expect(diagnostic?.code).toBe("tasks_schema");
    expect(diagnostic && { line: diagnostic.line, column: diagnostic.column }).toEqual(positionOf(text, text.indexOf("Bad_Id")));
  });

  it.each([
    ["a missing title", "- { id: t1 }\n", "{ id: t1 }"],
    ["an unknown key", "- { id: t1, title: x, owner: me }\n", "owner"],
    ["a non-list root", "id: t1\n", "id: t1\n"],
    ["a duplicate key", "- { id: t1, id: t2, title: x }\n", "id"],
    ["invalid acceptance", "- { id: t1, title: x, acceptance: later }\n", "later"],
    ["a done item with an unknown key", "- { id: t1, title: x, done: [{ check: x }] }\n", "check"],
  ])("reports tasks_schema for %s", (_label, text, at) => {
    const [first] = taskDiagnostics(text);
    expect(first?.code).toBe("tasks_schema");
    if (at !== "") expect(first?.at).toBe(at);
  });

  it("reports a YAML syntax error at the end of the text", () => {
    const text = "- { id: t1\n";
    expect(located(text)).toEqual([{ code: "tasks_schema", line: 2, column: 1, range: { start: 11, end: 11 } }]);
  });

  it("reports a duplicate task id at the second id", () => {
    const text = "- { id: t1, title: a }\n- { id: t1, title: b }\n";
    expect(located(text)).toEqual([at("tasks_duplicate_id", text, "t1", 2)]);
  });

  it("reports an unknown need at the need", () => {
    const text = "- { id: t1, title: a }\n- { id: t2, title: b, needs: [t1, t9] }\n";
    expect(located(text)).toEqual([at("tasks_unknown_need", text, "t9")]);
  });

  it("reports a need given as a string at the string", () => {
    const text = "- { id: t1, title: a, needs: t9 }\n";
    expect(located(text)).toEqual([at("tasks_unknown_need", text, "t9")]);
  });

  it("refuses a duplicate need at its second entry", () => {
    const text = "- { id: t1, title: a, needs: [t2, t2] }\n- { id: t2, title: b }\n";
    expect(located(text)).toEqual([at("tasks_schema", text, "t2", 2)]);
  });

  it("reports a self need at the need", () => {
    const text = "- { id: t1, title: a, needs: [t1] }\n";
    expect(located(text)).toEqual([at("tasks_cycle", text, "t1", 2)]);
  });

  it("reports a cycle on each member's needs and not on a task that only depends on it", () => {
    const text = "- { id: t1, title: a, needs: [t2] }\n- { id: t2, title: b, needs: [t1] }\n- { id: t3, title: c, needs: [t1] }\n";
    expect(located(text)).toEqual([at("tasks_cycle", text, "[t2]"), at("tasks_cycle", text, "[t1]")]);
  });

  it("rejects references in task commands", () => {
    expect(taskDiagnostics('- { id: t1, title: a, done: [{ run: "make ${{ inputs.goal }}" }] }\n').map((d) => d.code)).toEqual(["command_shell_ref"]);
    expect(taskDiagnostics('- { id: t1, title: a, done: [{ run: ["${{ inputs.goal }}"] }] }\n').map((d) => d.code)).toEqual(["command_exec_ref"]);
    expect(taskDiagnostics("- { id: t1, title: a, done: [{ run: [] }] }\n").map((d) => d.code)).toEqual(["command_argv_invalid"]);
  });

  it("enforces 64 tasks", () => {
    const list = (n: number): string => Array.from({ length: n }, (_, i) => `- { id: t${i}, title: x }\n`).join("");
    expect(parseTasks(list(64)).ok).toBe(true);
    expect(taskDiagnostics(list(65)).map((d) => d.code)).toEqual(["tasks_schema"]);
  });

  it("enforces 256 KiB of UTF-8", () => {
    const prefix = "- { id: t1, title: x, description: ";
    const body = "é".repeat(Math.ceil((256 * 1024 - prefix.length) / 2) + 1);
    expect(taskDiagnostics(`${prefix}${body} }\n`).map((d) => d.code)).toEqual(["tasks_schema"]);
    expect(parseTasks(`${prefix}${"a".repeat(1000)} }\n`).ok).toBe(true);
  });
});
