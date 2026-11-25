import { canonicalJson } from "../shared/canonical";
import type { OutputError } from "../shared/run";
import { isRecord, type GraphJob, type OutputDecl, type OutputItemType } from "../shared/workflow";
import type { RunState } from "./run-engine";
import { liveMatrixValue, matrixPinned } from "./matrix";
import { scanReferences, type Reference } from "./workflow-validate";

/**
 * The value an instance runs with: the one its current attempt recorded, else the live item. A
 * dynamic instance resolves nothing once its expansion is no longer pinned to the source's current
 * successful attempt.
 */
function matrixValueOf(job: GraphJob, state: RunState): unknown {
  if (!matrixPinned(state, job)) return undefined;
  const attempts = state.jobs[job.id]?.attempts ?? [];
  const current = attempts[attempts.length - 1];
  const recorded = current === undefined ? undefined : state.attempts[current]?.matrixValue;
  return recorded ?? liveMatrixValue(state, job);
}

export const MAX_OUTPUTS_BYTES = 256 * 1024;
export const MAX_LIST_ITEMS = 256;

export type OutputsResult = { ok: true; outputs: Record<string, unknown> } | { ok: false; errors: OutputError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function matchesItem(type: OutputItemType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
  }
}

function checkOne(name: string, decl: OutputDecl, value: unknown): OutputError | null {
  if (decl.type === "list") {
    if (!Array.isArray(value)) return { name, code: "output_type", message: `Output \`${name}\` must be a list.` };
    const items: unknown[] = value;
    if (items.length > MAX_LIST_ITEMS) return { name, code: "output_too_large", message: `Output \`${name}\` has more than ${MAX_LIST_ITEMS} items.` };
    const bad = items.findIndex((item) => !matchesItem(decl.items, item));
    if (bad >= 0) return { name, code: "output_type", message: `Item ${bad} of \`${name}\` must be a ${decl.items}.` };
    return null;
  }
  if (!matchesItem(decl.type, value)) return { name, code: "output_type", message: `Output \`${name}\` must be a ${decl.type}.` };
  return null;
}

/**
 * Checks a submitted outputs value against the declaration: every declared output present, none
 * undeclared, exact types, at most 256 list items and 256 KiB of canonical JSON in total.
 */
export function validateOutputs(decl: Readonly<Record<string, OutputDecl>>, value: unknown): OutputsResult {
  if (!isPlainObject(value)) return { ok: false, errors: [{ name: null, code: "outputs_shape", message: "Outputs must be a JSON object." }] };
  const errors: OutputError[] = [];
  for (const [name, item] of Object.entries(decl)) {
    if (!(name in value)) errors.push({ name, code: "output_missing", message: `Output \`${name}\` is required.` });
    else {
      const error = checkOne(name, item, value[name]);
      if (error) errors.push(error);
    }
  }
  for (const name of Object.keys(value)) {
    if (!Object.hasOwn(decl, name)) errors.push({ name, code: "output_undeclared", message: `Output \`${name}\` is not declared.` });
  }
  if (errors.length > 0) return { ok: false, errors };
  let encoded: string;
  try {
    encoded = canonicalJson(value);
  } catch {
    return { ok: false, errors: [{ name: null, code: "outputs_shape", message: "Outputs must be plain JSON." }] };
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_OUTPUTS_BYTES) {
    return { ok: false, errors: [{ name: null, code: "output_too_large", message: "Outputs exceed 256 KiB." }] };
  }
  const outputs: unknown = JSON.parse(encoded);
  if (!isPlainObject(outputs)) return { ok: false, errors: [{ name: null, code: "outputs_shape", message: "Outputs must be a JSON object." }] };
  return { ok: true, outputs };
}

/** Thrown when a reference has no value: a missing input, or a job without a current successful attempt. */
export class UnresolvedReferenceError extends Error {
  constructor(readonly expression: string) {
    super(`Reference ${expression} has no value.`);
    this.name = "UnresolvedReferenceError";
  }
}

/** The value of one reference for `job`, from the snapshot inputs and current successful attempts. */
export function referenceValue(ref: Reference, job: GraphJob, state: RunState): unknown {
  switch (ref.kind) {
    case "input": {
      if (!Object.hasOwn(state.snapshot.inputs, ref.name)) throw new UnresolvedReferenceError(`inputs.${ref.name}`);
      return state.snapshot.inputs[ref.name];
    }
    case "output": {
      const source = state.graph.jobs.find((candidate) => candidate.id === ref.job);
      const attemptId = source ? state.jobs[source.id]?.succeeded : undefined;
      const outputs = attemptId ? state.attempts[attemptId]?.outputs : undefined;
      if (!outputs || !Object.hasOwn(outputs, ref.name)) throw new UnresolvedReferenceError(`needs.${ref.job}.outputs.${ref.name}`);
      return outputs[ref.name];
    }
    case "matrix": {
      const value = job.matrix?.key === ref.key ? matrixValueOf(job, state) : undefined;
      if (value === undefined) throw new UnresolvedReferenceError(`matrix.${ref.key} in ${job.id}`);
      return value;
    }
  }
}

function scalarText(value: unknown, expression: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new UnresolvedReferenceError(expression);
}

/** Resolves the references of one string: an exact reference keeps its type, an embedded one must be a scalar. */
export function resolveText(text: string, job: GraphJob, state: RunState): unknown {
  const scanned = scanReferences(text);
  if (scanned.refs.length === 0) return text;
  const [first] = scanned.refs;
  if (scanned.exact && first) return referenceValue(first, job, state);
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (whole) => {
    const inner = scanReferences(whole).refs[0];
    if (!inner) throw new UnresolvedReferenceError(whole);
    return scalarText(referenceValue(inner, job, state), whole);
  });
}

function resolveValue(value: unknown, job: GraphJob, state: RunState): unknown {
  if (typeof value === "string") return resolveText(value, job, state);
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.map((item) => resolveValue(item, job, state));
  }
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, job, state)]));
  return value;
}

/**
 * The job's `with` values with every reference resolved. Only outputs of a needed job's current
 * successful attempt resolve; otherwise `UnresolvedReferenceError` is thrown.
 */
export function resolveWith(job: GraphJob, state: RunState): Record<string, unknown> {
  return Object.fromEntries(Object.entries(job.with).map(([key, value]) => [key, resolveValue(value, job, state)]));
}

export function scalarValue(value: unknown, expression: string): string {
  return scalarText(value, expression);
}
