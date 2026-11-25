import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { Diagnostic } from "../shared/workflow";
import { Banner, Button, MONOSPACE, type Colors } from "./ui";
import { highlightSpans, lineIndexOf, markRange, tokenizeYaml, type Span, type TextRange } from "./yaml-text";

export const EDITOR_FONT_SIZE = 13;
export const EDITOR_LINE_HEIGHT = 19;
const EDITOR_PADDING = 10;
/** Each mark splits the overlay text, so very long lists mark only their head and the active one. */
const MAX_MARKS = 50;
/** Very large texts skip syntax colors so typing stays responsive. */
const MAX_HIGHLIGHT_CHARS = 200_000;

/** A theme hex color with alpha, or the color unchanged when it is not `#rrggbb`. */
export function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  const value = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${value}`;
}

function spanColor(colors: Colors, span: Span): string {
  switch (span.kind) {
    case "comment":
      return colors.foregroundMuted;
    case "key":
      return colors.accent;
    case "literal":
      return colors.statusWarning;
    case "anchor":
      return colors.statusSuccess;
    case "punctuation":
      return colors.foregroundMuted;
    case "value":
    case "plain":
      return colors.foreground;
  }
}

type YamlViewProps = {
  colors: Colors;
  compact: boolean;
  text: string;
  diagnostics: readonly Diagnostic[];
  status: string;
  canSave: boolean;
  canDiscard: boolean;
  busy: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  onDiscard: () => void;
};

/**
 * The editable YAML with syntax colors and diagnostic marks. A colored copy of the text is drawn
 * over the input with the same font, line height, padding and width, inside the same scroll view,
 * so both scroll and wrap together; the copy ignores touches.
 */
/**
 * The highlight overlay is the only visible text layer; the input keeps the caret, selection and
 * accessibility with transparent glyphs. `caretColor` is a web style that native platforms ignore.
 */
export function editorInputStyle<T extends object>(colors: Pick<Colors, "foreground">, textStyle: T): T & { padding: number; margin: number; borderWidth: number; minHeight: number; color: string; caretColor: string; backgroundColor: string } {
  return { ...textStyle, padding: 0, margin: 0, borderWidth: 0, minHeight: 200, color: "transparent", caretColor: colors.foreground, backgroundColor: "transparent" };
}

export function YamlView({ colors, compact, text, diagnostics, status, canSave, canDiscard, busy, onChange, onSave, onDiscard }: YamlViewProps) {
  const input = useRef<TextInput>(null);
  const scroll = useRef<ScrollView>(null);
  const [active, setActive] = useState<{ list: readonly Diagnostic[]; index: number } | null>(null);
  const activeIndex = active?.list === diagnostics ? active.index : null;
  const ranges = useMemo(() => diagnostics.map((diagnostic) => markRange(text, diagnostic)), [text, diagnostics]);
  const spans = useMemo(() => {
    const marks: Array<TextRange & { active: boolean }> = [];
    ranges.forEach((range, index) => {
      if (range && (marks.length < MAX_MARKS || index === activeIndex)) marks.push({ ...range, active: index === activeIndex });
    });
    return highlightSpans(text, text.length > MAX_HIGHLIGHT_CHARS ? [] : tokenizeYaml(text), marks);
  }, [text, ranges, activeIndex]);

  const reveal = (index: number) => {
    const range = ranges[index];
    if (!range) return;
    setActive({ list: diagnostics, index });
    scroll.current?.scrollTo({ y: Math.max(0, lineIndexOf(text, range.start) * EDITOR_LINE_HEIGHT - EDITOR_LINE_HEIGHT * 2), animated: true });
    input.current?.focus();
    input.current?.setSelection(range.start, range.end);
  };

  const textStyle = { fontFamily: MONOSPACE, fontSize: EDITOR_FONT_SIZE, lineHeight: EDITOR_LINE_HEIGHT };
  const inputStyle = editorInputStyle(colors, textStyle);
  return (
    <View style={{ flex: 1, padding: compact ? 8 : 12, gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button colors={colors} primary label={busy ? "Saving…" : "Save"} disabled={!canSave} onPress={onSave} testID="yaml-save" hint="Publishes the draft as the saved workflow" />
        <Button colors={colors} label="Discard" disabled={!canDiscard || busy} onPress={onDiscard} testID="yaml-discard" hint="Drops the draft and restores the saved text" />
        <Text testID="yaml-status" style={{ color: colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
          {status}
        </Text>
      </View>
      <View style={{ flex: 1, minHeight: 220, borderRadius: 8, borderWidth: 1, borderColor: diagnostics.length > 0 ? colors.statusDanger : colors.border, backgroundColor: colors.surface1, overflow: "hidden" }}>
        <ScrollView ref={scroll} style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
          <View style={{ padding: EDITOR_PADDING }}>
            <TextInput
              ref={input}
              testID="yaml-input"
              accessibilityLabel="Workflow YAML"
              multiline
              scrollEnabled={false}
              value={text}
              onChangeText={onChange}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              textAlignVertical="top"
              selectionColor={withAlpha(colors.accent, 0.35)}
              cursorColor={colors.foreground}
              style={inputStyle}
            />
            <View pointerEvents="none" style={{ position: "absolute", left: EDITOR_PADDING, right: EDITOR_PADDING, top: EDITOR_PADDING }}>
              <Text style={{ ...textStyle, color: colors.foreground }} testID="yaml-highlight">
                {spans.map((span) => (
                  <Text
                    key={span.start}
                    style={{
                      color: spanColor(colors, span),
                      backgroundColor: span.marked ? withAlpha(colors.statusDanger, span.active ? 0.45 : 0.22) : undefined,
                      textDecorationLine: span.marked ? "underline" : "none",
                      textDecorationColor: colors.statusDanger,
                    }}
                  >
                    {text.slice(span.start, span.end)}
                  </Text>
                ))}
              </Text>
            </View>
          </View>
        </ScrollView>
      </View>
      {diagnostics.length > 0 ? (
        <ScrollView testID="yaml-diagnostics" style={{ maxHeight: 160, borderRadius: 8, borderWidth: 1, borderColor: colors.statusDanger }} contentContainerStyle={{ padding: 8, gap: 2 }}>
          <Text style={{ color: colors.statusDanger, fontWeight: "600", fontSize: 12 }}>
            {diagnostics.length} problem{diagnostics.length === 1 ? "" : "s"}
          </Text>
          {diagnostics.map((diagnostic, index) => {
            const located = ranges[index] !== null;
            return (
              <Pressable
                key={`${index}-${diagnostic.code}`}
                testID={`yaml-diagnostic-${index}`}
                accessibilityRole="button"
                accessibilityState={{ selected: index === activeIndex, disabled: !located }}
                accessibilityHint={located ? "Shows this problem in the YAML" : undefined}
                disabled={!located}
                onPress={() => reveal(index)}
                style={{ padding: 3, borderRadius: 4, backgroundColor: index === activeIndex ? colors.surface2 : undefined }}
              >
                <Text style={{ color: colors.statusDanger, fontFamily: MONOSPACE, fontSize: 12, textDecorationLine: located ? "underline" : "none" }}>
                  {diagnostic.line > 0 ? `${diagnostic.line}:${diagnostic.column}` : "—"} [{diagnostic.code}] {diagnostic.message}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}

/** The reload prompt after a conflict, with the person's unsent text kept. */
export function ConflictBanner({ colors, message, unsentText, onReload, onUseKept, onDismiss }: { colors: Colors; message: string; unsentText: string; onReload: () => void; onUseKept: () => void; onDismiss: () => void }) {
  return (
    <Banner colors={colors} tone="warning" text={message} testID="workflow-conflict">
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Button colors={colors} compact primary label="Reload" onPress={onReload} testID="conflict-reload" />
        <Button colors={colors} compact label="Use my text" onPress={onUseKept} testID="conflict-use-mine" />
        <Button colors={colors} compact label="Dismiss" onPress={onDismiss} />
      </View>
      <ScrollView style={{ maxHeight: 120 }}>
        <Text selectable style={{ color: colors.foregroundMuted, fontFamily: MONOSPACE, fontSize: 11 }}>
          {unsentText}
        </Text>
      </ScrollView>
    </Banner>
  );
}
