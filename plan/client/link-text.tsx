// Pressable roadmap references inside text the plugin renders itself (history, notes, cards):
// canonical roadmap:// links and short Q<n> references become link-role controls; everything else,
// malformed links included, stays plain text. Host-rendered chat message bodies are not touched.
import type { PluginTheme } from "@getpaseo/plugin";
import { Text } from "react-native";
import { parseLink, parseShortRef, type ParsedLink } from "../shared/links";

export type Segment = { kind: "text"; text: string } | { kind: "link"; raw: string; link: ParsedLink } | { kind: "short"; raw: string; number: number };

// Link paths use only id characters and slashes, so trailing punctuation stays text.
const TOKEN = /roadmap:\/\/[A-Za-z0-9_/-]+|\bQ[0-9]+\b/g;

export function splitLinks(text: string): Segment[] {
  const out: Segment[] = [];
  const pushText = (t: string) => {
    if (t === "") return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0];
    const index = m.index;
    pushText(text.slice(at, index));
    const link = raw.startsWith("roadmap://") ? parseLink(raw) : null;
    const number = link === null && !raw.startsWith("roadmap://") ? parseShortRef(raw) : null;
    if (link !== null) out.push({ kind: "link", raw, link });
    else if (number !== null) out.push({ kind: "short", raw, number });
    else pushText(raw);
    at = index + raw.length;
  }
  pushText(text.slice(at));
  return out;
}

export function LinkText(props: { text: string; theme: PluginTheme; onOpen(target: ParsedLink | number): void; color?: string }) {
  const { text, theme, onOpen } = props;
  return (
    <Text style={{ color: props.color ?? theme.colors.foreground, flexShrink: 1 }}>
      {splitLinks(text).map((s, i) =>
        s.kind === "text" ? (
          s.text
        ) : (
          <Text
            key={i}
            accessibilityRole="link"
            accessibilityLabel={`Open ${s.raw}`}
            onPress={() => onOpen(s.kind === "link" ? s.link : s.number)}
            style={{ color: theme.colors.accent, textDecorationLine: "underline" }}
          >
            {s.raw}
          </Text>
        ),
      )}
    </Text>
  );
}
