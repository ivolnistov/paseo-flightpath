// Clarify in chat: the owner's question about Q<n> goes to the discussion chat only when they press
// Send, as `Clarify Q<n> "<title>": <text>`. Discuss in chat instead places the question's context
// in that chat's draft, after the existing draft text, and sends nothing. Nothing is answered and no
// roadmap RPC is called; an answer is recorded only in the panel or by the agent with the owner's
// quoted words. Open chat appears only when the host can open the agent.
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { View } from "react-native";
import { useDiscussInChat } from "./chat-draft";
import { qLabel } from "./question-number";
import { ActionButton } from "./roadmap-screen";
import { TARGET_SIZE } from "./theme";
import { Muted, inputStyle } from "./ui";

export function clarifyText(number: number, title: string, text: string): string {
  return `Clarify ${qLabel(number)} ${JSON.stringify(title)}: ${text.trim()}`;
}

export function ClarifyComposer(props: {
  hostId: string;
  agentId: string;
  number: number;
  title: string;
  /** The block "Discuss in chat" places in the chat's draft. */
  context: string;
  theme: PluginTheme;
  /** The host's navigation to the chat; absent on hosts without it. */
  openAgent?(): void;
  /** The chat's status from the host's client state; anything but "idle" keeps the interruption note. */
  plannerStatus?: string | null;
}) {
  const { agentId, number, title, context, theme, openAgent, plannerStatus } = props;
  const paseo = usePaseo() as ReturnType<typeof usePaseo> | null;
  const toast = useToast();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [placing, setPlacing] = useState(false);
  const draft = useDiscussInChat(agentId);
  const empty = text.trim() === "";

  const send = async () => {
    if (empty || sending) return;
    if (paseo === null) {
      toast.error("The chat cannot be reached from this host.");
      return;
    }
    setSending(true);
    try {
      await paseo.agents.ref(agentId).send(clarifyText(number, title, text));
      setText("");
      toast.show("Sent to the discussion chat");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The message could not be sent");
    } finally {
      setSending(false);
    }
  };

  const discuss = async () => {
    if (placing) return;
    setPlacing(true);
    try {
      await draft.discuss(context);
    } finally {
      setPlacing(false);
    }
  };

  return (
    <View style={{ gap: 6, minWidth: 0, flexWrap: "wrap" }}>
      <Muted theme={theme}>Clarify in chat: asks the discussion chat about this question; nothing is answered. Discuss in chat adds the question to the chat's draft for you to send.</Muted>
      {plannerStatus !== "idle" ? <Muted theme={theme}>If the chat is responding, sending interrupts its current answer.</Muted> : null}
      <TextInput
        accessibilityLabel={`Question about ${qLabel(number)} for the chat`}
        placeholder="Ask the chat about this question"
        value={text}
        onChangeText={setText}
        multiline
        style={[inputStyle(theme), { minHeight: TARGET_SIZE }]}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <ActionButton label="Send to chat" theme={theme} disabled={empty || sending} onPress={() => void send()} />
        <ActionButton
          label="Discuss in chat"
          hint="Adds this question's context to the chat's draft without sending it"
          theme={theme}
          disabled={placing}
          onPress={() => void discuss()}
        />
        {openAgent !== undefined ? <ActionButton label="Open chat" icon="external-link" iconOnly hint="Open the planner chat" theme={theme} onPress={openAgent} /> : null}
      </View>
    </View>
  );
}
