import { Document, isMap, isScalar, isSeq, parseDocument, stringify, type Pair, type YAMLMap } from "yaml";
import { PipelineError } from "../shared/errors";
import { isRecord, JOB_ID_PATTERN } from "../shared/workflow";

export const EDITABLE_JOB_KEYS = ["name", "description", "kind", "needs", "uses", "with", "outputs", "done", "acceptance", "rework"] as const;
export type EditableJobKey = (typeof EDITABLE_JOB_KEYS)[number];
export type JobFields = Partial<Record<EditableJobKey, unknown>>;

export type EditOp =
  | { kind: "job.add"; id: string; fields: JobFields }
  | { kind: "job.update"; id: string; set?: JobFields; unset?: EditableJobKey[] }
  | { kind: "job.remove"; id: string }
  | { kind: "job.setNeeds"; id: string; needs: string[] }
  | { kind: "job.patch"; id: string; changes: PatchChange[] };

/**
 * One leaf edit inside a job: `path` starts with an editable job key and may go up to three
 * mapping levels deeper. A change with `remove` deletes the key; a mapping it empties is removed too.
 */
export type PatchChange = { path: string[]; value?: unknown } | { path: string[]; remove: true };

export const MAX_PATCH_DEPTH = 4;

type Splice = { start: number; end: number; text: string };

const RENDER = { collectionStyle: "flow", lineWidth: 0, blockQuote: false } as const;

/**
 * Applies one job edit to workflow text. Block-style mappings are edited by splicing only the
 * affected lines, so every other line and comment stays byte-identical. Flow-style mappings are
 * re-rendered as a unit.
 */
export function applyEdit(text: string, op: EditOp): string {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new PipelineError("edit_unparseable", "The workflow has YAML errors; fix them in the YAML view first.");
  const jobs = doc.get("jobs", true);
  if (!isMap(jobs)) throw new PipelineError("edit_unparseable", "The workflow has no `jobs` mapping.");
  const editor = new TextEditor(text);
  const jobPair = findPair(jobs, op.id);

  switch (op.kind) {
    case "job.add": {
      if (!JOB_ID_PATTERN.test(op.id)) throw new PipelineError("edit_invalid", `Job id \`${op.id}\` must match ${JOB_ID_PATTERN.source}.`);
      if (jobPair) throw new PipelineError("job_exists", `Job \`${op.id}\` already exists.`);
      const fields = checkedFields(op.fields);
      if (!editor.addJob(jobs, op.id, fields)) {
        jobs.set(doc.createNode(op.id), doc.createNode(Object.fromEntries(fields)));
        editor.rerender(jobs);
      }
      break;
    }
    case "job.remove": {
      const pair = requireJob(jobPair, op.id);
      if (!editor.removePair(jobs, pair)) {
        jobs.delete(op.id);
        editor.rerender(jobs);
      }
      break;
    }
    case "job.update":
      updateJob(doc, editor, requireJob(jobPair, op.id), op.id, checkedFields(op.set ?? {}), op.unset ?? []);
      break;
    case "job.patch":
      patchJob(doc, editor, requireJob(jobPair, op.id), op.id, checkedChanges(op.changes));
      break;
    case "job.setNeeds": {
      if (op.needs.some((need) => typeof need !== "string" || need === "")) throw new PipelineError("edit_invalid", "`needs` entries must be job ids.");
      const pair = requireJob(jobPair, op.id);
      if (op.needs.length === 0) updateJob(doc, editor, pair, op.id, [], ["needs"]);
      else updateJob(doc, editor, pair, op.id, [["needs", [...op.needs]]], []);
      break;
    }
  }
  return editor.result();
}

function requireJob(pair: Pair | undefined, id: string): Pair {
  if (!pair) throw new PipelineError("job_not_found", `Job \`${id}\` does not exist.`);
  return pair;
}

function checkedFields(fields: JobFields): Array<[EditableJobKey, unknown]> {
  const entries: Array<[EditableJobKey, unknown]> = [];
  for (const [key, value] of Object.entries(fields)) {
    const known = EDITABLE_JOB_KEYS.find((candidate) => candidate === key);
    if (!known) throw new PipelineError("edit_invalid", `\`${key}\` is not an editable job key.`);
    if (value === undefined) throw new PipelineError("edit_invalid", `\`${key}\` has no value; use unset to remove it.`);
    entries.push([known, value]);
  }
  return entries;
}

function updateJob(doc: Document, editor: TextEditor, pair: Pair, id: string, set: Array<[EditableJobKey, unknown]>, unset: readonly EditableJobKey[]): void {
  for (const key of unset) {
    if (!EDITABLE_JOB_KEYS.includes(key)) throw new PipelineError("edit_invalid", `\`${key}\` is not an editable job key.`);
  }
  const job = pair.value;
  if (!isMap(job)) throw new PipelineError("edit_invalid", `Job \`${id}\` is not a mapping.`);
  if (job.flow || !editor.canSplice(job)) {
    for (const key of unset) job.delete(key);
    for (const [key, value] of set) job.set(key, doc.createNode(value));
    editor.rerender(job);
    return;
  }
  for (const key of unset) {
    const existing = findPair(job, key);
    if (existing) editor.removePair(job, existing);
  }
  for (const [key, value] of set) {
    const existing = findPair(job, key);
    if (existing) editor.replaceValue(job, existing, value);
    else editor.appendPair(job, key, value);
  }
}

type Change = { path: string[]; remove: boolean; value: unknown };

function checkedChanges(changes: readonly PatchChange[]): Change[] {
  if (changes.length === 0) throw new PipelineError("edit_invalid", "A patch needs at least one change.");
  const seen: string[][] = [];
  return changes.map((change) => {
    const path = change.path;
    if (path.length === 0 || path.length > MAX_PATCH_DEPTH || path.some((segment) => typeof segment !== "string" || segment === "")) {
      throw new PipelineError("edit_invalid", `A patch path has 1 to ${MAX_PATCH_DEPTH} non-empty keys.`);
    }
    if (!EDITABLE_JOB_KEYS.some((key) => key === path[0])) throw new PipelineError("edit_invalid", `\`${path[0] ?? ""}\` is not an editable job key.`);
    // One change per key, and never a key together with a key inside it.
    if (seen.some((other) => other.length <= path.length ? other.every((segment, i) => path[i] === segment) : path.every((segment, i) => other[i] === segment))) {
      throw new PipelineError("edit_invalid", `The patch changes \`${path.join(".")}\` twice.`);
    }
    seen.push(path);
    const remove = "remove" in change && change.remove === true;
    const value = "value" in change ? change.value : undefined;
    if (!remove && value === undefined) throw new PipelineError("edit_invalid", `\`${path.join(".")}\` has no value; use remove to delete it.`);
    return { path: [...path], remove, value };
  });
}

/** A nested value holding every set change below one key; removals there have nothing to remove. */
function nestedValue(changes: readonly Change[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const change of changes) {
    if (change.remove) continue;
    let cursor = out;
    change.path.forEach((segment, index) => {
      if (index === change.path.length - 1) cursor[segment] = change.value;
      else {
        const next = cursor[segment];
        const child: Record<string, unknown> = isRecord(next) ? next : {};
        cursor[segment] = child;
        cursor = child;
      }
    });
  }
  return out;
}

/**
 * Applies leaf changes to a job. Block mappings are edited pair by pair, so every untouched line,
 * including comments inside the edited mappings, stays byte-identical. A flow mapping on the way is
 * re-rendered as a unit.
 */
function patchJob(doc: Document, editor: TextEditor, pair: Pair, id: string, changes: Change[]): void {
  const job = pair.value;
  if (!isMap(job)) throw new PipelineError("edit_invalid", `Job \`${id}\` is not a mapping.`);
  patchMap(doc, editor, job, changes);
}

function patchMap(doc: Document, editor: TextEditor, map: YAMLMap, changes: readonly Change[]): void {
  if (!editor.canSplice(map)) {
    for (const change of changes) {
      if (change.remove) map.deleteIn(change.path);
      else map.setIn(change.path, doc.createNode(change.value));
    }
    pruneEmpty(map);
    editor.rerender(map);
    return;
  }
  const groups = new Map<string, Change[]>();
  for (const change of changes) {
    const head = change.path[0] ?? "";
    groups.set(head, [...(groups.get(head) ?? []), { ...change, path: change.path.slice(1) }]);
  }
  const appends: Array<[string, unknown]> = [];
  for (const [key, group] of groups) {
    const existing = findPair(map, key);
    const leaf = group.find((change) => change.path.length === 0);
    if (leaf) {
      if (leaf.remove) {
        if (existing) editor.removePair(map, existing);
      } else if (existing) editor.replaceValue(map, existing, leaf.value);
      else appends.push([key, leaf.value]);
      continue;
    }
    const child = existing?.value;
    if (existing && isMap(child) && child.items.length > 0) {
      if (remaining(child, group) === 0) editor.removePair(map, existing);
      else patchMap(doc, editor, child, group);
      continue;
    }
    const value = nestedValue(group);
    if (Object.keys(value).length === 0) {
      if (existing && !isMap(child)) continue;
      if (existing) editor.removePair(map, existing);
    } else if (existing) editor.replaceValue(map, existing, value);
    else appends.push([key, value]);
  }
  if (appends.length > 0) editor.appendPairs(map, appends);
}

/** How many keys `map` keeps after `changes`, counting a child mapping the changes empty as gone. */
function remaining(map: YAMLMap, changes: readonly Change[]): number {
  const heads = new Set(changes.map((change) => change.path[0]));
  let count = 0;
  for (const item of map.items) {
    const key = isScalar(item.key) ? String(item.key.value) : null;
    if (key === null || !heads.has(key)) {
      count += 1;
      continue;
    }
    const own = changes.filter((change) => change.path[0] === key).map((change) => ({ ...change, path: change.path.slice(1) }));
    if (own.some((change) => change.path.length === 0)) {
      if (own.some((change) => change.path.length === 0 && !change.remove)) count += 1;
      continue;
    }
    if (own.some((change) => !change.remove)) count += 1;
    else if (isMap(item.value) && remaining(item.value, own) > 0) count += 1;
    else if (!isMap(item.value)) count += 1;
  }
  const added = new Set(changes.filter((change) => !change.remove && change.path[0] !== undefined && !findPair(map, change.path[0])).map((change) => change.path[0]));
  return count + added.size;
}

/** Drops mappings a removal emptied, so a removed last key leaves no empty parent behind. */
function pruneEmpty(map: YAMLMap): void {
  for (const item of [...map.items]) {
    if (isMap(item.value)) {
      pruneEmpty(item.value);
      if (item.value.items.length === 0) map.items.splice(map.items.indexOf(item), 1);
    }
  }
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((item) => isScalar(item.key) && String(item.key.value) === key);
}

function render(value: unknown): string {
  return stringify(value, RENDER).trimEnd();
}

function rangeOf(node: unknown): [number, number, number] | undefined {
  if ((isMap(node) || isSeq(node) || isScalar(node)) && node.range) return node.range;
  return undefined;
}

class TextEditor {
  private readonly splices: Splice[] = [];
  private readonly eol: string;

  constructor(private readonly text: string) {
    this.eol = text.includes("\r\n") ? "\r\n" : "\n";
  }

  result(): string {
    let out = this.text;
    const ordered = [...this.splices].sort((a, b) => b.start - a.start || b.end - a.end);
    for (const splice of ordered) out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
    return out;
  }

  /** A block map whose keys each start their own line. */
  canSplice(map: YAMLMap): boolean {
    if (map.flow || map.items.length === 0) return false;
    return map.items.every((pair) => this.indentOf(pair) !== null);
  }

  rerender(node: YAMLMap): void {
    const range = rangeOf(node);
    if (!range) throw new PipelineError("edit_unparseable", "The edited node has no source range.");
    const holder = new Document();
    holder.contents = node;
    let rendered = holder.toString({ lineWidth: 0, blockQuote: false }).replace(/\r?\n$/, "");
    if (!node.flow) {
      const start = this.lineStart(range[0]);
      const indent = " ".repeat(range[0] - start);
      rendered = rendered.split("\n").join(this.eol + indent);
    }
    this.splices.push({ start: range[0], end: this.contentEnd(range[1]), text: rendered });
  }

  replaceValue(map: YAMLMap, pair: Pair, value: unknown): void {
    const valueRange = rangeOf(pair.value);
    const inline = valueRange !== undefined && valueRange[1] > valueRange[0] && (isScalar(pair.value) || (isMap(pair.value) && pair.value.flow) || (isSeq(pair.value) && pair.value.flow));
    if (inline) {
      this.splices.push({ start: valueRange[0], end: valueRange[1], text: render(value) });
      return;
    }
    const key = this.keyText(pair);
    const indent = this.indentOf(pair) ?? this.indentOf(map.items[0]) ?? "";
    this.splices.push({ start: this.pairLineStart(pair), end: this.pairEnd(pair), text: `${indent}${key}: ${render(value)}${this.eol}` });
  }

  appendPair(map: YAMLMap, key: string, value: unknown): void {
    this.appendPairs(map, [[key, value]]);
  }

  /** Appends keys after the mapping's last pair, in order, as one insertion. */
  appendPairs(map: YAMLMap, pairs: ReadonlyArray<[string, unknown]>): void {
    const last = map.items[map.items.length - 1];
    const indent = this.indentOf(map.items[0]) ?? "";
    if (!last) throw new PipelineError("edit_unparseable", "Cannot append to an empty mapping.");
    this.insertAfter(last, pairs.map(([key, value]) => `${indent}${key}: ${render(value)}${this.eol}`).join(""));
  }

  removePair(map: YAMLMap, pair: Pair): boolean {
    if (!this.canSplice(map)) return false;
    this.splices.push({ start: this.pairLineStart(pair), end: this.pairEnd(pair), text: "" });
    return true;
  }

  addJob(jobs: YAMLMap, id: string, fields: Array<[EditableJobKey, unknown]>): boolean {
    if (!this.canSplice(jobs)) return false;
    const first = jobs.items[0];
    const last = jobs.items[jobs.items.length - 1];
    const indent = this.indentOf(first);
    if (indent === null || !last) return false;
    const child = this.childIndent(jobs) ?? `${indent}  `;
    const lines = fields.length === 0 ? [`${indent}${id}: {}`] : [`${indent}${id}:`, ...fields.map(([key, value]) => `${child}${key}: ${render(value)}`)];
    this.insertAfter(last, lines.map((line) => line + this.eol).join(""));
    return true;
  }

  private insertAfter(pair: Pair, block: string): void {
    const end = this.pairEnd(pair);
    const needsBreak = end > 0 && this.text[end - 1] !== "\n";
    this.splices.push({ start: end, end, text: (needsBreak ? this.eol : "") + block });
  }

  private childIndent(jobs: YAMLMap): string | null {
    for (const pair of jobs.items) {
      if (isMap(pair.value) && !pair.value.flow && pair.value.items[0]) {
        const indent = this.indentOf(pair.value.items[0]);
        if (indent !== null) return indent;
      }
    }
    return null;
  }

  private keyText(pair: Pair): string {
    const range = rangeOf(pair.key);
    return range ? this.text.slice(range[0], range[1]) : String(isScalar(pair.key) ? pair.key.value : pair.key);
  }

  private indentOf(pair: Pair | undefined): string | null {
    const range = pair ? rangeOf(pair.key) : undefined;
    if (!range) return null;
    const start = this.lineStart(range[0]);
    const prefix = this.text.slice(start, range[0]);
    return /^ *$/.test(prefix) ? prefix : null;
  }

  private lineStart(pos: number): number {
    return this.text.lastIndexOf("\n", pos - 1) + 1;
  }

  private pairLineStart(pair: Pair): number {
    const range = rangeOf(pair.key);
    if (!range) throw new PipelineError("edit_unparseable", "A key has no source range.");
    return this.lineStart(range[0]);
  }

  /** The offset after the last line of a pair, including its trailing comments and line break. */
  private pairEnd(pair: Pair): number {
    const range = rangeOf(pair.value) ?? rangeOf(pair.key);
    if (!range) throw new PipelineError("edit_unparseable", "A pair has no source range.");
    const end = range[2];
    const start = this.lineStart(end);
    if (this.text.slice(start, end).trim() === "") return start;
    const newline = this.text.indexOf("\n", end);
    return newline === -1 ? this.text.length : newline + 1;
  }

  /** Trims a block node's end back to its last content character. */
  private contentEnd(end: number): number {
    let at = end;
    while (at > 0 && /\s/.test(this.text[at - 1] ?? "")) at -= 1;
    return at;
  }
}
