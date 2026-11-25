import type { PluginClientSlashCommandContribution } from "@getpaseo/plugin/client";
import { parseLink, parseShortRef, type ParsedLink } from "../shared/links";

const DESCRIPTION = "Open the decision roadmap";

// ---- Stage R4.5a: a scoped, one-shot, client-only pending route (card §6.2, G5) ----
// The SDK `openPanel(id, { location? })` carries no route, so `/roadmap <args>` leaves the route
// here and the panel of the same workspace and project takes it. Nothing is written anywhere.

export type RoadmapRoute =
  | { kind: "roadmap" }
  | { kind: "feature"; query: string }
  /** A question or answer link, its kind and pinned revision kept. */
  | { kind: "question"; link: ParsedLink }
  /** A short Q<n>, resolved against the session open in the panel. */
  | { kind: "question-number"; number: number };
/** The workspace the command ran in: `ctx.workspace.id` and `ctx.workspace.projectId`. */
export type RouteScope = { workspaceId: string; projectId: string };

export const PENDING_ROUTE_TTL_MS = 30_000;

const pending = new Map<string, { projectId: string; route: RoadmapRoute; at: number }>();
const listeners = new Set<() => void>();

/**
 * "" | "features" | "runs" → roadmap; "feature <id or title>" → feature; "question <link | Q<n>>" →
 * question or question-number; anything else → roadmap.
 */
export function parseRoadmapArgs(args: string): RoadmapRoute {
  const trimmed = args.trim();
  const match = /^feature(?:\s+(.*))?$/.exec(trimmed);
  const query = match?.[1]?.trim();
  if (query) return { kind: "feature", query };
  const question = /^question\s+(\S+)$/.exec(trimmed);
  if (question !== null) {
    const link = parseLink(question[1]);
    if (link !== null) return { kind: "question", link };
    const number = parseShortRef(question[1]);
    if (number !== null) return { kind: "question-number", number };
  }
  return { kind: "roadmap" };
}

/** Replaces any pending route of the same scope and notifies the subscribers. */
export function setPendingRoute(scope: RouteScope, route: RoadmapRoute): void {
  pending.set(scope.workspaceId, { projectId: scope.projectId, route, at: Date.now() });
  for (const listener of [...listeners]) listener();
}

/**
 * One-shot: returns and deletes the route only for an exactly matching scope that is younger than
 * the TTL. A route of another workspace or project stays for its own scope; an expired one is
 * deleted and gives null.
 */
export function takePendingRoute(scope: RouteScope): RoadmapRoute | null {
  const entry = pending.get(scope.workspaceId);
  if (!entry || entry.projectId !== scope.projectId) return null;
  pending.delete(scope.workspaceId);
  return Date.now() - entry.at > PENDING_ROUTE_TTL_MS ? null : entry.route;
}

/** For an already open panel; returns the unsubscribe function. */
export function subscribePendingRoute(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * `/roadmap [features | runs | feature <id or title> | question <link or Q<n>>]`: opens the panel and
 * leaves the route for it.
 * One workspace-context command: the host offers it in both workspace draft and existing agent
 * composers, and rejects a second command of the same name in another context.
 */
export function roadmapSlashCommands(panelId: string): PluginClientSlashCommandContribution[] {
  return [
    {
      name: "roadmap",
      description: DESCRIPTION,
      argumentHint: "",
      context: "workspace",
      onSubmit: (c) => {
        setPendingRoute({ workspaceId: c.workspace.id, projectId: c.workspace.projectId }, parseRoadmapArgs(c.args));
        c.openPanel(panelId);
      },
    },
  ];
}
