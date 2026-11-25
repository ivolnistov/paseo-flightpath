import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Proposal } from "../shared/rpc";
import type { Workflow } from "../shared/workflow";
import { Banner, Button, MONOSPACE, Muted, SectionTitle, type Colors } from "./ui";
import { lineDiff, proposalDelta, proposalState } from "./view-model";

type ProposalPreviewProps = {
  colors: Colors;
  compact: boolean;
  proposal: Proposal;
  /** The editable text and model the proposal would replace. */
  baseText: string;
  baseModel: Workflow | null;
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
  onClose: () => void;
};

const MAX_DIFF_LINES = 400;

/** An AI proposal: line diff, added, removed and changed jobs, diagnostics, Apply and Discard. */
export function ProposalPreview({ colors, compact, proposal, baseText, baseModel, busy, onApply, onDiscard, onClose }: ProposalPreviewProps) {
  const delta = useMemo(() => proposalDelta(baseModel, proposal.model), [baseModel, proposal.model]);
  const diff = useMemo(() => lineDiff(baseText, proposal.yaml).filter((line, index, all) => line.kind !== "same" || all[index - 1]?.kind !== "same" || all[index + 1]?.kind !== "same"), [baseText, proposal.yaml]);
  const state = proposalState(proposal);
  const pending = proposal.status === "pending" || proposal.status === "stale";
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: compact ? 12 : 16, gap: 8 }} testID="proposal-preview">
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 16, fontWeight: "600" }}>AI proposal</Text>
        <Button colors={colors} compact label="Close" onPress={onClose} />
      </View>
      <Text style={{ color: colors.foreground }}>{proposal.summary}</Text>
      <Muted colors={colors} text={`${proposal.status} · ${proposal.createdAt} · agent ${proposal.agentId}`} />
      {state.reason ? <Banner colors={colors} tone="warning" text={state.reason} testID="proposal-blocked" /> : null}
      <SectionTitle colors={colors} text="Jobs" />
      <Muted colors={colors} text={`Added: ${delta.added.join(", ") || "none"}`} />
      <Muted colors={colors} text={`Removed: ${delta.removed.join(", ") || "none"}`} />
      <Muted colors={colors} text={`Changed: ${delta.changed.join(", ") || "none"}`} />
      {proposal.diagnostics.length > 0 ? (
        <View style={{ gap: 2 }}>
          <SectionTitle colors={colors} text="Diagnostics" />
          {proposal.diagnostics.map((diagnostic, index) => (
            <Text key={index} style={{ color: colors.statusDanger, fontFamily: MONOSPACE, fontSize: 12 }}>
              {diagnostic.line > 0 ? `${diagnostic.line}:${diagnostic.column}` : "—"} [{diagnostic.code}] {diagnostic.message}
            </Text>
          ))}
        </View>
      ) : null}
      <SectionTitle colors={colors} text="Line diff" />
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: 6 }}>
        {diff.slice(0, MAX_DIFF_LINES).map((line, index) => (
          <Text key={index} style={{ fontFamily: MONOSPACE, fontSize: 12, color: line.kind === "added" ? colors.statusSuccess : line.kind === "removed" ? colors.statusDanger : colors.foregroundMuted }}>
            {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
            {line.text}
          </Text>
        ))}
        {diff.length > MAX_DIFF_LINES ? <Muted colors={colors} text={`${diff.length - MAX_DIFF_LINES} more lines`} /> : null}
      </View>
      {pending ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button colors={colors} primary label="Apply" testID="proposal-apply" disabled={!state.canApply || busy} onPress={onApply} hint="Writes the proposal into the draft" />
          <Button colors={colors} label="Discard" testID="proposal-discard" disabled={busy} onPress={onDiscard} />
        </View>
      ) : null}
    </ScrollView>
  );
}
