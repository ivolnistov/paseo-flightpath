import type { Command, GraphJob } from "../shared/workflow";
import { referenceValue, scalarValue, UnresolvedReferenceError } from "./outputs";
import type { RunState } from "./run-engine";
import { scanReferences } from "./workflow-validate";

/** A shell string for `/bin/sh -c`, or an argv list executed without a shell. */
export type ResolvedCommand = { shell: string } | { argv: string[] };

export const MAX_ARG_BYTES = 4096;

export type ResolveCommandResult = { ok: true; command: ResolvedCommand } | { ok: false; reason: "ref_value_invalid" };

/**
 * A shell string stays byte-identical. In an argv list the first element is literal and every later
 * element resolves to exactly one argument; no value is ever spliced into shell text. A resolved
 * element over 4 KiB, with a NUL byte, or without a scalar value fails with `ref_value_invalid`.
 */
export function resolveCommand(command: Command, job: GraphJob, state: RunState): ResolveCommandResult {
  if (typeof command === "string") return { ok: true, command: { shell: command } };
  const [program, ...rest] = command;
  if (program === undefined) return { ok: false, reason: "ref_value_invalid" };
  const argv: string[] = [program];
  try {
    for (const element of rest) {
      const resolved = resolveElement(element, job, state);
      if (resolved.includes("\0") || Buffer.byteLength(resolved, "utf8") > MAX_ARG_BYTES) return { ok: false, reason: "ref_value_invalid" };
      argv.push(resolved);
    }
  } catch (error) {
    if (error instanceof UnresolvedReferenceError) return { ok: false, reason: "ref_value_invalid" };
    throw error;
  }
  return { ok: true, command: { argv } };
}

function resolveElement(element: string, job: GraphJob, state: RunState): string {
  const scanned = scanReferences(element);
  if (scanned.refs.length === 0) return element;
  if (scanned.invalid.length > 0) throw new UnresolvedReferenceError(element);
  const [first] = scanned.refs;
  if (scanned.exact && first) return scalarValue(referenceValue(first, job, state), element);
  let out = "";
  let last = 0;
  for (const match of element.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const ref = scanReferences(match[0]).refs[0];
    if (!ref) throw new UnresolvedReferenceError(match[0]);
    out += element.slice(last, match.index) + scalarValue(referenceValue(ref, job, state), match[0]);
    last = match.index + match[0].length;
  }
  return out + element.slice(last);
}
