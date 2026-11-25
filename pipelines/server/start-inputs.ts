import { MAX_TASKS, MAX_TASKS_BYTES, TASK_ID_PATTERN, type TaskInput } from "../shared/tasks";
import { isRecord, pathKey, type Diagnostic, type InputDecl } from "../shared/workflow";
import { parseYaml, readDoneItems, reportUnknownKeys, type Path, type Reporter } from "./workflow-parse";
import { checkLiteralCommand } from "./workflow-validate";

const TASK_KEYS = new Set(["id", "title", "description", "needs", "done", "acceptance"]);

export type StartInputsResult = { ok: true; values: Record<string, unknown> } | { ok: false; diagnostics: Diagnostic[] };

/** Validates Start-form values against the declarations. A `tasks` value is YAML or JSON text. */
export function parseStartInputs(decls: Record<string, InputDecl>, raw: Record<string, unknown>): StartInputsResult {
  const diagnostics: Diagnostic[] = [];
  const values: Record<string, unknown> = {};
  const fieldError = (code: string, input: string, message: string): void => {
    diagnostics.push({ code, message, line: 0, column: 0, range: null, input });
  };
  for (const name of Object.keys(raw)) {
    if (!Object.hasOwn(decls, name)) fieldError("unknown_key", name, `The workflow declares no input \`${name}\`.`);
  }
  for (const [name, decl] of Object.entries(decls)) {
    const supplied = Object.hasOwn(raw, name) ? raw[name] : undefined;
    const absent = supplied === undefined || supplied === null || (decl.type === "tasks" && typeof supplied === "string" && supplied.trim() === "");
    if (absent) {
      if (decl.default !== undefined) values[name] = decl.default;
      else if (decl.required) fieldError("input_missing", name, `Input \`${name}\` is required.`);
      continue;
    }
    switch (decl.type) {
      case "string":
        if (typeof supplied === "string") values[name] = supplied;
        else fieldError("input_type", name, `Input \`${name}\` must be a string.`);
        break;
      case "number":
        if (typeof supplied === "number" && Number.isFinite(supplied)) values[name] = supplied;
        else fieldError("input_type", name, `Input \`${name}\` must be a finite number.`);
        break;
      case "boolean":
        if (typeof supplied === "boolean") values[name] = supplied;
        else fieldError("input_type", name, `Input \`${name}\` must be a boolean.`);
        break;
      case "tasks": {
        if (typeof supplied !== "string") {
          fieldError("input_type", name, `Input \`${name}\` must be YAML or JSON text.`);
          break;
        }
        const parsed = parseTasks(supplied);
        if (parsed.ok) values[name] = parsed.tasks;
        else diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, input: name })));
        break;
      }
    }
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, values };
}

export type ParseTasksResult = { ok: true; tasks: TaskInput[] } | { ok: false; diagnostics: Diagnostic[] };

export function parseTasks(text: string): ParseTasksResult {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_TASKS_BYTES) {
    return { ok: false, diagnostics: [{ code: "tasks_schema", message: `The task list is ${bytes} bytes; the limit is ${MAX_TASKS_BYTES}.`, line: 0, column: 0, range: null }] };
  }
  const parsed = parseYaml(text, { syntax: "tasks_schema", duplicate: "tasks_schema", value: "tasks_schema" });
  const { reporter } = parsed;
  if (reporter.diagnostics.length > 0) return { ok: false, diagnostics: reporter.diagnostics };
  const root = parsed.value;
  if (!Array.isArray(root)) {
    reporter.report("tasks_schema", [], "The task list must be a list of tasks.");
    return { ok: false, diagnostics: reporter.diagnostics };
  }
  if (root.length > MAX_TASKS) {
    reporter.report("tasks_schema", [], `The task list has ${root.length} tasks; the limit is ${MAX_TASKS}.`);
    return { ok: false, diagnostics: reporter.diagnostics };
  }
  const tasks: TaskInput[] = [];
  const taskPaths = new Map<string, number>();
  root.forEach((item: unknown, index) => {
    const task = readTask(reporter, item, [index]);
    if (!task) return;
    if (taskPaths.has(task.id)) {
      reporter.report("tasks_duplicate_id", [index, "id"], `Task id \`${task.id}\` is used twice.`);
      return;
    }
    taskPaths.set(task.id, index);
    tasks.push(task);
  });
  for (const task of tasks) {
    const index = taskPaths.get(task.id) ?? 0;
    task.needs.forEach((need, needIndex) => {
      const item: Path = [index, "needs", needIndex];
      const path: Path = reporter.source[pathKey(item)] ? item : [index, "needs"];
      if (need === task.id) reporter.report("tasks_cycle", path, `Task \`${task.id}\` cannot need itself.`);
      else if (!taskPaths.has(need)) reporter.report("tasks_unknown_need", path, `Unknown task \`${need}\`.`);
    });
  }
  for (const id of tasksInCycles(tasks)) {
    const index = taskPaths.get(id) ?? 0;
    reporter.report("tasks_cycle", [index, "needs"], `Task \`${id}\` is part of a \`needs\` cycle.`);
  }
  return reporter.diagnostics.length > 0 ? { ok: false, diagnostics: reporter.diagnostics } : { ok: true, tasks };
}

function readTask(reporter: Reporter, item: unknown, path: Path): TaskInput | null {
  if (!isRecord(item)) {
    reporter.report("tasks_schema", path, "A task must be a mapping with `id` and `title`.");
    return null;
  }
  const before = reporter.diagnostics.length;
  reportUnknownKeys(reporter, item, path, TASK_KEYS, "tasks_schema");
  const id = item.id;
  if (typeof id !== "string" || !TASK_ID_PATTERN.test(id)) {
    reporter.report("tasks_schema", item.id === undefined ? path : [...path, "id"], `A task id must match ${TASK_ID_PATTERN.source}.`);
  }
  const title = item.title;
  if (typeof title !== "string" || title.trim() === "") {
    reporter.report("tasks_schema", item.title === undefined ? path : [...path, "title"], "A task requires a non-empty `title`.");
  }
  if (item.description !== undefined && typeof item.description !== "string") {
    reporter.report("tasks_schema", [...path, "description"], "`description` must be text.");
  }
  const needs: string[] = [];
  if (item.needs !== undefined && item.needs !== null) {
    const list: unknown[] = typeof item.needs === "string" ? [item.needs] : Array.isArray(item.needs) ? item.needs : [];
    if (typeof item.needs !== "string" && !Array.isArray(item.needs)) {
      reporter.report("tasks_schema", [...path, "needs"], "`needs` must be a task id or a list of task ids.");
    }
    list.forEach((need, index) => {
      const needPath: Path = typeof item.needs === "string" ? [...path, "needs"] : [...path, "needs", index];
      if (typeof need !== "string") reporter.report("tasks_schema", needPath, "A `needs` entry must be a task id.");
      else if (needs.includes(need)) reporter.report("tasks_schema", needPath, `\`${need}\` is listed twice.`);
      else needs.push(need);
    });
  }
  const done = item.done === undefined || item.done === null ? [] : readDoneItems(reporter, item.done, [...path, "done"], { shape: "tasks_schema", argv: "command_argv_invalid" });
  done.forEach((entry, index) => {
    if ("run" in entry) checkLiteralCommand(reporter, entry.run, [...path, "done", index, "run"]);
  });
  let acceptance: TaskInput["acceptance"] = "auto";
  if (item.acceptance !== undefined) {
    if (item.acceptance === "auto" || item.acceptance === "human") acceptance = item.acceptance;
    else reporter.report("tasks_schema", [...path, "acceptance"], "`acceptance` must be auto or human.");
  }
  if (reporter.diagnostics.length > before || typeof id !== "string" || typeof title !== "string") return null;
  const task: TaskInput = { id, title, needs, done, acceptance };
  if (typeof item.description === "string") task.description = item.description;
  return task;
}

function tasksInCycles(tasks: readonly TaskInput[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "done">();
  const cyclic = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    state.set(id, "visiting");
    stack.push(id);
    for (const need of byId.get(id)?.needs ?? []) {
      if (need === id || !byId.has(need)) continue;
      const seen = state.get(need);
      if (seen === "visiting") {
        for (const member of stack.slice(stack.indexOf(need))) cyclic.add(member);
      } else if (seen === undefined) {
        visit(need);
      }
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const task of tasks) if (!state.has(task.id)) visit(task.id);
  return tasks.map((task) => task.id).filter((id) => cyclic.has(id));
}
