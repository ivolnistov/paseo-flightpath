import { describe, expect, it } from "vitest";
import type { ExpandedGraph } from "../shared/workflow";
import { fitZoom, layoutGraph, MAX_ZOOM, MIN_ZOOM, NODE_HEIGHT, NODE_WIDTH, segmentCrossesBox, stepZoom, type GraphLayout } from "./graph-layout";
import { exampleGraph, graphJob, staticMatrixGraph } from "./test-support/graphs";

function crossings(layout: GraphLayout): string[] {
  const found: string[] = [];
  for (const route of layout.routes) {
    for (let i = 0; i + 1 < route.points.length; i += 1) {
      const a = route.points[i];
      const b = route.points[i + 1];
      if (!a || !b) continue;
      for (const node of layout.nodes) {
        if (segmentCrossesBox(a, b, { x: node.x, y: node.y, width: NODE_WIDTH, height: NODE_HEIGHT })) found.push(`${route.kind} ${route.from}->${route.to} crosses ${node.id}`);
      }
    }
  }
  return found;
}

function layerOf(layout: GraphLayout, id: string): number {
  const node = layout.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node.layer;
}

describe("layoutGraph", () => {
  it("lays the example workflow out in dependency layers with no route crossing a node", () => {
    const layout = layoutGraph(exampleGraph());
    expect(["discover", "implement.main", "lint", "module-tests", "review", "accept"].map((id) => layerOf(layout, id))).toEqual([0, 1, 2, 2, 3, 4]);
    expect(layout.routes.filter((route) => route.kind === "needs")).toHaveLength(7);
    expect(crossings(layout)).toEqual([]);
    for (const node of layout.nodes) {
      expect(node.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(node.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
  });

  it("routes every edge orthogonally from the source's right edge to the target's left edge", () => {
    const layout = layoutGraph(exampleGraph());
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    for (const route of layout.routes.filter((candidate) => candidate.kind === "needs")) {
      const first = route.points[0];
      const last = route.points[route.points.length - 1];
      expect(first?.x).toBe((byId.get(route.from)?.x ?? NaN) + NODE_WIDTH);
      expect(last?.x).toBe(byId.get(route.to)?.x);
      route.points.slice(1).forEach((point, index) => {
        const previous = route.points[index];
        expect(previous && (previous.x === point.x || previous.y === point.y)).toBe(true);
      });
    }
  });

  it("draws the rework as its own route from the review to the task group below every node", () => {
    const layout = layoutGraph(exampleGraph());
    const rework = layout.routes.filter((route) => route.kind === "rework");
    expect(rework.map((route) => [route.from, route.to])).toEqual([["review", "implement.main"]]);
    const lowest = Math.max(...layout.nodes.map((node) => node.y + NODE_HEIGHT));
    expect(Math.max(...(rework[0]?.points.map((point) => point.y) ?? []))).toBeGreaterThan(lowest);
  });

  it("draws the task group and the unexpanded dynamic matrix as a pending group around their nodes", () => {
    const layout = layoutGraph(exampleGraph());
    expect(layout.groups.map((group) => [group.id, group.kind, group.pending])).toEqual([
      ["implement", "tasks", false],
      ["module-tests", "matrix", true],
    ]);
    const node = layout.nodes.find((candidate) => candidate.id === "module-tests");
    const group = layout.groups.find((candidate) => candidate.id === "module-tests");
    expect(node && group && group.x < node.x && group.y < node.y && group.x + group.width > node.x + NODE_WIDTH && group.y + group.height > node.y + NODE_HEIGHT).toBe(true);
  });

  it("frames a static matrix's instances in one group, adjacent in their layer, with no crossings", () => {
    const layout = layoutGraph(staticMatrixGraph());
    const group = layout.groups.find((candidate) => candidate.id === "module-tests");
    expect(group).toMatchObject({ kind: "matrix", pending: false });
    const instances = layout.nodes.filter((node) => node.id.startsWith("module-tests["));
    expect(instances).toHaveLength(3);
    expect(new Set(instances.map((node) => node.layer))).toEqual(new Set([2]));
    for (const node of instances) {
      expect(group && node.x >= group.x && node.y >= group.y && node.x + NODE_WIDTH <= group.x + group.width && node.y + NODE_HEIGHT <= group.y + group.height).toBe(true);
    }
    expect(crossings(layout)).toEqual([]);
  });

  it("keeps routes off nodes in a wide graph with many skipped layers", () => {
    const jobs = ["a", "b", "c", "d", "e"].map((id) => graphJob({ id, uses: "checks" }));
    const graph: ExpandedGraph = {
      jobs: [...jobs, graphJob({ id: "side", uses: "checks" })],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
        { from: "d", to: "e" },
        { from: "a", to: "e" },
        { from: "a", to: "d" },
        { from: "side", to: "e" },
      ],
      groups: [],
      reworks: [{ from: "e", to: "b", max: 1 }],
      maxParallel: 1,
    };
    const layout = layoutGraph(graph);
    expect(layout.nodes.map((node) => [node.id, node.layer])).toEqual([
      ["a", 0],
      ["side", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
      ["e", 4],
    ]);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const at = (id: string, side: "left" | "right", fraction: number) => {
      const node = byId.get(id);
      if (!node) throw new Error(`no node ${id}`);
      return { x: side === "left" ? node.x : node.x + NODE_WIDTH, y: node.y + NODE_HEIGHT * fraction };
    };
    expect(layout.routes.map((route) => [route.kind, route.from, route.to, route.points[0], route.points[route.points.length - 1]])).toEqual([
      ...graph.edges.map((edge) => ["needs", edge.from, edge.to, at(edge.from, "right", 0.5), at(edge.to, "left", 0.5)]),
      ["rework", "e", "b", at("e", "right", 0.75), at("b", "left", 0.75)],
    ]);
    const top = Math.min(...layout.nodes.map((node) => node.y));
    const bottom = Math.max(...layout.nodes.map((node) => node.y + NODE_HEIGHT));
    for (const route of layout.routes) {
      const ys = route.points.map((point) => point.y);
      const long = route.kind === "needs" && (byId.get(route.to)?.layer ?? 0) - (byId.get(route.from)?.layer ?? 0) > 1;
      if (long) expect(Math.min(...ys)).toBeLessThan(top);
      if (route.kind === "rework") expect(Math.max(...ys)).toBeGreaterThan(bottom);
    }
    expect(layout.routes.filter((route) => route.kind === "needs" && Math.min(...route.points.map((point) => point.y)) < top).map((route) => `${route.from}->${route.to}`)).toEqual(["a->e", "a->d", "side->e"]);
    expect(crossings(layout)).toEqual([]);
  });
});

describe("zoom", () => {
  it("Fit keeps the whole diagram in the viewport on both axes", () => {
    const layout = layoutGraph(exampleGraph());
    for (const viewport of [
      { width: 320, height: 480 },
      { width: 1280, height: 720 },
      { width: 393, height: 200 },
    ]) {
      const scale = fitZoom(layout, viewport);
      expect(layout.width * scale).toBeLessThanOrEqual(viewport.width + 1e-9);
      expect(layout.height * scale).toBeLessThanOrEqual(viewport.height + 1e-9);
    }
    expect(fitZoom({ width: 10, height: 10 }, { width: 1000, height: 1000 })).toBe(MAX_ZOOM);
  });

  it("steps in and out within bounds, landing on 100%", () => {
    expect(stepZoom(0.9, 1)).toBe(1);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1.1, -1)).toBe(1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(0.1, -1)).toBe(0.1);
    expect(stepZoom(0.1, 1)).toBeCloseTo(0.125);
  });
});
