// A sandbox-only agent provider with no model behind it, so an E2E run can have a real agent and
// composer without any model request. It opens sessions and answers catalog and lifecycle requests;
// every prompt is refused. Every input it receives is appended to $PASEO_HOME/e2e-inert-ledger.jsonl,
// so a run can prove that nothing was sent. It has no network code and starts no process.
// Plain JavaScript, kept outside the TypeScript and lint globs; staged as the plugin's index.server.ts.
import { appendFileSync } from "node:fs";
import path from "node:path";

const PROVIDER_ID = "e2e-inert";
const MODEL = { id: "inert", label: "Inert (no model)", isDefault: true };
const MODE = { id: "default", label: "Default" };

function ledger(entry) {
  const home = process.env.PASEO_HOME;
  if (typeof home !== "string" || home === "") return;
  appendFileSync(path.join(home, "e2e-inert-ledger.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function connection() {
  const listeners = new Set();
  const emit = (event) => queueMicrotask(() => listeners.forEach((l) => l(event)));
  const config = { model: MODEL.id, mode: MODE.id, models: [MODEL], modes: [MODE], thinkingOptions: [] };
  return {
    version: 1,
    // session.persistence: the host can reopen an agent after a daemon restart from the handle below.
    capabilities: ["prompt.message", "session.persistence"],
    async send(input) {
      const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
      ledger({ input: input.type, sessionId, ...(input.type === "session.prompt" ? { prompt: input.prompt } : {}) });
      switch (input.type) {
        case "catalog":
          return emit({ type: "catalog", requestId: input.requestId, catalog: { models: [MODEL], modes: [MODE], defaultModel: MODEL.id, defaultMode: MODE.id } });
        case "sessions":
          return emit({ type: "sessions", requestId: input.requestId, sessions: [] });
        case "session.open": {
          const cwd = input.config?.cwd ?? "/";
          // A reopened agent keeps the handle it was given; there is no history to replay.
          const persistence = input.persistence ?? { version: 1, data: { inertSession: sessionId } };
          emit({ type: "session.opened", requestId: input.requestId, sessionId, capabilities: ["prompt.message", "session.persistence"], restoration: "core", persistence, cwd });
          emit({ type: "session.config", sessionId, config });
          return emit({ type: "session.ready", requestId: input.requestId, sessionId });
        }
        case "session.prompt": {
          return emit({ type: "session.prompt_result", sessionId, clientMessageId: input.prompt?.clientMessageId ?? "", result: { type: "failed", error: { message: "The inert E2E provider refuses every prompt.", code: "inert" } } });
        }
        case "session.can_stop_runtime":
          return emit({ type: "session.can_stop_runtime", requestId: input.requestId, sessionId, canStop: true });
        case "session.close":
          emit({ type: "request.completed", requestId: input.requestId });
          return emit({ type: "session.closed", sessionId });
        default:
          if (typeof input.requestId === "string") return emit({ type: "request.failed", requestId: input.requestId, error: { message: `The inert E2E provider does not support ${input.type}.`, code: "unsupported" } });
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      listeners.clear();
    },
  };
}

export default function contribute(server) {
  server.registerProvider({
    id: PROVIDER_ID,
    label: "E2E inert",
    description: "Sandbox fixture: no model; refuses every prompt.",
    async status() {
      return { available: true };
    },
    async connect() {
      ledger({ input: "connect" });
      return connection();
    },
  });
  // The host requires a cleanup function; the provider holds nothing beyond its connections.
  return () => undefined;
}
