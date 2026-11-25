import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import type { ExpandedGraph } from "../shared/workflow";
import { fitZoom, GROUP_LABEL, layoutGraph, NODE_HEIGHT, NODE_WIDTH, stepZoom, type LayoutRoute, type Point } from "./graph-layout";
import { amber, Button, GateMarker, StatusChip, WaitMarker, type Colors } from "./ui";
import type { JobRow } from "./view-model";

type GraphViewProps = {
  graph: ExpandedGraph;
  rows: readonly JobRow[];
  colors: Colors;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd?: (() => void) | null;
};

/** The workflow or run graph in dependency layers, with Fit to screen and zoom. */
export function GraphView({ graph, rows, colors, selectedId, onSelect, onAdd }: GraphViewProps) {
  // Live run updates replace the graph object; the layout and zoom change only with its structure.
  const shape = useMemo(() => JSON.stringify([graph.jobs.map((job) => [job.id, job.matrix !== undefined, job.matrixIndex ?? null]), graph.edges, graph.groups, graph.reworks]), [graph]);
  const [layout, setLayout] = useState(() => ({ shape, value: layoutGraph(graph) }));
  if (layout.shape !== shape) setLayout({ shape, value: layoutGraph(graph) });
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  // Null follows the fit; a manual zoom sticks until Fit is pressed again.
  const [manual, setManual] = useState<number | null>(null);
  const [manualShape, setManualShape] = useState(shape);
  if (manualShape !== shape) {
    setManualShape(shape);
    setManual(null);
  }
  const fitted = viewport ? fitZoom(layout.value, viewport) : 1;
  const scale = manual ?? fitted;
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport((previous) => (previous && previous.width === width && previous.height === height ? previous : { width, height }));
  };
  const s = (value: number): number => value * scale;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", gap: 6, padding: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button colors={colors} compact label="Fit to screen" testID="diagram-fit" onPress={() => setManual(null)} />
        <Button colors={colors} compact label="Zoom out" testID="diagram-zoom-out" onPress={() => setManual(stepZoom(scale, -1))} />
        <Button colors={colors} compact label="Zoom in" testID="diagram-zoom-in" onPress={() => setManual(stepZoom(scale, 1))} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{Math.round(scale * 100)}%</Text>
        {onAdd ? <Button colors={colors} compact primary label="Add block" testID="diagram-add" onPress={onAdd} /> : null}
      </View>
      <View style={{ flex: 1 }} onLayout={onLayout}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ minHeight: s(layout.value.height) }}>
          <ScrollView horizontal contentContainerStyle={{ width: s(layout.value.width), height: s(layout.value.height) }}>
            <View accessibilityLabel="Workflow diagram" style={{ width: s(layout.value.width), height: s(layout.value.height) }}>
              {layout.value.groups.map((group) => (
                <View
                  key={`group-${group.id}`}
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: s(group.x),
                    top: s(group.y),
                    width: s(group.width),
                    height: s(group.height),
                    borderWidth: 1,
                    borderStyle: "dashed",
                    borderRadius: s(8),
                    borderColor: group.pending ? colors.foregroundMuted : colors.border,
                    backgroundColor: colors.surface1,
                  }}
                >
                  <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: Math.max(8, s(11)), marginLeft: s(8), height: s(GROUP_LABEL), lineHeight: s(GROUP_LABEL) }}>
                    {group.kind === "tasks" ? "Tasks" : "Matrix"} · {group.id}
                    {group.pending ? " · expands at run time" : ""}
                  </Text>
                </View>
              ))}
              {layout.value.routes.map((route, index) => (
                <Route key={`route-${index}`} route={route} scale={scale} color={route.kind === "rework" ? amber(colors) : colors.foregroundMuted} />
              ))}
              {layout.value.nodes.map((node) => {
                const row = rowById.get(node.id);
                if (!row) return null;
                const selected = node.id === selectedId;
                return (
                  <Pressable
                    key={node.id}
                    testID={`node-${node.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${row.title}${row.label ? `, ${row.label}` : ""}`}
                    accessibilityState={{ selected }}
                    onPress={() => onSelect(node.id)}
                    style={{
                      position: "absolute",
                      left: s(node.x),
                      top: s(node.y),
                      width: s(NODE_WIDTH),
                      height: s(NODE_HEIGHT),
                      padding: s(8),
                      gap: s(3),
                      borderRadius: s(8),
                      borderWidth: selected ? 2 : 1,
                      borderColor: selected ? colors.accent : row.humanGate ? amber(colors) : colors.border,
                      backgroundColor: colors.surface2,
                      overflow: "hidden",
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: s(4) }}>
                      <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontWeight: "600", fontSize: Math.max(8, s(13)) }}>
                        {row.title}
                      </Text>
                      {row.humanGate ? <GateMarker colors={colors} /> : null}
                    </View>
                    <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: Math.max(7, s(11)) }}>
                      {row.subtitle ? `${row.subtitle} · ` : ""}
                      {row.uses} · {row.kind}
                      {row.criteria > 0 ? ` · ${row.criteria} criteria` : ""}
                      {row.checks > 0 ? ` · ${row.checks} checks` : ""}
                    </Text>
                    {row.agent ? (
                      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: Math.max(7, s(11)) }}>
                        {row.agent}
                      </Text>
                    ) : null}
                    <View style={{ flexDirection: "row", gap: s(6), alignItems: "center" }}>
                      {row.label ? <StatusChip colors={colors} label={row.label} /> : null}
                      {row.marker ? <WaitMarker colors={colors} marker={row.marker} /> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}

const STROKE = 2;
const ARROW = 6;

function Route({ route, scale, color }: { route: LayoutRoute; scale: number; color: string }) {
  const dashed = route.kind === "rework";
  const segments: Array<{ a: Point; b: Point }> = [];
  for (let i = 0; i + 1 < route.points.length; i += 1) {
    const a = route.points[i];
    const b = route.points[i + 1];
    if (a && b) segments.push({ a, b });
  }
  const end = route.points[route.points.length - 1];
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0 }} testID={`route-${route.kind}-${route.from}-${route.to}`}>
      {segments.map(({ a, b }, index) => {
        const horizontal = a.y === b.y;
        const left = Math.min(a.x, b.x) * scale;
        const top = Math.min(a.y, b.y) * scale;
        const length = (horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)) * scale;
        return (
          <View
            key={index}
            style={
              horizontal
                ? { position: "absolute", left, top: top - STROKE / 2, width: length, height: 0, borderTopWidth: STROKE, borderColor: color, borderStyle: dashed ? "dashed" : "solid" }
                : { position: "absolute", left: left - STROKE / 2, top, width: 0, height: length, borderLeftWidth: STROKE, borderColor: color, borderStyle: dashed ? "dashed" : "solid" }
            }
          />
        );
      })}
      {end ? (
        <View
          style={{
            position: "absolute",
            left: end.x * scale - ARROW,
            top: end.y * scale - ARROW / 2 - 1,
            width: 0,
            height: 0,
            borderTopWidth: ARROW / 2 + 1,
            borderBottomWidth: ARROW / 2 + 1,
            borderLeftWidth: ARROW,
            borderTopColor: "transparent",
            borderBottomColor: "transparent",
            borderLeftColor: color,
          }}
        />
      ) : null}
    </View>
  );
}
