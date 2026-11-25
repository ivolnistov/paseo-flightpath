import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import type { Result, RpcError, ValueOf } from "../shared/rpc";
import { RunGet } from "../shared/rpc-runs";
import { roadmapKey, RpcFailure, useRoadmapVersion } from "./hooks";
import { conflictMessage } from "./layout";
import { cardStyle } from "./theme";
import type { RunRowData } from "./timeline-data";
import { Heading, Muted } from "./ui";

type RunGetValue = ValueOf<typeof RunGet>;

// These codes classify a lost reference (project or run gone) as "no longer available".
const GONE: ReadonlySet<RpcError["code"]> = new Set(["unknown_project", "not_found"]);
const isGone = (e: unknown) => e instanceof RpcFailure && GONE.has(e.rpcError.code);
const errorText = (e: unknown) => (e instanceof RpcFailure ? conflictMessage(e.rpcError) : e instanceof Error ? e.message : "Something went wrong.");
const unwrap = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new RpcFailure(r.error);
  return r.value;
};

const COUNTED = [
  ["in_progress", "In progress"],
  ["checks_pending", "Checks pending"],
  ["review_pending", "Review pending"],
  ["awaiting_acceptance", "Awaiting acceptance"],
  ["verified", "Verified"],
  ["ceiling", "At ceiling"],
] as const;

/**
 * A `decision-run` timeline row (Stage R3.5). The row holds only a reference; the card reads the
 * current run through `run.get`, refreshed by the roadmap version, and shows counts only (never the
 * run token, event details or unresolved text). Read-only: run actions stay in the panel.
 */
export function RunTimelineCard(props: PluginTimelineItemProps<RunRowData>) {
  const { theme, host, layout, item } = props;
  const { projectId, runId } = item.data;
  const compact = layout.compact;
  const version = useRoadmapVersion(host.id, projectId);
  const call = useRpc(RunGet);
  const run = useQuery({
    queryKey: [...roadmapKey(host.id, projectId), "run", runId],
    queryFn: async () => unwrap((await call({ projectId, runId })) as Result<RunGetValue>),
  });

  const view = run.data;
  let body;
  if (isGone(version.error) || isGone(run.error)) body = <Muted theme={theme}>Run no longer available</Muted>;
  else if (view) {
    const counts = COUNTED.map(([state, label]) => [label, view.run.tasks.filter((t) => t.state === state).length] as const).filter(([, n]) => n > 0);
    body = (
      <>
        <Heading theme={theme}>{`Run ${view.run.state}${view.run.pauseReason ? ` (${view.run.pauseReason})` : ""}`}</Heading>
        <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
          {counts.map(([label, n]) => (
            <Text key={label} style={{ color: theme.colors.foreground }}>{`${label}: ${n}`}</Text>
          ))}
          <Text style={{ color: theme.colors.foreground }}>{`Ready: ${view.ready.length}`}</Text>
          <Text style={{ color: theme.colors.foreground }}>{`Unresolved: ${view.unresolved?.length ?? 0}`}</Text>
        </View>
      </>
    );
  } else if (run.isError) body = <Text style={{ color: theme.colors.statusDanger }}>{errorText(run.error)}</Text>;
  else body = <Muted theme={theme}>Loading…</Muted>;

  return <View style={{ ...cardStyle(theme, { dimmed: view?.run.state === "ended" }), gap: compact ? 8 : 12, padding: compact ? 10 : 14 }}>{body}</View>;
}
