// Places text in the draft of one bound chat on the panel's host, through the composer API of hosts
// that have it. The SDK is read as a namespace so a host without `useComposers` loads this module
// unchanged and reports the action as unsupported. Nothing here sends, or changes the chat's
// provider, model, mode, thinking, permissions or session.
import * as clientSdk from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useRef } from "react";
import { optionalExport } from "../shared/host-features";

/** The part of the host's composer this module uses. */
export interface DraftComposer {
  readonly prompt: string;
  /** Inserts at the cursor, replacing the selection. */
  insertText(text: string): void;
  /** Equal offsets place the cursor. Offsets are clamped: documented against the prompt, applied by the 0.16 app against the live input text. */
  focus(options?: { selection?: { start: number; end: number } }): Promise<void>;
}

type UseComposers = (selector: { agentId: string }) => readonly DraftComposer[];

function composersHook(): UseComposers | null {
  const candidate = optionalExport(clientSdk, "useComposers");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime-detected host hook; older SDK types do not declare it
  return typeof candidate === "function" ? (candidate as UseComposers) : null;
}

export type ChatDraftAvailability = "unsupported" | "unavailable" | "ready";

export type PlaceResult = { ok: true } | { ok: false; reason: "unsupported" | "unavailable" | "busy" | "focus" | "changed" | "insert"; message: string };

/** How many times the cursor is moved again after the draft changed during a focus. */
const MAX_REFOCUS = 3;

/**
 * A selection offset past any draft. Hosts clamp selection offsets; the 0.16 app clamps them to
 * the input's live text when the selection is applied. Kept within a 32-bit integer in case a
 * platform passes it on unclamped.
 */
export const END_OF_DRAFT = 2_147_483_647;

/** Put before every placed block so it starts a paragraph of its own. */
export const BLOCK_SEPARATOR = "\n\n";

export const UNSUPPORTED_MESSAGE = "This Paseo version cannot place text in a chat draft. Update Paseo, or use Send to chat.";
export const UNAVAILABLE_MESSAGE = "The planner chat is not available on this host. Open the chat or choose another planner.";

const errorText = (e: unknown) => (e instanceof Error && e.message !== "" ? e.message : "unknown error");

/**
 * The bound chat's composer: exactly the agent `agentId` on the host this surface belongs to (the
 * host's composer source is per installation). No title search and no fallback to another agent.
 */
export function useChatDraft(agentId: string | null): { availability: ChatDraftAvailability; place(block: string): Promise<PlaceResult> } {
  // Detection is fixed for the loaded host, so the hook order is stable across renders.
  const useComposers = composersHook();
  let composers: readonly DraftComposer[] | null = null;
  if (useComposers !== null) {
    try {
      // An empty id names no agent: the host resolves it to no composer.
      composers = useComposers({ agentId: agentId ?? "" });
    } catch {
      // A surface without the host's composer source: the same on every render of this mount.
      composers = null;
    }
  }
  const supported = useComposers !== null && composers !== null;
  const target = agentId !== null && composers?.length === 1 ? composers[0] : undefined;
  // The newest resolution: the host hands out a new composer whenever the draft changes.
  const latest = useRef<{ agentId: string | null; composer: DraftComposer | undefined }>({ agentId, composer: target });
  latest.current = { agentId, composer: target };
  const busy = useRef(false);

  const place = useCallback(
    async (block: string): Promise<PlaceResult> => {
      if (!supported) return { ok: false, reason: "unsupported", message: UNSUPPORTED_MESSAGE };
      const bound = latest.current;
      if (bound.composer === undefined) return { ok: false, reason: "unavailable", message: UNAVAILABLE_MESSAGE };
      if (busy.current) return { ok: false, reason: "busy", message: "The question is already being placed in the chat draft." };
      busy.current = true;
      try {
        let composer = bound.composer;
        let prompt = composer.prompt;
        // The cursor goes after all of the draft, so no draft text and no selected range is replaced.
        // `prompt` can lag the input (typed text not yet published, or a newer saved draft loaded when
        // the chat is revealed), so the offset is past any text: the host clamps it to the input's
        // live text when it applies the selection. The newest composer is read after each focus, and
        // the focus repeated until the text holds still.
        for (let refocus = 0; ; refocus++) {
          try {
            await composer.focus({ selection: { start: END_OF_DRAFT, end: END_OF_DRAFT } });
          } catch (e) {
            return { ok: false, reason: "focus", message: `The chat could not be focused (${errorText(e)}). The draft was not changed.` };
          }
          const now = latest.current;
          if (now.agentId !== bound.agentId || now.composer === undefined) {
            return { ok: false, reason: "unavailable", message: "The planner chat changed or became unavailable while it was being focused. The draft was not changed." };
          }
          composer = now.composer;
          if (composer.prompt === prompt) break;
          prompt = composer.prompt;
          if (refocus >= MAX_REFOCUS) {
            return { ok: false, reason: "changed", message: "The chat draft kept changing while it was being focused. The draft was not changed; try again." };
          }
        }
        try {
          // Always a blank line first: the plugin cannot see the live draft's ending, and an extra
          // blank line is harmless where a missing one would join the block to the draft.
          composer.insertText(BLOCK_SEPARATOR + block);
        } catch (e) {
          return { ok: false, reason: "insert", message: `The question could not be placed in the chat draft (${errorText(e)}). Check the draft before sending.` };
        }
        return { ok: true };
      } finally {
        busy.current = false;
      }
    },
    [supported],
  );

  return { availability: !supported ? "unsupported" : target === undefined ? "unavailable" : "ready", place };
}

export const PLACED_MESSAGE = "Question placed in the chat draft. Review it and send when ready.";

/** "Discuss in chat": places the block and reports the outcome; the person sends from the chat. */
export function useDiscussInChat(agentId: string | null): { availability: ChatDraftAvailability; discuss(block: string): Promise<boolean> } {
  const draft = useChatDraft(agentId);
  const toast = useToast();
  const { place } = draft;
  const discuss = useCallback(
    async (block: string): Promise<boolean> => {
      const out = await place(block);
      if (out.ok) toast.show(PLACED_MESSAGE);
      else toast.error(out.message);
      return out.ok;
    },
    [place, toast],
  );
  return { availability: draft.availability, discuss };
}
