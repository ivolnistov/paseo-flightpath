import { canonicalJson, deepClone } from "./canonical";
import { DomainError } from "./errors";
import {
  Question as QuestionSchema,
  refKey,
  type Activation,
  type Actor,
  type Answer,
  type Invalidation,
  type Question,
  type Ref,
  type RefKey,
  type Stale,
  type Session,
  type Visibility,
} from "./model";
import { nextNumber } from "./numbering";

export type AnswerInput = {
  optionId?: string;
  text?: string;
  note?: string;
  quoted?: string;
  defaulted?: true;
  source: "ui" | "chat";
  actor: Actor;
  at: string;
};
export type GraphChange = { sessions: Session[]; staleMarked: Ref[]; visibilityChanged: Ref[] };
export type Relation =
  | { kind: "activation"; target: Ref; activation: Activation }
  | { kind: "invalidation"; target: Ref; invalidation: Invalidation };

type Entry = { ref: Ref; question: Question };

/** Questions in document order (sessions, then questions), keyed by RefKey. */
function index(sessions: Session[]): Map<RefKey, Entry> {
  const out = new Map<RefKey, Entry>();
  for (const s of sessions) {
    for (const question of s.questions) {
      const ref = { sessionId: s.id, questionId: question.id };
      out.set(refKey(ref), { ref, question });
    }
  }
  return out;
}

/** Parents of a question on the combined activation + invalidation DAG. */
const parentsOf = (q: Question): Ref[] => [
  ...q.activatedBy.map((a) => a.parent),
  ...q.invalidatedBy.map((i) => i.upstream),
];

const sameRef = (a: Ref, b: Ref) => a.sessionId === b.sessionId && a.questionId === b.questionId;

export function findQuestion(sessions: Session[], ref: Ref): Question {
  const s = sessions.find((x) => x.id === ref.sessionId);
  const q = s?.questions.find((x) => x.id === ref.questionId);
  if (!q) throw new DomainError("not_found", `question ${refKey(ref)} not found`, { ref });
  return q;
}

/** Session ids are unique; question ids are unique within their session. */
export function assertUniqueIds(sessions: Session[]): void {
  const sessionIds = new Set<string>();
  for (const s of sessions) {
    if (sessionIds.has(s.id)) {
      throw new DomainError("invalid_input", `duplicate session id ${s.id}`, { duplicate: "session", id: s.id });
    }
    sessionIds.add(s.id);
    const questionIds = new Set<string>();
    for (const q of s.questions) {
      if (questionIds.has(q.id)) {
        throw new DomainError("invalid_input", `duplicate question id ${q.id} in session ${s.id}`, {
          duplicate: "question",
          id: q.id,
          sessionId: s.id,
        });
      }
      questionIds.add(q.id);
    }
  }
}

export function validateGraph(sessions: Session[]): void {
  assertUniqueIds(sessions);
  const idx = index(sessions);
  const unresolved: Ref[] = [];
  for (const { question } of idx.values()) {
    for (const parent of parentsOf(question)) {
      if (!idx.has(refKey(parent))) unresolved.push(parent);
    }
    for (const a of question.activatedBy) {
      const parent = idx.get(refKey(a.parent));
      if (parent && a.optionIds.some((id) => !parent.question.options.some((o) => o.id === id))) {
        unresolved.push(a.parent);
      }
    }
  }
  if (unresolved.length > 0) {
    throw new DomainError("unresolved_ref", "relation refers to an unknown question or option", { refs: unresolved });
  }

  const colour = new Map<RefKey, "grey" | "black">();
  const stack: Ref[] = [];
  const visit = (entry: Entry): void => {
    const key = refKey(entry.ref);
    const state = colour.get(key);
    if (state === "black") return;
    if (state === "grey") {
      const start = stack.findIndex((r) => sameRef(r, entry.ref));
      throw new DomainError("relation_cycle", "relations form a cycle", { cycle: stack.slice(start) });
    }
    colour.set(key, "grey");
    stack.push(entry.ref);
    for (const parent of parentsOf(entry.question)) visit(idx.get(refKey(parent))!);
    stack.pop();
    colour.set(key, "black");
  };
  for (const entry of idx.values()) visit(entry);
}

export function computeVisibility(sessions: Session[]): Map<RefKey, Visibility> {
  const idx = index(sessions);
  const memo = new Map<RefKey, Visibility>();
  const state = new Map<RefKey, "grey" | "black">();
  const visibility = (key: RefKey): Visibility => {
    if (state.get(key) === "black") return memo.get(key)!;
    if (state.get(key) === "grey") throw new DomainError("relation_cycle", `cycle at ${key}`, { at: key });
    state.set(key, "grey");
    const entry = idx.get(key);
    let result: Visibility = entry ? "active" : "inactive";
    for (const a of entry?.question.activatedBy ?? []) {
      const parentKey = refKey(a.parent);
      const parent = idx.get(parentKey)?.question;
      if (
        !parent ||
        visibility(parentKey) !== "active" ||
        parent.validity !== "valid" ||
        parent.answer?.optionId === undefined ||
        !a.optionIds.includes(parent.answer.optionId)
      ) {
        result = "inactive";
        break;
      }
    }
    memo.set(key, result);
    state.set(key, "black");
    return result;
  };
  for (const key of idx.keys()) visibility(key);
  return memo;
}

/** Downstream refs reachable through invalidation edges, excluding `start`, in BFS/document order. */
export function invalidationClosure(sessions: Session[], start: Ref): Ref[] {
  const idx = index(sessions);
  const children = new Map<RefKey, Ref[]>();
  for (const { ref, question } of idx.values()) {
    for (const i of question.invalidatedBy) {
      const key = refKey(i.upstream);
      children.set(key, [...(children.get(key) ?? []), ref]);
    }
  }
  const startKey = refKey(start);
  const seen = new Set<RefKey>([startKey]);
  const out: Ref[] = [];
  const queue: Ref[] = [start];
  while (queue.length > 0) {
    for (const child of children.get(refKey(queue.shift()!)) ?? []) {
      const key = refKey(child);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

export function layoutDepth(sessions: Session[], sessionId: string): Map<string, number> {
  const idx = index(sessions);
  const memo = new Map<RefKey, number>();
  const state = new Map<RefKey, "grey" | "black">();
  const depth = (key: RefKey): number => {
    if (state.get(key) === "black") return memo.get(key)!;
    if (state.get(key) === "grey") throw new DomainError("relation_cycle", `cycle at ${key}`, { at: key });
    state.set(key, "grey");
    const entry = idx.get(key);
    let d = 0;
    for (const parent of entry ? parentsOf(entry.question) : []) {
      const pk = refKey(parent);
      if (idx.has(pk)) d = Math.max(d, depth(pk) + 1);
    }
    memo.set(key, d);
    state.set(key, "black");
    return d;
  };
  const out = new Map<string, number>();
  const s = sessions.find((x) => x.id === sessionId);
  for (const question of s?.questions ?? []) {
    out.set(question.id, depth(refKey({ sessionId, questionId: question.id })));
  }
  return out;
}

function visibilityDiff(before: Session[], after: Session[]): Ref[] {
  const a = computeVisibility(before);
  const b = computeVisibility(after);
  const out: Ref[] = [];
  for (const { ref } of index(after).values()) {
    const key = refKey(ref);
    if (a.get(key) !== b.get(key)) out.push(ref);
  }
  return out;
}

function requireActive(sessions: Session[], ref: Ref): void {
  if (computeVisibility(sessions).get(refKey(ref)) !== "active") {
    throw new DomainError("question_inactive", `question ${refKey(ref)} is inactive`, { ref });
  }
}

export function applyAnswer(
  sessions: Session[],
  ref: Ref,
  input: AnswerInput,
): GraphChange & { rev: number; valueChanged: boolean } {
  // inputs must be a valid graph; enforced
  validateGraph(sessions);
  const current = findQuestion(sessions, ref);
  requireActive(sessions, ref);
  if ((input.optionId === undefined) === (input.text === undefined)) {
    throw new DomainError("invalid_input", "exactly one of optionId or text is required");
  }
  if (input.optionId !== undefined && !current.options.some((o) => o.id === input.optionId)) {
    throw new DomainError("invalid_input", `unknown option ${input.optionId}`);
  }
  if (input.text !== undefined && !current.allowFreeText) {
    throw new DomainError("invalid_input", "free text is not allowed for this question");
  }

  const next = deepClone(sessions);
  const q = findQuestion(next, ref);
  const previous = q.answer;
  const rev = q.revisions.length + 1;
  const answer: Answer = {
    rev,
    ...(input.optionId !== undefined ? { optionId: input.optionId } : { text: input.text }),
    source: input.source,
    actor: deepClone(input.actor),
    at: input.at,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.quoted !== undefined ? { quoted: input.quoted } : {}),
    ...(input.defaulted === true ? { defaulted: true as const } : {}),
  };
  q.revisions.push(answer);
  q.answer = deepClone(answer);
  q.validity = "valid";
  delete q.stale;
  delete q.review;

  const valueChanged =
    previous === undefined || previous.optionId !== input.optionId || previous.text !== input.text;
  const staleMarked: Ref[] = [];
  if (previous !== undefined && valueChanged) {
    staleMarked.push(...markDownstreamStale(next, ref, { causeSessionId: ref.sessionId, causeQuestionId: ref.questionId, causeRev: rev, at: input.at }));
  }
  return { sessions: next, staleMarked, visibilityChanged: visibilityDiff(sessions, next), rev, valueChanged };
}

/**
 * Every answered question downstream of `ref` (invalidation edges, transitively) must be reviewed
 * with `cause`. A skipped or out-of-scope one keeps that explicit outcome and gains a `review`
 * marker; any other becomes stale. Returns the questions made stale.
 */
function markDownstreamStale(sessions: Session[], ref: Ref, cause: Stale): Ref[] {
  const marked: Ref[] = [];
  for (const downstream of invalidationClosure(sessions, ref)) {
    const target = findQuestion(sessions, downstream);
    if (!target.answer) continue;
    if (target.validity === "skipped" || target.validity === "out_of_scope") {
      target.review = { ...cause };
      continue;
    }
    target.validity = "stale";
    target.stale = { ...cause };
    marked.push(downstream);
  }
  return marked;
}

export function confirmAnswer(
  sessions: Session[],
  ref: Ref,
  by: Pick<AnswerInput, "source" | "actor" | "at" | "quoted">,
): GraphChange & { rev: number } {
  // inputs must be a valid graph; enforced
  validateGraph(sessions);
  const current = findQuestion(sessions, ref);
  if (current.validity !== "stale" || !current.answer) {
    throw new DomainError("not_stale", `question ${refKey(ref)} is not stale`, { ref });
  }
  requireActive(sessions, ref);
  const next = deepClone(sessions);
  const q = findQuestion(next, ref);
  const rev = q.revisions.length + 1;
  const answer: Answer = {
    rev,
    ...(current.answer.optionId !== undefined ? { optionId: current.answer.optionId } : { text: current.answer.text }),
    source: by.source,
    actor: deepClone(by.actor),
    at: by.at,
    ...(by.quoted !== undefined ? { quoted: by.quoted } : {}),
  };
  q.revisions.push(answer);
  q.answer = deepClone(answer);
  q.validity = "valid";
  delete q.stale;
  return { sessions: next, staleMarked: [], visibilityChanged: visibilityDiff(sessions, next), rev };
}

export function updateDefinition(
  sessions: Session[],
  ref: Ref,
  /** `recommendedOptionId: null` removes the recommendation. */
  patch: Partial<Pick<Question, "title" | "context" | "options" | "allowFreeText">> & { recommendedOptionId?: string | null },
  at: string,
): GraphChange & { definitionRev: number } {
  // inputs must be a valid graph; enforced
  validateGraph(sessions);
  const current = findQuestion(sessions, ref);
  const next = deepClone(sessions);
  const q = findQuestion(next, ref);
  let changed = false;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Object.entries returns string keys; the keys of a cloned patch are its own fields
  for (const [key, value] of Object.entries(deepClone(patch)) as Array<[keyof typeof patch, unknown]>) {
    if (value === undefined) continue;
    if (value === null) {
      if (current[key] !== undefined) changed = true;
      delete (q as Record<string, unknown>)[key];
      continue;
    }
    if (canonicalJson(current[key] ?? null) !== canonicalJson(value)) changed = true;
    (q as Record<string, unknown>)[key] = value;
  }
  if (changed) q.definitionRev += 1;

  const staleMarked: Ref[] = [];
  // Only a current answer can go stale; a skipped or out-of-scope outcome, its history and any review
  // marker are kept whatever the edit does to the options.
  const answer = q.validity === "valid" || q.validity === "stale" ? q.answer : undefined;
  if (
    answer &&
    ((answer.optionId !== undefined && !q.options.some((o) => o.id === answer.optionId)) ||
      (answer.text !== undefined && !q.allowFreeText))
  ) {
    q.validity = "stale";
    q.stale = { causeSessionId: ref.sessionId, causeQuestionId: ref.questionId, causeRev: answer.rev, at };
    staleMarked.push(ref);
  }
  const parsed = QuestionSchema.safeParse(q);
  if (!parsed.success) {
    throw new DomainError("invalid_input", "invalid question definition", { issues: parsed.error.issues });
  }
  validateGraph(next);
  return { sessions: next, staleMarked, visibilityChanged: visibilityDiff(sessions, next), definitionRev: q.definitionRev };
}

function relationParent(rel: Relation): Ref {
  return rel.kind === "activation" ? rel.activation.parent : rel.invalidation.upstream;
}

function checkRelationRefs(sessions: Session[], rel: Relation): void {
  const idx = index(sessions);
  const parent = idx.get(refKey(relationParent(rel)));
  const refs = [rel.target, relationParent(rel)].filter((r) => !idx.has(refKey(r)));
  if (refs.length > 0 || !parent) {
    throw new DomainError("unresolved_ref", "relation refers to an unknown question", { refs });
  }
  if (rel.kind === "activation") {
    const missing = rel.activation.optionIds.filter((id) => !parent.question.options.some((o) => o.id === id));
    if (rel.activation.optionIds.length === 0 || missing.length > 0) {
      throw new DomainError("unresolved_ref", "activation refers to unknown options", { refs: [rel.activation.parent], missing });
    }
  }
}

export function addRelation(sessions: Session[], rel: Relation): GraphChange {
  // inputs must be a valid graph; enforced
  validateGraph(sessions);
  checkRelationRefs(sessions, rel);
  const next = deepClone(sessions);
  const q = findQuestion(next, rel.target);
  const parent = relationParent(rel);
  if (rel.kind === "activation") {
    if (q.activatedBy.some((a) => sameRef(a.parent, parent))) {
      throw new DomainError("invalid_input", "activation edge already exists");
    }
    q.activatedBy.push(deepClone(rel.activation));
  } else {
    if (q.invalidatedBy.some((i) => sameRef(i.upstream, parent))) {
      throw new DomainError("invalid_input", "invalidation edge already exists");
    }
    q.invalidatedBy.push(deepClone(rel.invalidation));
  }
  validateGraph(next);
  return { sessions: next, staleMarked: [], visibilityChanged: visibilityDiff(sessions, next) };
}

export function removeRelation(sessions: Session[], rel: Relation): GraphChange {
  // inputs must be a valid graph; enforced
  validateGraph(sessions);
  findQuestion(sessions, rel.target);
  const next = deepClone(sessions);
  const q = findQuestion(next, rel.target);
  const parent = relationParent(rel);
  if (rel.kind === "activation") {
    const wanted = canonicalJson([...rel.activation.optionIds].sort());
    const i = q.activatedBy.findIndex(
      (a) => sameRef(a.parent, parent) && canonicalJson([...a.optionIds].sort()) === wanted,
    );
    if (i < 0) throw new DomainError("not_found", "activation edge not found");
    q.activatedBy.splice(i, 1);
  } else {
    const i = q.invalidatedBy.findIndex((x) => sameRef(x.upstream, parent));
    if (i < 0) throw new DomainError("not_found", "invalidation edge not found");
    q.invalidatedBy.splice(i, 1);
  }
  return { sessions: next, staleMarked: [], visibilityChanged: visibilityDiff(sessions, next) };
}

export type QuestionDraft = Pick<Question, "title" | "context" | "options" | "allowFreeText"> & {
  recommendedOptionId?: string;
  tag?: "language";
  activatedBy: Activation[];
  invalidatedBy: Invalidation[];
};

export function insertQuestion(
  sessions: Session[],
  sessionId: string,
  id: string,
  draft: QuestionDraft,
): GraphChange & { questionId: string } {
  // inputs must be a valid graph; enforced
  validateGraph(sessions);
  const next = deepClone(sessions);
  const s = next.find((x) => x.id === sessionId);
  if (!s) throw new DomainError("not_found", `session ${sessionId} not found`, { sessionId });
  const order = s.questions.reduce((max, q) => Math.max(max, q.order), -1) + 1;
  const parsed = QuestionSchema.safeParse({
    id,
    order,
    number: nextNumber(s),
    title: draft.title,
    context: draft.context,
    options: deepClone(draft.options),
    ...(draft.recommendedOptionId !== undefined ? { recommendedOptionId: draft.recommendedOptionId } : {}),
    ...(draft.tag !== undefined ? { tag: draft.tag } : {}),
    allowFreeText: draft.allowFreeText,
    definitionRev: 1,
    activatedBy: deepClone(draft.activatedBy),
    invalidatedBy: deepClone(draft.invalidatedBy),
    revisions: [],
    discussion: [],
    validity: "unanswered",
  });
  if (!parsed.success) {
    throw new DomainError("invalid_input", "invalid question definition", { issues: parsed.error.issues });
  }
  s.questions.push(parsed.data);
  validateGraph(next);
  return { sessions: next, staleMarked: [], visibilityChanged: [], questionId: id };
}

export function skipQuestion(sessions: Session[], ref: Ref, at: string): GraphChange {
  // inputs must be a valid graph; enforced
  validateGraph(sessions);
  findQuestion(sessions, ref);
  requireActive(sessions, ref);
  void at; // skipping records no revision; `at` is kept for a uniform command signature
  const next = deepClone(sessions);
  const q = findQuestion(next, ref);
  q.validity = "skipped";
  delete q.stale;
  delete q.review;
  return { sessions: next, staleMarked: [], visibilityChanged: visibilityDiff(sessions, next) };
}

/**
 * Marks an active question out of scope: no answer revision, its own staleness cleared, answer
 * history and discussion kept. Activation children hide as for a skip (their parent is no longer
 * valid). Answered invalidation dependents become stale as after a changed answer, with the
 * out-of-scope mark as cause (`markId` when recorded) instead of an answer revision.
 */
export function markOutOfScope(sessions: Session[], ref: Ref, at: string, markId?: string): GraphChange {
  validateGraph(sessions);
  findQuestion(sessions, ref);
  requireActive(sessions, ref);
  const current = findQuestion(sessions, ref);
  if (current.validity === "out_of_scope" && current.review === undefined) {
    throw new DomainError("invalid_input", `question ${refKey(ref)} is already out of scope`, { ref });
  }
  const next = deepClone(sessions);
  const q = findQuestion(next, ref);
  // Marking a question under review again keeps its outcome and only resolves the review: its
  // dependents were already marked when it first went out of scope.
  if (current.validity === "out_of_scope") {
    delete q.review;
    return { sessions: next, staleMarked: [], visibilityChanged: [] };
  }
  q.validity = "out_of_scope";
  delete q.stale;
  const staleMarked = markDownstreamStale(next, ref, {
    causeSessionId: ref.sessionId,
    causeQuestionId: ref.questionId,
    causeKind: "out_of_scope",
    ...(markId !== undefined ? { causeMarkId: markId } : {}),
    at,
  });
  return { sessions: next, staleMarked, visibilityChanged: visibilityDiff(sessions, next) };
}
