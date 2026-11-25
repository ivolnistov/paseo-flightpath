// relationLinks on stored self-links (KensAI 01a1c5cb c0110). The store accepts a link whose two ends
// are the same question: `Link` has no rule against it (shared/model.ts), `link.create` checks only
// that each end exists (server/sessions.ts checkLinkEnd), and `session.get` returns every link touching
// the session (server/views.ts). Such links can therefore be in a store whatever link.create does in
// the future. The question card and the Map List write a question's relations from this helper, so a
// stored self-link must come out of it with its kind and its target (the question itself), not vanish.
import { describe, expect, it } from "vitest";
import { RoadmapDataV2, type Link } from "../shared/model";
import { buildSessionView } from "../server/views";
import { MAP_SESSION, mapRoadmap, OTHER_SESSION } from "../server/test-support/map-fixture";
import { addRelation } from "../shared/graph";
import { relationLinks } from "./relation-links";

const ref = (questionId: string, sessionId = MAP_SESSION) => ({ sessionId, questionId });
function withLinks(extra: Link[]) {
  const data = mapRoadmap();
  data.meta.links = [...data.meta.links, ...extra];
  const parsed = RoadmapDataV2.safeParse(data);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  return buildSessionView(data, 1, MAP_SESSION);
}

describe("relationLinks: a stored self-link", () => {
  const SELF: Link[] = [
    { id: "lk-self-informs", kind: "informs", from: ref("m4"), to: ref("m4") },
    { id: "lk-self-supersedes", kind: "supersedes", from: ref("m10"), to: ref("m10") },
    { id: "lk-other-self", kind: "informs", from: ref("t1", OTHER_SESSION), to: ref("t1", OTHER_SESSION) },
  ];

  it("the session view carries the self-links touching it, and only those", () => {
    const v = withLinks(SELF);
    const ours = new Set(SELF.map((l) => l.id));
    expect(v.links.map((l) => l.id).filter((id) => ours.has(id)).sort()).toEqual(["lk-self-informs", "lk-self-supersedes"]);
  });

  it("an informs self-link appears on its question with its kind and the question itself as target", () => {
    const v = withLinks(SELF);
    const links = relationLinks(v, "m4");
    const own = links.filter((l) => l.target.kind === "question" && l.target.questionId === "m4");
    expect(own.map((l) => l.label), `Q4's relations: ${links.map((l) => l.label).join("; ")}`).not.toEqual([]);
    // DeepSeek Flash review 01a1c67a c0037: the link's own direction, marked as the question itself.
    expect(own.map((l) => l.label), own.map((l) => l.label).join("; ")).toEqual(["Informs Q4 Map question 4 (itself)"]);
    expect(new Set(links.map((l) => l.key)).size, "keys stay unique").toBe(links.length);
  });

  it("a supersedes self-link appears on its question with its kind and the question itself as target", () => {
    const v = withLinks(SELF);
    const own = relationLinks(v, "m10").filter((l) => l.target.kind === "question" && l.target.questionId === "m10");
    expect(own.map((l) => l.label), "Q10's own relations").not.toEqual([]);
    expect(own.map((l) => l.label), own.map((l) => l.label).join("; ")).toEqual(["Supersedes Q10 Map question 10 (itself)"]);
  });

  it("the self-link adds nothing to other questions, and their relations are unchanged", () => {
    const before = buildSessionView(mapRoadmap(), 1, MAP_SESSION);
    const after = withLinks(SELF);
    for (const id of ["m3", "m5", "m11", "m30"]) expect(relationLinks(after, id), id).toEqual(relationLinks(before, id));
  });
});

// KensAI 01a1c636 c0126: one parent may both activate and invalidate the same question. The graph
// accepts that (addRelation refuses only a second relation of the same kind from the same parent), the
// relation editor keeps the other kind when adding one, and the Map draws two edges. The question's
// relations (its card and the Map List) map both kinds to "Depends on" and keep one entry per wording
// and target, so one of the two stored relations is no longer told apart.
describe("relationLinks: a parent that both activates and invalidates the question", () => {
  function both() {
    const data = mapRoadmap();
    const session = data.sessions.find((s) => s.id === MAP_SESSION)!;
    // m3 is activated by m1 in the fixture; m1 also invalidates it.
    const child = session.questions.find((q) => q.id === "m3")!;
    expect(child.activatedBy.map((a) => a.parent.questionId), "m3 is activated by m1").toContain("m1");
    expect(child.invalidatedBy.some((i) => i.upstream.questionId === "m1"), "not yet invalidated by m1").toBe(false);
    const change = addRelation(data.sessions, { kind: "invalidation", target: ref("m3"), invalidation: { upstream: ref("m1") } });
    data.sessions = change.sessions;
    const parsed = RoadmapDataV2.safeParse(data);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    return buildSessionView(data, 1, MAP_SESSION);
  }

  it("the store keeps both relations, and the Map draws both edges", async () => {
    const v = both();
    const q3 = v.questions.find((x) => x.question.id === "m3")!.question;
    expect(q3.activatedBy.some((a) => a.parent.questionId === "m1") && q3.invalidatedBy.some((i) => i.upstream.questionId === "m1")).toBe(true);
    const { mapModel } = await import("./map-layout");
    const m = mapModel(v, { showInactive: true });
    const kinds = m.edges.filter((e) => e.from === "q:m1" && e.to === "q:m3").map((e) => e.kind).sort();
    expect(kinds).toEqual(["activation", "invalidation"]);
  });

  it("Q3's relations keep both: two entries for Q1, told apart by their wording", () => {
    const v = both();
    const fromQ1 = relationLinks(v, "m3").filter((l) => l.target.kind === "question" && l.target.questionId === "m1");
    expect(fromQ1.map((l) => l.label), "one entry per stored relation").toHaveLength(2);
    expect(new Set(fromQ1.map((l) => l.label)).size, `labels: ${fromQ1.map((l) => l.label).join(" | ")}`).toBe(2);
    expect(new Set(fromQ1.map((l) => l.key)).size, "keys stay unique").toBe(2);
    // DeepSeek Flash review 01a1c6c1 c0108: each entry names the kind of the relation it stands for.
    expect(fromQ1.map((l) => l.label).sort()).toEqual(["Depends on Q1 Map question 1 (activation)", "Depends on Q1 Map question 1 (invalidation)"]);
    // The parent's side names the same two relations.
    const toQ3 = relationLinks(v, "m1").filter((l) => l.target.kind === "question" && l.target.questionId === "m3");
    expect(toQ3.map((l) => l.label).sort()).toEqual(["Needed by Q3 Map question 3 (activation)", "Needed by Q3 Map question 3 (invalidation)"]);
    // A parent of one kind only stays unmarked (m2 activates m4 and m5 in the fixture, without invalidating them).
    expect(relationLinks(v, "m4").map((l) => l.label)).toContain("Depends on Q2 Map question 2");
  });
});
