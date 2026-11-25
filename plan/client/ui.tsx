// Small themed building blocks shared by the roadmap components.
import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { QuestionStatus } from "../shared/status";
import { STATUS_LABEL, statusColor, TARGET_SIZE } from "./theme";

/** A plain text button with the same 44 px target as `ActionButton`. */
export function Button(props: {
  label: string;
  onPress(): void;
  theme: PluginTheme;
  disabled?: boolean;
  primary?: boolean;
}) {
  const { theme, primary, disabled } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={props.onPress}
      style={{
        minHeight: TARGET_SIZE,
        minWidth: TARGET_SIZE,
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

export function StatusChip({ status, theme }: { status: QuestionStatus; theme: PluginTheme }) {
  const color = statusColor(status, theme);
  return (
    <View style={{ borderColor: color, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, alignSelf: "flex-start" }}>
      <Text style={{ color, fontSize: 12 }}>{STATUS_LABEL[status]}</Text>
    </View>
  );
}

export function Muted({ children, theme }: { children: ReactNode; theme: PluginTheme }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{children}</Text>;
}

export function Heading({ children, theme }: { children: ReactNode; theme: PluginTheme }) {
  return <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{children}</Text>;
}

/** Tap-to-toggle row used for selections and switches. */
export function Toggle(props: { label: string; value: boolean; onChange(value: boolean): void; theme: PluginTheme; disabled?: boolean }) {
  const { theme, value } = props;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: value, disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onChange(!value)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: value ? theme.colors.accent : theme.colors.border,
          backgroundColor: value ? theme.colors.accent : "transparent",
        }}
      />
      <Text style={{ color: theme.colors.foreground }}>{props.label}</Text>
    </Pressable>
  );
}

export function inputStyle(theme: PluginTheme) {
  return {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  } as const;
}
