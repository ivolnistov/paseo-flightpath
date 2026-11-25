import type { PluginTheme } from "@getpaseo/plugin";
import type { ViewStyle } from "react-native";
import type { FeatureStatus } from "../shared/model";
import type { QuestionStatus } from "../shared/status";

export function statusColor(status: QuestionStatus, theme: PluginTheme): string {
  switch (status) {
    case "open":
      return theme.colors.accent;
    case "answered":
      return theme.colors.statusSuccess;
    case "stale":
      return theme.colors.statusWarning;
    case "skipped":
    case "out_of_scope":
    case "inactive":
      return theme.colors.foregroundMuted;
  }
}

export { STATUS_LABEL } from "./status-label";

export function cardStyle(theme: PluginTheme, opts: { dimmed: boolean }): ViewStyle {
  return {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 6,
    opacity: opts.dimmed ? 0.5 : 1,
  };
}

/** Minimum touch target in both axes (44 px). */
export const TARGET_SIZE = 44;

export const FEATURE_STATUS_LABEL: Record<FeatureStatus, string> = {
  created: "Created",
  planned: "Planned",
  executing: "Executing",
  done: "Done",
  deferred: "Deferred",
  cancelled: "Cancelled",
};

export function featureStatusColor(status: FeatureStatus, theme: PluginTheme): string {
  switch (status) {
    case "created":
    case "deferred":
      return theme.colors.foregroundMuted;
    case "planned":
      return theme.colors.accent;
    case "executing":
      return theme.colors.statusWarning;
    case "done":
      return theme.colors.statusSuccess;
    case "cancelled":
      return theme.colors.statusDanger;
  }
}
