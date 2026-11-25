// The Map's pure model on a synthetic 40-question branching session (server/test-support/map-fixture):
// the session view comes from the real server view builder, so columns are the server's depths. The
// model is read through this minimal shape:
//   mapModel(view, { showInactive? }) → {
//     lanes: { key, label, notes?: string[] }[],
//     nodes: { key, lane, column, x, y, width, height, label, questionId?, ref?, inactive? }[],
//     edges: { kind, from, to, optionIds?, crossLane, back, segments: { x1, y1, x2, y2 }[] }[],
//     world: { width, height },
//     notes: string[],
//   }
// where `from`/`to` are node keys, a local node carries `questionId`, and an external stub carries
// `ref` (a question or a bare session end). Pure module: no React Native, no host.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonical";
import { RoadmapDataV2 } from "../shared/model";
import type { SessionView } from "../shared/rpc";
import { buildSessionView } from "../server/views";
import { EMPTY_SESSION, INACTIVE_IDS, largeMapRoadmap, legacyMapRoadmap, MAP_SESSION, mapRoadmap, OTHER_SESSION } from "../server/test-support/map-fixture";
import { answered, NOW_ISO, q as storedQuestion } from "../server/test-support/build";
import { roadmapData } from "../server/test-support/grilling";
import type { Link, Question, RoadmapData } from "../shared/model";

type Seg = { x1: number; y1: number; x2: number; y2: number };
type MapNode = { key: string; lane: string; column: number; x: number; y: number; width: number; height: number; label: string; questionId?: string; ref?: { sessionId: string; questionId?: string }; inactive?: boolean };
type MapEdge = { kind: string; from: string; to: string; optionIds?: string[]; crossLane: boolean; back: boolean; segments: Seg[] };
type MapLane = { key: string; label: string; notes?: string[] };
type Model = { lanes: MapLane[]; nodes: MapNode[]; edges: MapEdge[]; world: { width: number; height: number }; notes: string[] };

const layoutPath = "./map-layout";
async function mapModel(view: SessionView, opts: Record<string, unknown> = {}): Promise<Model> {
  const mod: unknown = await import(/* @vite-ignore */ layoutPath).catch((e: unknown) => {
    throw new Error(`missing module client/map-layout.ts: ${String(e)}`);
  });
  const fn: unknown = typeof mod === "object" && mod !== null ? Reflect.get(mod, "mapModel") : undefined;
  if (typeof fn !== "function") throw new Error("missing export: map-layout.mapModel");
  const out: unknown = Reflect.apply(fn, undefined, [view, opts]);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the documented shape above; each case checks the fields it reads
  return out as Model;
}

const view = (data = mapRoadmap()): SessionView => buildSessionView(data, 1, MAP_SESSION);
const qvOf = (v: SessionView, id: string) => v.questions.find((x) => x.question.id === id)!;
const nodeOfQuestion = (m: Model, id: string) => {
  const found = m.nodes.filter((n) => n.questionId === id);
  expect(found.length, `one node for ${id}`).toBe(1);
  return found[0];
};
const stubs = (m: Model) => m.nodes.filter((n) => n.questionId === undefined);
const stubOf = (m: Model, sessionId: string, questionId?: string) => {
  const found = stubs(m).filter((n) => n.ref?.sessionId === sessionId && n.ref?.questionId === questionId);
  expect(found.length, `one stub for ${sessionId}/${questionId ?? "(session)"}`).toBe(1);
  return found[0];
};
const laneOf = (m: Model, n: MapNode) => m.lanes.find((l) => l.key === n.lane)!;
const nodeByKey = (m: Model, key: string) => m.nodes.find((n) => n.key === key)!;
const endKey = (m: Model, end: { sessionId: string; questionId?: string }) =>
  (end.sessionId === MAP_SESSION && end.questionId !== undefined ? nodeOfQuestion(m, end.questionId) : stubOf(m, end.sessionId, end.questionId)).key;

/** Every stored relation and link of the view that has an end in this session, as the model must draw it. */
function expectedEdges(v: SessionView, showInactive = true) {
  const shown = new Set(v.questions.filter((x) => showInactive || x.visibility === "active").map((x) => x.question.id));
  const out: Array<{ kind: string; from: { sessionId: string; questionId?: string }; to: { sessionId: string; questionId?: string }; optionIds?: string[] }> = [];
  for (const x of v.questions) {
    if (!shown.has(x.question.id)) continue;
    const to = { sessionId: MAP_SESSION, questionId: x.question.id };
    for (const a of x.question.activatedBy) out.push({ kind: "activation", from: a.parent, to, optionIds: [...a.optionIds].sort() });
    for (const i of x.question.invalidatedBy) out.push({ kind: "invalidation", from: i.upstream, to });
  }
  for (const l of v.links) {
    const local = (e: { sessionId: string; questionId?: string }) => e.sessionId === MAP_SESSION && e.questionId !== undefined;
    const hidden = (e: { sessionId: string; questionId?: string }) => local(e) && !shown.has(e.questionId!);
    if (hidden(l.from) || hidden(l.to)) continue;
    if (!local(l.from) && !local(l.to)) continue;
    out.push({ kind: l.kind, from: l.from, to: l.to });
  }
  return out.filter((e) => (e.from.sessionId === MAP_SESSION && e.from.questionId !== undefined && !shown.has(e.from.questionId) ? false : true));
}
const edgeSig = (e: { kind: string; from: string; to: string; optionIds?: string[] }) => `${e.kind}|${e.from}|${e.to}|${(e.optionIds ?? []).slice().sort().join(",")}`;

// ---- Geometry helpers ----
const inside = (n: MapNode, x: number, y: number) => x > n.x && x < n.x + n.width && y > n.y && y < n.y + n.height;
/** Whether an axis-aligned segment passes through the open interior of a node rectangle. */
function crossesInterior(s: Seg, n: MapNode): boolean {
  if (s.y1 === s.y2) {
    const [a, b] = [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)];
    return s.y1 > n.y && s.y1 < n.y + n.height && b > n.x && a < n.x + n.width;
  }
  const [a, b] = [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)];
  return s.x1 > n.x && s.x1 < n.x + n.width && b > n.y && a < n.y + n.height;
}
const onBoundary = (n: MapNode, x: number, y: number) =>
  ((x === n.x || x === n.x + n.width) && y >= n.y && y <= n.y + n.height) || ((y === n.y || y === n.y + n.height) && x >= n.x && x <= n.x + n.width);

describe("the synthetic map fixture", () => {
  it("is a valid store with 40 questions in six blocks, four of them inactive, and a view with server depths", () => {
    const data = mapRoadmap();
    const parsed = RoadmapDataV2.safeParse(data);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    const v = view(data);
    expect(v.questions.length).toBe(40);
    expect(v.questions.filter((x) => x.visibility === "inactive").map((x) => x.question.id).sort()).toEqual([...INACTIVE_IDS].sort());
    expect(new Set(v.questions.map((x) => x.question.blockId)).size).toBe(6);
    expect(qvOf(v, "m1").depth, "the root has an external parent").toBe(1);
    expect(Math.max(...v.questions.map((x) => x.depth))).toBeGreaterThanOrEqual(5);
  });
});

describe("mapModel: nodes, lanes and columns from stored data only", () => {
  it("every question is a node in the lane of its block at its server depth column; inactive nodes only with showInactive", async () => {
    const v = view();
    const all = await mapModel(v, { showInactive: true });
    for (const x of v.questions) {
      const n = nodeOfQuestion(all, x.question.id);
      expect(n.column, x.question.id).toBe(x.depth);
      const block = v.session.blocks!.find((b) => b.id === x.question.blockId)!;
      expect(laneOf(all, n).label, x.question.id).toMatch(new RegExp(`^Block ${block.order + 1}\\b`));
    }
    expect(nodeOfQuestion(all, "m1").column, "a local child of an external parent sits at column 1 or more").toBeGreaterThanOrEqual(1);
    const active = await mapModel(v, { showInactive: false });
    expect(active.nodes.filter((n) => n.questionId !== undefined).length).toBe(36);
    for (const id of INACTIVE_IDS) expect(active.nodes.some((n) => n.questionId === id), id).toBe(false);
  });

  it("the lanes are the blocks in order and one Other sessions lane; no other grouping is invented", async () => {
    const m = await mapModel(view());
    const labels = m.lanes.map((l) => l.label);
    expect(labels.filter((l) => /^Block \d/.test(l)).map((l) => /^Block (\d+)/.exec(l)![1])).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(labels.filter((l) => /Other sessions/.test(l)).length).toBe(1);
    expect(labels.length).toBe(7);
    for (const s of stubs(m)) expect(laneOf(m, s).label).toMatch(/Other sessions/);
  });

  it("a legacy session has all its questions in one lane", async () => {
    const m = await mapModel(buildSessionView(legacyMapRoadmap(), 1, MAP_SESSION));
    const lanes = new Set(m.nodes.filter((n) => n.questionId !== undefined).map((n) => n.lane));
    expect(lanes.size).toBe(1);
    expect(m.lanes.find((l) => lanes.has(l.key))!.label).toMatch(/^All questions/);
  });
});

describe("mapModel: external ends", () => {
  it("one stub per distinct other-session end with catalog titles; an empty session is title unavailable; this session's own bare end is a lane note", async () => {
    const m = await mapModel(view());
    expect(stubOf(m, OTHER_SESSION, "t1").label).toMatch(/Other session \/ Other question 1/);
    expect(stubOf(m, OTHER_SESSION, "t2").label).toMatch(/Other session \/ Other question 2/);
    expect(stubOf(m, EMPTY_SESSION).label).toMatch(/title unavailable/);
    expect(stubs(m).length, "t1, t2 and session U, each once").toBe(3);
    expect(m.nodes.some((n) => n.ref?.sessionId === MAP_SESSION && n.ref.questionId === undefined), "no node for this session itself").toBe(false);
    expect(JSON.stringify(m.lanes)).toMatch(/Informed by|Informs this session/);
  });

  it("a link to a question that no longer exists ends at a missing stub", async () => {
    const v = view();
    v.links = [...v.links, { id: "lk-missing", kind: "informs", from: { sessionId: MAP_SESSION, questionId: "m7" }, to: { sessionId: OTHER_SESSION, questionId: "gone" } }];
    const m = await mapModel(v);
    expect(stubOf(m, OTHER_SESSION, "gone").label).toMatch(/a question that no longer exists/);
  });

  it("stub columns are non-negative and deterministic: a source sits one column before its earliest local target, a target-only stub one after its latest local source", async () => {
    const m = await mapModel(view());
    const col = (id: string) => nodeOfQuestion(m, id).column;
    expect(stubOf(m, OTHER_SESSION, "t1").column, "t1 activates m1 (also a link target: the source rule wins)").toBe(Math.max(0, col("m1") - 1));
    expect(stubOf(m, OTHER_SESSION, "t2").column, "t2 supersedes m6").toBe(Math.max(0, col("m6") - 1));
    expect(stubOf(m, EMPTY_SESSION).column, "session U is only informed by m8").toBe(col("m8") + 1);
    for (const s of stubs(m)) expect(s.column, s.label).toBeGreaterThanOrEqual(0);
  });

  it("relations between two other-session questions are not drawn and the model says they are unavailable", async () => {
    const m = await mapModel(view());
    const t1 = stubOf(m, OTHER_SESSION, "t1").key;
    const t2 = stubOf(m, OTHER_SESSION, "t2").key;
    expect(m.edges.filter((e) => (e.from === t1 && e.to === t2) || (e.from === t2 && e.to === t1))).toEqual([]);
    expect(m.notes.join("\n")).toMatch(/relations among other sessions are not shown/i);
  });
});

describe("mapModel: edges", () => {
  it("one edge per stored relation or link with its kind, direction and activation condition; two activations by one parent with different options stay two", async () => {
    const v = view();
    const m = await mapModel(v, { showInactive: true });
    const want = expectedEdges(v).map((e) => edgeSig({ kind: e.kind, from: endKey(m, e.from), to: endKey(m, e.to), ...(e.optionIds ? { optionIds: e.optionIds } : {}) }));
    expect(m.edges.map(edgeSig).sort()).toEqual([...new Set(want)].sort());
    const m2 = nodeOfQuestion(m, "m2").key;
    const m5 = nodeOfQuestion(m, "m5").key;
    expect(m.edges.filter((e) => e.kind === "activation" && e.from === m2 && e.to === m5).map((e) => e.optionIds).sort()).toEqual([["a"], ["a", "b"]]);
  });

  it("only exact duplicates collapse: the same kind, endpoints and condition", async () => {
    const v = view();
    v.links = [...v.links, { id: "lk-dup", kind: "informs", from: { sessionId: MAP_SESSION, questionId: "m30" }, to: { sessionId: MAP_SESSION, questionId: "m4" } }];
    const m = await mapModel(v);
    const from = nodeOfQuestion(m, "m30").key;
    const to = nodeOfQuestion(m, "m4").key;
    expect(m.edges.filter((e) => e.kind === "informs" && e.from === from && e.to === to).length).toBe(1);
  });

  it("hiding inactive questions hides their edges", async () => {
    const v = view();
    const m = await mapModel(v, { showInactive: false });
    const keys = new Set(m.nodes.map((n) => n.key));
    for (const e of m.edges) expect(keys.has(e.from) && keys.has(e.to), edgeSig(e)).toBe(true);
    expect(m.edges.map(edgeSig).sort()).toEqual(
      [...new Set(expectedEdges(v, false).map((e) => edgeSig({ kind: e.kind, from: endKey(m, e.from), to: endKey(m, e.to), ...(e.optionIds ? { optionIds: e.optionIds } : {}) })))].sort(),
    );
  });

  it("edges between lanes are flagged cross-lane; links never change columns; a link whose target column is not after its source is a back edge", async () => {
    const v = view();
    const m = await mapModel(v);
    expect(m.edges.filter((e) => e.crossLane).length).toBeGreaterThanOrEqual(8);
    for (const e of m.edges) expect(e.crossLane, edgeSig(e)).toBe(nodeByKey(m, e.from).lane !== nodeByKey(m, e.to).lane);
    for (const e of m.edges.filter((x) => x.kind === "activation" || x.kind === "invalidation")) {
      if (nodeByKey(m, e.from).questionId !== undefined) expect(e.back, edgeSig(e)).toBe(false);
    }
    const back = (from: string, to: string) => m.edges.find((e) => e.from === nodeOfQuestion(m, from).key && e.to === nodeOfQuestion(m, to).key)!;
    expect(back("m30", "m4").back).toBe(true);
    expect(back("m10", "m11").back, "a same-column link").toBe(true);
    expect(back("m11", "m10").back, "the other half of a two-link cycle").toBe(true);
    for (const x of v.questions) expect(nodeOfQuestion(m, x.question.id).column).toBe(x.depth);
  });
});

// DeepSeek Flash review 01a1c6c1 c0114: a session's first block takes the caller's blockId
// (blockPlacement in server/sessions.ts; question.create from the UI, roadmap_ask from the chat), and
// an Id is any non-empty string (shared/model.ts), so "external" or "all" is a valid stored block id
// (a probe of the service at 83e2cf5 stored both). Later blocks get generated ids. At 83e2cf5 the
// other-session lane was "lane:external" and a legacy session's lane "lane:all", so such a block's
// lane "lane:<blockId>" collided with them. Since b8e3725 only block lanes carry the "lane:" prefix
// (the others are "other-sessions" and "all-questions", client/map-layout.ts), and these cases keep
// each lane its own, with every node in its own lane (DeepSeek Flash review 01a1c737 c0049).
describe("mapModel: a first block whose id is \"external\" or \"all\"", () => {
  function renameFirstBlock(data: RoadmapData, id: string): RoadmapData {
    const s = data.sessions.find((x) => x.id === MAP_SESSION)!;
    const first = s.blocks![0].id;
    s.blocks![0] = { ...s.blocks![0], id };
    s.questions = s.questions.map((qq) => (qq.blockId === first ? { ...qq, blockId: id } : qq));
    return data;
  }
  for (const id of ["external", "all"]) {
    it(`first block "${id}": the lanes stay distinct, every question sits in its block's lane and every other-session stub in Other sessions`, async () => {
      const data = renameFirstBlock(mapRoadmap(), id);
      expect(RoadmapDataV2.safeParse(data).success, "a valid store").toBe(true);
      const v = view(data);
      expect(v.session.blocks?.[0].id).toBe(id);
      const m = await mapModel(v, { showInactive: true });
      const keys = m.lanes.map((l) => l.key);
      expect(new Set(keys).size, `lane keys ${keys.join(", ")}`).toBe(keys.length);
      expect(m.lanes.map((l) => l.label.split(" · ")[0]), "one lane per block, then Other sessions").toEqual(["Block 1", "Block 2", "Block 3", "Block 4", "Block 5", "Block 6", "Other sessions"]);
      const laneOfBlock = new Map(v.session.blocks!.map((b) => [b.id, m.lanes.find((l) => l.label.startsWith(`Block ${b.order + 1} · `))!.key]));
      const misplaced: string[] = [];
      for (const n of m.nodes) {
        if (n.questionId !== undefined) {
          const want = laneOfBlock.get(qvOf(v, n.questionId).question.blockId!);
          if (n.lane !== want) misplaced.push(`${n.label} in ${n.lane}, not ${want}`);
        } else if (n.ref !== undefined && laneOf(m, n).label !== "Other sessions") misplaced.push(`stub ${n.label} in ${laneOf(m, n).label}`);
      }
      expect(misplaced).toEqual([]);
      const want = expectedEdges(v).map((e) => edgeSig({ kind: e.kind, from: endKey(m, e.from), to: endKey(m, e.to), ...(e.optionIds ? { optionIds: e.optionIds } : {}) }));
      expect(m.edges.map(edgeSig).sort(), "the edges are the stored relations and links").toEqual([...new Set(want)].sort());
      // No two nodes share a place.
      const overlaps: string[] = [];
      for (let i = 0; i < m.nodes.length; i++) for (let j = i + 1; j < m.nodes.length; j++) {
        const [a, b] = [m.nodes[i], m.nodes[j]];
        if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) overlaps.push(`${a.label} / ${b.label}`);
      }
      expect(overlaps).toEqual([]);
    });
  }

  it("the same map with ordinary block ids is laid out the same way (control)", async () => {
    const plain = await mapModel(view(mapRoadmap()), { showInactive: true });
    expect(new Set(plain.lanes.map((l) => l.key)).size).toBe(plain.lanes.length);
  });
});

describe("mapModel: geometry and routing", () => {
  it("is deterministic and leaves the view unchanged", async () => {
    const v = view();
    const before = canonicalJson(v);
    const a = await mapModel(v);
    const b = await mapModel(view());
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(v)).toBe(before);
  });

  it("no two nodes overlap; every node keeps at least a 44 px target at 75 %", async () => {
    const m = await mapModel(view());
    for (const n of m.nodes) {
      expect(n.width * 0.75, n.label).toBeGreaterThanOrEqual(44);
      expect(n.height * 0.75, n.label).toBeGreaterThanOrEqual(44);
    }
    for (let i = 0; i < m.nodes.length; i++) {
      for (let j = i + 1; j < m.nodes.length; j++) {
        const [p, q] = [m.nodes[i], m.nodes[j]];
        const apart = p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y;
        expect(apart, `${p.label} / ${q.label}`).toBe(true);
      }
    }
  });

  it("every edge is a connected chain of horizontal and vertical segments from its source's boundary to its target's", async () => {
    const m = await mapModel(view());
    for (const e of m.edges) {
      expect(e.segments.length, edgeSig(e)).toBeGreaterThan(0);
      for (const s of e.segments) expect(s.x1 === s.x2 || s.y1 === s.y2, `${edgeSig(e)} orthogonal`).toBe(true);
      for (let i = 1; i < e.segments.length; i++) {
        expect([e.segments[i].x1, e.segments[i].y1], `${edgeSig(e)} connected`).toEqual([e.segments[i - 1].x2, e.segments[i - 1].y2]);
      }
      const first = e.segments[0];
      const last = e.segments.at(-1)!;
      expect(onBoundary(nodeByKey(m, e.from), first.x1, first.y1), `${edgeSig(e)} starts on its source`).toBe(true);
      expect(onBoundary(nodeByKey(m, e.to), last.x2, last.y2), `${edgeSig(e)} ends on its target`).toBe(true);
    }
  });

  it("no segment passes through any node, including same-column, back, cross-lane and shared-stub edges", async () => {
    const m = await mapModel(view());
    const hits: string[] = [];
    for (const e of m.edges) for (const s of e.segments) for (const n of m.nodes) if (crossesInterior(s, n)) hits.push(`${edgeSig(e)} crosses ${n.label}`);
    expect(hits).toEqual([]);
  });

  it("the final segment enters the target horizontally: from the left for a forward edge, from the right for a back edge", async () => {
    const m = await mapModel(view());
    for (const e of m.edges) {
      const last = e.segments.at(-1)!;
      const target = nodeByKey(m, e.to);
      expect(last.y1, `${edgeSig(e)} horizontal`).toBe(last.y2);
      if (e.back) {
        expect(last.x2, `${edgeSig(e)} at the right edge`).toBe(target.x + target.width);
        expect(last.x1, `${edgeSig(e)} moving left`).toBeGreaterThan(last.x2);
      } else {
        expect(last.x2, `${edgeSig(e)} at the left edge`).toBe(target.x);
        expect(last.x1, `${edgeSig(e)} moving right`).toBeLessThan(last.x2);
      }
    }
  });

  it("the world holds every node and segment", async () => {
    const m = await mapModel(view());
    for (const n of m.nodes) {
      expect(n.x >= 0 && n.y >= 0 && n.x + n.width <= m.world.width && n.y + n.height <= m.world.height, n.label).toBe(true);
      expect(inside(n, n.x + n.width / 2, n.y + n.height / 2)).toBe(true);
    }
    for (const e of m.edges) for (const s of e.segments) for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) expect(x >= 0 && y >= 0 && x <= m.world.width && y <= m.world.height, edgeSig(e)).toBe(true);
  });

  // Plan r4 §2.8: each edge's vertical run takes "a per-edge x slot inside the gutter (slots spread by
  // edge index so parallel runs do not overlap)". KensAI 9126580 c0039: the gutter offers 16 slots
  // (`k % 16`) and the lane track 7, so further runs reuse a slot. On this fixture, runs of different
  // edges and kinds then lie on one x with overlapping y ranges (for example an activation and an
  // invalidation run at the same x), so their line styles stack and the two routes read as one. The
  // horizontal stubs that leave one source or enter one target are shared by design and not checked.
  for (const [name, data] of [
    ["the 40-question fixture", () => mapRoadmap()],
    ["119 questions, the largest map drawn in full", () => largeMapRoadmap(119)],
  ] as const) {
    it(`no two edges share a vertical run (same x, overlapping y): ${name}`, async () => {
      const m = await mapModel(view(data()));
      const runs = m.edges.flatMap((e) => e.segments.filter((s) => s.x1 === s.x2).map((s) => ({ e: edgeSig(e), x: s.x1, lo: Math.min(s.y1, s.y2), hi: Math.max(s.y1, s.y2) })));
      const shared: string[] = [];
      for (let i = 0; i < runs.length; i++) {
        for (let j = i + 1; j < runs.length; j++) {
          const [a, b] = [runs[i], runs[j]];
          if (a.e !== b.e && a.x === b.x && Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 0) shared.push(`x=${a.x}: ${a.e} [${a.lo}–${a.hi}] / ${b.e} [${b.lo}–${b.hi}]`);
        }
      }
      expect(shared.slice(0, 5), `${shared.length} pairs of edges share a vertical run`).toEqual([]);
    });
  }

  // Route separation, read from what a route means rather than how the layout assigns positions: two
  // different edges may share a line only where they meet one node, along that node's row at its side
  // (several edges leaving or entering it). Anywhere else a shared or touching collinear run makes two
  // routes read as one: vertical runs in gutters, long horizontal runs in lane tracks, and the short
  // horizontal stubs of two different nodes on one row that meet in the gutter between them, which
  // then draw an unbroken line from one node to the other although no edge joins them (on the
  // 40-question fixture at 5d6944d: m30 and m32 share row y = 1892; the back edge m30 → m4 leaves m30
  // to x = 1800, the activation m16 → m32 enters m32 from x = 1756).
  // Checked on the 40-question fixture, 119 questions (the largest map drawn in full), a dense
  // 119-question map with forward, back and cross-lane links, and 400 questions both drawn in full and
  // with every lane but the open block's collapsed (the Map opens on the List above 400 nodes, and the
  // graph stays one press away).
  describe("route separation and bounds on dense maps", () => {
    const dense = () => {
      const data = largeMapRoadmap(119);
      const ids = Array.from({ length: 119 }, (_, k) => `m${k + 1}`);
      const seen = new Set<string>();
      const links: Array<{ id: string; kind: "informs" | "supersedes"; from: { sessionId: string; questionId: string }; to: { sessionId: string; questionId: string } }> = [];
      for (let i = 0; i < ids.length; i++) {
        for (const step of [7, 31, 58]) {
          const j = (i * 5 + step) % ids.length;
          if (j === i) continue;
          const key = `${i}>${j}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({ id: `dl-${i}-${j}`, kind: step === 31 ? "supersedes" : "informs", from: { sessionId: MAP_SESSION, questionId: ids[i] }, to: { sessionId: MAP_SESSION, questionId: ids[j] } });
        }
      }
      data.meta.links = [...(data.meta.links ?? []), ...links] as typeof data.meta.links;
      return data;
    };
    const fixtures: Array<[string, () => Promise<Model>]> = [
      ["the 40-question fixture", () => mapModel(view())],
      ["119 questions", () => mapModel(view(largeMapRoadmap(119)))],
      ["a dense 119-question map", () => mapModel(view(dense()))],
      ["400 questions drawn in full", () => mapModel(view(largeMapRoadmap(400)))],
      [
        "400 questions with every lane but the open block's collapsed",
        async () => {
          const v = view(largeMapRoadmap(400));
          const full = await mapModel(v);
          const open = v.session.blocks?.find((b) => b.state === "open")?.id;
          const keep = full.lanes.find((l) => open !== undefined && l.key.includes(open))?.key;
          return mapModel(v, { collapsed: new Set(full.lanes.map((l) => l.key).filter((k) => k !== keep)) });
        },
      ],
    ];
    const centreY = (n: MapNode) => n.y + n.height / 2;

    it("the dense fixture is a valid store whose links all reach the map", async () => {
      expect(RoadmapDataV2.safeParse(dense()).success).toBe(true);
      const m = await mapModel(view(dense()));
      expect(m.edges.filter((e) => e.kind !== "activation").length, "the added links are drawn").toBeGreaterThan(300);
      expect(m.edges.some((e) => e.back) && m.edges.some((e) => e.crossLane), "back and cross-lane edges").toBe(true);
    });

    for (const [name, build] of fixtures) {
      it(`no two edges share or touch a vertical run: ${name}`, async () => {
        const m = await build();
        const runs = m.edges.flatMap((e) => e.segments.filter((g) => g.x1 === g.x2).map((g) => ({ e: edgeSig(e), x: g.x1, lo: Math.min(g.y1, g.y2), hi: Math.max(g.y1, g.y2) })));
        const bad: string[] = [];
        for (let i = 0; i < runs.length; i++) {
          for (let j = i + 1; j < runs.length; j++) {
            const [a, b] = [runs[i], runs[j]];
            if (a.e !== b.e && a.x === b.x && Math.min(a.hi, b.hi) >= Math.max(a.lo, b.lo)) bad.push(`x=${a.x}: ${a.e} [${a.lo}–${a.hi}] / ${b.e} [${b.lo}–${b.hi}]`);
          }
        }
        expect(bad.slice(0, 5), `${bad.length} pairs`).toEqual([]);
      });

      it(`horizontal runs of different edges share a line only where they meet one node, at its side: ${name}`, async () => {
        const m = await build();
        const byKey = new Map(m.nodes.map((n) => [n.key, n]));
        type H = { e: MapEdge; y: number; lo: number; hi: number };
        // One edge's consecutive horizontal pieces on one row are one run (a straight edge between two
        // nodes on one row is drawn as a stub and a continuation).
        const runs: H[] = m.edges.flatMap((e) => {
          const out: H[] = [];
          for (const g of e.segments) {
            if (g.y1 !== g.y2) continue;
            const [lo, hi] = [Math.min(g.x1, g.x2), Math.max(g.x1, g.x2)];
            const last = out.at(-1);
            if (last !== undefined && last.y === g.y1 && (lo === last.hi || hi === last.lo)) Object.assign(last, { lo: Math.min(lo, last.lo), hi: Math.max(hi, last.hi) });
            else out.push({ e, y: g.y1, lo, hi });
          }
          return out;
        });
        // Both edges meet one node, the shared line is that node's row, and both runs touch its side.
        // (A forward edge leaving a node and a back edge entering it from the right share its right
        // side by design.)
        const touches = (r: H, n: MapNode) => r.lo === n.x || r.lo === n.x + n.width || r.hi === n.x || r.hi === n.x + n.width;
        const sharedEnd = (a: H, b: H) =>
          [a.e.from, a.e.to]
            .filter((k) => k === b.e.from || k === b.e.to)
            .map((k) => byKey.get(k))
            .some((n) => n !== undefined && a.y === centreY(n) && touches(a, n) && touches(b, n));
        const bad: string[] = [];
        for (let i = 0; i < runs.length; i++) {
          for (let j = i + 1; j < runs.length; j++) {
            const [a, b] = [runs[i], runs[j]];
            if (a.e === b.e || a.y !== b.y || Math.min(a.hi, b.hi) < Math.max(a.lo, b.lo)) continue;
            if (!sharedEnd(a, b)) bad.push(`y=${a.y}: ${edgeSig(a.e)} [${a.lo}–${a.hi}] / ${edgeSig(b.e)} [${b.lo}–${b.hi}]`);
          }
        }
        expect(bad.slice(0, 5), `${bad.length} pairs`).toEqual([]);
      });

      it(`no segment crosses a node and the world holds every node and segment: ${name}`, async () => {
        const m = await build();
        const hits: string[] = [];
        for (const e of m.edges) for (const g of e.segments) for (const n of m.nodes) if (crossesInterior(g, n)) hits.push(`${edgeSig(e)} crosses ${n.label}`);
        expect(hits.slice(0, 5), `${hits.length} crossings`).toEqual([]);
        const out: string[] = [];
        for (const n of m.nodes) if (!(n.x >= 0 && n.y >= 0 && n.x + n.width <= m.world.width && n.y + n.height <= m.world.height)) out.push(n.label);
        for (const e of m.edges) for (const g of e.segments) for (const [x, y] of [[g.x1, g.y1], [g.x2, g.y2]]) if (!(x >= 0 && y >= 0 && x <= m.world.width && y <= m.world.height)) out.push(edgeSig(e));
        expect(out.slice(0, 5), `${out.length} outside the world`).toEqual([]);
      });
    }
  });

  // Crossing next-column edges (review of a89c7c7). When every node of one column is joined to every
  // node of the next column in one lane, some of those edges must cross, and a crossing pair of
  // next-column edges cannot both be drawn inside the gutter between the two columns without their
  // stubs meeting another node's stubs on a shared row (a false line between two nodes). These
  // fixtures build that situation from stored relations only, add parallel edges with other
  // conditions, an invalidation and back links on the same nodes, and a second lane, and then check
  // what a reader relies on: every stored relation is one edge with its kind, ends and condition;
  // every route runs from its source's side to its target's side; no route crosses a node, leaves the
  // world, shares a vertical run, or draws a line between two nodes that no edge joins; collapsing a
  // lane keeps every edge to a shown node at its port with its stored ends.
  describe("crossing next-column edges", () => {
    const opts3 = [
      { id: "a", label: "Option A" },
      { id: "b", label: "Option B" },
      { id: "c", label: "Option C" },
    ];
    const sref = (questionId: string) => ({ sessionId: MAP_SESSION, questionId });
    /**
     * Lane b1 (open): roots x1..xk answered a; children y1..yk, each activated by every root on option
     * a (k × k next-column edges), y1 also by x1 on options b,c (a second condition, same ends), y2
     * invalidated by x1. Lane b2: z1, z2 activated by y1 and y2 (cross-lane, two columns on). Links:
     * yk informs x1 and y1 supersedes x2 (back edges into the left column), z1 informs y2 (a back edge
     * across lanes).
     */
    function crossing(k: number): RoadmapData {
      const xs = Array.from({ length: k }, (_, i) => `x${i + 1}`);
      const ys = Array.from({ length: k }, (_, i) => `y${i + 1}`);
      let order = 0;
      const make = (id: string, blockId: string, extra: Partial<Question> = {}) => storedQuestion(id, { order: order, number: ++order, title: `Crossing ${id}`, options: opts3, blockId, ...extra });
      const questions: Question[] = [
        ...xs.map((id) => answered(make(id, "b1"), "a")),
        ...ys.map((id, i) =>
          answered(
            make(id, "b1", {
              activatedBy: [...xs.map((x) => ({ parent: sref(x), optionIds: ["a"] })), ...(i === 0 ? [{ parent: sref("x1"), optionIds: ["b", "c"] }] : [])],
              invalidatedBy: i === 1 ? [{ upstream: sref("x1") }] : [],
            }),
            "a",
          ),
        ),
        make("z1", "b2", { activatedBy: [{ parent: sref("y1"), optionIds: ["a"] }, { parent: sref("y2"), optionIds: ["a"] }] }),
        make("z2", "b2", { activatedBy: [{ parent: sref("y2"), optionIds: ["a"] }] }),
      ];
      const data = roadmapData([
        {
          id: MAP_SESSION,
          title: "Crossing session",
          createdAt: NOW_ISO,
          status: "active",
          questions,
          blocks: [
            { id: "b1", order: 0, state: "accepted", openedAt: NOW_ISO, acceptedAt: NOW_ISO, acceptedBy: { kind: "human" } },
            { id: "b2", order: 1, state: "open", openedAt: NOW_ISO },
          ],
        },
      ]);
      const links: Link[] = [
        { id: "cl-back", kind: "informs", from: sref(ys[k - 1]), to: sref("x1") },
        { id: "cl-super", kind: "supersedes", from: sref("y1"), to: sref("x2") },
        { id: "cl-lanes", kind: "informs", from: sref("z1"), to: sref("y2") },
      ];
      data.meta.links = links;
      return data;
    }
    /** The edge signatures the stored relations and links call for, independent of the layout. */
    function expectedSigs(data: RoadmapData): string[] {
      const out: string[] = [];
      for (const qq of data.sessions[0].questions) {
        for (const a of qq.activatedBy) out.push(edgeSig({ kind: "activation", from: `q:${a.parent.questionId}`, to: `q:${qq.id}`, optionIds: a.optionIds }));
        for (const iv of qq.invalidatedBy) out.push(edgeSig({ kind: "invalidation", from: `q:${iv.upstream.questionId}`, to: `q:${qq.id}` }));
      }
      const idOf = (end: { sessionId: string; questionId?: string }) => `q:${end.questionId ?? end.sessionId}`;
      for (const l of data.meta.links) out.push(edgeSig({ kind: l.kind, from: idOf(l.from), to: idOf(l.to) }));
      return out.sort();
    }
    /** What a reader of the drawing relies on, as a list of problems (empty when the drawing is sound). */
    function drawingProblems(m: Model): string[] {
      const problems: string[] = [];
      const byKey = new Map(m.nodes.map((n) => [n.key, n]));
      for (const e of m.edges) {
        const from = byKey.get(e.from);
        const to = byKey.get(e.to);
        if (from === undefined || to === undefined) {
          problems.push(`${edgeSig(e)}: an end is not a drawn node`);
          continue;
        }
        const segs = e.segments;
        if (segs.length === 0) problems.push(`${edgeSig(e)}: no route`);
        else {
          if (!onBoundary(from, segs[0].x1, segs[0].y1)) problems.push(`${edgeSig(e)}: does not start on its source`);
          const last = segs.at(-1)!;
          if (!onBoundary(to, last.x2, last.y2)) problems.push(`${edgeSig(e)}: does not end on its target`);
          if (last.y1 !== last.y2) problems.push(`${edgeSig(e)}: does not enter its target horizontally`);
          else if (e.back ? !(last.x2 === to.x + to.width && last.x1 > last.x2) : !(last.x2 === to.x && last.x1 < last.x2)) problems.push(`${edgeSig(e)}: enters its target from the wrong side`);
        }
        for (let i = 0; i < segs.length; i++) {
          const g = segs[i];
          if (g.x1 !== g.x2 && g.y1 !== g.y2) problems.push(`${edgeSig(e)}: a diagonal segment`);
          if (i > 0 && (segs[i - 1].x2 !== g.x1 || segs[i - 1].y2 !== g.y1)) problems.push(`${edgeSig(e)}: a gap in its route`);
          for (const n of m.nodes) if (crossesInterior(g, n)) problems.push(`${edgeSig(e)}: crosses ${n.label}`);
          for (const [x, y] of [[g.x1, g.y1], [g.x2, g.y2]]) if (!(x >= 0 && y >= 0 && x <= m.world.width && y <= m.world.height)) problems.push(`${edgeSig(e)}: leaves the world`);
        }
      }
      for (const n of m.nodes) if (!(n.x >= 0 && n.y >= 0 && n.x + n.width <= m.world.width && n.y + n.height <= m.world.height)) problems.push(`${n.label}: outside the world`);
      const ids = (e: MapEdge) => `${edgeSig(e)}${(e as MapEdge & { via?: { from: string; to: string } }).via !== undefined ? ` via ${JSON.stringify((e as MapEdge & { via?: unknown }).via)}` : ""}`;
      // Vertical runs of two different edges never share or touch on one x.
      const vr = m.edges.flatMap((e) => e.segments.filter((g) => g.x1 === g.x2).map((g) => ({ e, x: g.x1, lo: Math.min(g.y1, g.y2), hi: Math.max(g.y1, g.y2) })));
      for (let i = 0; i < vr.length; i++) for (let j = i + 1; j < vr.length; j++) if (vr[i].e !== vr[j].e && vr[i].x === vr[j].x && Math.min(vr[i].hi, vr[j].hi) >= Math.max(vr[i].lo, vr[j].lo)) problems.push(`shared vertical run at x=${vr[i].x}: ${ids(vr[i].e)} / ${ids(vr[j].e)}`);
      // Horizontal runs of two different edges share a line only where both meet one node, on its row, at its side.
      type H = { e: MapEdge; y: number; lo: number; hi: number };
      const hr: H[] = m.edges.flatMap((e) => {
        const out: H[] = [];
        for (const g of e.segments) {
          if (g.y1 !== g.y2) continue;
          const [lo, hi] = [Math.min(g.x1, g.x2), Math.max(g.x1, g.x2)];
          const prev = out.at(-1);
          if (prev !== undefined && prev.y === g.y1 && (lo === prev.hi || hi === prev.lo)) Object.assign(prev, { lo: Math.min(lo, prev.lo), hi: Math.max(hi, prev.hi) });
          else out.push({ e, y: g.y1, lo, hi });
        }
        return out;
      });
      const side = (r: H, n: MapNode) => [n.x, n.x + n.width].some((x) => r.lo === x || r.hi === x);
      for (let i = 0; i < hr.length; i++) {
        for (let j = i + 1; j < hr.length; j++) {
          const [a, b] = [hr[i], hr[j]];
          if (a.e === b.e || a.y !== b.y || Math.min(a.hi, b.hi) < Math.max(a.lo, b.lo)) continue;
          const shared = [a.e.from, a.e.to].filter((k) => k === b.e.from || k === b.e.to).map((k) => byKey.get(k));
          if (!shared.some((n) => n !== undefined && a.y === n.y + n.height / 2 && side(a, n) && side(b, n))) problems.push(`a line between two nodes at y=${a.y}: ${ids(a.e)} [${a.lo}–${a.hi}] / ${ids(b.e)} [${b.lo}–${b.hi}]`);
        }
      }
      return problems;
    }

    for (const k of [2, 3, 5]) {
      it(`${k} × ${k} crossing activations: the conflict exists, every relation is one edge with its condition, and the drawing is sound`, async () => {
        const data = crossing(k);
        expect(RoadmapDataV2.safeParse(data).success, "a valid store").toBe(true);
        const m = await mapModel(view(data));
        // The situation the case is about: x and y nodes in two next columns of one lane, on shared rows,
        // so that edges from one row to another (which must cross) run between them.
        const xn = Array.from({ length: k }, (_, i) => nodeOfQuestion(m, `x${i + 1}`));
        const yn = Array.from({ length: k }, (_, i) => nodeOfQuestion(m, `y${i + 1}`));
        expect(new Set([...xn, ...yn].map((n) => n.lane)).size, "one lane").toBe(1);
        expect(new Set(xn.map((n) => n.column)).size, "the roots share a column").toBe(1);
        expect(yn.every((n) => n.column === xn[0].column + 1), "the children are in the next column").toBe(true);
        expect(new Set(yn.map((n) => n.y)), "the children's rows are the roots' rows").toEqual(new Set(xn.map((n) => n.y)));
        const crossingPairs = m.edges.filter((e) => e.kind === "activation" && xn.some((n) => n.key === e.from) && yn.some((n) => n.key === e.to) && nodeByKey(m, e.from).y !== nodeByKey(m, e.to).y);
        expect(crossingPairs.length, "next-column edges between different rows").toBeGreaterThanOrEqual(2);
        // Identity: exactly the stored relations and links, each once, with its condition.
        expect(m.edges.map(edgeSig).sort()).toEqual(expectedSigs(data));
        const y1 = m.edges.filter((e) => e.kind === "activation" && e.from === xn[0].key && e.to === yn[0].key).map((e) => (e.optionIds ?? []).slice().sort().join(","));
        expect(y1.sort(), "x1 → y1 under two conditions stays two edges").toEqual(["a", "b,c"]);
        expect(drawingProblems(m)).toEqual([]);
      });
    }

    // Laying out a dense map must not stall the screen that opens it (the Map, and above 400 nodes its
    // List, read the model before they draw). Measured at 8a0514c in Node: 10 × 10 crossing activations
    // 12 ms, 20 × 20 about 0.4 s, 30 × 30 (60 questions, about 900 edges) about 6.5 s, 40 × 40 did not
    // finish within ten minutes; sparse maps stay cheap (400 questions with 1597 edges 26 ms, 1000
    // questions 25 ms). The bound below is generous (a dense map of this size took 12 ms at 10 × 10)
    // so that machine speed does not decide it; the drawing must still be sound.
    it("a dense 30 × 30 crossing map is laid out within a second, and the drawing is sound", async () => {
      const v = view(crossing(30));
      // DeepSeek Flash review 01a1c67a c0028: the module is loaded before timing, so the bound measures the layout only.
      await import(/* @vite-ignore */ layoutPath);
      const t0 = performance.now();
      const m = await mapModel(v);
      const ms = performance.now() - t0;
      expect(m.edges.length, "the dense map's edges").toBeGreaterThan(900);
      expect(ms, `laid out in ${Math.round(ms)} ms`).toBeLessThan(1000);
      expect(drawingProblems(m)).toEqual([]);
    }, 120_000);

    // KensAI 01a1c5cb c0111: the store accepts a link whose two ends are the same question (`Link` has no
    // rule against it, link.create checks only that each end exists, session.get returns it), and the
    // Map contract draws each stored link with an end in the session as one edge (OVERVIEW.md, the Map).
    // A self-link must therefore be one edge from its node to itself, of its kind, drawn as a loop that
    // leaves the node and comes back to it without covering anything: not a line that collapses onto
    // the node's side, and not dropped. Another session's self-link is not this session's and is not
    // shown; a self-link of a hidden inactive question is hidden with it.
    describe("stored self-links", () => {
      const sref = (questionId: string, sessionId = MAP_SESSION) => ({ sessionId, questionId });
      function withSelfLinks(): RoadmapData {
        const data = mapRoadmap();
        data.meta.links = [
          ...data.meta.links,
          { id: "lk-self-informs", kind: "informs", from: sref("m4"), to: sref("m4") },
          { id: "lk-self-supersedes", kind: "supersedes", from: sref("m10"), to: sref("m10") },
          { id: "lk-self-inactive", kind: "informs", from: sref("m38"), to: sref("m38") },
          { id: "lk-other-self", kind: "informs", from: sref("t1", OTHER_SESSION), to: sref("t1", OTHER_SESSION) },
        ] satisfies Link[];
        return data;
      }

      it("each is one edge from its node to itself with its kind; the edge set is exactly the stored relations and links", async () => {
        const data = withSelfLinks();
        expect(RoadmapDataV2.safeParse(data).success, "a valid store").toBe(true);
        const v = view(data);
        expect(v.links.some((l) => l.id === "lk-self-informs"), "the session view carries the self-link").toBe(true);
        const m = await mapModel(v, { showInactive: true });
        const loops = (id: string, kind: string) => m.edges.filter((e) => e.kind === kind && e.from === nodeOfQuestion(m, id).key && e.to === nodeOfQuestion(m, id).key);
        expect(loops("m4", "informs").length, "Q4 informs itself: one edge").toBe(1);
        expect(loops("m10", "supersedes").length, "Q10 supersedes itself: one edge").toBe(1);
        expect(loops("m38", "informs").length, "the inactive Q38's self-link while inactive questions are shown").toBe(1);
        const want = expectedEdges(v).map((e) => edgeSig({ kind: e.kind, from: endKey(m, e.from), to: endKey(m, e.to), ...(e.optionIds ? { optionIds: e.optionIds } : {}) }));
        expect(m.edges.map(edgeSig).sort()).toEqual([...new Set(want)].sort());
        expect(new Set(m.edges.map((e) => (e as MapEdge & { key?: string }).key)).size, "edge keys stay unique").toBe(m.edges.length);
      });

      it("the loop leaves its node and returns to it, encloses an area, covers no node and keeps the drawing sound", async () => {
        const m = await mapModel(view(withSelfLinks()), { showInactive: true });
        const problems: string[] = [];
        for (const id of ["m4", "m10"]) {
          const n = nodeOfQuestion(m, id);
          const e = m.edges.find((x) => x.from === n.key && x.to === n.key);
          if (e === undefined) {
            problems.push(`${n.label}: no self-link edge`);
            continue;
          }
          const segs = e.segments;
          if (segs.length < 3) problems.push(`${n.label}: ${segs.length} segment(s), not a loop`);
          if (!segs.some((g) => g.x1 === g.x2 && g.y1 !== g.y2)) problems.push(`${n.label}: no vertical run, so the way out and the way back are one line`);
          if (segs.length > 0 && segs[0].y1 === segs.at(-1)!.y2 && segs[0].x1 === segs.at(-1)!.x2) problems.push(`${n.label}: leaves and returns at one point`);
        }
        expect(problems).toEqual([]);
        expect(drawingProblems(m)).toEqual([]);
      });

      it("hidden inactive questions hide their self-links; another session's self-link adds no edge and no stub", async () => {
        const m = await mapModel(view(withSelfLinks()), { showInactive: false });
        expect(m.nodes.some((n) => n.questionId === "m38"), "Q38 is hidden").toBe(false);
        const keys = new Set(m.nodes.map((n) => n.key));
        for (const e of m.edges) expect(keys.has(e.from) && keys.has(e.to), edgeSig(e)).toBe(true);
        const stubT1 = stubs(m).filter((n) => n.ref?.sessionId === OTHER_SESSION && n.ref?.questionId === "t1");
        expect(m.edges.filter((e) => stubT1.some((n) => n.key === e.from) && e.from === e.to), "no loop on another session's question").toEqual([]);
      });

      // ---- Audit at 82c7502: loops among other edges, at the map's edges, collapsed, grown ----
      /** Segment endpoints of one edge lying inside a segment of another: a drawn junction no edge makes. */
      function junctions(m: Model, involving: (e: MapEdge) => boolean): string[] {
        const out: string[] = [];
        const within = (x: number, y: number, g: Seg) =>
          g.x1 === g.x2 ? x === g.x1 && y > Math.min(g.y1, g.y2) && y < Math.max(g.y1, g.y2) : y === g.y1 && x > Math.min(g.x1, g.x2) && x < Math.max(g.x1, g.x2);
        for (const a of m.edges) {
          for (const b of m.edges) {
            if (a === b || (!involving(a) && !involving(b))) continue;
            // Two loops of one node share the stub at its side, as all edges of a node share its centre stub.
            if (a.from === a.to && b.from === b.to && a.from === b.from) continue;
            for (const g of a.segments) for (const [x, y] of [[g.x1, g.y1], [g.x2, g.y2]]) if (b.segments.some((h) => within(x, y, h))) out.push(`${edgeSig(a)} meets ${edgeSig(b)} at (${x}, ${y})`);
          }
        }
        return [...new Set(out)];
      }
      const isLoop = (e: MapEdge) => e.from === e.to;
      /** drawingProblems, except where two loops of one node share the stub at that node's side (as every edge of a node shares its centre stub). */
      const loopAware = (m: Model) =>
        drawingProblems(m).filter((p) => {
          const loopsOfOne = m.edges.filter(isLoop);
          return !(p.startsWith("a line between two nodes") && loopsOfOne.some((a) => loopsOfOne.some((b) => a !== b && a.from === b.from && p.includes(edgeSig(a)) && p.includes(edgeSig(b)))));
        });
      function loopProblems(m: Model): string[] {
        const out: string[] = [];
        for (const e of m.edges.filter(isLoop)) {
          const n = nodeByKey(m, e.from);
          const segs = e.segments;
          if (segs.length < 3) out.push(`${edgeSig(e)}: not a loop`);
          if (!segs.some((g) => g.x1 === g.x2 && g.y1 !== g.y2)) out.push(`${edgeSig(e)}: no vertical run`);
          const first = segs[0];
          const last = segs.at(-1)!;
          if (first.x1 !== n.x + n.width || last.x2 !== n.x + n.width) out.push(`${edgeSig(e)}: does not leave and enter on the right side`);
          if (first.y1 === last.y2) out.push(`${edgeSig(e)}: leaves and returns at one point`);
          if (!(first.y1 > n.y && first.y1 < n.y + n.height && last.y2 > n.y && last.y2 < n.y + n.height)) out.push(`${edgeSig(e)}: its ends are not on its node's side`);
          // The loop stays in its own lane (it never runs through another lane's nodes or track).
          const lane = m.lanes.find((l) => l.key === n.lane) as (MapLane & { y?: number; height?: number }) | undefined;
          if (lane?.y !== undefined && lane.height !== undefined) for (const g of segs) if (Math.min(g.y1, g.y2) < lane.y || Math.max(g.y1, g.y2) > lane.y + lane.height) out.push(`${edgeSig(e)}: leaves its lane`);
        }
        return out;
      }
      function selfLinked(extra: Array<[string, "informs" | "supersedes"]>): RoadmapData {
        const data = mapRoadmap();
        data.meta.links = [...data.meta.links, ...extra.map(([id, kind], k) => ({ id: `lk-audit-${k}`, kind, from: sref(id), to: sref(id) }) satisfies Link)];
        return data;
      }

      it("two self-links of different kinds on one node are two loops with their own keys and runs; a third on another node keeps apart", async () => {
        const m = await mapModel(view(selfLinked([["m4", "informs"], ["m4", "supersedes"], ["m10", "supersedes"]])), { showInactive: true });
        const n4 = nodeOfQuestion(m, "m4").key;
        const loops4 = m.edges.filter((e) => e.from === n4 && e.to === n4);
        expect(loops4.map((e) => e.kind).sort(), "Q4's two loops").toEqual(["informs", "supersedes"]);
        expect(new Set(m.edges.map((e) => (e as MapEdge & { key?: string }).key)).size, "edge keys stay unique").toBe(m.edges.length);
        expect(loopProblems(m)).toEqual([]);
        expect(loopAware(m)).toEqual([]);
        expect(junctions(m, isLoop), "no loop touches another edge where no edge joins").toEqual([]);
      });

      it("a self-link on a node of the last column, and on nodes with neighbours in the next column, stays inside the world and joins nothing", async () => {
        const base = await mapModel(view(), { showInactive: true });
        const local = base.nodes.filter((n) => n.questionId !== undefined);
        const lastCol = Math.max(...local.map((n) => n.column));
        const rightmost = local.filter((n) => n.column === lastCol).map((n) => n.questionId!);
        // Nodes with a direct next-column edge, so their gutter holds other runs on the same rows.
        const busy = base.edges.filter((e) => !e.back && nodeByKey(base, e.to).column === nodeByKey(base, e.from).column + 1).map((e) => nodeByKey(base, e.from).questionId).filter((q): q is string => q !== undefined).slice(0, 4);
        const ids = [...new Set([...rightmost, ...busy])];
        expect(ids.length, "loops on the last column and on busy gutters").toBeGreaterThanOrEqual(3);
        const m = await mapModel(view(selfLinked(ids.map((id) => [id, "informs"] as [string, "informs"]))), { showInactive: true });
        expect(m.edges.filter(isLoop).length).toBe(ids.length);
        expect(loopProblems(m)).toEqual([]);
        expect(loopAware(m)).toEqual([]);
        expect(junctions(m, isLoop)).toEqual([]);
      });

      it("inside a collapsed lane a self-link is counted among the edges not drawn, adds nothing to the port, and is drawn once the lane expands", async () => {
        const plain = largeMapRoadmap(130);
        const looped = largeMapRoadmap(130);
        looped.meta.links = [{ id: "lk-loop-m3", kind: "informs", from: sref("m3"), to: sref("m3") }];
        const lane = "lane:b1";
        const count = (m: Model) => Number(/^(\d+) edges? between collapsed lanes/.exec(m.notes.find((t) => /between collapsed lanes/.test(t)) ?? "")?.[1] ?? 0);
        const ports = (m: Model) => m.nodes.filter((n) => n.key.startsWith("port:")).map((n) => n.label).sort();
        const collapsedAll = new Set(["lane:b1", "lane:b2", "lane:b3", "lane:b4", "lane:b5"]);
        const a = await mapModel(view(plain), { collapsed: collapsedAll });
        const b = await mapModel(view(looped), { collapsed: collapsedAll });
        expect(count(b), "one more edge not drawn").toBe(count(a) + 1);
        expect(ports(b), "the ports are unchanged").toEqual(ports(a));
        expect(b.edges.filter(isLoop), "no loop drawn on a port or a hidden node").toEqual([]);
        const open = await mapModel(view(looped), { collapsed: new Set([...collapsedAll].filter((k) => k !== lane)) });
        const n3 = nodeOfQuestion(open, "m3").key;
        expect(open.edges.filter((e) => e.from === n3 && e.to === n3).length, "Block 1 expanded: Q3's loop is drawn").toBe(1);
        expect(loopProblems(open)).toEqual([]);
        expect(junctions(open, isLoop)).toEqual([]);
      });

      it("label room reserved in the loop's lane and above it moves the loop with its node; the drawing stays sound", async () => {
        const m = await mapModel(view(selfLinked([["m4", "informs"], ["m10", "supersedes"]])), { showInactive: true });
        const lane4 = nodeOfQuestion(m, "m4").lane;
        const above = m.lanes[Math.max(0, m.lanes.findIndex((l) => l.key === lane4) - 1)].key;
        const grown = await reserve(m, new Map([[above, 45], [lane4, 30]]));
        expect(loopProblems(grown)).toEqual([]);
        expect(loopAware(grown)).toEqual([]);
        expect(junctions(grown, isLoop)).toEqual([]);
      });

      it("a stored link from this session to itself is one note above the map, once per kind, and no node, stub or lane", async () => {
        const one = [storedQuestion("a1", { order: 0, number: 1, title: "Only question", options: [{ id: "a", label: "A" }], blockId: "b1" })];
        const data = roadmapData([{ id: MAP_SESSION, title: "Lone session", createdAt: NOW_ISO, status: "active", questions: one, blocks: [{ id: "b1", order: 0, state: "open", openedAt: NOW_ISO }] }]);
        const S = { sessionId: MAP_SESSION };
        data.meta.links = [
          { id: "ls-1", kind: "informs", from: S, to: S },
          { id: "ls-2", kind: "informs", from: S, to: S },
          { id: "ls-3", kind: "supersedes", from: S, to: S },
        ];
        expect(RoadmapDataV2.safeParse(data).success, "a valid store").toBe(true);
        const m = await mapModel(view(data));
        const own = m.notes.filter((t) => /this session/i.test(t));
        expect(own.filter((t) => /informs itself/.test(t)).length, own.join(" | ")).toBe(1);
        expect(own.filter((t) => /supersedes itself/.test(t)).length, own.join(" | ")).toBe(1);
        expect(m.lanes.map((l) => l.key), "no Other sessions lane for it").toEqual(["lane:b1"]);
        expect(m.lanes.flatMap((l) => l.notes ?? []), "no lane note for it").toEqual([]);
        expect(m.nodes.map((n) => n.questionId ?? n.key), "only the question").toEqual(["a1"]);
        expect(m.edges).toEqual([]);
      });

      it("another session's link to itself is not in this session's view and leaves no note", async () => {
        const data = mapRoadmap();
        data.meta.links = [...data.meta.links, { id: "ls-t", kind: "informs", from: { sessionId: OTHER_SESSION }, to: { sessionId: OTHER_SESSION } }];
        const v = view(data);
        expect(v.links.some((l) => l.id === "ls-t"), "not in the view").toBe(false);
        const m = await mapModel(v);
        expect(m.notes.some((t) => /itself/.test(t))).toBe(false);
      });

    });

    // Seeded random stores, valid against the store schema: activations and invalidations point only
    // to earlier questions (the server refuses cycles in them), links join any two questions and may
    // form cycles (a link and its reverse, longer loops). Several blocks, several options per question,
    // several activations per child. Every relation must be one edge with its condition, the drawing
    // sound, the model deterministic, and the layout quick.
    function randomStore(seed: number, count: number, blocks: number, density: number): RoadmapData {
      let x = seed >>> 0;
      const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
      const perBlock = Math.ceil(count / blocks);
      const ids = Array.from({ length: count }, (_, i) => `r${i + 1}`);
      const questions: Question[] = ids.map((id, i) => {
        const earlier = ids.slice(Math.max(0, i - 3 * perBlock), i);
        const parents = earlier.length === 0 ? [] : [...new Set(Array.from({ length: Math.floor(rnd() * density) }, () => pick(earlier)))];
        const upstream = earlier.length === 0 || rnd() > 0.3 ? [] : [pick(earlier)];
        const base = storedQuestion(id, {
          order: i,
          number: i + 1,
          title: `Random ${i + 1}`,
          options: opts3,
          blockId: `b${Math.floor(i / perBlock) + 1}`,
          activatedBy: parents.map((p) => ({ parent: sref(p), optionIds: [pick(["a", "b", "c"])] })),
          invalidatedBy: upstream.map((u) => ({ upstream: sref(u) })),
        });
        return base;
      });
      const blockIds = [...new Set(questions.map((qq) => qq.blockId!))];
      const data = roadmapData([
        {
          id: MAP_SESSION,
          title: "Random session",
          createdAt: NOW_ISO,
          status: "active",
          questions,
          blocks: blockIds.map((id, i) => (i < blockIds.length - 1 ? { id, order: i, state: "accepted" as const, openedAt: NOW_ISO, acceptedAt: NOW_ISO, acceptedBy: { kind: "human" as const } } : { id, order: i, state: "open" as const, openedAt: NOW_ISO })),
        },
      ]);
      const seen = new Set<string>();
      const links: Link[] = [];
      for (let k = 0; k < Math.floor(count * density * 0.6); k++) {
        const [a, b] = [pick(ids), pick(ids)];
        if (a === b || seen.has(`${a}>${b}`)) continue;
        seen.add(`${a}>${b}`);
        links.push({ id: `rl-${k}`, kind: rnd() < 0.7 ? "informs" : "supersedes", from: sref(a), to: sref(b) });
        // A two-link cycle now and then.
        if (rnd() < 0.15 && !seen.has(`${b}>${a}`)) {
          seen.add(`${b}>${a}`);
          links.push({ id: `rl-${k}-back`, kind: "informs", from: sref(b), to: sref(a) });
        }
      }
      data.meta.links = links;
      return data;
    }

    for (const [seed, count, blocks, density] of [
      [1, 40, 4, 3],
      [2, 60, 3, 5],
      [3, 119, 5, 4],
      [4, 119, 2, 6],
      [5, 200, 8, 3],
      [6, 400, 16, 2],
    ] as const) {
      it(`random store (seed ${seed}, ${count} questions, ${blocks} blocks, up to ${density} parents): identity, sound drawing, determinism, within a second`, async () => {
        const data = randomStore(seed, count, blocks, density);
        expect(RoadmapDataV2.safeParse(data).success, "a valid store").toBe(true);
        const v = view(data);
        await import(/* @vite-ignore */ layoutPath);
        const t0 = performance.now();
        const m = await mapModel(v);
        const ms = performance.now() - t0;
        expect(m.edges.map(edgeSig).sort()).toEqual(expectedSigs(data));
        expect(drawingProblems(m).slice(0, 5)).toEqual([]);
        expect(canonicalJson(await mapModel(v)), "deterministic").toBe(canonicalJson(m));
        expect(ms, `laid out in ${Math.round(ms)} ms (${m.edges.length} edges)`).toBeLessThan(1000);
      }, 120_000);
    }

    for (const k of [40, 60]) {
      it(`a ${k} × ${k} crossing map (${2 * k} questions) is laid out within two seconds, and the drawing is sound`, async () => {
        const v = view(crossing(k));
        await import(/* @vite-ignore */ layoutPath);
        const t0 = performance.now();
        const m = await mapModel(v);
        const ms = performance.now() - t0;
        expect(ms, `laid out in ${Math.round(ms)} ms (${m.edges.length} edges)`).toBeLessThan(2000);
        expect(drawingProblems(m).slice(0, 5)).toEqual([]);
      }, 120_000);
    }

    // reserveLaneSpace: room added at the bottom of some lanes (for the selected question's condition
    // labels), everything below each grown lane moved down. Read from what a reader relies on: the same
    // edges with the same conditions, each route still orthogonal, connected and from side to side,
    // crossing no node and drawing no false line; lanes still apart and in order; every node inside
    // its own lane; the added room free of nodes and ports; nothing that was apart brought together;
    // the input left unchanged and the result deterministic.
    type Lane = { key: string; y: number; height: number; trackY: number };
    async function reserve(m: Model, extra: Map<string, number>): Promise<Model> {
      const mod: unknown = await import(/* @vite-ignore */ layoutPath);
      const fn: unknown = typeof mod === "object" && mod !== null ? Reflect.get(mod, "reserveLaneSpace") : undefined;
      if (typeof fn !== "function") throw new Error("missing export: map-layout.reserveLaneSpace");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the documented model shape
      return Reflect.apply(fn, undefined, [m, extra]) as Model;
    }
    const num = (v: unknown) => (typeof v === "number" ? v : Number.NaN);
    const lanesOf = (m: Model): Lane[] => m.lanes.map((l) => ({ key: l.key, y: num(Reflect.get(l, "y")), height: num(Reflect.get(l, "height")), trackY: num(Reflect.get(l, "trackY")) }));
    function growthProblems(before: Model, after: Model, extra: Map<string, number>): string[] {
      const out: string[] = [];
      const total = [...extra.values()].reduce((a, b) => a + Math.max(0, b), 0);
      if (after.world.width !== before.world.width) out.push("the world's width changed");
      if (after.world.height !== before.world.height + total) out.push(`world height ${after.world.height}, expected ${before.world.height + total}`);
      // Same edges, same conditions, same shape (segment count and orientation, x unchanged).
      if (canonicalJson(after.edges.map(edgeSig)) !== canonicalJson(before.edges.map(edgeSig))) out.push("the edges changed");
      after.edges.forEach((e, i) => {
        const b = before.edges[i];
        if (e.segments.length !== b.segments.length) out.push(`${edgeSig(e)}: segment count changed`);
        e.segments.forEach((g, j) => {
          const o = b.segments[j];
          if (o === undefined) return;
          if (g.x1 !== o.x1 || g.x2 !== o.x2) out.push(`${edgeSig(e)}: an x moved`);
          if ((g.x1 === g.x2) !== (o.x1 === o.x2)) out.push(`${edgeSig(e)}: a segment changed orientation`);
          if (g.y1 === g.y2 && Math.abs(g.x2 - g.x1) !== Math.abs(o.x2 - o.x1)) out.push(`${edgeSig(e)}: a horizontal run changed length`);
          if (g.x1 === g.x2 && Math.abs(g.y2 - g.y1) < Math.abs(o.y2 - o.y1)) out.push(`${edgeSig(e)}: a vertical run got shorter`);
        });
      });
      // Lanes in order and apart; each grown by its own extra; nodes inside their own lane band.
      const la = lanesOf(after);
      const lb = lanesOf(before);
      la.forEach((l, i) => {
        if (l.height !== lb[i].height + Math.max(0, extra.get(l.key) ?? 0)) out.push(`${l.key}: height ${l.height}`);
        if (i > 0 && l.y < la[i - 1].y + la[i - 1].height) out.push(`${l.key} overlaps ${la[i - 1].key}`);
      });
      for (const n of after.nodes) {
        const lane = la.find((l) => l.key === n.lane);
        if (lane !== undefined && !(n.y >= lane.y && n.y + n.height <= lane.y + lane.height)) out.push(`${n.label} outside its lane`);
      }
      // The added room (the bottom `extra` px of each grown lane) holds no node and no port.
      for (const l of la) {
        const e = Math.max(0, extra.get(l.key) ?? 0);
        if (e === 0) continue;
        const band = { top: l.y + l.height - e, bottom: l.y + l.height };
        for (const n of after.nodes) if (n.x < after.world.width && n.y < band.bottom && n.y + n.height > band.top && n.lane === l.key) out.push(`${n.label} in the room added to ${l.key}`);
      }
      // Monotone: two nodes' vertical order is kept and their distance never shrinks.
      for (let i = 0; i < before.nodes.length; i++) {
        for (let j = i + 1; j < before.nodes.length; j++) {
          const [a, b] = [before.nodes[i], before.nodes[j]];
          const [a2, b2] = [after.nodes.find((n) => n.key === a.key)!, after.nodes.find((n) => n.key === b.key)!];
          if (Math.sign(b2.y - a2.y) !== Math.sign(b.y - a.y) || Math.abs(b2.y - a2.y) < Math.abs(b.y - a.y)) out.push(`${a.label} / ${b.label}: vertical order or distance changed`);
        }
      }
      return [...out, ...drawingProblems(after)];
    }

    const growthCases: Array<[string, () => Promise<Model>]> = [
      ["the 40-question fixture", () => mapModel(view())],
      ["the 5 × 5 crossing map (cross-lane and back links, a lane below)", () => mapModel(view(crossing(5)))],
      ["a random store with cyclic links (seed 3, 119 questions, 5 blocks)", () => mapModel(view(randomStore(3, 119, 5, 4)))],
      [
        "a random store with all but its first and last lanes collapsed (ports)",
        async () => {
          const v = view(randomStore(5, 200, 8, 3));
          const fullModel = await mapModel(v);
          const keys = lanesOf(fullModel).map((l) => l.key);
          return mapModel(v, { collapsed: new Set(keys.slice(1, -1)) });
        },
      ],
    ];
    for (const [name, build] of growthCases) {
      it(`reserving room in several lanes keeps every route, node, port and lane sound: ${name}`, async () => {
        const before = await build();
        const keys = lanesOf(before).map((l) => l.key);
        expect(keys.length, "more than one lane").toBeGreaterThan(1);
        // The first, a middle and the last lane grow by different amounts (the last below everything).
        const extra = new Map([
          [keys[0], 47],
          [keys[Math.floor(keys.length / 2)], 121],
          [keys[keys.length - 1], 30],
        ]);
        const snapshot = canonicalJson(before);
        const after = await reserve(before, extra);
        expect(canonicalJson(before), "the input model is unchanged").toBe(snapshot);
        expect(drawingProblems(before), "the model was sound before").toEqual([]);
        expect(growthProblems(before, after, extra).slice(0, 8)).toEqual([]);
        expect(canonicalJson(await reserve(before, extra)), "deterministic").toBe(canonicalJson(after));
        // Growing a lane by nothing changes nothing.
        expect(canonicalJson(await reserve(before, new Map([[keys[1], 0]])))).toBe(snapshot);
      });
    }

    it("is deterministic and leaves the view unchanged", async () => {
      const v = view(crossing(3));
      const before = canonicalJson(v);
      const [a, b] = [await mapModel(v), await mapModel(v)];
      expect(canonicalJson(a)).toBe(canonicalJson(b));
      expect(canonicalJson(v)).toBe(before);
    });

    for (const [name, lane] of [
      ["the crossing lane collapsed", "lane:b1"],
      ["the second lane collapsed", "lane:b2"],
    ] as const) {
      it(`${name}: every edge between it and a shown node ends at its port with its stored ends; the drawing is sound`, async () => {
        const data = crossing(3);
        const v = view(data);
        const full = await mapModel(v);
        const m = await mapModel(v, { collapsed: new Set([lane]) });
        const laneOf = new Map(full.nodes.map((n) => [n.key, n.lane]));
        type ViaEdge = MapEdge & { via?: { from: string; to: string } };
        const crossingEdges = full.edges.filter((e) => (laneOf.get(e.from) === lane) !== (laneOf.get(e.to) === lane));
        const inside = full.edges.filter((e) => laneOf.get(e.from) === lane && laneOf.get(e.to) === lane);
        const outside = full.edges.filter((e) => laneOf.get(e.from) !== lane && laneOf.get(e.to) !== lane);
        const vias = (m.edges as ViaEdge[]).filter((e) => e.via !== undefined);
        expect(vias.map((e) => `${e.kind}|${e.via!.from}|${e.via!.to}|${(e.optionIds ?? []).slice().sort().join(",")}`).sort(), "each edge to a shown node is kept with its stored ends").toEqual(crossingEdges.map(edgeSig).sort());
        expect((m.edges as ViaEdge[]).filter((e) => e.via === undefined).map(edgeSig).sort(), "edges between shown nodes are unchanged").toEqual(outside.map(edgeSig).sort());
        expect(m.nodes.some((n) => laneOf.get(n.key) === lane), "the collapsed lane's nodes are hidden").toBe(false);
        if (inside.length > 0) expect(m.notes.join(" "), "edges inside the collapsed lane are noted, not drawn").toMatch(/not drawn/);
        const port = m.nodes.find((n) => (n as MapNode & { port?: { lane: string; edges: number } }).port?.lane === lane) as (MapNode & { port?: { lane: string; edges: number } }) | undefined;
        expect(port, "the lane's port").toBeDefined();
        expect(port!.port!.edges, "the port counts its edges").toBe(crossingEdges.length);
        for (const e of vias) expect(e.from === port!.key || e.to === port!.key, `${edgeSig(e)} ends at the port`).toBe(true);
        expect(drawingProblems(m)).toEqual([]);
      });
    }

    // The 40-question fixture's m2 → m5 pair (activation on a, and on a or b): two next-column edges
    // with the same ends but different conditions, which the layout may draw through the track.
    it("the 40-question fixture's two m2 → m5 activations stay two edges with their conditions and sound routes", async () => {
      const m = await mapModel(view());
      const pair = m.edges.filter((e) => e.kind === "activation" && e.from === nodeOfQuestion(m, "m2").key && e.to === nodeOfQuestion(m, "m5").key);
      expect(pair.map((e) => (e.optionIds ?? []).slice().sort().join(",")).sort()).toEqual(["a", "a,b"]);
      expect(drawingProblems({ ...m, edges: pair, nodes: m.nodes }).filter((p) => !p.startsWith("a line") && !p.startsWith("shared"))).toEqual([]);
      expect(drawingProblems(m)).toEqual([]);
    });
  });

  it("does not import React Native or the host", () => {
    let source = "";
    try {
      source = readFileSync(new URL("./map-layout.ts", import.meta.url), "utf8");
    } catch {
      throw new Error("missing module client/map-layout.ts");
    }
    // DeepSeek Flash review 01a1c67a c0035: single quotes, a dynamic import, require and a re-export count too.
    expect(source).not.toMatch(/(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'](?:react-native(?:\/[^"']*)?|@getpaseo\/plugin\/client[^"']*)["']/);
    expect(source).not.toMatch(/@getpaseo\/plugin\/client/);
  });
});
