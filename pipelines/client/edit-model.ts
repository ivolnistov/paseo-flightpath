import { REASONING_LEVELS, isRecord, type DoneItem, type Job, type Reasoning, type Workflow } from "../shared/workflow";
import type { EditOp } from "./hooks";

/** `inherit` writes neither `profile` nor `model`, so the job takes `defaults.agent`. */
export type AgentSelection = { kind: "inherit" } | { kind: "profile"; value: string } | { kind: "model"; value: string };

export type EditorState = {
  name: string;
  description: string;
  /** `with.prompt`; null when the job has none and takes none here. */
  prompt: string | null;
  acceptance: "auto" | "human" | null;
  /** Null when the job's `uses` takes no agent or its settings are only editable in YAML. */
  agent: { selection: AgentSelection; reasoning: Reasoning | null; fallback: { model: string; reasoning: Reasoning | null } | null; retries: number | null } | null;
  criteria: string[];
  needs: string[];
};

export type EditorLocks = { prompt: string | null; agent: string | null; criteria: string | null };

const AGENT_KEYS = new Set(["profile", "model", "reasoning", "fallback", "retries"]);
const PROMPT_USES = new Set(["agent", "run-tasks", "review", "approval"]);
const AGENT_USES = new Set(["agent", "run-tasks", "review"]);

function isReasoning(value: unknown): value is Reasoning {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

function hasExpression(value: unknown): boolean {
  return typeof value === "string" && value.includes("${{");
}

/** What the visual editor leaves to the YAML view, and why. */
export function editorLocks(job: Job): EditorLocks {
  const prompt = job.with.prompt;
  const agent = job.with.agent;
  let agentLock: string | null = null;
  if (!AGENT_USES.has(job.uses)) agentLock = `\`${job.uses}\` runs no agent.`;
  else if (agent !== undefined && !isRecord(agent)) agentLock = "`with.agent` is not a mapping; edit it in YAML.";
  else if (isRecord(agent) && Object.keys(agent).some((key) => !AGENT_KEYS.has(key))) agentLock = "`with.agent` has keys this editor does not show; edit it in YAML.";
  else if (isRecord(agent) && Object.values(agent).some(hasExpression)) agentLock = "`with.agent` uses an expression; edit it in YAML.";
  return {
    prompt: !PROMPT_USES.has(job.uses) ? `\`${job.uses}\` takes no prompt.` : prompt !== undefined && typeof prompt !== "string" ? "`with.prompt` is not text; edit it in YAML." : null,
    agent: agentLock,
    criteria: job.uses === "agent" ? null : "Acceptance criteria belong to agent jobs; edit other `done` items in YAML.",
  };
}

export function editorState(job: Job): EditorState {
  const locks = editorLocks(job);
  const raw = isRecord(job.with.agent) ? job.with.agent : {};
  const fallback = isRecord(raw.fallback) ? raw.fallback : null;
  const selection: AgentSelection =
    typeof raw.profile === "string" ? { kind: "profile", value: raw.profile } : typeof raw.model === "string" ? { kind: "model", value: raw.model } : { kind: "inherit" };
  return {
    name: job.name ?? "",
    description: job.description ?? "",
    prompt: locks.prompt === null ? (typeof job.with.prompt === "string" ? job.with.prompt : "") : null,
    acceptance: job.uses === "agent" ? (job.acceptance ?? "auto") : null,
    agent:
      locks.agent === null
        ? {
            selection,
            reasoning: isReasoning(raw.reasoning) ? raw.reasoning : null,
            fallback: fallback && typeof fallback.model === "string" ? { model: fallback.model, reasoning: isReasoning(fallback.reasoning) ? fallback.reasoning : null } : null,
            retries: typeof raw.retries === "number" ? raw.retries : null,
          }
        : null,
    criteria: job.done.flatMap((item) => ("criterion" in item ? [item.criterion] : [])),
    needs: [...job.needs],
  };
}

function agentValue(agent: NonNullable<EditorState["agent"]>, original: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Keep the original key order where keys survive.
  const order = [...Object.keys(original), ...AGENT_KEYS].filter((key, index, all) => all.indexOf(key) === index);
  const values: Record<string, unknown> = {};
  if (agent.selection.kind === "profile") values.profile = agent.selection.value.trim();
  if (agent.selection.kind === "model") values.model = agent.selection.value.trim();
  if (agent.reasoning !== null) values.reasoning = agent.reasoning;
  if (agent.fallback !== null && agent.fallback.model.trim() !== "") {
    values.fallback = agent.fallback.reasoning === null ? { model: agent.fallback.model.trim() } : { model: agent.fallback.model.trim(), reasoning: agent.fallback.reasoning };
  }
  if (agent.retries !== null) values.retries = agent.retries;
  for (const key of order) if (key in values) out[key] = values[key];
  return out;
}

/** `done` with text criteria replaced in place, new ones appended, and every `run` item kept. */
export function mergeCriteria(done: readonly DoneItem[], criteria: readonly string[]): DoneItem[] {
  const texts = criteria.map((text) => text.trim()).filter((text) => text !== "");
  let next = 0;
  const out: DoneItem[] = [];
  for (const item of done) {
    if ("run" in item) out.push(item);
    else if (next < texts.length) out.push({ criterion: texts[next++] ?? "" });
  }
  for (; next < texts.length; next += 1) out.push({ criterion: texts[next] ?? "" });
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type PatchChange = { path: string[]; value: unknown } | { path: string[]; remove: true };

/** Leaf changes that turn `before` into `after` below `path`; mappings are compared key by key. */
function diffValue(path: string[], before: unknown, after: unknown, out: PatchChange[]): void {
  if (after === undefined) {
    if (before !== undefined) out.push({ path, remove: true });
    return;
  }
  if (isRecord(after) && isRecord(before) && path.length < 4) {
    for (const key of Object.keys(before)) if (!(key in after)) out.push({ path: [...path, key], remove: true });
    for (const [key, value] of Object.entries(after)) diffValue([...path, key], before[key], value, out);
    return;
  }
  if (!same(before, after)) out.push({ path, value: after });
}

/**
 * The one `job.patch` that turns `job` into `state`; null when nothing changed. Each change is a
 * leaf, such as `with.agent.model`, so the server edits only those lines and keeps every other key
 * and comment, inside `with` too.
 */
export function editOp(job: Job, state: EditorState): EditOp | null {
  const changes: PatchChange[] = [];
  const text = (key: "name" | "description", value: string, original: string | undefined) => {
    const trimmed = value.trim();
    if (trimmed === (original ?? "")) return;
    changes.push(trimmed === "" ? { path: [key], remove: true } : { path: [key], value: trimmed });
  };
  text("name", state.name, job.name);
  text("description", state.description, job.description);
  if (state.acceptance !== null && state.acceptance !== (job.acceptance ?? "auto")) {
    if (state.acceptance === "human") changes.push({ path: ["acceptance"], value: "human" });
    else if (job.acceptance !== undefined) changes.push({ path: ["acceptance"], remove: true });
  }
  if (state.prompt !== null) {
    const prompt = state.prompt.trim() === "" ? undefined : state.prompt;
    diffValue(["with", "prompt"], job.with.prompt, prompt, changes);
  }
  if (state.agent !== null) {
    const original = isRecord(job.with.agent) ? job.with.agent : {};
    const value = agentValue(state.agent, original);
    diffValue(["with", "agent"], job.with.agent, Object.keys(value).length === 0 ? undefined : value, changes);
  }
  if (job.uses === "agent") {
    const done = mergeCriteria(job.done, state.criteria);
    if (!same(done, job.done)) changes.push(done.length === 0 ? { path: ["done"], remove: true } : { path: ["done"], value: done });
  }
  if (!same(state.needs, job.needs)) changes.push(state.needs.length === 0 ? { path: ["needs"], remove: true } : { path: ["needs"], value: state.needs });
  return changes.length === 0 ? null : { kind: "job.patch", id: job.id, changes };
}

/** Jobs that depend on `id` through `needs`; choosing one as a need would form a cycle. */
export function dependents(model: Pick<Workflow, "jobs">, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const job of model.jobs) {
      if (current !== undefined && job.needs.includes(current) && !out.has(job.id)) {
        out.add(job.id);
        stack.push(job.id);
      }
    }
  }
  return out;
}

export const NEW_BLOCK_USES = ["agent", "checks", "review", "approval"] as const;
export type NewBlockUses = (typeof NEW_BLOCK_USES)[number];
export type NewBlock = { uses: NewBlockUses; name: string; prompt: string; command: string; needs: string[] };

const MAX_ID = 48;

/** A free job id from `name`, or from `uses` when the name gives no usable letters. */
export function deriveJobId(name: string, uses: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .slice(0, MAX_ID - 4)
      .replace(/-+$/, "");
  const base = slug(name) || slug(uses) || "block";
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Why the block cannot be added yet, or null. */
export function newBlockProblem(block: NewBlock): string | null {
  if (block.uses === "checks" && block.command.trim() === "") return "Enter the command this checks block runs.";
  if (block.uses === "agent" && block.prompt.trim() === "") return "Enter the prompt this agent block runs.";
  return null;
}

export function addOp(block: NewBlock, taken: Iterable<string>): EditOp {
  const fields: Record<string, unknown> = { uses: block.uses };
  if (block.name.trim() !== "") fields.name = block.name.trim();
  if (block.needs.length > 0) fields.needs = [...block.needs];
  if (block.uses === "checks") fields.with = { run: [block.command.trim()] };
  else if (block.prompt.trim() !== "") fields.with = { prompt: block.prompt };
  return { kind: "job.add", id: deriveJobId(block.name, block.uses, taken), fields };
}
