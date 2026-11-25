import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { StatusLabel, StatusTone } from "./view-model";
import { statusTone } from "./view-model";

export type Colors = PluginTheme["colors"];

export const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export function toneColor(colors: Colors, tone: StatusTone): string {
  switch (tone) {
    case "muted":
      return colors.foregroundMuted;
    case "accent":
      return colors.accent;
    case "warning":
      return colors.statusWarning;
    case "danger":
      return colors.statusDanger;
    case "success":
      return colors.statusSuccess;
  }
}

/** The amber of the rework arrow and the human-gate marker. */
export function amber(colors: Colors): string {
  return colors.statusWarning;
}

type ButtonProps = {
  colors: Colors;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  testID?: string;
  hint?: string;
  compact?: boolean;
};

export function Button({ colors, label, onPress, disabled = false, primary = false, danger = false, testID, hint, compact = false }: ButtonProps) {
  const background = disabled ? colors.surface2 : primary ? colors.accent : colors.surface2;
  const color = disabled ? colors.foregroundMuted : primary ? colors.accentForeground : danger ? colors.statusDanger : colors.foreground;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ paddingHorizontal: compact ? 10 : 14, paddingVertical: compact ? 5 : 7, borderRadius: 6, backgroundColor: background, borderWidth: 1, borderColor: primary && !disabled ? colors.accent : colors.border }}
    >
      <Text style={{ color, fontSize: compact ? 12 : 13, fontWeight: primary ? "600" : "400" }}>{label}</Text>
    </Pressable>
  );
}

export function Banner({ colors, tone, text, testID, children }: { colors: Colors; tone: "success" | "danger" | "warning" | "info"; text: string; testID?: string; children?: ReactNode }) {
  const color = tone === "success" ? colors.statusSuccess : tone === "danger" ? colors.statusDanger : tone === "warning" ? colors.statusWarning : colors.accent;
  return (
    <View testID={testID} accessibilityRole="alert" style={{ padding: 8, borderRadius: 6, borderWidth: 1, borderColor: color, gap: 6 }}>
      <Text style={{ color, fontSize: 12 }}>{text}</Text>
      {children}
    </View>
  );
}

export function StatusChip({ colors, label }: { colors: Colors; label: StatusLabel }) {
  const color = toneColor(colors, statusTone(label));
  return (
    <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, borderWidth: 1, borderColor: color, alignSelf: "flex-start" }}>
      <Text style={{ color, fontSize: 11 }}>{label}</Text>
    </View>
  );
}

/** The one marker Diagram and Task list both draw for a job waiting for a person. */
export function WaitMarker({ colors, marker }: { colors: Colors; marker: "needs-review" | "needs-attention" }) {
  const label = marker === "needs-review" ? "Needs review" : "Needs attention";
  const color = marker === "needs-review" ? amber(colors) : colors.statusDanger;
  return (
    <View accessibilityLabel={label} testID={`marker-${marker}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function GateMarker({ colors }: { colors: Colors }) {
  return (
    <View accessibilityLabel="Human gate" style={{ paddingHorizontal: 5, borderRadius: 4, backgroundColor: amber(colors) }}>
      <Text style={{ color: colors.surface0, fontSize: 10, fontWeight: "700" }}>HUMAN</Text>
    </View>
  );
}

export function SectionTitle({ colors, text }: { colors: Colors; text: string }) {
  return <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", marginTop: 6 }}>{text}</Text>;
}

export function Muted({ colors, text, mono = false }: { colors: Colors; text: string; mono?: boolean }) {
  return <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontFamily: mono ? MONOSPACE : undefined }}>{text}</Text>;
}

export function Segmented<T extends string>({ colors, options, value, onChange, compact }: { colors: Colors; options: ReadonlyArray<{ id: T; label: string }>; value: T; onChange: (id: T) => void; compact: boolean }) {
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", borderRadius: 8, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <Pressable
            key={option.id}
            testID={`tab-${option.id}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.id)}
            style={{ flex: compact ? 1 : undefined, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: active ? colors.surface2 : colors.surface1 }}
          >
            <Text style={{ color: active ? colors.foreground : colors.foregroundMuted, textAlign: "center", fontSize: 13 }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
