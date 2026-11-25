// Delegation provenance (Stage R3.2): a chat delegation counts only when the quoted words exist in a
// real user message of that agent's host timeline.
// Residual risk (plan §0): this proves the message exists in that chat, not that a human wrote it;
// an un-enveloped local SDK or CLI send is indistinguishable from a UI message.
import type { PaseoApi } from "@getpaseo/client";
import type { DelegationProvenance } from "../shared/model";

const MAX_QUOTE = 2000;
const ENVELOPE = "<paseo-system";

type TimelineEntry = {
  item: { type: string; text?: string; messageId?: string };
  turnId?: string;
  timestamp: string;
  seqStart: number;
};

/**
 * The newest `user_message` of the agent's canonical tail (200 entries) whose text is not a
 * `<paseo-system` envelope and contains the trimmed quote (1..2000 characters) verbatim, or null.
 */
export async function verifyUserMessage(paseo: PaseoApi, agentId: string, quoted: string): Promise<DelegationProvenance | null> {
  const quote = quoted.trim();
  if (quote.length === 0 || quote.length > MAX_QUOTE) return null;
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", projection: "canonical", limit: 200 });
  const entries = (page.entries ?? []) as TimelineEntry[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const text = e.item.type === "user_message" ? e.item.text : undefined;
    if (typeof text !== "string" || text.trimStart().startsWith(ENVELOPE) || !text.includes(quote)) continue;
    return {
      agentId,
      ...(e.item.messageId !== undefined ? { messageId: e.item.messageId } : {}),
      seqStart: e.seqStart,
      ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
      timestamp: e.timestamp,
      quoted: quote,
    };
  }
  return null;
}
