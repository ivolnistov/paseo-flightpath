import type { ExpandedGraph } from "../shared/workflow";

/** The graph job ids a workflow job id stands for: its task or matrix group, else itself. */
export function membersOf(graph: ExpandedGraph, jobId: string): string[] {
  const group = graph.groups.find((candidate) => candidate.id === jobId);
  if (group) return [...group.jobIds];
  return graph.jobs.some((job) => job.id === jobId) ? [jobId] : [];
}

/** Every job reachable from `roots` through `needs` edges, roots included, in graph declaration order. */
export function downstream(graph: ExpandedGraph, roots: readonly string[]): string[] {
  const reached = new Set(roots);
  const queue = [...roots];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const edge of graph.edges) {
      if (edge.from === id && !reached.has(edge.to)) {
        reached.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return graph.jobs.map((job) => job.id).filter((id) => reached.has(id));
}

/**
 * The jobs a return to `target` supersedes: the target and everything downstream of it. For a
 * `run-tasks` target with task ids, only those tasks, the tasks that need them and every job
 * downstream of the group.
 */
export function affectedSet(graph: ExpandedGraph, target: string, taskIds?: readonly string[]): string[] {
  const group = graph.groups.find((candidate) => candidate.id === target && candidate.kind === "tasks");
  if (group && taskIds !== undefined && taskIds.length > 0) {
    const roots = taskIds.map((taskId) => `${target}.${taskId}`).filter((id) => group.jobIds.includes(id));
    return downstream(graph, roots);
  }
  return downstream(graph, membersOf(graph, target));
}

/** Task ids of a `run-tasks` group, or null when `target` is not one. */
export function taskIdsOf(graph: ExpandedGraph, target: string): string[] | null {
  const group = graph.groups.find((candidate) => candidate.id === target && candidate.kind === "tasks");
  if (!group) return null;
  return graph.jobs.filter((job) => group.jobIds.includes(job.id) && job.taskId !== undefined).map((job) => job.taskId ?? "");
}
