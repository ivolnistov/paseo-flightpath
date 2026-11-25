// Pure plan display helpers. No React Native import; tested in the node environment.
import { parseDod, type DodItem } from "../shared/dod";
import { isV2Revision, type PlanRevision, type PlanRevisionV2, type TaskDefinition, type TaskDefinitionV2, type TaskState } from "../shared/model";
import type { z } from "zod";
import type { ApprovalStatus, TaskInput } from "../shared/rpc";
import type { DodTemplateValue } from "../shared/rpc-dod";

type TaskStatus = TaskState["status"];

export const hashPrefix = (h: string) => h.slice(0, 12);

const LABELS: Record<ApprovalStatus, string> = {
  current: "Approved, current",
  not_current: "Approval not current",
  unapproved: "Not approved",
  unverified: "Unverified approval copy",
};
const COLOR_KEYS = {
  current: "statusSuccess",
  not_current: "statusWarning",
  unapproved: "foregroundMuted",
  unverified: "statusDanger",
} as const satisfies Record<ApprovalStatus, string>;

export const approvalLabel = (status: ApprovalStatus): string => LABELS[status];
export const approvalColorKey = (status: ApprovalStatus): (typeof COLOR_KEYS)[ApprovalStatus] => COLOR_KEYS[status];

export type MarkdownBlock = { kind: "heading" | "bullet" | "text"; text: string };

/** Blank-line separated blocks; a leading `#`, `-` or `*` marker selects the kind. Never HTML. */
export function markdownBlocks(md: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const raw of md.split(/\n[ \t]*\n/)) {
    const block = raw.trim();
    if (!block) continue;
    const heading = /^#{1,6}[ \t]+/.exec(block);
    if (heading) {
      blocks.push({ kind: "heading", text: block.slice(heading[0].length) });
      continue;
    }
    const bullet = /^[-*][ \t]+/.exec(block);
    if (bullet) {
      blocks.push({ kind: "bullet", text: block.slice(bullet[0].length) });
      continue;
    }
    blocks.push({ kind: "text", text: block });
  }
  return blocks;
}

/**
 * Ruling 7 edges available in the UI. Moving to in_progress needs a current approval. A revision a
 * run manages (any run of the feature with the same planId and planRev, in any state; Stage R4.2)
 * never offers `verified`: its tasks are verified by the run's checks and review, which is exactly
 * the server's refusal rule.
 */
export function allowedTaskTargets(status: TaskStatus, current: boolean, runManaged = false): readonly TaskStatus[] {
  const edges = manualTargets(status, current);
  return runManaged ? edges.filter((to) => to !== "verified") : edges;
}

function manualTargets(status: TaskStatus, current: boolean): readonly TaskStatus[] {
  switch (status) {
    case "todo":
      return current ? ["in_progress"] : [];
    case "in_progress":
      return ["done", "todo"];
    case "done":
      return current ? ["in_progress", "verified"] : ["verified"];
    case "verified":
    case "cancelled":
      return [];
  }
}

// ---- Stage R1.2: v2 task preview, revision diff and the bound draft editor ----

export type TaskSpecView = {
  id: string;
  title: string;
  description: string;
  v2?: {
    dependsOn: string[];
    parallel: boolean;
    completion: "auto" | "human";
    grill: boolean;
    grillSessionId?: string;
    dod: string;
    dodItems: DodItem[];
  };
};

const isV2Task = (task: TaskDefinition | TaskDefinitionV2): task is TaskDefinitionV2 => "dod" in task;

/** A task as the preview shows it; a three-field legacy task has no v2 block. */
export function taskSpec(task: TaskDefinition | TaskDefinitionV2): TaskSpecView {
  const base = { id: task.id, title: task.title, description: task.description };
  if (!isV2Task(task)) return base;
  return {
    ...base,
    v2: {
      dependsOn: [...task.dependsOn],
      parallel: task.parallel,
      completion: task.completion,
      grill: task.grill,
      ...(task.grillSessionId !== undefined ? { grillSessionId: task.grillSessionId } : {}),
      dod: task.dod,
      dodItems: parseDod(task.dod).items,
    },
  };
}

export type TaskField = "title" | "description" | "dependsOn" | "parallel" | "completion" | "grill" | "grillSessionId" | "dod";
export type TaskDiff = {
  kind: "added" | "removed" | "changed" | "moved";
  taskId: string;
  title: string;
  changes?: Array<{ field: TaskField; before: string; after: string }>;
  from?: number;
  to?: number;
};
export type RevisionDiff = { schemaChanged: boolean; markdownChanged: boolean; tasks: TaskDiff[] };

const FIELDS: TaskField[] = ["title", "description", "dependsOn", "parallel", "completion", "grill", "grillSessionId", "dod"];

/** Display string of one task field; "—" when the task does not have it. */
function fieldText(task: TaskDefinition | TaskDefinitionV2, field: TaskField): string {
  const value = (task as Record<string, unknown>)[field];
  if (value === undefined) return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * Differences between two revisions, tasks matched by id: added, changed and moved tasks in `to`
 * order (a task both changed and moved gets both entries), then removed tasks in `from` order.
 */
export function revisionDiff(from: PlanRevision, to: PlanRevision): RevisionDiff {
  const fromTasks: Array<TaskDefinition | TaskDefinitionV2> = from.tasks;
  const toTasks: Array<TaskDefinition | TaskDefinitionV2> = to.tasks;
  const fromIndex = new Map(fromTasks.map((t, i) => [t.id, i] as const));
  const toIds = new Set(toTasks.map((t) => t.id));
  const tasks: TaskDiff[] = [];
  toTasks.forEach((t, index) => {
    const at = fromIndex.get(t.id);
    if (at === undefined) {
      tasks.push({ kind: "added", taskId: t.id, title: t.title });
      return;
    }
    const before = fromTasks[at];
    const changes = FIELDS.map((field) => ({ field, before: fieldText(before, field), after: fieldText(t, field) })).filter((c) => c.before !== c.after);
    if (changes.length > 0) tasks.push({ kind: "changed", taskId: t.id, title: t.title, changes });
    if (at !== index) tasks.push({ kind: "moved", taskId: t.id, title: t.title, from: at, to: index });
  });
  for (const t of fromTasks) if (!toIds.has(t.id)) tasks.push({ kind: "removed", taskId: t.id, title: t.title });
  return { schemaChanged: isV2Revision(from) !== isV2Revision(to), markdownChanged: from.markdown !== to.markdown, tasks };
}

const SOURCE_LABEL: Record<DodTemplateValue["source"], string> = {
  file: "dod template.md",
  project: "Project settings",
  global: "Global settings",
  none: "No template",
};
export const dodSourceLabel = (source: DodTemplateValue["source"]): string => SOURCE_LABEL[source];

/** The template appended to a DoD on an explicit request; it replaces nothing. */
export function insertTemplate(current: string, template: string): string {
  return current.trim() === "" ? template : `${current.trimEnd()}\n${template}`;
}

/** Edits of the bound draft editor, by task id: the DoD text and the human grill checkbox. */
export type TaskEdits = Record<string, { dod?: string; grill?: boolean }>;

export function taskEditsChanged(revision: PlanRevisionV2, edits: TaskEdits): boolean {
  return revision.tasks.some((t) => {
    const e = edits[t.id];
    return e !== undefined && ((e.dod !== undefined && e.dod !== t.dod) || (e.grill !== undefined && e.grill !== t.grill));
  });
}

/**
 * The full task list for the next draft, in revision order, mapped to exactly the TaskInput fields.
 * Only `dod` and `grill` can change; `grillSessionId` is never sent (no client authority over it).
 */
export function draftTasks(revision: PlanRevisionV2, edits: TaskEdits): Array<z.output<typeof TaskInput>> {
  return revision.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    dependsOn: [...t.dependsOn],
    parallel: t.parallel,
    completion: t.completion,
    grill: edits[t.id]?.grill ?? t.grill,
    dod: edits[t.id]?.dod ?? t.dod,
  }));
}
