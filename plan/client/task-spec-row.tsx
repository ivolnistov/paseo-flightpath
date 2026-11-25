// One task of a plan revision as approval would create it (Stage R1.2). Read-only.
import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { TaskSpecView } from "./plan-format";
import { cardStyle } from "./theme";
import { Muted } from "./ui";

export function TaskSpecRow(props: { spec: TaskSpecView; titles: Record<string, string>; theme: PluginTheme; compact: boolean }) {
  const { spec, titles, theme } = props;
  const v2 = spec.v2;
  return (
    <View style={[cardStyle(theme, { dimmed: false }), { gap: 4, minWidth: 0 }]}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{spec.title}</Text>
      {spec.description ? <Muted theme={theme}>{spec.description}</Muted> : null}
      {v2 ? (
        <View style={{ gap: 4 }}>
          {v2.dependsOn.length > 0 ? <Muted theme={theme}>{`Depends on: ${v2.dependsOn.map((id) => titles[id] ?? id).join(", ")}`}</Muted> : null}
          {v2.parallel ? <Muted theme={theme}>Parallel</Muted> : null}
          <Muted theme={theme}>
            {v2.completion === "human" ? "Completion: needs human acceptance" : "Completion: automatic after checks and review"}
          </Muted>
          <Muted theme={theme}>{v2.grill ? "Grill: yes" : "Grill: no"}</Muted>
          {v2.dodItems.length === 0 ? (
            <Muted theme={theme}>No DoD yet</Muted>
          ) : (
            v2.dodItems.map((item) => (
              <Text key={item.index} style={{ color: theme.colors.foreground }}>
                {item.kind === "check" ? `Check: ${item.command}` : item.text}
              </Text>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}
