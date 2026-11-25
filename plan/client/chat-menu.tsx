// The session header's Chat menu: the view mode (Grilling or Map), the owner's manual Finish behind a
// confirmation, Bind or Change chat, Retry with one wording per state, Reopen for a closed session,
// and the explanation of the roadmap tools state. A card under the trigger on wide screens, a host
// sheet on compact ones. The notices that need the owner stay visible outside it, on the screen.
import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { SessionView } from "../shared/rpc";
import { DiscussionRetry, SessionFinish } from "../shared/rpc-discussion";
import { SessionReopen } from "../shared/rpc-grilling";
import { FocusScope, MenuItem, MenuSeparator, moveFocus } from "./discussion-ui";
import { TOOLS_EXPLANATION, TOOLS_STATE, grillingActions, retryItem } from "./grilling-header";
import { useRoadmapMutation, type FinishMutation } from "./hooks";
import { ActionButton, lucideName } from "./roadmap-screen";
import { TARGET_SIZE } from "./theme";

export type ViewMode = "grilling" | "map";

const MODE_LABEL: Record<ViewMode, string> = { grilling: "Grilling", map: "Map" };
type KeyEvent = { key?: string; shiftKey?: boolean; nativeEvent?: { key?: string; shiftKey?: boolean }; preventDefault?(): void };

/** The element that has keyboard focus on the web; undefined elsewhere. Read without the DOM types. */
const activeElement = (): unknown => {
  const doc: unknown = Reflect.get(globalThis, "document");
  return typeof doc === "object" && doc !== null ? Reflect.get(doc, "activeElement") : undefined;
};
const keyOf = (e: KeyEvent) => e.key ?? e.nativeEvent?.key;

export const MANUAL_FINISH_TEXT = "Closes this discussion on your own decision. The chat's open proposal, if any, is kept as not accepted.";

/** The Finish confirmation's content: in a focus scope on compact, as it is on wide. */
function ConfirmScope(props: { compact: boolean; onEscape(): void; children: ReactNode }) {
  return props.compact ? (
    <FocusScope label="Finish discussion" onEscape={props.onEscape} focusOnMount>
      {props.children}
    </FocusScope>
  ) : (
    <>{props.children}</>
  );
}

/**
 * The Chat menu trigger with its menu anchored under it, and the Finish confirmation. Bind or Change
 * chat asks the screen to show the planner picker (`onChangeChat`).
 */
export function ChatMenu(props: {
  hostId: string;
  projectId: string;
  view: SessionView | undefined;
  theme: PluginTheme;
  compact: boolean;
  mode: ViewMode;
  onMode(mode: ViewMode): void;
  onChangeChat(): void;
  /** The trigger, for the screen to return focus to it (after the planner picker closes). */
  triggerRef?: RefObject<View | null>;
  /** The screen's one session.finish request, shared with the proposal's Accept. */
  finish?: FinishMutation;
}) {
  const { hostId, projectId, view, theme, compact, mode } = props;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const plannerStatus = useAgent(view?.session.planner?.agentId ?? "", (a) => a.status) ?? null;
  const ownFinish = useRoadmapMutation(hostId, projectId, SessionFinish);
  const finish = props.finish ?? ownFinish;
  const retry = useRoadmapMutation(hostId, projectId, DiscussionRetry);
  const reopen = useRoadmapMutation(hostId, projectId, SessionReopen);
  const actions = view !== undefined ? grillingActions(view, { plannerStatus }) : null;
  const tools = view?.grilling?.tools;
  const toolsWarning = tools !== undefined && tools !== "attached";
  const retryState = retryItem(actions?.retry ?? null);

  // Focus moves into the menu when it opens and back to the trigger when it is dismissed; an item that
  // opens a dialog leaves focus to it. Change chat… returns it to the trigger too: the planner picker it
  // opens mounts in the same commit, below the menu, so its own effect then moves focus into it, and a
  // picker that cannot take focus leaves it on the trigger rather than on the unmounted item.
  const ownTriggerRef = useRef<View | null>(null);
  const triggerRef = props.triggerRef ?? ownTriggerRef;
  const firstItemRef = useRef<View | null>(null);
  const wasOpen = useRef(false);
  const restoreFocus = useRef(true);
  // A host sheet mounts its content after the menu opens: focus waits until the first item exists.
  const focusInto = useRef(false);
  const focusFirstItem = () => {
    if (!focusInto.current || firstItemRef.current === null) return;
    focusInto.current = false;
    moveFocus(firstItemRef, { preventScroll: true });
  };
  useEffect(() => {
    if (open && !wasOpen.current) focusInto.current = true;
    if (!open) focusInto.current = false;
    if (!open && wasOpen.current && restoreFocus.current) moveFocus(triggerRef);
    wasOpen.current = open;
    focusFirstItem();
  });
  // The Finish confirmation opens from a menu item that unmounts with the menu: focus goes to the
  // trigger first, so it is the host dialog's restore target on wide screens, and is put back on the
  // trigger once the dialog closes, which the compact host sheet does not do. Both aim at the same
  // element, so the plugin and the host's restore never pull focus apart.
  const refocusAfterConfirm = useRef(false);
  const closeConfirm = () => {
    refocusAfterConfirm.current = true;
    setConfirming(false);
  };
  useEffect(() => {
    if (confirming || !refocusAfterConfirm.current) return;
    refocusAfterConfirm.current = false;
    moveFocus(triggerRef);
  });
  // Wide: the menu is a popover, not a trap. When focus leaves it for another control (Tab past the
  // last item), it closes and leaves focus there. The compact sheet keeps focus inside instead.
  const menuRef = useRef<View | null>(null);
  const leaveMenu = (next: unknown) => {
    if (compact || Platform.OS !== "web" || typeof next !== "object" || next === null || menuRef.current === null) return;
    const contains: unknown = Reflect.get(menuRef.current, "contains");
    if (typeof contains === "function" && Reflect.apply(contains, menuRef.current, [next]) !== true) close(false);
  };
  const close = (restore = true) => {
    restoreFocus.current = restore;
    setOpen(false);
  };
  const choose =
    (fn: () => void, restore = true) =>
    () => {
      close(restore);
      fn();
    };
  // Escape closes the menu wherever focus is inside it or on the trigger. React Native Web passes
  // key events of focused views; the prop is not in React Native's view types.
  const escape: Record<string, (e: KeyEvent) => void> = {
    onKeyDown: (e) => {
      if (open && keyOf(e) === "Escape") {
        e.preventDefault?.();
        close();
      }
    },
  };

  // The trigger names what the menu holds now: the items it renders, in their order.
  const blocks = view?.session.blocks !== undefined;
  const menuLabel = `Chat menu: ${[
    "view mode",
    ...(blocks && actions?.finish === true ? ["finish discussion"] : []),
    ...(blocks && actions !== null && actions.bind !== null ? [actions.bind === "bind" ? "bind chat" : "change chat"] : []),
    ...(blocks ? ["retry"] : []),
    ...(blocks && actions?.reopen === true ? ["reopen"] : []),
    ...(tools !== undefined ? ["roadmap tools"] : []),
  ].join(", ")}`;
  const trigger = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={toolsWarning ? `${menuLabel} (roadmap tools ${TOOLS_STATE[tools]})` : menuLabel}
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      ref={triggerRef}
      {...escape}
      onPress={() => (open ? close() : setOpen(true))}
      style={{
        minHeight: TARGET_SIZE,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingLeft: 14,
        paddingRight: 12,
        borderRadius: 6,
        backgroundColor: open ? theme.colors.surface1 : theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Text style={{ color: theme.colors.foreground }}>Chat</Text>
      <Text style={{ fontSize: 12, lineHeight: 18, paddingHorizontal: 6, borderRadius: 4, borderWidth: 1, borderColor: theme.colors.accent, color: theme.colors.statusSuccess }}>{MODE_LABEL[mode]}</Text>
      {toolsWarning ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.statusWarning }} /> : null}
      <Icon name={lucideName("chevron-down")} size={14} color={theme.colors.foregroundMuted} />
    </Pressable>
  );

  // The compact sheet is the host's bottom sheet, which keeps no focus inside it on the web: Tab past
  // the last enabled item wraps to the first and Shift+Tab before the first to the last. Tab between
  // items stays the browser's. Wide menus are not a host sheet; native has no Tab order to keep.
  const mapItemRef = useRef<View | null>(null);
  const finishItemRef = useRef<View | null>(null);
  const bindItemRef = useRef<View | null>(null);
  const retryItemRef = useRef<View | null>(null);
  const reopenItemRef = useRef<View | null>(null);
  const hasBlocks = view?.session.blocks !== undefined;
  const order = [
    { ref: firstItemRef, enabled: true },
    { ref: mapItemRef, enabled: true },
    { ref: finishItemRef, enabled: hasBlocks && actions?.finish === true && !finish.pending },
    { ref: bindItemRef, enabled: hasBlocks && actions !== null && actions.bind !== null },
    { ref: retryItemRef, enabled: hasBlocks && retryState.enabled && !retry.pending },
    { ref: reopenItemRef, enabled: hasBlocks && actions?.reopen === true && !reopen.pending },
  ].filter((i) => i.enabled);
  const menuKeys: Record<string, (e: KeyEvent) => void> = {
    onKeyDown: (e) => {
      if (keyOf(e) !== "Tab") return escape.onKeyDown(e);
      if (!compact || Platform.OS !== "web" || order.length === 0) return;
      const shift = e.shiftKey ?? e.nativeEvent?.shiftKey ?? false;
      const first = order[0].ref;
      const last = order[order.length - 1].ref;
      const active = activeElement();
      if (!shift && active !== undefined && active === last.current) {
        e.preventDefault?.();
        moveFocus(first);
      } else if (shift && active !== undefined && active === first.current) {
        e.preventDefault?.();
        moveFocus(last);
      }
    },
  };

  const items = (
    <View ref={menuRef} accessibilityRole="menu" accessibilityLabel="Chat menu" style={{ gap: 0 }} {...menuKeys}>
      <MenuItem onBlur={leaveMenu} ref={firstItemRef} onLayout={focusFirstItem} label="Grilling" icon="list" checked={mode === "grilling"} theme={theme} onPress={choose(() => props.onMode("grilling"))} />
      <MenuItem onBlur={leaveMenu} ref={mapItemRef} label="Map" icon="map" checked={mode === "map"} theme={theme} onPress={choose(() => props.onMode("map"))} />
      {view?.session.blocks !== undefined ? (
        <>
          <MenuSeparator theme={theme} />
          {actions?.finish === true ? <MenuItem onBlur={leaveMenu} ref={finishItemRef} label="Finish discussion…" icon="flag" theme={theme} disabled={finish.pending} onPress={choose(() => setConfirming(true))} /> : null}
          {actions !== null && actions.bind !== null ? (
            <MenuItem onBlur={leaveMenu} ref={bindItemRef} label={actions.bind === "bind" ? "Bind chat…" : "Change chat…"} icon="repeat" theme={theme} onPress={choose(props.onChangeChat)} />
          ) : null}
          <MenuItem
            onBlur={leaveMenu}
            ref={retryItemRef}
            label="Retry"
            icon="rotate-cw"
            hint={retryState.hint}
            theme={theme}
            disabled={!retryState.enabled || retry.pending}
            onPress={choose(() => void retry.run({ sessionId: view.session.id }, { expectedRevision: view.revision }))}
          />
          {actions?.reopen === true ? (
            <MenuItem onBlur={leaveMenu} ref={reopenItemRef} label="Reopen" icon="rotate-ccw" theme={theme} disabled={reopen.pending} onPress={choose(() => void reopen.run({ sessionId: view.session.id }, { expectedRevision: view.revision }))} />
          ) : null}
        </>
      ) : null}
      {tools !== undefined ? (
        <>
          <MenuSeparator theme={theme} />
          <View style={{ flexDirection: "row", gap: 10, paddingTop: 6, paddingBottom: 8, paddingHorizontal: 10 }}>
            <Icon name={lucideName("info")} size={15} color={toolsWarning ? theme.colors.statusWarning : theme.colors.foregroundMuted} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: toolsWarning ? theme.colors.statusWarning : theme.colors.foreground }}>{`Roadmap tools: ${TOOLS_STATE[tools]}`}</Text>
              <Text style={{ fontSize: 12, lineHeight: 16, color: theme.colors.foregroundMuted }}>{TOOLS_EXPLANATION[tools]}</Text>
            </View>
          </View>
        </>
      ) : null}
    </View>
  );

  const menu = open ? (
    compact ? (
      <Modal title="Chat" open onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <Modal.Content>{items}</Modal.Content>
      </Modal>
    ) : (
      <>
      {/* A press anywhere outside the card closes the menu without acting; keyboard users press Escape. */}
      <Pressable
        accessible={false}
        accessibilityLabel="Close the Chat menu"
        // Pointer only, out of the keyboard Tab order: React Native Web's Pressable takes its tab order
        // from tabIndex alone (it ignores focusable); focusable keeps Android's focus off it too.
        tabIndex={-1}
        focusable={false}
        onPress={() => close()}
        style={{ position: "absolute", top: -4000, left: -4000, right: -4000, bottom: -4000, minHeight: TARGET_SIZE, zIndex: 9 }}
      />
      <View
        style={{
          position: "absolute",
          top: TARGET_SIZE + 6,
          right: 0,
          zIndex: 10,
          width: 304,
          padding: 6,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          shadowColor: "#000",
          shadowOpacity: 0.5,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 12 },
          elevation: 8,
        }}
      >
        {items}
      </View>
      </>
    )
  ) : null;

  const confirm =
    confirming && view !== undefined ? (
      <Modal title="Finish discussion" open onOpenChange={(next) => !next && closeConfirm()}>
        <Modal.Content>
          {/* Wide: the host dialog moves focus in, keeps Tab and handles Escape. Compact: the host sheet
              does none of that, so a focus scope does, starting on Cancel. */}
          <ConfirmScope compact={compact} onEscape={closeConfirm}>
          <Text style={{ color: theme.colors.foreground }}>{MANUAL_FINISH_TEXT}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>It approves no plan and starts nothing.</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <ActionButton label="Cancel" theme={theme} onPress={closeConfirm} />
            <ActionButton
              label="Finish discussion"
              theme={theme}
              primary
              disabled={finish.pending}
              onPress={() => {
                closeConfirm();
                void finish.run({ sessionId: view.session.id, basis: "manual" }, { expectedRevision: view.revision });
              }}
            />
          </View>
          </ConfirmScope>
        </Modal.Content>
      </Modal>
    ) : null;

  return (
    <View style={{ position: "relative", zIndex: 10 }}>
      {trigger}
      {menu}
      {confirm}
    </View>
  );
}
