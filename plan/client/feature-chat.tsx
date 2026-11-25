// The feature chat (Stage R4.1): the bound coordinator's live timeline, a composer that sends only
// to that coordinator, its pending permission requests, and the run's safe Pause/Resume, which
// are plugin RPCs (never an agent interrupt or cancel). Layout inside the feature screen is R4.2.
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { FlatList, Platform, Pressable, Text, TextInput, View } from "react-native";
import type { Feature } from "../shared/model";
import type { Result, ValueOf } from "../shared/rpc";
import { RunList, RunPause, RunResume } from "../shared/rpc-runs";
import { roadmapKey, RpcFailure, useRoadmapMutation } from "./hooks";
import { RunTimelineCard } from "./run-timeline-card";
import { DecisionTimelineCard } from "./timeline-card";
import { ROW_KIND, ROW_VERSION, RowData, RUN_ROW_KIND, RUN_ROW_VERSION, RunRowData } from "./timeline-data";
import { Heading, Muted } from "./ui";
import { useAgentTimeline, type TimelineEntry, type TransientEntry } from "./use-agent-timeline";

type RunListValue = ValueOf<typeof RunList>;
type Row = TimelineEntry | TransientEntry;
type PermissionRequest = { id: string; name: string; title?: string; description?: string };

const unwrap = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new RpcFailure(r.error);
  return r.value;
};

/**
 * FeatureChat's own action control (R42-UI-01): the shared `Button` look with the 44 px minimum
 * touch target, kept local so other screens keep the shared button unchanged.
 */
function ChatButton(props: { label: string; onPress(): void; theme: PluginTheme; disabled?: boolean; primary?: boolean }) {
  const { theme, primary, disabled } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={props.onPress}
      style={{
        minHeight: 44,
        minWidth: 44,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
        opacity: disabled ? 0.5 : 1,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground }}>{props.label}</Text>
    </Pressable>
  );
}

/** The host layout platform for the plugin's own row cards (only the host's supported values). */
const PLATFORM: "ios" | "android" | "web" = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web";

/**
 * The plugin's own timeline rows render through their registered cards when the kind, version and
 * strict data match exactly; anything else is shown as an honest placeholder line.
 */
function ownRow(row: Row): { kind: "question"; data: RowData } | { kind: "run"; data: RunRowData } | { kind: "other"; label: string } | null {
  const item = row.item as { type: string; kind?: unknown; version?: unknown; data?: unknown };
  if (item.type !== "plugin") return null;
  if (item.kind === ROW_KIND && item.version === ROW_VERSION) {
    const parsed = RowData.safeParse(item.data);
    if (parsed.success) return { kind: "question", data: parsed.data };
  }
  if (item.kind === RUN_ROW_KIND && item.version === RUN_ROW_VERSION) {
    const parsed = RunRowData.safeParse(item.data);
    if (parsed.success) return { kind: "run", data: parsed.data };
  }
  return { kind: "other", label: `Plugin row not shown (${typeof item.kind === "string" ? item.kind : "unknown"} v${typeof item.version === "number" ? item.version : "?"})` };
}

/** One readable line per timeline item: who said it, or which tool ran with its status. */
function rowText(row: Row): { who: string; text: string } {
  const item = row.item as { type: string; text?: unknown; name?: unknown; status?: unknown; error?: unknown };
  const text = typeof item.text === "string" ? item.text : "";
  switch (item.type) {
    case "user_message":
      return { who: "You", text };
    case "assistant_message":
      return { who: "Coordinator", text };
    case "reasoning":
      return { who: "Thinking", text };
    case "tool_call":
      return { who: "Tool", text: `${typeof item.name === "string" ? item.name : "tool"}${typeof item.status === "string" ? ` (${item.status})` : ""}` };
    default:
      return { who: item.type, text };
  }
}

export function FeatureChat(props: { hostId: string; projectId: string; feature: Feature; theme: PluginTheme; compact: boolean }) {
  const { hostId, projectId, feature, theme, compact } = props;
  const agentId = feature.coordinator?.agentId ?? null;
  const timeline = useAgentTimeline(agentId);
  const paseo = usePaseo() as ReturnType<typeof usePaseo> | null;
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [permissionError, setPermissionError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<PermissionRequest[]>([]);
  // The chat context: a generation bumped on every coordinator change (so A -> B -> A never admits
  // an outcome of the first A), plus whether the chat is mounted. An asynchronous send or
  // permission answer from an earlier context, or after unmount, changes nothing here.
  const context = useRef<{ generation: number; mounted: boolean }>({ generation: 0, mounted: true });
  useEffect(() => {
    context.current.mounted = true;
    return () => {
      context.current.mounted = false;
    };
  }, []);
  useEffect(() => {
    // A new coordinator context: the per-context send and error state starts fresh. The draft is
    // the person's text and is kept.
    context.current.generation += 1;
    setSending(false);
    setSendError(undefined);
    setPermissionError(undefined);
  }, [agentId]);
  const still = (generation: number) => context.current.mounted && context.current.generation === generation;

  // Pending permissions are a snapshot mirror on the agent handle (null until a snapshot arrives),
  // not reactive state: read it now, after a refresh, and on every agent update, so a request raised
  // after the first render appears without relying on an incidental timeline re-render.
  useEffect(() => {
    if (agentId === null || !paseo) {
      setPending([]);
      return;
    }
    let alive = true;
    const handle = paseo.agents.ref(agentId);
    const read = () => {
      if (!alive) return;
      const list = (handle.pendingPermissions ?? []) as PermissionRequest[];
      setPending(list.filter((p) => typeof p.id === "string"));
    };
    read();
    const unsubscribe = typeof handle.subscribe === "function" ? handle.subscribe(() => read()) : undefined;
    if (typeof handle.refresh === "function") void handle.refresh().then(read, () => undefined);
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [agentId, paseo]);

  // The feature's live run, read directly; same query key as useRunList, so the cache is shared.
  const listRuns = useRpc(RunList);
  const runs = useQuery({
    queryKey: [...roadmapKey(hostId, projectId), "runs", feature.id],
    queryFn: async () => unwrap((await listRuns({ projectId, featureId: feature.id })) as Result<RunListValue>),
  });
  const liveView = runs.data?.runs.find((v) => v.run.featureId === feature.id && v.run.state !== "ended");
  const live = liveView?.run;
  // As in runControls: the server refuses run.resume for any run-level blocker other than the pause itself.
  const resumeBlocker = liveView?.blocked.find((b) => b.taskId === undefined && b.code !== "run_not_running")?.code;
  const pause = useRoadmapMutation(hostId, projectId, RunPause);
  const resume = useRoadmapMutation(hostId, projectId, RunResume);

  if (agentId === null) {
    return (
      <View style={{ gap: 8, padding: compact ? 10 : 14 }}>
        <Muted theme={theme}>No coordinator chat yet</Muted>
      </View>
    );
  }

  const agent = paseo ? paseo.agents.ref(agentId) : null;

  const send = async () => {
    const message = text.trim();
    if (message === "" || !agent || sending) return;
    const generation = context.current.generation;
    setSending(true);
    setSendError(undefined);
    try {
      await agent.send(message);
      // Only the sent draft is cleared; text typed while the send was in flight stays.
      if (still(generation)) setText((t) => (t.trim() === message ? "" : t));
    } catch (e) {
      // Visible and not retried; the text stays so the person can send it again.
      if (still(generation)) setSendError(`Not sent: ${e instanceof Error ? e.message : "send failed"}`);
    } finally {
      if (still(generation)) setSending(false);
    }
  };
  const respond = async (request: PermissionRequest, behavior: "allow" | "deny") => {
    if (!agent) return;
    const generation = context.current.generation;
    setPermissionError(undefined);
    try {
      await agent.respondToPermission({ requestId: request.id, response: { behavior } });
    } catch (e) {
      if (still(generation)) setPermissionError(`Answer not delivered: ${e instanceof Error ? e.message : "failed"}`);
    }
  };

  const rows: Row[] = [...timeline.entries, ...(timeline.transient ?? [])];
  const status =
    timeline.status === "loading" ? "Loading chat…" : timeline.status === "stale" || timeline.status === "error" ? `Chat connection lost${timeline.error ? `: ${timeline.error}` : ""}` : null;

  return (
    <View style={{ flex: 1, gap: 8, padding: compact ? 10 : 14 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {/* The heading keeps a readable width; on a narrow panel the run button wraps below it. */}
        <View style={{ flex: 1, minWidth: 160 }}>
          <Heading theme={theme}>Coordinator chat</Heading>
        </View>
        {live?.state === "running" ? (
          <ChatButton label="Pause" theme={theme} disabled={pause.pending} onPress={() => void pause.run({ runId: live.id, runToken: live.runToken })} />
        ) : null}
        {live?.state === "paused" ? (
          <ChatButton label="Resume" theme={theme} disabled={resume.pending || resumeBlocker !== undefined} onPress={() => void resume.run({ runId: live.id, runToken: live.runToken })} />
        ) : null}
      </View>
      {live?.state === "paused" && resumeBlocker !== undefined ? <Muted theme={theme}>{`Resume: ${resumeBlocker.replace(/_/g, " ")}`}</Muted> : null}
      {status ? (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Muted theme={theme}>{status}</Muted>
          {timeline.status === "stale" || timeline.status === "error" ? <ChatButton label="Reload chat" theme={theme} onPress={timeline.reload} /> : null}
        </View>
      ) : null}
      <FlatList
        style={{ flex: 1 }}
        data={rows}
        keyExtractor={(row: Row, index: number) => ("seqStart" in row ? `s${row.seqStart}-${row.seqEnd}` : `t${index}`)}
        renderItem={({ item }: { item: Row }) => {
          const own = ownRow(item);
          if (own && own.kind !== "other") {
            const cardProps = {
              agentId,
              timestamp: new Date(item.timestamp),
              theme,
              host: { id: hostId, label: hostId },
              layout: { compact, platform: PLATFORM },
            };
            return own.kind === "question" ? (
              <DecisionTimelineCard {...cardProps} item={{ type: "plugin", kind: ROW_KIND, version: ROW_VERSION, data: own.data }} />
            ) : (
              <RunTimelineCard {...cardProps} item={{ type: "plugin", kind: RUN_ROW_KIND, version: RUN_ROW_VERSION, data: own.data }} />
            );
          }
          if (own) {
            return (
              <View style={{ paddingVertical: 4 }}>
                <Muted theme={theme}>{own.label}</Muted>
              </View>
            );
          }
          const line = rowText(item);
          return (
            <View style={{ paddingVertical: 4 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{line.who}</Text>
              <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{line.text}</Text>
            </View>
          );
        }}
      />
      {pending.map((request) => (
        <View key={request.id} style={{ gap: 6, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, padding: 8 }}>
          <Text style={{ color: theme.colors.foreground }}>{request.title ?? request.name}</Text>
          {request.description ? <Muted theme={theme}>{request.description}</Muted> : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <ChatButton label="Allow" primary theme={theme} onPress={() => void respond(request, "allow")} />
            <ChatButton label="Deny" theme={theme} onPress={() => void respond(request, "deny")} />
          </View>
        </View>
      ))}
      {permissionError ? <Text style={{ color: theme.colors.statusDanger }}>{permissionError}</Text> : null}
      {sendError ? <Text style={{ color: theme.colors.statusDanger }}>{sendError}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Message the coordinator"
          placeholderTextColor={theme.colors.foregroundMuted}
          multiline
          style={{
            flex: 1,
            fontSize: 16,
            minHeight: 44,
            maxHeight: 120,
            paddingHorizontal: 10,
            paddingVertical: 8,
            borderWidth: 1,
            borderRadius: 6,
            borderColor: theme.colors.border,
            color: theme.colors.foreground,
            backgroundColor: theme.colors.surface1,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={sending}
          onPress={() => void send()}
          style={{
            minHeight: 44,
            minWidth: 64,
            paddingHorizontal: 12,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            backgroundColor: theme.colors.accent,
            opacity: sending ? 0.6 : 1,
          }}
        >
          <Text style={{ color: theme.colors.accentForeground }}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}
