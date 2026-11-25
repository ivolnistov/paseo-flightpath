import type { ExpandedGraph } from "../shared/workflow";

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 88;
export const COLUMN_GAP = 88;
export const ROW_GAP = 36;
export const PADDING = 28;
/** Space around a group's members, and above them for the group label. */
export const GROUP_PAD = 10;
export const GROUP_LABEL = 18;
/** Distance between parallel routes that share a lane. */
export const LANE_STEP = 8;

export type Point = { x: number; y: number };
export type LayoutNode = { id: string; x: number; y: number; layer: number };
export type LayoutRoute = { from: string; to: string; kind: "needs" | "rework"; points: Point[] };
export type LayoutGroup = { id: string; kind: "tasks" | "matrix"; x: number; y: number; width: number; height: number; pending: boolean };
export type GraphLayout = { nodes: LayoutNode[]; routes: LayoutRoute[]; groups: LayoutGroup[]; width: number; height: number };

/** Longest-path layering over the graph's edges; the graph is acyclic. */
export function layersOf(graph: ExpandedGraph): Map<string, number> {
  const ids = new Set(graph.jobs.map((job) => job.id));
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }
  const layers = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    const known = layers.get(id);
    if (known !== undefined) return known;
    if (stack.has(id)) return 0;
    stack.add(id);
    let layer = 0;
    for (const from of incoming.get(id) ?? []) layer = Math.max(layer, visit(from, stack) + 1);
    stack.delete(id);
    layers.set(id, layer);
    return layer;
  };
  for (const job of graph.jobs) visit(job.id, new Set());
  return layers;
}

/**
 * Places jobs in dependency layers (columns) and routes every edge orthogonally through the gaps
 * between columns. An edge between adjacent layers bends in the gap between them; a longer edge
 * climbs to a lane above every node, so no route crosses a node. Rework routes run in lanes below
 * every node. Members of one group stay adjacent within a column.
 */
export function layoutGraph(graph: ExpandedGraph): GraphLayout {
  const layers = layersOf(graph);
  const groupOf = new Map<string, string>();
  for (const group of graph.groups) for (const id of group.jobIds) groupOf.set(id, group.id);
  const position = new Map(graph.jobs.map((job, index) => [job.id, index]));
  const firstOfGroup = new Map<string, number>();
  for (const job of graph.jobs) {
    const key = groupOf.get(job.id) ?? job.id;
    if (!firstOfGroup.has(key)) firstOfGroup.set(key, position.get(job.id) ?? 0);
  }
  const columns: string[][] = [];
  for (const job of graph.jobs) (columns[layers.get(job.id) ?? 0] ??= []).push(job.id);
  for (const column of columns) {
    if (!column) continue;
    column.sort((a, b) => {
      const ga = firstOfGroup.get(groupOf.get(a) ?? a) ?? 0;
      const gb = firstOfGroup.get(groupOf.get(b) ?? b) ?? 0;
      return ga - gb || (position.get(a) ?? 0) - (position.get(b) ?? 0);
    });
  }

  const longEdges = graph.edges.filter((edge) => (layers.get(edge.to) ?? 0) - (layers.get(edge.from) ?? 0) > 1);
  const topLanes = longEdges.length;
  const top = PADDING + topLanes * LANE_STEP + GROUP_PAD + GROUP_LABEL;
  const nodes: LayoutNode[] = [];
  const byId = new Map<string, LayoutNode>();
  columns.forEach((column, layer) => {
    let y = top;
    let previousGroup: string | null = null;
    (column ?? []).forEach((id, row) => {
      const group = groupOf.get(id) ?? null;
      // A change of group in a column leaves room for both group frames and the next label.
      if (row > 0 && group !== previousGroup) y += 2 * GROUP_PAD + GROUP_LABEL;
      const node = { id, layer, x: PADDING + layer * (NODE_WIDTH + COLUMN_GAP), y };
      nodes.push(node);
      byId.set(id, node);
      y += NODE_HEIGHT + ROW_GAP;
      previousGroup = group;
    });
  });
  const nodesBottom = Math.max(top + NODE_HEIGHT, ...nodes.map((node) => node.y + NODE_HEIGHT));
  const columnCount = Math.max(1, columns.length);

  const routes: LayoutRoute[] = [];
  let lane = 0;
  for (const edge of graph.edges) {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) continue;
    const sy = source.y + NODE_HEIGHT / 2;
    const ty = target.y + NODE_HEIGHT / 2;
    const sx = source.x + NODE_WIDTH;
    const tx = target.x;
    if (target.layer - source.layer <= 1) {
      const bend = sx + COLUMN_GAP / 2;
      routes.push({ from: edge.from, to: edge.to, kind: "needs", points: compact([{ x: sx, y: sy }, { x: bend, y: sy }, { x: bend, y: ty }, { x: tx, y: ty }]) });
      continue;
    }
    lane += 1;
    const laneY = PADDING + (topLanes - lane) * LANE_STEP;
    const out = sx + COLUMN_GAP / 2 - LANE_STEP / 2;
    const into = tx - COLUMN_GAP / 2 + LANE_STEP / 2;
    routes.push({
      from: edge.from,
      to: edge.to,
      kind: "needs",
      points: compact([{ x: sx, y: sy }, { x: out, y: sy }, { x: out, y: laneY }, { x: into, y: laneY }, { x: into, y: ty }, { x: tx, y: ty }]),
    });
  }

  let reworkLane = 0;
  for (const rework of graph.reworks) {
    // A rework names workflow job ids; draw it between the first expanded node of each.
    const from = nodeFor(graph, byId, rework.from);
    const to = nodeFor(graph, byId, rework.to);
    if (!from || !to) continue;
    reworkLane += 1;
    const laneY = nodesBottom + GROUP_PAD + reworkLane * (LANE_STEP + 4);
    const out = from.x + NODE_WIDTH + COLUMN_GAP / 2 + LANE_STEP / 2;
    const into = to.x - COLUMN_GAP / 2 - LANE_STEP / 2;
    const fy = from.y + (NODE_HEIGHT * 3) / 4;
    const ty = to.y + (NODE_HEIGHT * 3) / 4;
    routes.push({
      from: from.id,
      to: to.id,
      kind: "rework",
      points: compact([{ x: from.x + NODE_WIDTH, y: fy }, { x: out, y: fy }, { x: out, y: laneY }, { x: into, y: laneY }, { x: into, y: ty }, { x: to.x, y: ty }]),
    });
  }

  const groups: LayoutGroup[] = [];
  const framed = new Set<string>();
  for (const group of graph.groups) {
    const members = group.jobIds.flatMap((id) => {
      const node = byId.get(id);
      return node ? [node] : [];
    });
    if (members.length === 0) continue;
    framed.add(group.id);
    groups.push({ id: group.id, kind: group.kind, pending: false, ...frame(members) });
  }
  // A dynamic matrix that has not expanded yet is one node drawn as a pending group.
  for (const job of graph.jobs) {
    if (!job.matrix || job.matrixIndex !== undefined || framed.has(job.id)) continue;
    const node = byId.get(job.id);
    if (node) groups.push({ id: job.id, kind: "matrix", pending: true, ...frame([node]) });
  }

  return {
    nodes,
    routes,
    groups,
    width: PADDING * 2 + columnCount * (NODE_WIDTH + COLUMN_GAP),
    height: nodesBottom + GROUP_PAD + reworkLane * (LANE_STEP + 4) + PADDING,
  };
}

function nodeFor(graph: ExpandedGraph, byId: ReadonlyMap<string, LayoutNode>, jobId: string): LayoutNode | undefined {
  const direct = byId.get(jobId);
  if (direct) return direct;
  const member = graph.jobs.find((job) => job.sourceJobId === jobId && byId.has(job.id));
  return member ? byId.get(member.id) : undefined;
}

function frame(members: readonly LayoutNode[]): { x: number; y: number; width: number; height: number } {
  const left = Math.min(...members.map((node) => node.x)) - GROUP_PAD;
  const topY = Math.min(...members.map((node) => node.y)) - GROUP_PAD - GROUP_LABEL;
  const right = Math.max(...members.map((node) => node.x + NODE_WIDTH)) + GROUP_PAD;
  const bottom = Math.max(...members.map((node) => node.y + NODE_HEIGHT)) + GROUP_PAD;
  return { x: left, y: topY, width: right - left, height: bottom - topY };
}

/** Drops repeated points and points in the middle of a straight run. */
function compact(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    const before = out[out.length - 2];
    if (before && last && ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))) out.pop();
    out.push(point);
  }
  return out;
}

/** True when the axis-aligned segment a–b passes through the inside of the box. */
export function segmentCrossesBox(a: Point, b: Point, box: { x: number; y: number; width: number; height: number }): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return maxX > box.x && minX < box.x + box.width && maxY > box.y && minY < box.y + box.height;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
const ZOOM_STEP = 1.25;

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** The largest zoom at which the whole diagram fits the viewport on both axes, at most the maximum. */
export function fitZoom(size: { width: number; height: number }, viewport: { width: number; height: number }): number {
  if (size.width <= 0 || size.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  const scale = Math.min(viewport.width / size.width, viewport.height / size.height, MAX_ZOOM);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** One zoom step, landing on 100% when a step crosses it. Below the manual minimum only zooming in moves. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  if (scale < MIN_ZOOM) return direction > 0 ? Math.min(scale * ZOOM_STEP, MIN_ZOOM) : scale;
  const next = direction > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP;
  const crossesOne = (scale < 1 && next > 1) || (scale > 1 && next < 1);
  return clampZoom(crossesOne ? 1 : next);
}
