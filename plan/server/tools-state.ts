// Whether a discussion chat has the roadmap MCP tools, read from the plugin's grant state.
//
// A grant is attributed to the chat only through an exact link: a grant bound to the chat's agent
// (attached), or a grant marked with the chat's reservation, which the injection reads from the
// creation env (pending while unbound). The host's agent.create hook carries no agent id or labels,
// so the reservation in the env is the only correlation; a workspace directory or a time window
// never identifies a grant.
//
// A reservation the owner retried after an unresolved creation is ambiguous: the earlier attempt may
// have issued a grant with the same mark and created no chat, so only a grant bound to the chat
// itself counts (attached) and anything else is unknown.
//
// Unmarked grants are another chat's, or this chat's when the creation came from an older plugin
// version or a host that did not pass the env. So a live (not stale) unbound unmarked grant in the
// chat's directory issued at or after `since` makes the state unknown, never pending. A planner whose
// reservation is not known (no feature records it, or its feature was deleted) may own a marked
// grant, so for it any live unbound grant there issued at or after `since`, marked or not, makes the
// state unknown; that count reads no marks. Both counts need the chat's workspace directory and use
// the same `since`: the reservation time for a new or reconciled creation; for an already bound chat
// (Discuss again, or the header) the earlier of the session's creation and the binding less 60 s.
// Without such a grant and without a live grant of its own, the chat has no usable grant (not
// attached): none was issued, or the one it had was made stale.
//
// What cannot be read is unknown, for the reads actually made: the grant bound to the chat's agent
// is read from the grants file alone, so attached never needs the marks file; an unreadable marks
// file affects only the reservation lookup and the unmarked count.
import type { DiscussionTools } from "../shared/rpc-discussion";
import type { McpState } from "./mcp-state";

/** The grant lookups; the reservation lookup is optional, and without it a reservation reads unknown. */
export type GrantReader = Pick<McpState, "grantForAgent" | "grantsIssuedSince"> & Partial<Pick<McpState, "grantsForReservation">>;

export interface ToolsQuery {
  agentId: string;
  /** The chat's reservation, when it was created by Discuss; its grant carries this mark. */
  reservationId?: string;
  /**
   * The owner confirmed a retry under this reservation: an earlier attempt may have issued a grant
   * with the same mark, so no marked grant can be attributed to this chat.
   */
  retried?: boolean;
  /** Grants issued before this instant are not counted by directory (either scope). */
  since: string;
  /** The chat's workspace directory, resolved only when grants must be counted by directory (either scope). */
  cwd: () => Promise<string | undefined>;
}

export async function toolsState(state: GrantReader, q: ToolsQuery): Promise<DiscussionTools> {
  try {
    if ((await state.grantForAgent(q.agentId)) !== null) return "attached";
    if (q.reservationId !== undefined) {
      if (q.retried === true || state.grantsForReservation === undefined) return "unknown";
      const own = await state.grantsForReservation(q.reservationId);
      const unbound = own.filter((g) => g.agentId === undefined);
      // One unbound grant of this creation: waiting for the chat's session. Several, or one bound to
      // another agent, cannot be told apart from what the plugin knows.
      if (unbound.length === 1 && own.length === 1) return "pending";
      if (own.length > 0) return "unknown";
    }
    const cwd = await q.cwd();
    if (cwd === undefined) return "unknown";
    // Without the chat's reservation (a planner no feature records, or whose feature was deleted) its
    // own grant may be a marked one, so marked grants count as well.
    const scope = q.reservationId === undefined ? "all" : "unmarked";
    return (await state.grantsIssuedSince(q.since, cwd, scope)) > 0 ? "unknown" : "not_attached";
  } catch {
    return "unknown";
  }
}
