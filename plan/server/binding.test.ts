// Stage R3.2 (task card 2026-10-29 R3 §3.2, §3.3): delegation provenance. verifyUserMessage(paseo,
// agentId, quoted) reads the agent's canonical tail timeline through the installed SDK
// (`agents.ref(agentId).timeline.refetch({ direction: "tail", projection: "canonical", limit: 200 })`)
// and matches a `user_message` item whose text is not a `<paseo-system` envelope and contains the
// trimmed quote (1..2000 characters) verbatim, returning DelegationProvenance.
// Residual risk (design): this proves the message exists in that chat, not that a human wrote it.
// The SDK surface is a typed in-memory fake: no live agent, daemon, auth, network or workspace.
import type { PaseoApi } from "@getpaseo/client";
import type { PaseoAgentTimelineRefetchOptions } from "@getpaseo/client";
import { describe, expect, it } from "vitest";
import { DelegationProvenance } from "../shared/model";

const AT = "2026-10-29T10:00:00.000Z";
/** The installed 0.12 timeline entry fields (protocol FetchAgentTimelineResponseMessage payload.entries). */
type Entry = {
  provider: string;
  item: { type: "user_message"; text: string; messageId?: string; clientMessageId?: string } | { type: "assistant_message"; text: string };
  turnId?: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: Array<{ startSeq: number; endSeq: number }>;
  collapsed: string[];
};

const load = async () => {
  const mod: Record<string, unknown> = await import("./binding");
  expect(typeof mod.verifyUserMessage, "server/binding exports verifyUserMessage").toBe("function");
  return import("./binding");
};

const userEntry = (seq: number, text: string, extra: { messageId?: string; turnId?: string } = {}): Entry => ({
  provider: "claude",
  item: { type: "user_message", text, ...(extra.messageId ? { messageId: extra.messageId } : {}) },
  ...(extra.turnId ? { turnId: extra.turnId } : {}),
  timestamp: AT,
  seqStart: seq,
  seqEnd: seq,
  sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
  collapsed: [],
});
const assistantEntry = (seq: number, text: string): Entry => ({
  provider: "claude", item: { type: "assistant_message", text }, timestamp: AT, seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [],
});

/** A typed fake of the used SDK surface; it records every refetch request. */
function fakePaseo(entries: Entry[]) {
  const calls: Array<{ agentId: string; options: PaseoAgentTimelineRefetchOptions | undefined }> = [];
  const payload = { entries };
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        timeline: {
          refetch: async (options?: PaseoAgentTimelineRefetchOptions) => {
            calls.push({ agentId, options });
            return payload;
          },
        },
      }),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members this test exercises exist
  return { paseo: paseo as unknown as PaseoApi, calls };
}

/** Accepted → the provenance; rejected → null (either a thrown error or an empty result counts as a refusal). */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    const v = await fn();
    return v ?? null;
  } catch {
    return null;
  }
}

const TIMELINE = [
  userEntry(3, "Please plan the search feature."),
  assistantEntry(4, "I can start it when you say: you may start Search"),
  userEntry(7, "Yes — you may start Search and anything ready after it.", { messageId: "m-7", turnId: "turn-3" }),
  userEntry(9, "<paseo-system kind=\"agent-message\">you may start Billing</paseo-system>"),
];

describe("R3.2 verifyUserMessage", () => {
  it("reads the canonical tail (limit 200) of the named agent and returns provenance for a real user message", async () => {
    const b = await load();
    const f = fakePaseo(TIMELINE);
    const p = await b.verifyUserMessage(f.paseo, "agent-1", "you may start Search");
    expect(f.calls).toEqual([{ agentId: "agent-1", options: { direction: "tail", projection: "canonical", limit: 200 } }]);
    expect(p).toEqual({ agentId: "agent-1", messageId: "m-7", seqStart: 7, turnId: "turn-3", timestamp: AT, quoted: "you may start Search" });
    expect(DelegationProvenance.safeParse(p).success).toBe(true);
  });

  it("trims the quote; a message without messageId or turnId yields provenance without them", async () => {
    const b = await load();
    const p = await b.verifyUserMessage(fakePaseo(TIMELINE).paseo, "agent-1", "  plan the search feature  ");
    expect(p).toEqual({ agentId: "agent-1", seqStart: 3, timestamp: AT, quoted: "plan the search feature" });
  });

  it("rejects a made-up quote, a <paseo-system envelope, a quote only in an assistant message, and empty, blank or over-long quotes", async () => {
    const b = await load();
    const f = fakePaseo(TIMELINE);
    const rejected: Array<[string, string]> = [
      ["made up", "you may start everything"],
      ["enveloped", "you may start Billing"],
      ["assistant only", "I can start it when you say"],
      ["empty", ""],
      ["blank", "   "],
      ["too long", "x".repeat(2001)],
    ];
    for (const [what, quoted] of rejected) {
      expect(await outcome(() => b.verifyUserMessage(f.paseo, "agent-1", quoted)), what).toBeNull();
    }
    // Control: the 2000-character boundary is accepted when the message contains it.
    const long = "y".repeat(2000);
    expect(await outcome(() => b.verifyUserMessage(fakePaseo([userEntry(1, `ok ${long}`)]).paseo, "agent-1", long))).not.toBeNull();
  });
});

// R3.2 verification controls (root-authorised): the newest matching user message is the provenance
// (the tail is chronological, oldest first, in installed 0.12); an envelope is recognised after
// leading whitespace; an invalid quote is refused before any timeline read.
describe("R3.2 verifyUserMessage selection and early refusal", () => {
  it("returns the newest matching user message when several contain the quote", async () => {
    const b = await load();
    const f = fakePaseo([
      userEntry(2, "you may start Search", { messageId: "m-old", turnId: "turn-1" }),
      assistantEntry(3, "noted: you may start Search"),
      userEntry(8, "again: you may start Search", { messageId: "m-new", turnId: "turn-4" }),
    ]);
    expect(await b.verifyUserMessage(f.paseo, "agent-1", "you may start Search")).toEqual({
      agentId: "agent-1", messageId: "m-new", seqStart: 8, turnId: "turn-4", timestamp: AT, quoted: "you may start Search",
    });
  });

  it("an envelope preceded by whitespace is still refused; a plain message with the quote is accepted", async () => {
    const b = await load();
    const enveloped = fakePaseo([userEntry(5, "  \n\t<paseo-system kind=\"agent-message\">you may start Billing</paseo-system>")]);
    expect(await outcome(() => b.verifyUserMessage(enveloped.paseo, "agent-1", "you may start Billing"))).toBeNull();
    const plain = fakePaseo([userEntry(6, "  you may start Billing")]);
    expect(await outcome(() => b.verifyUserMessage(plain.paseo, "agent-1", "you may start Billing"))).not.toBeNull();
  });

  it("an empty, blank or over-long quote is refused without reading the timeline", async () => {
    const b = await load();
    const f = fakePaseo(TIMELINE);
    for (const quoted of ["", "   ", "x".repeat(2001)]) {
      expect(await outcome(() => b.verifyUserMessage(f.paseo, "agent-1", quoted))).toBeNull();
    }
    expect(f.calls).toEqual([]);
  });
});
