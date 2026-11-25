import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { TrackerList, TrackerReconcile, TrackerResolve, type Result, type ValueOf } from "../shared/rpc";
import { roadmapKey, RpcFailure } from "./hooks";
import { conflictMessage } from "./layout";
import { intentRowLabel } from "./tracker-format";
import { Button, Heading, Muted, inputStyle } from "./ui";

type ListValue = ValueOf<typeof TrackerList>;
type Reconciled = ValueOf<typeof TrackerReconcile>;
type Resolved = ValueOf<typeof TrackerResolve>;
/** Identity of the intent being resolved, pinned when its dialog opens. */
type ResolveTarget = { intentId: string; planRev: number; kind: "create" | "close"; storeRevision: number; title: string; mode: "link" | "not_created" };

const CONFIRM_TEXT = {
  create: "I checked SnailOrbit and no ticket was created for this task. A fresh preview may create it again.",
  close: "I checked SnailOrbit and this ticket was not closed. A fresh preview may offer the close again.",
} as const;

/**
 * Mapped tickets and tracker intents that need attention, for any plan, whatever its approval state
 * or the tracker settings. Read-only: Check status never resolves, retries or closes anything.
 */
export function TrackerListSection(props: {
  hostId: string;
  projectId: string;
  planId: string;
  titles: Record<string, string>;
  theme: PluginTheme;
}) {
  const { hostId, projectId, planId, titles, theme } = props;
  const listRpc = useRpc(TrackerList);
  const reconcileRpc = useRpc(TrackerReconcile);
  const resolveRpc = useRpc(TrackerResolve);
  const queryClient = useQueryClient();
  const [checks, setChecks] = useState<Record<string, Reconciled | string>>({});
  const [target, setTarget] = useState<ResolveTarget | null>(null);
  const [remoteKey, setRemoteKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const query = useQuery({
    queryKey: [...roadmapKey(hostId, projectId), "tracker-list", planId],
    queryFn: async () => {
      const out = (await listRpc({ projectId, planId })) as Result<ListValue>;
      if (!out.ok) throw new RpcFailure(out.error);
      return out.value;
    },
  });

  async function check(intentId: string) {
    try {
      const out = (await reconcileRpc({ projectId, planId, intentId })) as Result<Reconciled>;
      setChecks((c) => ({ ...c, [intentId]: out.ok ? out.value : out.error.message }));
    } catch (e) {
      setChecks((c) => ({ ...c, [intentId]: e instanceof Error ? e.message : "Check failed" }));
    }
  }

  async function submitResolve() {
    if (!target || busy) return;
    if (target.mode === "link" && !/^[A-Za-z0-9_.-]{1,128}$/.test(remoteKey.trim())) {
      setOutcome("Enter the ticket key, for example SYN-42.");
      return;
    }
    setBusy(true);
    setOutcome(null);
    const pinned = target;
    try {
      const out = (await resolveRpc({
        projectId,
        planId,
        intentId: pinned.intentId,
        planRev: pinned.planRev,
        expectedRevision: pinned.storeRevision,
        resolution: pinned.mode === "link" ? { kind: "link", remoteKey: remoteKey.trim() } : { kind: "not_created", confirm: true },
      })) as Result<Resolved>;
      if (out.ok) {
        setTarget(null);
        setRemoteKey("");
        setOutcome(null);
      } else {
        // Keep the dialog and the typed key so the person can retry after reviewing.
        setOutcome(conflictMessage(out.error));
      }
    } catch (e) {
      setOutcome(e instanceof Error ? e.message : "Resolve failed");
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: roadmapKey(hostId, projectId) });
    }
  }

  const task = (taskId: string | null, planRev: number | null) =>
    taskId === null ? "Unknown task" : `${titles[taskId] ?? taskId}${planRev !== null ? ` · rev ${planRev}` : ""}`;

  if (query.isError) return <Muted theme={theme}>Tracker records could not be loaded.</Muted>;
  const list = query.data;
  if (!list) return <Muted theme={theme}>Loading tracker records…</Muted>;

  return (
    <View style={{ gap: 6 }}>
      <Heading theme={theme}>Tickets</Heading>
      {list.tickets.length === 0 ? <Muted theme={theme}>No tickets created.</Muted> : null}
      {list.tickets.map((t) => (
        <Text key={t.intentId} selectable style={{ color: theme.colors.foreground, fontSize: 12 }}>
          {t.remoteKey} · {t.state === "created" ? "Open" : "Closed"} · {task(t.taskId, t.planRev)} · {t.url}
        </Text>
      ))}
      {list.intents.length > 0 ? <Heading theme={theme}>Needs attention</Heading> : null}
      {list.intents.map((x) => {
        const c = checks[x.intentId];
        return (
          <View key={x.intentId} style={{ gap: 2 }}>
            <Text style={{ color: x.state === "failed" ? theme.colors.statusDanger : theme.colors.statusWarning, fontSize: 12 }}>
              {intentRowLabel(x.state, x.interrupted)} · {x.kind} · {task(x.taskId, x.planRev)}
              {x.errorClass ? ` · ${x.errorClass}` : ""}
            </Text>
            {x.state !== "failed" ? (
              <>
                <Muted theme={theme}>Needs a decision; it is never resent automatically.</Muted>
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  <Button label="Check status" theme={theme} onPress={() => void check(x.intentId)} />
                  {x.state === "unknown" || x.interrupted ? (
                    <>
                      <Button
                        label={x.kind === "close" ? "Confirm it is closed" : "Link ticket"}
                        theme={theme}
                        onPress={() => {
                          setRemoteKey("");
                          setOutcome(null);
                          setTarget({ intentId: x.intentId, planRev: x.planRev, kind: x.kind === "close" ? "close" : "create", storeRevision: list.revision, title: task(x.taskId, x.planRev), mode: "link" });
                        }}
                      />
                      <Button
                        label={x.kind === "close" ? "Confirm not closed" : "Confirm not created"}
                        theme={theme}
                        onPress={() => {
                          setOutcome(null);
                          setTarget({ intentId: x.intentId, planRev: x.planRev, kind: x.kind === "close" ? "close" : "create", storeRevision: list.revision, title: task(x.taskId, x.planRev), mode: "not_created" });
                        }}
                      />
                    </>
                  ) : null}
                </View>
              </>
            ) : null}
            {c === undefined ? null : typeof c === "string" ? (
              <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{c}</Text>
            ) : (
              <Muted theme={theme}>
                Status: {c.state}
                {c.remoteKey ? ` · ${c.remoteKey}` : ""}
              </Muted>
            )}
          </View>
        );
      })}
      <Modal title="Resolve tracker action" open={target !== null} onOpenChange={(open) => !open && !busy && setTarget(null)}>
        <Modal.Content>
          {target ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: theme.colors.foreground }}>{target.title}</Text>
              {target.mode === "link" ? (
                <>
                  <Muted theme={theme}>
                    {target.kind === "close"
                      ? "Enter the key of the original ticket. It is checked in SnailOrbit and must be closed; nothing is changed there."
                      : "Enter the key of the ticket you found in SnailOrbit. It is checked there (read only) and must belong to the same project."}
                  </Muted>
                  <TextInput
                    accessibilityLabel="Ticket key"
                    placeholder="SYN-42"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    autoCapitalize="characters"
                    value={remoteKey}
                    onChangeText={setRemoteKey}
                    style={inputStyle(theme)}
                  />
                  <Button label="Link" theme={theme} primary disabled={busy || remoteKey.trim() === ""} onPress={() => void submitResolve()} />
                </>
              ) : (
                <>
                  <Text style={{ color: theme.colors.foreground }}>{CONFIRM_TEXT[target.kind]}</Text>
                  <Button label="I confirm" theme={theme} primary disabled={busy} onPress={() => void submitResolve()} />
                </>
              )}
              {outcome ? <Text style={{ color: theme.colors.statusDanger }}>{outcome}</Text> : null}
              <Muted theme={theme}>Recorded as a decision made in the Paseo UI; the plugin cannot prove who confirmed it.</Muted>
            </View>
          ) : null}
        </Modal.Content>
      </Modal>
    </View>
  );
}
