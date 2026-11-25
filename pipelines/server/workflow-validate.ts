import {
  JOB_ID_PATTERN,
  isBuiltIn,
  isMatrixScalar,
  isRecord,
  matrixItemsProblem,
  pathKey,
  type BuiltIn,
  type Command,
  type Diagnostic,
  type InputType,
  type Job,
  type OutputDecl,
  type Workflow,
} from "../shared/workflow";
import { readAgentDecl, Reporter, type Path } from "./workflow-parse";

export type Reference =
  | { kind: "input"; name: string }
  | { kind: "output"; job: string; name: string }
  | { kind: "matrix"; key: string };

export type ScannedText = {
  refs: Reference[];
  /** The whole text is exactly one reference. */
  exact: boolean;
  invalid: string[];
};

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const INPUT_REF = /^inputs\.([A-Za-z_][A-Za-z0-9_-]*)$/;
const OUTPUT_REF = /^needs\.([a-z][a-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_-]*)$/;
const MATRIX_REF = /^matrix\.([A-Za-z_][A-Za-z0-9_-]*)$/;

export function hasExpression(text: string): boolean {
  return text.includes("${{");
}

/** Finds `${{ … }}` references in a string. Unknown or unterminated expressions go to `invalid`. */
export function scanReferences(text: string): ScannedText {
  const refs: Reference[] = [];
  const invalid: string[] = [];
  let matches = 0;
  let exact = false;
  for (const match of text.matchAll(EXPRESSION)) {
    matches += 1;
    if (match.index === 0 && match[0].length === text.length) exact = true;
    const body = (match[1] ?? "").trim();
    const input = INPUT_REF.exec(body);
    const output = OUTPUT_REF.exec(body);
    const matrix = MATRIX_REF.exec(body);
    if (input?.[1] !== undefined) refs.push({ kind: "input", name: input[1] });
    else if (output?.[1] !== undefined && output[2] !== undefined) refs.push({ kind: "output", job: output[1], name: output[2] });
    else if (matrix?.[1] !== undefined) refs.push({ kind: "matrix", key: matrix[1] });
    else invalid.push(match[0]);
  }
  if (hasExpression(text.replace(EXPRESSION, ""))) invalid.push("${{");
  return { refs, exact: exact && matches === 1, invalid };
}

type Expected = "any" | "string" | "scalar";

const WITH_KEYS: Record<BuiltIn, readonly string[]> = {
  agent: ["prompt", "agent"],
  "run-tasks": ["tasks", "prompt", "context", "agent", "reviewer", "criteria"],
  checks: ["run", "isolated"],
  review: ["agent", "prompt"],
  approval: ["prompt"],
};

const SCALAR_TYPES = new Set<string>(["string", "number", "boolean", "scalar"]);

/** A reference's value type; `scalar` is a matrix value whose items mix scalar types. */
type RefType = InputType | OutputDecl["type"] | "scalar";

export function validateWorkflow(workflow: Workflow): Diagnostic[] {
  const reporter = new Reporter(workflow.source);
  const jobs = new Map<string, Job>();
  for (const job of workflow.jobs) {
    const path: Path = ["jobs", job.id];
    if (!JOB_ID_PATTERN.test(job.id)) {
      reporter.report("job_id_invalid", path, `Job id \`${job.id}\` must match ${JOB_ID_PATTERN.source}.`, { onKey: true, jobId: job.id });
    } else if (jobs.has(job.id)) {
      reporter.report("job_id_invalid", path, `Job id \`${job.id}\` is used twice.`, { onKey: true, jobId: job.id });
    }
    if (!jobs.has(job.id)) jobs.set(job.id, job);
  }

  for (const job of workflow.jobs) checkNeeds(reporter, job, jobs);
  checkCycles(reporter, workflow.jobs, jobs);

  let runTasks: string | undefined;
  for (const job of workflow.jobs) {
    const path: Path = ["jobs", job.id];
    if (!isBuiltIn(job.uses)) {
      reporter.report("uses_unknown", [...path, "uses"], `\`${job.uses}\` is not a built-in. Use agent, run-tasks, checks, review or approval.`, { jobId: job.id });
      continue;
    }
    if (job.uses === "run-tasks") {
      if (runTasks !== undefined) {
        reporter.report("run_tasks_multiple", [...path, "uses"], `Only one \`run-tasks\` job is allowed; \`${runTasks}\` already uses it.`, { jobId: job.id });
      } else {
        runTasks = job.id;
      }
    }
    checkPlacement(reporter, job, jobs);
    checkStrategy(reporter, job, jobs);
    checkWith(reporter, workflow, job, job.uses, jobs);
    checkDone(reporter, job);
  }
  return reporter.diagnostics;
}

function checkNeeds(reporter: Reporter, job: Job, jobs: ReadonlyMap<string, Job>): void {
  job.needs.forEach((need, index) => {
    const path = needPath(reporter, job, index);
    if (need === job.id) reporter.report("needs_self", path, `Job \`${job.id}\` cannot need itself.`, { jobId: job.id });
    else if (!jobs.has(need)) reporter.report("needs_unknown", path, `Unknown job \`${need}\`.`, { jobId: job.id });
  });
}

function needPath(reporter: Reporter, job: Job, index: number): Path {
  const item: Path = ["jobs", job.id, "needs", index];
  return reporter.source[pathKey(item)] ? item : ["jobs", job.id, "needs"];
}

function checkCycles(reporter: Reporter, ordered: readonly Job[], jobs: ReadonlyMap<string, Job>): void {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;
  const cyclic = new Set<string>();
  const visit = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    for (const need of jobs.get(id)?.needs ?? []) {
      if (need === id || !jobs.has(need)) continue;
      if (!index.has(need)) {
        visit(need);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(need) ?? 0));
      } else if (onStack.has(need)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(need) ?? 0));
      }
    }
    if (low.get(id) === index.get(id)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      if (component.length > 1) for (const item of component) cyclic.add(item);
    }
  };
  for (const job of ordered) if (!index.has(job.id)) visit(job.id);
  for (const job of ordered) {
    if (!cyclic.has(job.id)) continue;
    const at = job.needs.findIndex((need) => cyclic.has(need));
    reporter.report("needs_cycle", needPath(reporter, job, Math.max(at, 0)), `Job \`${job.id}\` is part of a \`needs\` cycle.`, { jobId: job.id });
  }
}

export function ancestors(id: string, jobs: ReadonlyMap<string, Job>): Set<string> {
  const seen = new Set<string>();
  const pending = [...(jobs.get(id)?.needs ?? [])];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next) || !jobs.has(next)) continue;
    seen.add(next);
    pending.push(...(jobs.get(next)?.needs ?? []));
  }
  return seen;
}

function checkPlacement(reporter: Reporter, job: Job, jobs: ReadonlyMap<string, Job>): void {
  const path: Path = ["jobs", job.id];
  if (job.uses !== "agent" && Object.keys(job.outputs).length > 0) {
    reporter.report("unknown_key", [...path, "outputs"], "Only `agent` jobs declare outputs.", { onKey: true, jobId: job.id });
  }
  if (job.uses !== "agent" && job.acceptance !== undefined) {
    reporter.report("acceptance_invalid", [...path, "acceptance"], "`acceptance` applies to `agent` jobs only.", { onKey: true, jobId: job.id });
  }
  if (job.rework) {
    if (job.uses !== "review" && job.uses !== "approval") {
      reporter.report("rework_on_wrong_job", [...path, "rework"], "`rework` is allowed on `review` and `approval` jobs only.", { onKey: true, jobId: job.id });
    } else if (!ancestors(job.id, jobs).has(job.rework.to)) {
      reporter.report("rework_target_not_ancestor", [...path, "rework", "to"], `\`${job.rework.to}\` is not an ancestor of \`${job.id}\` through \`needs\`.`, { jobId: job.id });
    }
  }
}

const MATRIX_MESSAGES = {
  matrix_empty: "A matrix needs at least one item.",
  matrix_too_large: "A matrix has at most 64 items.",
  matrix_invalid: "Matrix items must be unique scalars.",
} as const;

/** The matrix source of a job with `strategy`: a fixed scalar list, or one reference to a scalar `list` output of a direct need. */
function checkStrategy(reporter: Reporter, job: Job, jobs: ReadonlyMap<string, Job>): void {
  const strategy = job.strategy;
  if (!strategy) return;
  const path: Path = ["jobs", job.id, "strategy"];
  const options = { jobId: job.id };
  if (job.uses !== "agent" && job.uses !== "checks") {
    reporter.report("matrix_uses_unsupported", path, "Only `agent` and `checks` jobs take a matrix.", { onKey: true, jobId: job.id });
  }
  if (Object.keys(job.outputs).length > 0) {
    reporter.report("matrix_outputs_unsupported", ["jobs", job.id, "outputs"], "A matrix job declares no outputs.", { onKey: true, jobId: job.id });
  }
  for (const [key, value] of Object.entries(strategy.matrix)) {
    const valuePath: Path = [...path, "matrix", key];
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      const bad = items.findIndex((item) => !isMatrixScalar(item));
      if (bad >= 0) {
        reporter.report("matrix_invalid", [...valuePath, bad], "Matrix items must be scalars.", options);
        continue;
      }
      const problem = matrixItemsProblem(items);
      if (problem) reporter.report(problem, valuePath, MATRIX_MESSAGES[problem], options);
      continue;
    }
    const source = matrixSource(value);
    if (!source) {
      reporter.report("matrix_ref_not_list", valuePath, "A matrix reference is exactly `${{ needs.<job>.outputs.<name> }}`.", options);
      continue;
    }
    if (!job.needs.includes(source.jobId)) {
      reporter.report("ref_not_in_needs", valuePath, `\`${source.jobId}\` is not in the \`needs\` of \`${job.id}\`.`, options);
      continue;
    }
    const need = jobs.get(source.jobId);
    const decl = need?.uses === "agent" ? need.outputs[source.output] : undefined;
    if (!decl) reporter.report("ref_unknown_output", valuePath, `Job \`${source.jobId}\` declares no output \`${source.output}\`.`, options);
    else if (decl.type !== "list" || decl.items === "object") {
      reporter.report("matrix_ref_not_list", valuePath, `\`${source.jobId}.${source.output}\` must be a list of strings, numbers or booleans.`, options);
    }
  }
}

/** The output a dynamic matrix value names, when it is exactly one output reference. */
export function matrixSource(value: string): { jobId: string; output: string } | null {
  const scanned = scanReferences(value);
  const [ref] = scanned.refs;
  if (!scanned.exact || scanned.invalid.length > 0 || ref?.kind !== "output") return null;
  return { jobId: ref.job, output: ref.name };
}

function checkDone(reporter: Reporter, job: Job): void {
  job.done.forEach((item, index) => {
    const path: Path = ["jobs", job.id, "done", index];
    if (job.uses !== "agent") {
      reporter.report("criterion_unverified", path, "Acceptance criteria are verified on `agent` jobs only.", { jobId: job.id });
      return;
    }
    if ("criterion" in item) {
      if (hasExpression(item.criterion)) {
        reporter.report("expression_unsupported", [...path, "criterion"], "Criteria take no references.", { jobId: job.id });
      }
      return;
    }
    checkLiteralCommand(reporter, item.run, [...path, "run"], job.id);
  });
}

/** A command that takes no reference in either form. */
export function checkLiteralCommand(reporter: Reporter, command: Command, path: Path, jobId?: string): void {
  const options: { jobId?: string } = {};
  if (jobId !== undefined) options.jobId = jobId;
  if (typeof command === "string") {
    if (hasExpression(command)) reporter.report("command_shell_ref", path, "A shell command is literal; use an argv list to pass values.", options);
    return;
  }
  command.forEach((element, index) => {
    if (!hasExpression(element)) return;
    if (index === 0) reporter.report("command_exec_ref", [...path, index], "The executable must be literal.", options);
    else reporter.report("expression_unsupported", [...path, index], "Acceptance criteria commands take no references.", options);
  });
}

function checkWith(reporter: Reporter, workflow: Workflow, job: Job, uses: BuiltIn, jobs: ReadonlyMap<string, Job>): void {
  const path: Path = ["jobs", job.id, "with"];
  const allowed = WITH_KEYS[uses];
  const options = { jobId: job.id };
  for (const key of Object.keys(job.with)) {
    if (!allowed.includes(key)) {
      reporter.report("with_unknown", [...path, key], `\`${uses}\` takes no parameter \`${key}\`. Allowed: ${allowed.join(", ") || "none"}.`, { onKey: true, jobId: job.id });
    }
  }
  const refs = new RefChecker(reporter, workflow, job, jobs);
  const w = job.with;
  if (uses === "agent" && w.prompt === undefined) {
    reporter.report("with_type", ["jobs", job.id, Object.keys(w).length > 0 ? "with" : "uses"], "`agent` requires `with.prompt`.", options);
  }
  if (w.prompt !== undefined && allowed.includes("prompt")) {
    if (typeof w.prompt === "string" && w.prompt.trim() !== "") refs.check(w.prompt, [...path, "prompt"], "string");
    else reporter.report("with_type", [...path, "prompt"], "`prompt` must be non-empty text.", options);
  }
  for (const key of ["agent", "reviewer"] as const) {
    const value = w[key];
    if (value === undefined || !allowed.includes(key)) continue;
    readAgentDecl(reporter, value, [...path, key], "with_type", job.id);
    if (containsExpression(value)) reporter.report("expression_unsupported", [...path, key], "Agent settings take no references.", options);
  }
  if (uses === "run-tasks") {
    if (w.tasks !== undefined) checkTasksRef(reporter, workflow, w.tasks, [...path, "tasks"], job.id);
    if (w.context !== undefined) refs.walk(w.context, [...path, "context"]);
    if (w.criteria !== undefined && w.criteria !== "reviewer" && w.criteria !== "human") {
      reporter.report("with_type", [...path, "criteria"], "`criteria` must be reviewer or human.", options);
    }
  }
  if (uses === "checks") {
    if (w.isolated !== undefined && typeof w.isolated !== "boolean") {
      reporter.report("with_type", [...path, "isolated"], "`isolated` must be a boolean.", options);
    }
    if (!Array.isArray(w.run) || w.run.length === 0) {
      reporter.report("with_type", w.run === undefined ? ["jobs", job.id, "uses"] : [...path, "run"], "`checks` requires `with.run`, a non-empty list of commands.", options);
    } else {
      w.run.forEach((entry: unknown, index) => checkRunEntry(reporter, refs, entry, [...path, "run", index], job.id));
    }
  }
}

function checkRunEntry(reporter: Reporter, refs: RefChecker, entry: unknown, path: Path, jobId: string): void {
  const options = { jobId };
  if (typeof entry === "string") {
    if (entry.trim() === "") reporter.report("with_type", path, "A shell command must be non-empty.", options);
    else if (hasExpression(entry)) reporter.report("command_shell_ref", path, "A shell command is literal; use an argv list to pass values.", options);
    return;
  }
  if (!Array.isArray(entry)) {
    reporter.report("with_type", path, "A command is a shell string or an argv list of strings.", options);
    return;
  }
  if (entry.length === 0) {
    reporter.report("command_argv_invalid", path, "An argv command must have at least one element.", options);
    return;
  }
  entry.forEach((element: unknown, index) => {
    const elementPath: Path = [...path, index];
    if (typeof element !== "string" || (index === 0 && element === "")) {
      reporter.report("command_argv_invalid", elementPath, index === 0 && element === "" ? "The executable must be non-empty." : "argv elements must be strings.", options);
    } else if (index === 0) {
      if (hasExpression(element)) reporter.report("command_exec_ref", elementPath, "The executable must be literal.", options);
    } else {
      refs.check(element, elementPath, "scalar");
    }
  });
}

function checkTasksRef(reporter: Reporter, workflow: Workflow, value: unknown, path: Path, jobId: string): void {
  const options = { jobId };
  const scanned = typeof value === "string" ? scanReferences(value) : null;
  const ref = scanned?.exact ? scanned.refs[0] : undefined;
  if (!scanned || !ref || scanned.invalid.length > 0) {
    reporter.report("with_type", path, "`tasks` must be exactly `${{ inputs.<name> }}` naming a `tasks` input.", options);
    return;
  }
  if (ref.kind !== "input") {
    reporter.report("ref_type", path, "`tasks` must reference a `tasks` input.", options);
    return;
  }
  const decl = workflow.inputs[ref.name];
  if (!decl) reporter.report("ref_unknown_input", path, `Unknown input \`${ref.name}\`.`, options);
  else if (decl.type !== "tasks") reporter.report("ref_type", path, `Input \`${ref.name}\` is a ${decl.type}, not tasks.`, options);
}

function containsExpression(value: unknown): boolean {
  if (typeof value === "string") return hasExpression(value);
  if (Array.isArray(value)) return value.some((item: unknown) => containsExpression(item));
  if (isRecord(value)) return Object.values(value).some((item) => containsExpression(item));
  return false;
}

class RefChecker {
  constructor(
    private readonly reporter: Reporter,
    private readonly workflow: Workflow,
    private readonly job: Job,
    private readonly jobs: ReadonlyMap<string, Job>,
  ) {}

  walk(value: unknown, path: Path): void {
    if (typeof value === "string") this.check(value, path, "any");
    else if (Array.isArray(value)) value.forEach((item: unknown, index) => this.walk(item, [...path, index]));
    else if (isRecord(value)) for (const [key, item] of Object.entries(value)) this.walk(item, [...path, key]);
  }

  check(text: string, path: Path, expected: Expected): void {
    const options = { jobId: this.job.id };
    const scanned = scanReferences(text);
    for (const expression of scanned.invalid) {
      this.reporter.report("expression_unsupported", path, `Unsupported expression \`${expression}\`. Use inputs.<name> or needs.<job>.outputs.<name>.`, options);
    }
    for (const ref of scanned.refs) {
      const type = this.typeOf(ref, path);
      if (type === null) continue;
      const scalar = SCALAR_TYPES.has(type);
      if (type === "tasks") {
        this.reporter.report("ref_type", path, "A `tasks` input is used only by `run-tasks` `with.tasks`.", options);
      } else if ((!scanned.exact || expected === "scalar") && !scalar) {
        this.reporter.report("ref_type", path, `A ${type} value cannot be embedded in text; only scalars can.`, options);
      } else if (expected === "string" && scanned.exact && type !== "string") {
        this.reporter.report("ref_type", path, `Expected a string, got a ${type}.`, options);
      }
    }
  }

  private typeOf(ref: Reference, path: Path): RefType | null {
    const options = { jobId: this.job.id };
    switch (ref.kind) {
      case "input": {
        const decl = this.workflow.inputs[ref.name];
        if (decl) return decl.type;
        this.reporter.report("ref_unknown_input", path, `Unknown input \`${ref.name}\`.`, options);
        return null;
      }
      case "output": {
        if (!this.job.needs.includes(ref.job)) {
          this.reporter.report("ref_not_in_needs", path, `\`${ref.job}\` is not in the \`needs\` of \`${this.job.id}\`.`, options);
          return null;
        }
        const source = this.jobs.get(ref.job);
        const decl = source?.uses === "agent" ? source.outputs[ref.name] : undefined;
        if (decl) return decl.type;
        this.reporter.report("ref_unknown_output", path, `Job \`${ref.job}\` declares no output \`${ref.name}\`.`, options);
        return null;
      }
      case "matrix": {
        const value = this.job.strategy?.matrix[ref.key];
        if (value === undefined) {
          this.reporter.report("expression_unsupported", path, `\`matrix.${ref.key}\` needs \`strategy.matrix.${ref.key}\` on this job.`, options);
          return null;
        }
        return this.matrixType(value);
      }
    }
  }

  private matrixType(value: unknown[] | string): RefType {
    if (Array.isArray(value)) {
      const types = new Set(value.map((item) => typeof item));
      const [only] = types;
      return types.size === 1 && (only === "string" || only === "number" || only === "boolean") ? only : "scalar";
    }
    const source = matrixSource(value);
    const decl = source ? this.jobs.get(source.jobId)?.outputs[source.output] : undefined;
    return decl?.type === "list" && decl.items !== "object" ? decl.items : "scalar";
  }
}
