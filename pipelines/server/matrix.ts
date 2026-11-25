import { matrixInstanceId, type ExpandedGraph, type GraphJob, type MatrixScalar } from "../shared/workflow";
import type { RunState } from "./run-engine";

export type MatrixFailure = "matrix_empty" | "matrix_too_large" | "matrix_invalid";

/** The latest expansion of one dynamic matrix, pinned to the source attempt it came from. */
export type MatrixState = { sourceAttemptId: string; values: MatrixScalar[] | null; reason: MatrixFailure | null };

/** A dynamic matrix job that has not expanded; it never runs an attempt itself. */
export function isUnexpanded(gj: GraphJob): boolean {
  return gj.matrix !== undefined && gj.matrixIndex === undefined;
}

/** The source output of a dynamic matrix declaration, or null for a fixed list. */
export function matrixRef(gj: GraphJob): { jobId: string; output: string } | null {
  const source = gj.matrix?.source;
  return source !== undefined && "ref" in source ? source.ref : null;
}

/** Dynamic matrix templates of the snapshot graph, in declaration order. */
export function dynamicTemplates(base: ExpandedGraph): GraphJob[] {
  return base.jobs.filter((gj) => isUnexpanded(gj) && matrixRef(gj) !== null);
}

/** The item an instance runs with, from its fixed list or the current expansion. */
export function liveMatrixValue(state: RunState, gj: GraphJob): MatrixScalar | undefined {
  if (gj.matrix === undefined || gj.matrixIndex === undefined) return undefined;
  if ("fixed" in gj.matrix.source) return gj.matrix.source.fixed[gj.matrixIndex];
  return state.matrices[gj.sourceJobId]?.values?.[gj.matrixIndex];
}

/**
 * Whether a matrix instance may start: a static instance always may; a dynamic instance only while
 * its expansion is pinned to the source's current successful attempt.
 */
export function matrixPinned(state: RunState, gj: GraphJob): boolean {
  if (gj.matrixIndex === undefined) return !isUnexpanded(gj);
  const ref = matrixRef(gj);
  if (ref === null) return true;
  const expansion = state.matrices[gj.sourceJobId];
  const succeeded = state.jobs[ref.jobId]?.succeeded ?? null;
  return expansion !== undefined && expansion.values !== null && succeeded !== null && expansion.sourceAttemptId === succeeded;
}

/** The ids `liveGraph` gives a dynamic matrix for `count` items. */
export function instanceIds(templateId: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => matrixInstanceId(templateId, index));
}

/**
 * The snapshot graph with every expanded dynamic matrix replaced by its instances: each instance
 * takes the template's incoming and outgoing edges, and the instances form one `matrix` group.
 */
export function liveGraph(base: ExpandedGraph, matrices: Readonly<Record<string, MatrixState>>): ExpandedGraph {
  const graph = structuredClone(base);
  for (const template of dynamicTemplates(base)) {
    const values = matrices[template.id]?.values;
    if (!values) continue;
    const instances = values.map((value, index): GraphJob => ({
      ...structuredClone(template),
      id: matrixInstanceId(template.id, index),
      name: `${template.name} (${String(value)})`,
      matrixIndex: index,
    }));
    const ids = instances.map((instance) => instance.id);
    const at = graph.jobs.findIndex((gj) => gj.id === template.id);
    graph.jobs.splice(at, 1, ...instances);
    graph.edges = graph.edges.flatMap((edge) => {
      if (edge.to === template.id) return ids.map((id) => ({ from: edge.from, to: id }));
      if (edge.from === template.id) return ids.map((id) => ({ from: id, to: edge.to }));
      return [edge];
    });
    graph.groups.push({ id: template.id, kind: "matrix", jobIds: ids });
  }
  return graph;
}
