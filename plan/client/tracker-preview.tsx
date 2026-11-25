import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { TrackerApply, TrackerPreview, type Result, type RpcError, type ValueOf } from "../shared/rpc";
import { roadmapKey } from "./hooks";
import { conflictMessage } from "./layout";
import { actionLabel, payloadText, stateLabel } from "./tracker-format";
import { cardStyle } from "./theme";
import { Button, Heading, Muted } from "./ui";

type Preview = ValueOf<typeof TrackerPreview>;
type ApplyOut = ValueOf<typeof TrackerApply>;
/** A preview together with the task captions captured when it arrived. */
type Shown = { value: Preview; captions: Record<string, string> };

const errorText = (e: RpcError) =>
  e.code === "tracker_token_mismatch"
    ? "The plan, approval, tracker settings or SnailOrbit connection changed since this preview. Preview again."
    : e.code === "tracker_not_current"
      ? "The latest plan revision is no longer currently approved."
      : e.code === "tracker_unavailable"
        ? "The live tracker connection is unavailable; nothing was sent."
        : conflictMessage(e);

/**
 * Exact tracker actions for the plan's current approved revision. The preview shown is the one
 * applied: Apply sends all of its actionable ids, its token and its store revision, never values
 * from a newer fetch. Only "Preview again" replaces it. Each opening and each preview request has a
 * generation; completions from an earlier one are ignored, so a closed or reopened modal never
 * shows or applies a stale tuple. Mapped tickets and intents needing attention live in the plan
 * view's tracker list.
 */
export function TrackerPreviewModal(props: {
  hostId: string;
  projectId: string;
  planId: string;
  titles: Record<string, string>;
  theme: PluginTheme;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { hostId, projectId, planId, titles, theme, open, onOpenChange } = props;
  const previewRpc = useRpc(TrackerPreview);
  const applyRpc = useRpc(TrackerApply);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [shown, setShown] = useState<Shown | null>(null);
  const preview = shown?.value ?? null;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<ApplyOut | null>(null);
  const [conflicted, setConflicted] = useState(false);
  // Guards against a double press before React re-renders the disabled button.
  const inFlight = useRef(false);
  // Opening generation (bumped on every open/close) and preview request generation.
  const openingGen = useRef(0);
  const requestGen = useRef(0);
  const loadingRef = useRef(false);
  const titlesRef = useRef(titles);
  titlesRef.current = titles;

  async function load() {
    const opening = openingGen.current;
    const request = ++requestGen.current;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    setApplied(null);
    setConflicted(false);
    setShown(null);
    const current = () => opening === openingGen.current && request === requestGen.current;
    try {
      const out = (await previewRpc({ projectId, planId })) as Result<Preview>;
      if (!current()) return;
      if (out.ok) {
        // Captions are pinned with the preview, from the titles known when it arrived.
        const captions = Object.fromEntries(out.value.actions.map((a) => [a.taskId, titlesRef.current[a.taskId] ?? a.taskId]));
        setShown({ value: out.value, captions });
      } else setError(errorText(out.error));
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      if (current()) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    openingGen.current += 1;
    loadingRef.current = false;
    setLoading(false);
    setShown(null);
    setApplied(null);
    setConflicted(false);
    setError(null);
    if (open) void load();
    // Load once per opening; refreshing is the explicit "Preview again".
  }, [open]);

  const liveBlocked = !!preview && preview.mode === "live" && !preview.liveAvailable;
  const actionIds = preview ? preview.actions.map((a) => a.actionId).filter((x): x is string => x !== null) : [];

  async function apply() {
    // Never while a preview is loading: the confirmed tuple must be the one on screen.
    if (!preview || actionIds.length === 0 || inFlight.current || applied || conflicted || loadingRef.current || liveBlocked) return;
    inFlight.current = true;
    setApplying(true);
    const opening = openingGen.current;
    const request = requestGen.current;
    const pinned = { actionIds, confirmToken: preview.confirmToken, expectedRevision: preview.storeRevision };
    try {
      const out = (await applyRpc({ projectId, planId, ...pinned })) as Result<ApplyOut>;
      if (opening !== openingGen.current || request !== requestGen.current) return; // modal closed or reopened meanwhile
      if (out.ok) setApplied(out.value);
      else if (out.error.code === "revision_conflict") setConflicted(true); // the held tuple is never re-sent
      else toast.show(errorText(out.error), { variant: "error" });
    } catch (e) {
      if (opening === openingGen.current) toast.show(e instanceof Error ? e.message : "Apply failed", { variant: "error" });
    } finally {
      inFlight.current = false;
      setApplying(false);
      await queryClient.invalidateQueries({ queryKey: roadmapKey(hostId, projectId) });
    }
  }

  const stopped = applied?.results.some((r) => r.state === "not_attempted");
  // Result rows carry no kind; take it from the displayed preview's action of the same id.
  const kindById: Record<string, "create" | "close"> = Object.fromEntries(
    (preview?.actions ?? []).flatMap((a) => (a.actionId && a.kind !== "skip" ? [[a.actionId, a.kind] as const] : [])),
  );
  const captions = shown?.captions ?? {};

  return (
    <Modal title="Tracker actions" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        {loading ? <Muted theme={theme}>Loading preview…</Muted> : null}
        {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
        {preview ? (
          <View style={{ gap: 12 }}>
            <Muted theme={theme}>
              Mode: {preview.mode === "live" ? "Live" : "Dry run"} · New issues go to {preview.destination.provider}
              {preview.destination.projectKey ? ` / ${preview.destination.projectKey}` : ""}; each action below shows its own target.
            </Muted>
            {preview.mode === "live" && preview.liveAvailable ? (
              <Text style={{ color: theme.colors.statusWarning, fontWeight: "600" }}>
                Live mode: Apply will send these exact requests to the configured SnailOrbit connection. Reachability is checked only when you apply.
              </Text>
            ) : preview.mode === "live" ? (
              <Text style={{ color: theme.colors.statusDanger, fontWeight: "600" }}>
                Live connection unavailable ({preview.unavailableReason ?? "no live adapter"}); Apply will not send.
              </Text>
            ) : (
              <Muted theme={theme}>Dry run: Apply checks the batch and sends nothing.</Muted>
            )}
            {preview.actions.map((a, i) => (
              <View key={`${a.taskId}:${a.kind}:${i}`} style={cardStyle(theme, { dimmed: a.kind === "skip" })}>
                <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
                  {actionLabel(a.kind)} · {captions[a.taskId] ?? a.taskId}
                </Text>
                {a.destination ? (
                  <Muted theme={theme}>
                    Target: {a.destination.provider} / {a.destination.projectKey}
                  </Muted>
                ) : null}
                {a.reason ? <Muted theme={theme}>{a.reason}</Muted> : null}
                {a.payload !== null ? (
                  <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12 }}>
                    {payloadText(a.payload)}
                  </Text>
                ) : null}
              </View>
            ))}
            {applied ? null : (
              <Button
                label={actionIds.length === 0 ? "Nothing to apply" : `Apply ${actionIds.length} ${actionIds.length === 1 ? "action" : "actions"}`}
                theme={theme}
                primary
                disabled={applying || loading || conflicted || liveBlocked || actionIds.length === 0}
                onPress={() => void apply()}
              />
            )}
          </View>
        ) : null}
        {applied ? (
          <View style={{ gap: 6 }}>
            <Heading theme={theme}>Results</Heading>
            {applied.results.map((r) => (
              <Text key={r.actionId} style={{ color: r.state === "failed" ? theme.colors.statusDanger : theme.colors.foreground, fontSize: 12 }}>
                {stateLabel(r.state, kindById[r.actionId])}
                {r.remoteKey ? ` · ${r.remoteKey}` : ""}
                {r.error ? ` · ${r.error}` : ""}
              </Text>
            ))}
            {stopped ? (
              <Muted theme={theme}>
                The batch stopped, and nothing was sent for the actions marked not attempted. Either an earlier action in it failed or
                has an unknown outcome, or the plan, its approval, the tracker settings or the connection changed, or the connection
                could not be opened. Preview again to continue.
              </Muted>
            ) : null}
          </View>
        ) : null}
        {preview && preview.interrupted.length > 0 ? (
          <Muted theme={theme}>Some earlier tracker actions were interrupted; they are listed in the plan view and never resent.</Muted>
        ) : null}
        {applied?.results.some((r) => r.state === "unknown") ? (
          <Muted theme={theme}>Unknown outcomes are listed in the plan view, where you can check their status.</Muted>
        ) : null}
        {conflicted ? (
          <Text style={{ color: theme.colors.statusWarning }}>The roadmap changed. Preview again to get a fresh batch.</Text>
        ) : null}
        <Button label="Preview again" theme={theme} disabled={loading || applying} onPress={() => void load()} />
      </Modal.Content>
    </Modal>
  );
}
