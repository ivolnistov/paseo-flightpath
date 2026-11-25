import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Button, GateMarker, StatusChip, WaitMarker, type Colors } from "./ui";
import type { JobRow } from "./view-model";

type JobListProps = {
  rows: readonly JobRow[];
  colors: Colors;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd?: (() => void) | null;
  /** Shown above the rows, such as the run's blockers. */
  header?: ReactNode;
};

/** The Task list: one row per job in graph order, group members under their group's heading. */
export function JobList({ rows, colors, selectedId, onSelect, onAdd, header }: JobListProps) {
  let previousGroup: string | null = null;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 10, gap: 6 }} accessibilityLabel="Task list">
      {header}
      {onAdd ? (
        <View style={{ flexDirection: "row" }}>
          <Button colors={colors} compact primary label="Add block" testID="list-add" onPress={onAdd} />
        </View>
      ) : null}
      {rows.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>No jobs yet.</Text> : null}
      {rows.map((row) => {
        const groupKey = row.group ? `${row.group.kind}:${row.group.id}` : null;
        const heading = groupKey !== null && groupKey !== previousGroup ? row.group : null;
        previousGroup = groupKey;
        const selected = row.id === selectedId;
        return (
          <View key={row.id} style={{ gap: 4 }}>
            {heading ? (
              <Text style={{ color: colors.foregroundMuted, fontSize: 12, marginTop: 6 }}>
                {heading.kind === "tasks" ? "Tasks" : "Matrix"} · {heading.id}
              </Text>
            ) : null}
            <Pressable
              testID={`row-${row.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${row.title}${row.label ? `, ${row.label}` : ""}`}
              accessibilityState={{ selected }}
              onPress={() => onSelect(row.id)}
              style={{
                marginLeft: row.group ? 12 : 0,
                padding: 10,
                gap: 4,
                borderRadius: 8,
                borderWidth: selected ? 2 : 1,
                borderColor: selected ? colors.accent : colors.border,
                backgroundColor: colors.surface1,
                opacity: row.retired ? 0.6 : 1,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 14, flexShrink: 1 }}>{row.title}</Text>
                {row.humanGate ? <GateMarker colors={colors} /> : null}
                {row.label ? <StatusChip colors={colors} label={row.label} /> : null}
                {row.marker ? <WaitMarker colors={colors} marker={row.marker} /> : null}
              </View>
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                {row.subtitle ? `${row.subtitle} · ` : ""}
                {row.id} · {row.uses} · {row.kind}
                {row.agent ? ` · ${row.agent}` : ""}
              </Text>
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                {row.criteria > 0 ? `${row.criteria} acceptance criteria` : "No text criteria"}
                {row.checks > 0 ? ` · ${row.checks} checks` : ""}
                {row.needs.length > 0 ? ` · needs ${row.needs.join(", ")}` : ""}
                {row.attempts > 0 ? ` · ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}` : ""}
                {row.retired ? " · retired" : ""}
              </Text>
              {row.reason && row.status !== "succeeded" ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{row.reason}</Text> : null}
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}
