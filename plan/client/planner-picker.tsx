// Planner picker (S3/G5, PLAN §3.2/§3.8): lists this project's chats on the panel's host and binds the
// chosen one as the session's planner through the UI-only `session.planner.set`. It never sends, runs or
// answers anything in a chat.
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { SessionPlannerSet } from "../shared/rpc";
import { moveFocus } from "./discussion-ui";
import { usePlannerAgents, useRoadmapMutation } from "./hooks";
import { ActionButton } from "./roadmap-screen";
import { TARGET_SIZE } from "./theme";

/** The only agent fields the picker reads from a `paseo.agents.list` entry. */
export type PlannerAgentEntry = {
  agent: { id: string; provider: string; title: string | null; status: string; archivedAt?: string | null; internal?: boolean };
  project: { projectKey: string };
};
export type PlannerCandidate = { agentId: string; label: string; provider: string; current: boolean };

/**
 * This project's chats (projectKey === projectId) that are neither archived (non-empty archivedAt) nor
 * internal; labelled by title, else agent id; the current planner marked; sorted by label, then id.
 */
export function plannerCandidates(entries: readonly PlannerAgentEntry[], projectId: string, currentAgentId: string | null): PlannerCandidate[] {
  return entries
    .filter((e) => e.project.projectKey === projectId)
    .filter((e) => !(typeof e.agent.archivedAt === "string" && e.agent.archivedAt !== "") && e.agent.internal !== true)
    .map((e) => ({
      agentId: e.agent.id,
      label: e.agent.title !== null && e.agent.title !== "" ? e.agent.title : e.agent.id,
      provider: e.agent.provider,
      current: e.agent.id === currentAgentId,
    }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}

export function PlannerPicker(props: {
  hostId: string;
  projectId: string;
  sessionId: string;
  revision: number;
  currentAgentId: string | null;
  theme: PluginTheme;
  onDone(): void;
}) {
  const { hostId, projectId, sessionId, revision, currentAgentId, theme, onDone } = props;
  const agents = usePlannerAgents(hostId, projectId, true);
  const bind = useRoadmapMutation(hostId, projectId, SessionPlannerSet);

  // The menu item that opened the picker is gone once the menu closes: focus moves in, to the first chat
  // or (while they load, or with none) to Cancel, once, without scrolling. The screen returns it to the
  // Chat menu trigger when the picker closes.
  const firstRef = useRef<View | null>(null);
  const cancelRef = useRef<View | null>(null);
  const focusIn = useRef(true);
  useEffect(() => {
    if (!focusIn.current) return;
    const target = firstRef.current !== null ? firstRef : cancelRef;
    if (target.current === null) return;
    focusIn.current = false;
    moveFocus(target, { preventScroll: true });
  });

  // Only a successful rebind closes the picker; a failure (toast, conflict refetch) keeps it open.
  async function choose(agentId: string) {
    const out = await bind.run({ sessionId, agentId }, { expectedRevision: revision });
    if (out) onDone();
  }

  let content;
  if (agents.isError) {
    content = <Text style={{ color: theme.colors.statusDanger }}>Chats could not be loaded.</Text>;
  } else if (agents.data === undefined) {
    content = <Text style={{ color: theme.colors.foregroundMuted }}>Loading chats…</Text>;
  } else {
    const candidates = plannerCandidates(agents.data, projectId, currentAgentId);
    content =
      candidates.length === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>No other chats in this project.</Text>
      ) : (
        candidates.map((c, i) => (
          <Pressable
            key={c.agentId}
            {...(i === 0 ? { ref: firstRef } : {})}
            accessibilityRole="button"
            accessibilityLabel={c.current ? `${c.label} (current planner)` : c.label}
            accessibilityState={{ disabled: bind.pending, selected: c.current }}
            disabled={bind.pending}
            onPress={() => void choose(c.agentId)}
            style={{
              minHeight: TARGET_SIZE,
              justifyContent: "center",
              paddingHorizontal: 10,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: c.current ? theme.colors.accent : theme.colors.border,
              backgroundColor: theme.colors.surface1,
              opacity: bind.pending ? 0.5 : 1,
              minWidth: 0,
            }}
          >
            <Text style={{ color: theme.colors.foreground, flexShrink: 1 }}>{c.current ? `${c.label} · current planner` : c.label}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{c.provider}</Text>
          </Pressable>
        ))
      );
  }

  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Choose the planner chat</Text>
      {content}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, minWidth: 0 }}>
        <ActionButton ref={cancelRef} label="Cancel" theme={theme} disabled={bind.pending} onPress={onDone} />
      </View>
    </View>
  );
}
