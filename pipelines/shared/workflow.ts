export const BUILT_INS = ["agent", "run-tasks", "checks", "review", "approval"] as const;
export type BuiltIn = (typeof BUILT_INS)[number];

export const JOB_KINDS = ["research", "design", "coding", "testing", "review", "acceptance"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const REASONING_LEVELS = ["low", "medium", "high"] as const;
export type Reasoning = (typeof REASONING_LEVELS)[number];

export type Acceptance = "auto" | "human";
export type CriteriaMode = "reviewer" | "human";

export const JOB_ID_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export const DEFAULT_MAX_PARALLEL = 3;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_REWORK_MAX = 2;
export const DEFAULT_MATRIX_MAX_PARALLEL = 1;
export const MAX_MATRIX_PARALLEL = 8;
export const MAX_MATRIX_ITEMS = 64;

/** One matrix item: a scalar passed as `${{ matrix.<key> }}`. */
export type MatrixScalar = string | number | boolean;

/** `strategy` as written: one matrix key whose value is a fixed list or exactly one reference. */
export type Strategy = { matrix: Record<string, unknown[] | string>; maxParallel: number };

/** A matrix declaration on a graph job: a fixed list expanded at Start, or a `list` output expanded when its source succeeds. */
export type MatrixDecl = {
  key: string;
  source: { fixed: MatrixScalar[] } | { ref: { jobId: string; output: string } };
  maxParallel: number;
};

/** A literal shell string run with `/bin/sh -c`, or an argv list executed without a shell. */
export type Command = string | string[];

export type DoneItem = { run: Command } | { criterion: string };

export type InputType = "string" | "number" | "boolean" | "tasks";

export type InputDecl = {
  type: InputType;
  required: boolean;
  default?: unknown;
  description?: string;
};

export type OutputItemType = "string" | "number" | "boolean" | "object";

export type OutputDecl =
  | { type: "string" | "number" | "boolean" | "object" }
  | { type: "list"; items: OutputItemType };

export type Fallback = { model: string; reasoning?: Reasoning };

/** Settings as written in YAML: every key is optional and inherits from `defaults.agent`. */
export type AgentSettingsDecl = {
  profile?: string;
  model?: string;
  reasoning?: Reasoning;
  fallback?: Fallback;
  retries?: number;
};

/** Settings after inheritance. */
export type AgentSettings = {
  profile?: string;
  model?: string;
  reasoning?: Reasoning;
  fallback?: Fallback;
  retries: number;
};

export type Rework = { to: string; max: number };

export type Job = {
  id: string;
  name?: string;
  description?: string;
  kind?: JobKind;
  needs: string[];
  uses: string;
  with: Record<string, unknown>;
  outputs: Record<string, OutputDecl>;
  done: DoneItem[];
  acceptance?: Acceptance;
  rework?: Rework;
  strategy?: Strategy;
};

export type WorkflowDefaults = {
  maxParallel: number;
  agent: AgentSettingsDecl;
};

export type SourceLoc = { line: number; column: number; start: number; end: number };

/** Source positions of parsed nodes, keyed by `pathKey(path)`. */
export type SourceIndex = Record<string, { key?: SourceLoc; value: SourceLoc }>;

export type Workflow = {
  name?: string;
  inputs: Record<string, InputDecl>;
  defaults: WorkflowDefaults;
  jobs: Job[];
  source: SourceIndex;
};

export type DiagnosticRange = { start: number; end: number };

/**
 * `line` and `column` are one-based; both are 0 when the value has no source text.
 * `range` uses zero-based UTF-16 offsets with an exclusive end.
 */
export type Diagnostic = {
  code: string;
  message: string;
  line: number;
  column: number;
  range: DiagnosticRange | null;
  jobId?: string;
  input?: string;
};

export type GraphJob = {
  id: string;
  sourceJobId: string;
  name: string;
  kind: JobKind;
  uses: "agent" | "run-task" | "checks" | "review" | "approval";
  taskId?: string;
  with: Record<string, unknown>;
  outputs: Record<string, OutputDecl>;
  done: DoneItem[];
  agent?: AgentSettings;
  reviewer?: AgentSettings;
  criteria: CriteriaMode;
  humanAcceptance: boolean;
  isolated: boolean;
  /**
   * Set on a matrix job. With `matrixIndex` the job is instance `<sourceJobId>[<matrixIndex>]`;
   * without it the job is a dynamic matrix that has not expanded and never runs itself.
   */
  matrix?: MatrixDecl;
  matrixIndex?: number;
};

export type ExpandedGraph = {
  jobs: GraphJob[];
  edges: Array<{ from: string; to: string }>;
  groups: Array<{ id: string; kind: "tasks" | "matrix"; jobIds: string[] }>;
  reworks: Array<{ from: string; to: string; max: number }>;
  maxParallel: number;
};

export type PathSegment = string | number;

export function pathKey(path: readonly PathSegment[]): string {
  return JSON.stringify(path);
}

export function isBuiltIn(value: string): value is BuiltIn {
  return (BUILT_INS as readonly string[]).includes(value);
}

export function defaultKind(uses: BuiltIn): JobKind {
  switch (uses) {
    case "agent":
    case "run-tasks":
      return "coding";
    case "checks":
      return "testing";
    case "review":
      return "review";
    case "approval":
      return "acceptance";
  }
}

export function isMatrixScalar(value: unknown): value is MatrixScalar {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

/** `<jobId>[<index>]`. */
export function matrixInstanceId(jobId: string, index: number): string {
  return `${jobId}[${index}]`;
}

/**
 * Checks matrix items: 1 to 64 unique scalars. Returns the failure reason, or null when valid.
 * Items are compared by type and value, so `1` and `"1"` are distinct.
 */
export function matrixItemsProblem(items: readonly unknown[]): "matrix_empty" | "matrix_too_large" | "matrix_invalid" | null {
  if (items.length === 0) return "matrix_empty";
  if (items.length > MAX_MATRIX_ITEMS) return "matrix_too_large";
  const seen = new Set<string>();
  for (const item of items) {
    if (!isMatrixScalar(item)) return "matrix_invalid";
    const key = `${typeof item}:${String(item)}`;
    if (seen.has(key)) return "matrix_invalid";
    seen.add(key);
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
