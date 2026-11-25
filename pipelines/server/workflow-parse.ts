import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, visit, type Document, type Node, type YAMLError } from "yaml";
import {
  DEFAULT_MATRIX_MAX_PARALLEL,
  DEFAULT_MAX_PARALLEL,
  MAX_MATRIX_PARALLEL,
  DEFAULT_REWORK_MAX,
  JOB_ID_PATTERN,
  JOB_KINDS,
  NAME_PATTERN,
  REASONING_LEVELS,
  isRecord,
  pathKey,
  type AgentSettingsDecl,
  type Command,
  type Diagnostic,
  type DoneItem,
  type Fallback,
  type InputDecl,
  type InputType,
  type Job,
  type JobKind,
  type OutputDecl,
  type PathSegment,
  type Reasoning,
  type Rework,
  type SourceIndex,
  type SourceLoc,
  type Strategy,
  type Workflow,
} from "../shared/workflow";

export type Path = readonly PathSegment[];

const TOP_KEYS = new Set(["name", "inputs", "defaults", "jobs"]);
const DEFAULTS_KEYS = new Set(["max-parallel", "agent"]);
const JOB_KEYS = new Set(["name", "description", "kind", "needs", "uses", "with", "outputs", "done", "acceptance", "rework", "strategy"]);
const INPUT_KEYS = new Set(["type", "required", "default", "description"]);
const INPUT_TYPES = new Set<string>(["string", "number", "boolean", "tasks"]);
const OUTPUT_KEYS = new Set(["type", "items"]);
const AGENT_KEYS = new Set(["profile", "model", "reasoning", "fallback", "retries"]);
const FALLBACK_KEYS = new Set(["model", "reasoning"]);
const REWORK_KEYS = new Set(["to", "max"]);
const STRATEGY_KEYS = new Set(["matrix", "max-parallel"]);
const MODEL_PATTERN = /^[^/\s]+\/\S+$/;

/** Collects positioned diagnostics against a source index. */
export class Reporter {
  readonly diagnostics: Diagnostic[] = [];

  constructor(readonly source: SourceIndex) {}

  /** Reports at the value of `path`, or at its key when `onKey` is set; falls back to the nearest located ancestor. */
  report(code: string, path: Path, message: string, options: { onKey?: boolean; jobId?: string; input?: string } = {}): void {
    const loc = locate(this.source, path, options.onKey === true);
    const diagnostic: Diagnostic = {
      code,
      message,
      line: loc?.line ?? 0,
      column: loc?.column ?? 0,
      range: loc ? { start: loc.start, end: loc.end } : null,
    };
    if (options.jobId !== undefined) diagnostic.jobId = options.jobId;
    if (options.input !== undefined) diagnostic.input = options.input;
    this.diagnostics.push(diagnostic);
  }
}

function locate(source: SourceIndex, path: Path, onKey: boolean): SourceLoc | null {
  const exact = source[pathKey(path)];
  if (exact) {
    if (onKey && exact.key) return exact.key;
    if (exact.value.end > exact.value.start || !exact.key) return exact.value;
    return exact.key;
  }
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const entry = source[pathKey(path.slice(0, depth))];
    if (entry) return entry.key ?? entry.value;
  }
  return null;
}

export type ParsedYaml = { value: unknown; source: SourceIndex; reporter: Reporter };

/**
 * Parses one YAML document into plain data and a source index. Syntax errors, duplicate keys,
 * aliases, non-scalar keys and non-finite numbers are reported with `syntaxCode`, `duplicateCode`
 * and `valueCode`.
 */
export function parseYaml(text: string, codes: { syntax: string; duplicate: string; value: string }): ParsedYaml {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  const source: SourceIndex = {};
  const reporter = new Reporter(source);
  const problems: YAMLError[] = [...doc.errors, ...doc.warnings];
  for (const problem of problems) {
    // The parser can report an error one character past the end of the text.
    const start = Math.min(Math.max(problem.pos[0], 0), text.length);
    const reportedEnd = problem.code === "DUPLICATE_KEY" ? (keyEndAt(doc, problem.pos[0]) ?? problem.pos[1]) : problem.pos[1];
    const end = Math.min(Math.max(reportedEnd, start), text.length);
    const position = lines.linePos(start);
    reporter.diagnostics.push({
      code: problem.code === "DUPLICATE_KEY" ? codes.duplicate : codes.syntax,
      message: firstLine(problem.message),
      line: position.line,
      column: position.col,
      range: { start, end },
    });
  }
  if (problems.length > 0) return { value: undefined, source, reporter };

  const loc = (start: number, end: number): SourceLoc => {
    const position = lines.linePos(start);
    return { line: position.line, column: position.col, start, end };
  };
  const convert = (node: unknown, path: Path, key: SourceLoc | undefined): unknown => {
    const range = isNodeWithRange(node) ? node.range : undefined;
    const value = range ? loc(range[0], range[1]) : (key ?? loc(0, 0));
    const entry: { key?: SourceLoc; value: SourceLoc } = { value };
    if (key) entry.key = key;
    source[pathKey(path)] = entry;
    if (node === null || node === undefined) return null;
    if (isAlias(node)) {
      reporter.report(codes.value, path, "Anchors and aliases are not supported.");
      return null;
    }
    if (isScalar(node)) {
      const scalar: unknown = node.value;
      if (typeof scalar === "number" && !Number.isFinite(scalar)) {
        reporter.report(codes.value, path, "Numbers must be finite.");
        return null;
      }
      if (scalar === null || typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "boolean") return scalar;
      reporter.report(codes.value, path, "Unsupported scalar value.");
      return null;
    }
    if (isSeq(node)) {
      return node.items.map((item, index) => convert(item, [...path, index], undefined));
    }
    if (isMap(node)) {
      const result: Record<string, unknown> = {};
      for (const pair of node.items) {
        if (!isScalar(pair.key)) {
          const keyRange = isNodeWithRange(pair.key) ? pair.key.range : undefined;
          const at = keyRange ? loc(keyRange[0], keyRange[1]) : value;
          reporter.diagnostics.push({ code: codes.value, message: "Mapping keys must be scalars.", line: at.line, column: at.column, range: { start: at.start, end: at.end } });
          continue;
        }
        const name = String(pair.key.value);
        const keyRange = pair.key.range;
        const keyLoc = keyRange ? loc(keyRange[0], keyRange[1]) : value;
        Object.defineProperty(result, name, {
          value: convert(pair.value, [...path, name], keyLoc),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
    reporter.report(codes.value, path, "Unsupported YAML node.");
    return null;
  };
  const value = convert(doc.contents, [], undefined);
  return { value, source, reporter };
}

function keyEndAt(doc: Document, start: number): number | undefined {
  let end: number | undefined;
  visit(doc, {
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.range?.[0] === start) {
        end = pair.key.range[1];
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return end;
}

function isNodeWithRange(node: unknown): node is Node & { range: [number, number, number] } {
  return (isScalar(node) || isMap(node) || isSeq(node) || isAlias(node)) && Array.isArray(node.range);
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

export function parseWorkflow(text: string): { workflow: Workflow | null; diagnostics: Diagnostic[] } {
  const parsed = parseYaml(text, { syntax: "yaml_syntax", duplicate: "duplicate_key", value: "value_invalid" });
  const { reporter, source } = parsed;
  if (reporter.diagnostics.length > 0) return { workflow: null, diagnostics: reporter.diagnostics };
  const root = parsed.value;
  if (!isRecord(root)) {
    reporter.report("value_invalid", [], "The workflow must be a YAML mapping.");
    return { workflow: null, diagnostics: reporter.diagnostics };
  }
  reportUnknownKeys(reporter, root, [], TOP_KEYS);

  let name: string | undefined;
  if (root.name !== undefined) name = readText(reporter, root.name, ["name"]);
  const inputs = readInputs(reporter, root.inputs);
  const defaults = readDefaults(reporter, root.defaults);
  const jobs = readJobs(reporter, root.jobs);

  if (reporter.diagnostics.length > 0) return { workflow: null, diagnostics: reporter.diagnostics };
  const workflow: Workflow = { inputs, defaults, jobs, source };
  if (name !== undefined) workflow.name = name;
  return { workflow, diagnostics: [] };
}

export function reportUnknownKeys(reporter: Reporter, value: Record<string, unknown>, path: Path, known: ReadonlySet<string>, code = "unknown_key", jobId?: string): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      const options: { onKey: boolean; jobId?: string } = { onKey: true };
      if (jobId !== undefined) options.jobId = jobId;
      reporter.report(code, [...path, key], `Unknown key \`${key}\`. Allowed: ${[...known].join(", ")}.`, options);
    }
  }
}

function readText(reporter: Reporter, value: unknown, path: Path, code = "value_invalid", jobId?: string): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  const options: { jobId?: string } = {};
  if (jobId !== undefined) options.jobId = jobId;
  reporter.report(code, path, "Expected a non-empty string.", options);
  return undefined;
}

function readInteger(reporter: Reporter, value: unknown, path: Path, min: number, max: number, code = "value_invalid", jobId?: string): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
  const options: { jobId?: string } = {};
  if (jobId !== undefined) options.jobId = jobId;
  reporter.report(code, path, `Expected an integer from ${min} to ${max}.`, options);
  return undefined;
}

function readInputs(reporter: Reporter, value: unknown): Record<string, InputDecl> {
  const result: Record<string, InputDecl> = {};
  if (value === undefined || value === null) return result;
  if (!isRecord(value)) {
    reporter.report("value_invalid", ["inputs"], "`inputs` must be a mapping.");
    return result;
  }
  let tasksInput: string | undefined;
  for (const [inputName, raw] of Object.entries(value)) {
    const path: Path = ["inputs", inputName];
    if (!NAME_PATTERN.test(inputName)) {
      reporter.report("value_invalid", path, `Input name \`${inputName}\` must match ${NAME_PATTERN.source}.`, { onKey: true });
    }
    if (!isRecord(raw)) {
      reporter.report("input_type_invalid", path, "An input declaration must be a mapping with `type`.");
      continue;
    }
    reportUnknownKeys(reporter, raw, path, INPUT_KEYS);
    const type = raw.type;
    if (typeof type !== "string" || !INPUT_TYPES.has(type)) {
      reporter.report("input_type_invalid", [...path, "type"], "Input `type` must be string, number, boolean or tasks.");
      continue;
    }
    const inputType = asInputType(type);
    const decl: InputDecl = { type: inputType, required: true };
    if (raw.required !== undefined) {
      if (typeof raw.required === "boolean") decl.required = raw.required;
      else reporter.report("value_invalid", [...path, "required"], "`required` must be a boolean.");
    }
    if (raw.description !== undefined) {
      const description = readText(reporter, raw.description, [...path, "description"]);
      if (description !== undefined) decl.description = description;
    }
    if (raw.default !== undefined) {
      if (inputType === "tasks") {
        reporter.report("input_type_invalid", [...path, "default"], "A `tasks` input has no default; tasks are supplied at Start.");
      } else if (typeof raw.default !== inputType || (inputType === "number" && !Number.isFinite(raw.default))) {
        reporter.report("input_type_invalid", [...path, "default"], `The default must be a ${inputType}.`);
      } else {
        decl.default = raw.default;
      }
    }
    if (inputType === "tasks") {
      if (tasksInput !== undefined) {
        reporter.report("input_type_invalid", [...path, "type"], `Only one \`tasks\` input is allowed; \`${tasksInput}\` is already declared.`);
      } else {
        tasksInput = inputName;
      }
    }
    result[inputName] = decl;
  }
  return result;
}

function asInputType(type: string): InputType {
  switch (type) {
    case "string":
    case "number":
    case "boolean":
    case "tasks":
      return type;
    default:
      throw new Error(`Unexpected input type ${type}`);
  }
}

function readDefaults(reporter: Reporter, value: unknown): Workflow["defaults"] {
  const defaults: Workflow["defaults"] = { maxParallel: DEFAULT_MAX_PARALLEL, agent: {} };
  if (value === undefined || value === null) return defaults;
  if (!isRecord(value)) {
    reporter.report("value_invalid", ["defaults"], "`defaults` must be a mapping.");
    return defaults;
  }
  reportUnknownKeys(reporter, value, ["defaults"], DEFAULTS_KEYS);
  if (value["max-parallel"] !== undefined) {
    const max = readInteger(reporter, value["max-parallel"], ["defaults", "max-parallel"], 1, 8);
    if (max !== undefined) defaults.maxParallel = max;
  }
  if (value.agent !== undefined) {
    defaults.agent = readAgentDecl(reporter, value.agent, ["defaults", "agent"], "value_invalid") ?? {};
  }
  return defaults;
}

/** Reads an `agent`, `reviewer` or `defaults.agent` block. Shape errors use `code`; unknown keys use `unknown_key`. */
export function readAgentDecl(reporter: Reporter, value: unknown, path: Path, code: string, jobId?: string): AgentSettingsDecl | null {
  const options: { jobId?: string } = {};
  if (jobId !== undefined) options.jobId = jobId;
  if (!isRecord(value)) {
    reporter.report(code, path, "Agent settings must be a mapping.", options);
    return null;
  }
  const before = reporter.diagnostics.length;
  reportUnknownKeys(reporter, value, path, AGENT_KEYS, "unknown_key", jobId);
  const decl: AgentSettingsDecl = {};
  if (value.profile !== undefined) {
    const profile = readText(reporter, value.profile, [...path, "profile"], code, jobId);
    if (profile !== undefined) decl.profile = profile;
  }
  if (value.model !== undefined) {
    const model = readModel(reporter, value.model, [...path, "model"], code, jobId);
    if (model !== undefined) decl.model = model;
  }
  if (value.profile !== undefined && value.model !== undefined) {
    reporter.report(code, [...path, "model"], "Set either `profile` or `model`, not both.", options);
  }
  if (value.reasoning !== undefined) {
    const reasoning = readReasoning(reporter, value.reasoning, [...path, "reasoning"], code, jobId);
    if (reasoning !== undefined) decl.reasoning = reasoning;
  }
  if (value.fallback !== undefined) {
    const fallbackPath: Path = [...path, "fallback"];
    const raw = value.fallback;
    if (!isRecord(raw)) {
      reporter.report(code, fallbackPath, "`fallback` must be a mapping with `model`.", options);
    } else {
      reportUnknownKeys(reporter, raw, fallbackPath, FALLBACK_KEYS, "unknown_key", jobId);
      const model = raw.model === undefined ? undefined : readModel(reporter, raw.model, [...fallbackPath, "model"], code, jobId);
      if (raw.model === undefined) reporter.report(code, fallbackPath, "`fallback` requires `model`.", options);
      if (model !== undefined) {
        const fallback: Fallback = { model };
        if (raw.reasoning !== undefined) {
          const reasoning = readReasoning(reporter, raw.reasoning, [...fallbackPath, "reasoning"], code, jobId);
          if (reasoning !== undefined) fallback.reasoning = reasoning;
        }
        decl.fallback = fallback;
      }
    }
  }
  if (value.retries !== undefined) {
    const retries = readInteger(reporter, value.retries, [...path, "retries"], 0, 10, code, jobId);
    if (retries !== undefined) decl.retries = retries;
  }
  return reporter.diagnostics.length > before ? null : decl;
}

function readModel(reporter: Reporter, value: unknown, path: Path, code: string, jobId?: string): string | undefined {
  if (typeof value === "string" && MODEL_PATTERN.test(value)) return value;
  const options: { jobId?: string } = {};
  if (jobId !== undefined) options.jobId = jobId;
  reporter.report(code, path, "`model` must be `<provider>/<model>`.", options);
  return undefined;
}

function readReasoning(reporter: Reporter, value: unknown, path: Path, code: string, jobId?: string): Reasoning | undefined {
  const found = REASONING_LEVELS.find((level) => level === value);
  if (found) return found;
  const options: { jobId?: string } = {};
  if (jobId !== undefined) options.jobId = jobId;
  reporter.report(code, path, "`reasoning` must be low, medium or high.", options);
  return undefined;
}

function readJobs(reporter: Reporter, value: unknown): Job[] {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    reporter.report("value_invalid", ["jobs"], "`jobs` must be a non-empty mapping.");
    return [];
  }
  const jobs: Job[] = [];
  for (const [id, raw] of Object.entries(value)) {
    const job = readJob(reporter, id, raw);
    if (job) jobs.push(job);
  }
  return jobs;
}

function readJob(reporter: Reporter, id: string, raw: unknown): Job | null {
  const path: Path = ["jobs", id];
  if (!JOB_ID_PATTERN.test(id)) {
    reporter.report("job_id_invalid", path, `Job id \`${id}\` must match ${JOB_ID_PATTERN.source}.`, { onKey: true, jobId: id });
  }
  if (!isRecord(raw)) {
    reporter.report("value_invalid", path, "A job must be a mapping.", { jobId: id });
    return null;
  }
  reportUnknownKeys(reporter, raw, path, JOB_KEYS, "unknown_key", id);
  const job: Job = { id, needs: [], uses: "", with: {}, outputs: {}, done: [] };
  if (typeof raw.uses === "string") job.uses = raw.uses;
  else reporter.report("uses_unknown", raw.uses === undefined ? path : [...path, "uses"], "A job requires `uses` with a built-in name.", { onKey: raw.uses === undefined, jobId: id });

  if (raw.name !== undefined) {
    const text = readText(reporter, raw.name, [...path, "name"], "value_invalid", id);
    if (text !== undefined) job.name = text;
  }
  if (raw.description !== undefined) {
    const text = readText(reporter, raw.description, [...path, "description"], "value_invalid", id);
    if (text !== undefined) job.description = text;
  }
  if (raw.kind !== undefined) {
    const kind = JOB_KINDS.find((candidate): candidate is JobKind => candidate === raw.kind);
    if (kind) job.kind = kind;
    else reporter.report("value_invalid", [...path, "kind"], `\`kind\` must be one of ${JOB_KINDS.join(", ")}.`, { jobId: id });
  }
  if (raw.needs !== undefined) job.needs = readNeeds(reporter, raw.needs, [...path, "needs"], id);
  if (raw.with !== undefined && raw.with !== null) {
    if (isRecord(raw.with)) job.with = raw.with;
    else reporter.report("with_type", [...path, "with"], "`with` must be a mapping.", { jobId: id });
  }
  if (raw.outputs !== undefined && raw.outputs !== null) job.outputs = readOutputs(reporter, raw.outputs, [...path, "outputs"], id);
  if (raw.done !== undefined && raw.done !== null) {
    job.done = readDoneItems(reporter, raw.done, [...path, "done"], { shape: "value_invalid", argv: "command_argv_invalid" }, id);
  }
  if (raw.acceptance !== undefined) {
    if (raw.acceptance === "auto" || raw.acceptance === "human") job.acceptance = raw.acceptance;
    else reporter.report("acceptance_invalid", [...path, "acceptance"], "`acceptance` must be auto or human.", { jobId: id });
  }
  if (raw.rework !== undefined) {
    const rework = readRework(reporter, raw.rework, [...path, "rework"], id);
    if (rework) job.rework = rework;
  }
  if (raw.strategy !== undefined) {
    const strategy = readStrategy(reporter, raw.strategy, [...path, "strategy"], id);
    if (strategy) job.strategy = strategy;
  }
  return job;
}

/** Reads the shape of `strategy`; the matrix value itself is checked by validation. */
function readStrategy(reporter: Reporter, value: unknown, path: Path, jobId: string): Strategy | null {
  if (!isRecord(value)) {
    reporter.report("value_invalid", path, "`strategy` must be `{ matrix: { <key>: <list or reference> }, max-parallel }`.", { jobId });
    return null;
  }
  reportUnknownKeys(reporter, value, path, STRATEGY_KEYS, "unknown_key", jobId);
  let maxParallel = DEFAULT_MATRIX_MAX_PARALLEL;
  if (value["max-parallel"] !== undefined) {
    const read = readInteger(reporter, value["max-parallel"], [...path, "max-parallel"], 1, MAX_MATRIX_PARALLEL, "value_invalid", jobId);
    if (read === undefined) return null;
    maxParallel = read;
  }
  const matrixPath: Path = [...path, "matrix"];
  const matrix = value.matrix;
  if (!isRecord(matrix) || Object.keys(matrix).length !== 1) {
    reporter.report("matrix_keys", matrix === undefined ? path : matrixPath, "`strategy.matrix` must have exactly one key.", { onKey: matrix === undefined, jobId });
    return null;
  }
  const [[key, item] = ["", undefined]] = Object.entries(matrix);
  if (!NAME_PATTERN.test(key)) {
    reporter.report("matrix_keys", [...matrixPath, key], `Matrix key \`${key}\` must match ${NAME_PATTERN.source}.`, { onKey: true, jobId });
    return null;
  }
  if (typeof item === "string") return { matrix: { [key]: item }, maxParallel };
  if (Array.isArray(item)) {
    const items: unknown[] = item;
    return { matrix: { [key]: items }, maxParallel };
  }
  reporter.report("matrix_ref_not_list", [...matrixPath, key], "A matrix value is a list of scalars or exactly one reference to a list output.", { jobId });
  return null;
}

function readNeeds(reporter: Reporter, value: unknown, path: Path, jobId: string): string[] {
  const list: unknown[] = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (typeof value !== "string" && !Array.isArray(value)) {
    reporter.report("value_invalid", path, "`needs` must be a job id or a list of job ids.", { jobId });
    return [];
  }
  const needs: string[] = [];
  list.forEach((item, index) => {
    const itemPath: Path = typeof value === "string" ? path : [...path, index];
    if (typeof item !== "string") {
      reporter.report("value_invalid", itemPath, "A `needs` entry must be a job id.", { jobId });
    } else if (needs.includes(item)) {
      reporter.report("value_invalid", itemPath, `\`${item}\` is listed twice.`, { jobId });
    } else {
      needs.push(item);
    }
  });
  return needs;
}

function readOutputs(reporter: Reporter, value: unknown, path: Path, jobId: string): Record<string, OutputDecl> {
  const outputs: Record<string, OutputDecl> = {};
  if (!isRecord(value)) {
    reporter.report("output_type_invalid", path, "`outputs` must be a mapping.", { jobId });
    return outputs;
  }
  for (const [outputName, raw] of Object.entries(value)) {
    const outputPath: Path = [...path, outputName];
    if (!NAME_PATTERN.test(outputName)) {
      reporter.report("value_invalid", outputPath, `Output name \`${outputName}\` must match ${NAME_PATTERN.source}.`, { onKey: true, jobId });
    }
    if (!isRecord(raw)) {
      reporter.report("output_type_invalid", outputPath, "An output declaration must be a mapping with `type`.", { jobId });
      continue;
    }
    reportUnknownKeys(reporter, raw, outputPath, OUTPUT_KEYS, "unknown_key", jobId);
    const decl = outputDecl(raw.type, raw.items);
    if (decl) outputs[outputName] = decl;
    else reporter.report("output_type_invalid", outputPath, "Output `type` must be string, number, boolean, object, or list with `items` string, number, boolean or object.", { jobId });
  }
  return outputs;
}

function outputDecl(type: unknown, items: unknown): OutputDecl | null {
  if (type === "list") {
    if (items === "string" || items === "number" || items === "boolean" || items === "object") return { type: "list", items };
    return null;
  }
  if (items !== undefined) return null;
  if (type === "string" || type === "number" || type === "boolean" || type === "object") return { type };
  return null;
}

export type DoneCodes = { shape: string; argv: string };

/** Reads `done` items: `{ run: <command> }` or `{ criterion: <text> }`. */
export function readDoneItems(reporter: Reporter, value: unknown, path: Path, codes: DoneCodes, jobId?: string): DoneItem[] {
  const options: { jobId?: string } = {};
  if (jobId !== undefined) options.jobId = jobId;
  if (!Array.isArray(value)) {
    reporter.report(codes.shape, path, "`done` must be a list of `{ run }` or `{ criterion }` items.", options);
    return [];
  }
  const items: DoneItem[] = [];
  value.forEach((raw: unknown, index) => {
    const itemPath: Path = [...path, index];
    if (!isRecord(raw)) {
      reporter.report(codes.shape, itemPath, "A `done` item must be `{ run: <command> }` or `{ criterion: <text> }`.", options);
      return;
    }
    const keys = Object.keys(raw);
    const unknown = keys.filter((key) => key !== "run" && key !== "criterion");
    for (const key of unknown) {
      reporter.report(codes.shape === "value_invalid" ? "unknown_key" : codes.shape, [...itemPath, key], `Unknown key \`${key}\`. Allowed: run, criterion.`, { ...options, onKey: true });
    }
    if (unknown.length > 0) return;
    if (keys.length !== 1) {
      reporter.report(codes.shape, itemPath, "A `done` item has exactly one of `run` or `criterion`.", options);
      return;
    }
    if (raw.criterion !== undefined) {
      if (typeof raw.criterion === "string" && raw.criterion.trim() !== "") items.push({ criterion: raw.criterion });
      else reporter.report(codes.shape, [...itemPath, "criterion"], "A criterion must be non-empty text.", options);
      return;
    }
    const command = readCommand(reporter, raw.run, [...itemPath, "run"], codes, jobId);
    if (command !== null) items.push({ run: command });
  });
  return items;
}

/** Checks the shape of a command: a non-empty shell string or a non-empty list of strings. */
export function readCommand(reporter: Reporter, value: unknown, path: Path, codes: DoneCodes, jobId?: string): Command | null {
  const options: { jobId?: string } = {};
  if (jobId !== undefined) options.jobId = jobId;
  if (typeof value === "string") {
    if (value.trim() !== "") return value;
    reporter.report(codes.shape, path, "A shell command must be non-empty.", options);
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      reporter.report(codes.argv, path, "An argv command must have at least one element.", options);
      return null;
    }
    const argv: string[] = [];
    let valid = true;
    value.forEach((element: unknown, index) => {
      if (typeof element === "string" && (index > 0 || element !== "")) {
        argv.push(element);
      } else {
        valid = false;
        reporter.report(codes.argv, [...path, index], index === 0 && element === "" ? "The executable must be non-empty." : "argv elements must be strings.", options);
      }
    });
    return valid ? argv : null;
  }
  reporter.report(codes.shape, path, "A command is a shell string or an argv list of strings.", options);
  return null;
}

function readRework(reporter: Reporter, value: unknown, path: Path, jobId: string): Rework | null {
  if (!isRecord(value)) {
    reporter.report("value_invalid", path, "`rework` must be `{ to: <job id>, max: <0..5> }`.", { jobId });
    return null;
  }
  reportUnknownKeys(reporter, value, path, REWORK_KEYS, "unknown_key", jobId);
  const to = readText(reporter, value.to, [...path, "to"], "value_invalid", jobId);
  let max = DEFAULT_REWORK_MAX;
  if (value.max !== undefined) {
    const read = readInteger(reporter, value.max, [...path, "max"], 0, 5, "value_invalid", jobId);
    if (read === undefined) return null;
    max = read;
  }
  return to === undefined ? null : { to, max };
}
