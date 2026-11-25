import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import { usePlanList } from "./hooks";
import { approvalColorKey, approvalLabel } from "./plan-format";
import { cardStyle } from "./theme";
import { Heading, Muted } from "./ui";

/** Overview section: plans with their latest revision and approval state. */
export function PlansList(props: { hostId: string; projectId: string; theme: PluginTheme; onOpen(planId: string): void }) {
  const { hostId, projectId, theme, onOpen } = props;
  const plans = usePlanList(hostId, projectId);
  return (
    <View style={{ gap: 8, paddingTop: 12 }}>
      <Heading theme={theme}>Plans</Heading>
      {plans.isError ? <Text style={{ color: theme.colors.statusDanger }}>Plans could not be loaded.</Text> : null}
      {plans.data && plans.data.plans.length === 0 ? (
        <Muted theme={theme}>No plans yet. An agent drafts one from decided questions.</Muted>
      ) : null}
      {plans.data?.plans.map((p) => (
        <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={`Open plan ${p.title}`} onPress={() => onOpen(p.id)} style={cardStyle(theme, { dimmed: false })}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{p.title}</Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Muted theme={theme}>{p.latestRev === null ? "No revision" : `Rev ${p.latestRev}`}</Muted>
            <Text style={{ color: theme.colors[approvalColorKey(p.approval)], fontSize: 12 }}>{approvalLabel(p.approval)}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}
