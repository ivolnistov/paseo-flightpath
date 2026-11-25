// The Map's pure model: lanes, nodes, columns, rows and orthogonal edge routes from the stored
// relations and links of one session view. Nothing is inferred: nodes are this session's questions
// and one stub per other-session end its relations or links name; lanes are its blocks (or one lane
// for a legacy session) and one lane for other sessions; columns are the server's depths.
//
// Geometry reserves space so that no edge can cross a node: between consecutive columns a gutter
// holds every vertical run, and under each lane a track holds every long horizontal run. A
// horizontal run outside a track lies only inside a gutter, at the source's or the target's row.
// Pure: no React Native and no host.
import type { SessionView } from "../shared/rpc";

export const NODE_W = 184;
export const NODE_H = 60;
/** The least gutter width; a gutter grows by SLOT_PITCH per vertical run slot it needs. */
export const GUTTER = 78;
/** The least column pitch (a node and the least gutter). */
export const PITCH = NODE_W + GUTTER;
export const ROW = 72;
export const LANE_PAD = 14;
export const LANE_HEADER = 150;
/** The least height of a lane's routing track; it grows by TRACK_PITCH per slot its runs need. */
export const TRACK = 16;
const TRACK_PITCH = 3;
/** Gutter slots: SLOT_PITCH apart, SLOT_INSET from each gutter edge; vertical runs closer than RUN_GAP count as overlapping. */
const SLOT_PITCH = 4;
const SLOT_INSET = 8;
const RUN_GAP = 4;
export const INTER_LANE = 16;
/** How far below and above a node's centre a self-link leaves and comes back. */
const LOOP = 10;
const MARGIN = 8;

export type MapEdgeKind = "activation" | "invalidation" | "informs" | "supersedes";
export type MapEnd = { sessionId: string; questionId?: string };

export type MapLane = {
  key: string;
  label: string;
  notes?: string[];
  y: number;
  height: number;
  trackY: number;
  /** Collapsed: its nodes are hidden and its edges end at its port. */
  collapsed?: boolean;
  /** Nodes in the lane, collapsed or not. */
  count: number;
};
export type MapNode = {
  key: string;
  lane: string;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  /** A question of this session. */
  questionId?: string;
  /** An other-session end: a question, or a whole session. */
  ref?: MapEnd;
  inactive?: boolean;
  /** A stub whose question no longer exists; it cannot be opened. */
  missing?: boolean;
  /** The port of a collapsed lane: the end of every edge between that lane and a shown node. */
  port?: { lane: string; edges: number };
};
export type Segment = { x1: number; y1: number; x2: number; y2: number };
export type MapEdge = {
  key: string;
  kind: MapEdgeKind;
  from: string;
  to: string;
  optionIds?: string[];
  crossLane: boolean;
  back: boolean;
  segments: Segment[];
  /** For an edge redirected to a collapsed lane's port: its stored ends. */
  via?: { from: string; to: string };
};
export type MapModel = { lanes: MapLane[]; nodes: MapNode[]; edges: MapEdge[]; world: { width: number; height: number }; notes: string[] };

/**
 * The model with `extra` px added at the bottom of the named lanes, below their routing track. Every
 * lane, node, port and route point below a grown lane moves down by the growth above it, so the move is
 * monotone: routes keep their shape (only vertical runs lengthen), nothing that was apart comes
 * together, and the world grows by the total. The model itself is returned when nothing grows.
 */
export function reserveLaneSpace(model: MapModel, extra: ReadonlyMap<string, number>): MapModel {
  const steps: { bottom: number; shift: number }[] = [];
  let total = 0;
  for (const l of model.lanes) {
    const e = Math.max(0, extra.get(l.key) ?? 0);
    if (e === 0) continue;
    total += e;
    steps.push({ bottom: l.y + l.height, shift: total });
  }
  if (total === 0) return model;
  // Lanes are laid top to bottom, so the steps are in order of their bottoms.
  const at = (y: number) => {
    let shift = 0;
    for (const s of steps) {
      if (y <= s.bottom) break;
      shift = s.shift;
    }
    return y + shift;
  };
  return {
    ...model,
    lanes: model.lanes.map((l) => ({ ...l, y: at(l.y), height: l.height + Math.max(0, extra.get(l.key) ?? 0), trackY: at(l.trackY) })),
    nodes: model.nodes.map((n) => ({ ...n, y: at(n.y) })),
    edges: model.edges.map((e) => ({ ...e, segments: e.segments.map((s) => ({ x1: s.x1, y1: at(s.y1), x2: s.x2, y2: at(s.y2) })) })),
    world: { width: model.world.width, height: model.world.height + total },
  };
}

// Lane keys: a block's lane is "lane:<block id>" whatever the id (any non-empty string, "external" and
// "all" included); the two lanes that are not blocks have keys without that prefix, so no block id can
// name them.
/** The lane of other sessions' questions and sessions. */
export const EXTERNAL_LANE = "other-sessions";
/** A legacy session's single lane. */
export const LEGACY_LANE = "all-questions";
/** The lane key of a block, or of a legacy session's single lane. */
export const blockLaneKey = (blockId: string | undefined): string => (blockId === undefined ? LEGACY_LANE : `lane:${blockId}`);
const KIND_ORDER: Record<MapEdgeKind, number> = { activation: 0, invalidation: 1, informs: 2, supersedes: 3 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `collapsed`: lanes drawn as one node row (their header, and their port when an edge reaches them);
 * an edge between one of their nodes and a shown node ends
 * at the lane's port, and an edge between two collapsed nodes is not drawn (the model notes it).
 */
export function mapModel(view: SessionView, opts: { showInactive?: boolean; collapsed?: ReadonlySet<string> } = {}): MapModel {
  const showInactive = opts.showInactive ?? true;
  const sid = view.session.id;
  const shown = view.questions.filter((qv) => showInactive || qv.visibility === "active");
  const shownIds = new Set(shown.map((qv) => qv.question.id));
  const allIds = new Map(view.questions.map((qv) => [qv.question.id, qv]));
  const notes: string[] = [];

  // ---- Lanes: the blocks in order, or one lane for a legacy session ----
  const blocks = view.session.blocks !== undefined ? [...view.session.blocks].sort((a, b) => a.order - b.order) : undefined;
  // A question without a block in a session with blocks is not stored by the server; its key names no block.
  const laneOfQuestion = (blockId: string | undefined) => (blocks === undefined ? LEGACY_LANE : blockId === undefined ? "no-block" : blockLaneKey(blockId));
  const questions = (n: number) => `${n} ${n === 1 ? "question" : "questions"}`;
  const laneDefs: Array<{ key: string; label: string; notes: string[] }> =
    blocks === undefined
      ? [{ key: LEGACY_LANE, label: `All questions · ${questions(shown.length)}`, notes: [] }]
      : blocks.map((b) => ({ key: blockLaneKey(b.id), label: `Block ${b.order + 1} · ${b.state} · ${questions(shown.filter((qv) => qv.question.blockId === b.id).length)}`, notes: [] }));

  // ---- Endpoints ----
  const nodes = new Map<string, MapNode>();
  const localKey = (id: string) => `q:${id}`;
  const stubKey = (end: MapEnd) => (end.questionId !== undefined ? `x:${end.sessionId}/${end.questionId}` : `s:${end.sessionId}`);
  const isLocal = (end: MapEnd): end is { sessionId: string; questionId: string } => end.sessionId === sid && end.questionId !== undefined && allIds.has(end.questionId);
  const stubLabel = (end: MapEnd): { label: string; missing: boolean } => {
    if (end.questionId !== undefined) {
      const entry = end.sessionId === sid ? undefined : view.catalog.find((c) => c.ref.sessionId === end.sessionId && c.ref.questionId === end.questionId);
      return entry !== undefined ? { label: `${entry.sessionTitle} / ${entry.questionTitle}`, missing: false } : { label: "a question that no longer exists", missing: true };
    }
    const title = view.catalog.find((c) => c.ref.sessionId === end.sessionId)?.sessionTitle;
    return { label: title !== undefined ? `session ${title}` : `session ${end.sessionId} (title unavailable)`, missing: false };
  };
  /** The node key of an end, creating its stub; null for a hidden local question. */
  const endpoint = (end: MapEnd): string | null => {
    if (isLocal(end)) return shownIds.has(end.questionId) ? localKey(end.questionId) : null;
    const key = stubKey(end);
    if (!nodes.has(key)) {
      const { label, missing } = stubLabel(end);
      nodes.set(key, { key, lane: EXTERNAL_LANE, column: 0, x: 0, y: 0, width: NODE_W, height: NODE_H, label, ref: { ...end }, ...(missing ? { missing: true } : {}) });
    }
    return key;
  };

  // ---- Local nodes at the server's depth (never shallower than a local parent's column + 1) ----
  const column = new Map<string, number>();
  const parentIds = (id: string) => {
    const q = allIds.get(id)?.question;
    if (q === undefined) return [];
    return [...q.activatedBy.map((a) => a.parent), ...q.invalidatedBy.map((i) => i.upstream)].filter((r) => r.sessionId === sid && allIds.has(r.questionId)).map((r) => r.questionId);
  };
  const visiting = new Set<string>();
  const colOf = (id: string): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    // Relations form a DAG by server invariant; a cycle in a malformed view stops at the depth.
    if (visiting.has(id)) return allIds.get(id)?.depth ?? 0;
    visiting.add(id);
    let c = allIds.get(id)?.depth ?? 0;
    for (const p of parentIds(id)) c = Math.max(c, colOf(p) + 1);
    visiting.delete(id);
    column.set(id, c);
    return c;
  };
  for (const qv of shown) {
    const key = localKey(qv.question.id);
    nodes.set(key, {
      key,
      lane: laneOfQuestion(qv.question.blockId),
      column: colOf(qv.question.id),
      x: 0,
      y: 0,
      width: NODE_W,
      height: NODE_H,
      label: `Q${qv.number} ${qv.question.title}`,
      questionId: qv.question.id,
      ...(qv.visibility === "inactive" ? { inactive: true } : {}),
    });
  }

  // ---- Edges: one per stored relation or link touching this session; exact duplicates collapse ----
  type Raw = { kind: MapEdgeKind; from: string; to: string; optionIds?: string[] };
  const raw = new Map<string, Raw>();
  const add = (e: Raw) => {
    const sig = `${e.kind}|${e.from}|${e.to}|${(e.optionIds ?? []).join(",")}`;
    if (!raw.has(sig)) raw.set(sig, e);
  };
  for (const qv of shown) {
    const to = localKey(qv.question.id);
    for (const a of qv.question.activatedBy) {
      const from = endpoint(a.parent);
      if (from !== null) add({ kind: "activation", from, to, optionIds: [...a.optionIds].sort() });
    }
    for (const i of qv.question.invalidatedBy) {
      const from = endpoint(i.upstream);
      if (from !== null) add({ kind: "invalidation", from, to });
    }
  }
  const laneNote = (lane: string, text: string) => {
    const def = lane === EXTERNAL_LANE ? undefined : laneDefs.find((l) => l.key === lane);
    if (def !== undefined) def.notes.push(text);
    else externalNotes.push(text);
  };
  const externalNotes: string[] = [];
  for (const l of view.links) {
    const from: MapEnd = l.from;
    const to: MapEnd = l.to;
    const verb = l.kind === "informs" ? "Informs" : "Supersedes";
    // A bare end naming this session is a note on the other end's lane, never a node.
    const selfFrom = from.sessionId === sid && from.questionId === undefined;
    const selfTo = to.sessionId === sid && to.questionId === undefined;
    // A link from this session to itself names no question and no other session: it is a note on the
    // whole map, not on a lane or the "Other sessions" lane.
    if (selfFrom && selfTo) {
      const note = `This session ${l.kind === "informs" ? "informs" : "supersedes"} itself (a stored session link).`;
      if (!notes.includes(note)) notes.push(note);
      continue;
    }
    if (selfFrom || selfTo) {
      const other = selfTo ? from : to;
      if (isLocal(other) && !shownIds.has(other.questionId)) continue;
      const otherLabel = isLocal(other) ? (nodes.get(localKey(other.questionId))?.label ?? other.questionId) : stubLabel(other).label;
      const lane = isLocal(other) ? (nodes.get(localKey(other.questionId))?.lane ?? EXTERNAL_LANE) : EXTERNAL_LANE;
      laneNote(lane, selfTo ? `${verb} this session: ${otherLabel}` : `${l.kind === "informs" ? "Informed by" : "Superseded by"} this session: ${otherLabel}`);
      continue;
    }
    if (!isLocal(from) && !isLocal(to)) continue;
    // A link to a hidden question is hidden with it, and creates no stub on its own.
    if ((isLocal(from) && !shownIds.has(from.questionId)) || (isLocal(to) && !shownIds.has(to.questionId))) continue;
    const f = endpoint(from);
    const t = endpoint(to);
    if (f !== null && t !== null) add({ kind: l.kind, from: f, to: t });
  }

  // ---- Stub columns: a source sits before its earliest local target, a target-only stub after its latest local source ----
  const rawEdges = [...raw.values()];
  for (const stub of [...nodes.values()].filter((n) => n.questionId === undefined)) {
    const targets = rawEdges.filter((e) => e.from === stub.key && nodes.get(e.to)?.questionId !== undefined).map((e) => nodes.get(e.to)!.column);
    const sources = rawEdges.filter((e) => e.to === stub.key && nodes.get(e.from)?.questionId !== undefined).map((e) => nodes.get(e.from)!.column);
    stub.column = targets.length > 0 ? Math.max(0, Math.min(...targets) - 1) : sources.length > 0 ? Math.max(...sources) + 1 : 0;
  }
  if ([...nodes.values()].some((n) => n.lane === EXTERNAL_LANE)) {
    laneDefs.push({ key: EXTERNAL_LANE, label: "Other sessions", notes: externalNotes });
    notes.push("Relations among other sessions are not shown here: only relations and links with an end in this session are stored in its view.");
  } else if (externalNotes.length > 0) {
    laneDefs.push({ key: EXTERNAL_LANE, label: "Other sessions", notes: externalNotes });
  }

  // ---- Collapse: a collapsed lane's nodes leave the graph; their edges to shown nodes end at its port ----
  const laneCount = new Map<string, number>();
  for (const n of nodes.values()) laneCount.set(n.lane, (laneCount.get(n.lane) ?? 0) + 1);
  const collapsed = new Set([...(opts.collapsed ?? [])].filter((k) => laneDefs.some((d) => d.key === k)));
  let routed: Array<Raw & { via?: { from: string; to: string } }> = rawEdges;
  if (collapsed.size > 0) {
    const hidden = (key: string) => collapsed.has(nodes.get(key)!.lane);
    const portKey = (lane: string) => `port:${lane}`;
    const portEdges = new Map<string, number>();
    let between = 0;
    routed = [];
    for (const e of rawEdges) {
      const fh = hidden(e.from);
      const th = hidden(e.to);
      if (fh && th) {
        between++;
        continue;
      }
      if (!fh && !th) {
        routed.push(e);
        continue;
      }
      const lane = nodes.get(fh ? e.from : e.to)!.lane;
      portEdges.set(lane, (portEdges.get(lane) ?? 0) + 1);
      routed.push({ ...e, from: fh ? portKey(lane) : e.from, to: th ? portKey(lane) : e.to, via: { from: e.from, to: e.to } });
    }
    for (const n of [...nodes.values()]) if (collapsed.has(n.lane)) nodes.delete(n.key);
    for (const [lane, count] of portEdges) {
      const name = (laneDefs.find((d) => d.key === lane)?.label ?? lane).split(" · ")[0];
      const key = portKey(lane);
      const targets = routed.filter((e) => e.from === key).map((e) => nodes.get(e.to)!.column);
      const sources = routed.filter((e) => e.to === key).map((e) => nodes.get(e.from)!.column);
      const column = targets.length > 0 ? Math.max(0, Math.min(...targets) - 1) : Math.max(...sources) + 1;
      nodes.set(key, { key, lane, column, x: 0, y: 0, width: NODE_W, height: NODE_H, label: `→ ${name} (${count} ${count === 1 ? "edge" : "edges"})`, port: { lane, edges: count } });
    }
    if (between > 0) notes.push(`${between} ${between === 1 ? "edge" : "edges"} between collapsed lanes are not drawn; expand a lane to see them.`);
  }

  // ---- Route shapes: which gutters and track each edge uses, before any coordinate is known ----
  const all = [...nodes.values()];
  const maxCol = all.reduce((m, n) => Math.max(m, n.column), 0);
  const sorted = [...routed].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      cmp(a.from, b.from) ||
      cmp(a.to, b.to) ||
      cmp((a.optionIds ?? []).join(","), (b.optionIds ?? []).join(",")) ||
      cmp(a.via?.from ?? "", b.via?.from ?? "") ||
      cmp(a.via?.to ?? "", b.via?.to ?? ""),
  );
  // An edge to the next column runs in the gutter between them; any other runs down the gutter after
  // its source into the target lane's track, along it, and up the gutter before (or, for a back edge,
  // after) its target. A next-column edge may also be sent through the track (below).
  type Shape = { e: (typeof sorted)[number]; f: MapNode; t: MapNode; back: boolean; direct: boolean; g1: number; g2: number };
  const shapes: Shape[] = sorted.map((e) => {
    const f = nodes.get(e.from)!;
    const t = nodes.get(e.to)!;
    const back = t.column <= f.column;
    const direct = !back && t.column === f.column + 1;
    return { e, f, t, back, direct, g1: direct ? t.column : f.column + 1, g2: direct ? t.column : back ? t.column + 1 : t.column };
  });
  const trackSlots = () => assignSlots(
    shapes.filter((x) => !x.direct),
    (x) => x.t.lane,
    (x) => [Math.min(x.g1, x.g2), Math.max(x.g1, x.g2)],
    0,
  );

  // ---- Lanes and rows ----
  const rowsOf = (lane: string) => {
    const counts = new Map<number, number>();
    for (const n of all) if (n.lane === lane) counts.set(n.column, (counts.get(n.column) ?? 0) + 1);
    return Math.max(1, ...counts.values());
  };
  const layLanes = (slots: ReturnType<typeof trackSlots>): MapLane[] => {
    const out: MapLane[] = [];
    let top = 0;
    for (const def of laneDefs) {
      const content = rowsOf(def.key) * ROW - (ROW - NODE_H);
      const track = Math.max(TRACK, 4 + (slots.count.get(def.key) ?? 0) * TRACK_PITCH);
      out.push({
        key: def.key,
        label: def.label,
        ...(def.notes.length > 0 ? { notes: def.notes } : {}),
        y: top,
        height: LANE_PAD + content + LANE_PAD + track,
        trackY: top + LANE_PAD + content + LANE_PAD,
        ...(collapsed.has(def.key) ? { collapsed: true } : {}),
        count: laneCount.get(def.key) ?? 0,
      });
      top += LANE_PAD + content + LANE_PAD + track + INTER_LANE;
    }
    return out;
  };
  // Rows are ordered once, on the provisional lanes; a later change of track heights moves lanes but
  // keeps every node's row.
  const rowOf = new Map<string, number>();
  {
    const provisional = new Map(layLanes(trackSlots()).map((l) => [l.key, l]));
    const orderOf = (n: MapNode) => (n.questionId !== undefined ? (allIds.get(n.questionId)?.question.order ?? 0) : Number.MAX_SAFE_INTEGER);
    const placed = new Set<string>();
    for (let c = 0; c <= maxCol; c++) {
      for (const def of laneDefs) {
        const group = all.filter((n) => n.lane === def.key && n.column === c);
        const bary = new Map<string, number | null>();
        for (const n of group) {
          const ys = routed.filter((e) => e.to === n.key && placed.has(e.from)).map((e) => nodes.get(e.from)!.y + NODE_H / 2);
          bary.set(n.key, ys.length > 0 ? ys.reduce((sum, y) => sum + y, 0) / ys.length : null);
        }
        group.sort((a, b) => {
          const ba = bary.get(a.key) ?? null;
          const bb = bary.get(b.key) ?? null;
          if (ba !== null && bb !== null && ba !== bb) return ba - bb;
          if ((ba === null) !== (bb === null)) return ba === null ? 1 : -1;
          return orderOf(a) - orderOf(b) || cmp(a.key, b.key);
        });
        group.forEach((n, row) => {
          rowOf.set(n.key, row);
          n.y = provisional.get(def.key)!.y + LANE_PAD + row * ROW;
        });
        for (const n of group) placed.add(n.key);
      }
    }
  }
  const rowKey = (n: MapNode) => `${n.lane}#${rowOf.get(n.key) ?? 0}`;

  // ---- Gutter runs and their left-to-right order ----
  // A run's stub on a row meets the node on its left (an exit, or a back edge entering from the
  // right: side L) or the node on its right (an entry: side R). On one row, every L stub must end
  // left of every R stub of another edge, or the two stubs overlap and draw a line between two nodes
  // that no edge joins. Runs with only L stubs go leftmost and runs with only R stubs rightmost. A
  // next-column edge has both, from its source's row to its target's: on a row, the edges leaving it
  // must lie left of the edges entering it. That order exists exactly when these edges, read as arcs
  // between rows, form no cycle; the arcs a feedback-arc-set pass picks are routed through the target
  // lane's track instead, and the rest are ordered by their source row's rank, highest first.
  type End = { row: string; side: "L" | "R" };
  type Run = { shape: Shape; gutter: number; part: 0 | 1; ends: End[]; lo: number; hi: number };
  const runsFor = (x: Shape): Run[] => {
    if (x.direct) return rowKey(x.f) === rowKey(x.t) ? [] : [{ shape: x, gutter: x.g1, part: 0, ends: [{ row: rowKey(x.f), side: "L" }, { row: rowKey(x.t), side: "R" }], lo: 0, hi: 0 }];
    return [
      { shape: x, gutter: x.g1, part: 0, ends: [{ row: rowKey(x.f), side: "L" }], lo: 0, hi: 0 },
      { shape: x, gutter: x.g2, part: 1, ends: [{ row: rowKey(x.t), side: x.back ? "L" : "R" }], lo: 0, hi: 0 },
    ];
  };
  const rowRank = new Map<number, Map<string, number>>();
  for (let g = 0; g <= maxCol + 1; g++) {
    const arcs = shapes.filter((x) => x.direct && x.g1 === g && rowKey(x.f) !== rowKey(x.t));
    const rank = rankRows(arcs.map((x) => [rowKey(x.f), rowKey(x.t)]));
    for (const x of arcs) if (rank.get(rowKey(x.f))! > rank.get(rowKey(x.t))!) x.direct = false;
    rowRank.set(g, rank);
  }
  const gutterOrder = new Map<number, Run[]>();
  const gutterRuns = new Map<number, Run[]>();
  for (const x of shapes) for (const r of runsFor(x)) gutterRuns.set(r.gutter, [...(gutterRuns.get(r.gutter) ?? []), r]);
  for (const [g, runs] of gutterRuns) {
    const rank = rowRank.get(g) ?? new Map<string, number>();
    const leftOnly = runs.filter((r) => r.ends.every((e) => e.side === "L"));
    const rightOnly = runs.filter((r) => r.ends.every((e) => e.side === "R"));
    const both = runs
      .filter((r) => r.ends.some((e) => e.side === "L") && r.ends.some((e) => e.side === "R"))
      .map((r, i) => ({ r, i, k: rank.get(r.ends.find((e) => e.side === "L")!.row) ?? 0 }))
      .sort((a, b) => b.k - a.k || a.i - b.i)
      .map((x) => x.r);
    gutterOrder.set(g, [...leftOnly, ...both, ...rightOnly]);
  }

  // ---- Final lanes and rows ----
  const trackSlot = trackSlots();
  const lanes = layLanes(trackSlot);
  const laneByKey = new Map(lanes.map((l) => [l.key, l]));
  for (const n of all) n.y = laneByKey.get(n.lane)!.y + LANE_PAD + (rowOf.get(n.key) ?? 0) * ROW;
  const worldHeight = lanes.reduce((h, l) => Math.max(h, l.y + l.height), 0) + MARGIN;
  const trackYOf = (x: Shape) => laneByKey.get(x.t.lane)!.trackY + 3 + (trackSlot.slot.get(x) ?? 0) * TRACK_PITCH;

  // ---- Gutter slots: in each gutter's order, a run takes the lowest slot right of every L stub on the
  // rows of its R stubs whose runs lie apart from it (spans further than RUN_GAP apart) ----
  const centre = (n: MapNode) => n.y + n.height / 2;
  // A self-link leaves its node's right side below the centre and comes back above it, so its way out
  // and its way back are apart and the loop nests inside itself; every other edge meets the centre.
  const exitY = (x: Shape) => centre(x.f) + (x.f === x.t ? LOOP : 0);
  const entryY = (x: Shape) => centre(x.t) - (x.f === x.t ? LOOP : 0);
  const gutterSlot = new Map<Run, number>();
  const slotCount = new Map<number, number>();
  const runsOfShape = new Map<Shape, Run[]>();
  for (const [g, order] of gutterOrder) {
    const slots: Array<Array<[number, number]>> = [];
    // The highest slot taken so far by an L stub on each row: an R stub on that row goes right of it.
    const leftOn = new Map<string, number>();
    for (const r of order) {
      const x = r.shape;
      const [a, b] = x.direct ? [centre(x.f), centre(x.t)] : r.part === 0 ? [exitY(x), trackYOf(x)] : [trackYOf(x), entryY(x)];
      r.lo = Math.min(a, b);
      r.hi = Math.max(a, b);
      const least = Math.max(0, ...r.ends.filter((e) => e.side === "R").map((e) => (leftOn.get(e.row) ?? -1) + 1));
      let k = least;
      while (k < slots.length && !slots[k].every(([lo, hi]) => r.lo > hi + RUN_GAP || lo > r.hi + RUN_GAP)) k++;
      while (slots.length <= k) slots.push([]);
      slots[k].push([r.lo, r.hi]);
      gutterSlot.set(r, k);
      for (const e of r.ends) if (e.side === "L") leftOn.set(e.row, Math.max(leftOn.get(e.row) ?? -1, k));
      runsOfShape.set(x, [...(runsOfShape.get(x) ?? []), r]);
    }
    slotCount.set(g, slots.length);
  }
  // A gutter is as wide as its slots need, never narrower than GUTTER; columns follow from the widths.
  const gutterWidth = (g: number) => Math.max(GUTTER, 2 * SLOT_INSET + (slotCount.get(g) ?? 0) * SLOT_PITCH);
  const gutterLeft: number[] = [];
  let x0 = LANE_HEADER;
  for (let g = 0; g <= maxCol + 1; g++) {
    gutterLeft.push(x0);
    x0 += gutterWidth(g) + NODE_W;
  }
  const colX = (c: number) => gutterLeft[c] + gutterWidth(c);
  const worldWidth = gutterLeft[maxCol + 1] + gutterWidth(maxCol + 1) + MARGIN;
  for (const n of all) n.x = colX(n.column);
  const slotX = (r: Run | undefined, g: number) => gutterLeft[g] + SLOT_INSET + (r !== undefined ? (gutterSlot.get(r) ?? 0) : 0) * SLOT_PITCH;

  // ---- Routes ----
  const edges: MapEdge[] = shapes.map((x) => {
    const { e, f, t, back } = x;
    const sy = exitY(x);
    const ty = entryY(x);
    const runs = runsOfShape.get(x) ?? [];
    const points: Array<[number, number]> = [[f.x + f.width, sy]];
    if (x.direct) {
      // A next-column edge between two nodes on one row is one straight line.
      const gx = slotX(runs[0], x.g1);
      points.push([gx, sy], [gx, ty], [t.x, ty]);
    } else {
      const gx1 = slotX(runs.find((r) => r.part === 0), x.g1);
      const gx2 = slotX(runs.find((r) => r.part === 1), x.g2);
      const track = trackYOf(x);
      points.push([gx1, sy], [gx1, track], [gx2, track], [gx2, ty], [back ? t.x + t.width : t.x, ty]);
    }
    return {
      key: `${e.kind}|${e.from}|${e.to}|${(e.optionIds ?? []).join(",")}${e.via !== undefined ? `|via:${e.via.from}>${e.via.to}` : ""}`,
      kind: e.kind,
      from: e.from,
      to: e.to,
      ...(e.optionIds !== undefined ? { optionIds: e.optionIds } : {}),
      crossLane: f.lane !== t.lane,
      back,
      segments: toSegments(points),
      ...(e.via !== undefined ? { via: e.via } : {}),
    };
  });

  const nodeList = lanes.flatMap((lane) => all.filter((n) => n.lane === lane.key).sort((a, b) => a.column - b.column || a.y - b.y));
  return { lanes, nodes: nodeList, edges, world: { width: worldWidth, height: worldHeight }, notes };
}

/**
 * A rank for each row such that few arcs run from a higher rank to a lower one (none when the arcs form
 * no cycle): the greedy feedback-arc-set order of Eades, Lin and Smyth. Sinks go to the end, sources to
 * the front, and otherwise the row with the most outgoing over incoming arcs goes to the front; ties go
 * by key, so the result is deterministic. Parallel arcs count once each.
 */
function rankRows(arcs: Array<[string, string]>): Map<string, number> {
  const out = new Map<string, Map<string, number>>();
  const inc = new Map<string, Map<string, number>>();
  const add = (m: Map<string, Map<string, number>>, a: string, b: string) => {
    const row = m.get(a) ?? new Map<string, number>();
    row.set(b, (row.get(b) ?? 0) + 1);
    m.set(a, row);
  };
  const rows = new Set<string>();
  for (const [a, b] of arcs) {
    rows.add(a);
    rows.add(b);
    add(out, a, b);
    add(inc, b, a);
  }
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const r of rows) {
    outDeg.set(r, [...(out.get(r)?.values() ?? [])].reduce((sum, n) => sum + n, 0));
    inDeg.set(r, [...(inc.get(r)?.values() ?? [])].reduce((sum, n) => sum + n, 0));
  }
  const left = new Set([...rows].sort(cmp));
  const front: string[] = [];
  const back: string[] = [];
  const remove = (r: string) => {
    left.delete(r);
    for (const [b, n] of out.get(r) ?? []) if (left.has(b)) inDeg.set(b, inDeg.get(b)! - n);
    for (const [a, n] of inc.get(r) ?? []) if (left.has(a)) outDeg.set(a, outDeg.get(a)! - n);
  };
  while (left.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of left) {
        if (outDeg.get(r) === 0) {
          back.unshift(r);
          remove(r);
          changed = true;
        } else if (inDeg.get(r) === 0) {
          front.push(r);
          remove(r);
          changed = true;
        }
      }
    }
    if (left.size === 0) break;
    let best: string | null = null;
    for (const r of left) if (best === null || outDeg.get(r)! - inDeg.get(r)! > outDeg.get(best)! - inDeg.get(best)!) best = r;
    front.push(best!);
    remove(best!);
  }
  return new Map([...front, ...back].map((r, i) => [r, i]));
}

/**
 * Interval slots: within each group, items are taken in the given order and each gets the lowest slot
 * whose items all lie apart from it (spans further than `gap` apart). Deterministic for one order.
 */
function assignSlots<T>(items: T[], group: (t: T) => string | number, span: (t: T) => [number, number], gap: number): { slot: Map<T, number>; count: Map<string | number, number> } {
  const slot = new Map<T, number>();
  const count = new Map<string | number, number>();
  const taken = new Map<string | number, Array<Array<[number, number]>>>();
  for (const item of items) {
    const g = group(item);
    const [lo, hi] = span(item);
    const slots = taken.get(g) ?? [];
    let k = slots.findIndex((spans) => spans.every(([a, b]) => lo > b + gap || a > hi + gap));
    if (k < 0) {
      k = slots.length;
      slots.push([]);
    }
    slots[k].push([lo, hi]);
    taken.set(g, slots);
    slot.set(item, k);
    count.set(g, slots.length);
  }
  return { slot, count };
}

/** Consecutive points as segments, without zero-length ones; collinear runs stay connected. */
function toSegments(points: Array<[number, number]>): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (x1 !== x2 || y1 !== y2) out.push({ x1, y1, x2, y2 });
  }
  return out;
}
