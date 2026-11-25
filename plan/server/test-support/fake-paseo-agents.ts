// A scripted fake of the PaseoApi agent surface the automatic-grilling pause engine may use
// (task card §4.4): `paseo.agents.ref(id)` with `refresh()`, `pendingPermissions`, `current()`,
// `respondToPermission`, `send` and `run`. Every call is recorded. A pending request disappears once
// it has been answered, and answering a request that is not pending rejects, as the hosts do.
// Tests can script transport failures (the request stays pending), refresh results and rejections,
// and gates that hold a call in flight, so races are deterministic without real waits.
// Synthetic data only; this is a test double of the host, not of any plugin logic.
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";

export type FakeFeature = { type: "toggle"; id: string; label: string; value: boolean };

export interface FakeAgent {
  id: string;
  provider: string;
  cwd: string;
  workspaceId?: string;
  status: "idle" | "running" | "initializing" | "error" | "closed";
  archivedAt: string | null;
  features?: FakeFeature[];
  pending: AgentPermissionRequest[];
}

export interface RespondCall {
  agentId: string;
  requestId: string;
  response: AgentPermissionResponse;
}

/** A promise a test releases by hand: holds a host call in flight to interleave other events. */
export function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export function fakePaseoAgents(init: Array<Partial<FakeAgent> & { id: string }>) {
  const agents = new Map<string, FakeAgent>();
  for (const a of init) {
    agents.set(a.id, { provider: "claude", cwd: "/synthetic/none", status: "running", archivedAt: null, pending: [], ...a });
  }
  const calls = {
    respond: [] as RespondCall[],
    /** Each send with its options and the agent's status and pending requests when it was issued. */
    send: [] as Array<{ agentId: string; text: string; options?: Record<string, unknown>; statusAtSend?: string; pendingAtSend?: number }>,
    run: [] as Array<{ agentId: string; text: string }>,
    refresh: [] as string[],
    /** timeline.refetch calls: the host loads a closed (stored, not archived) agent on this read. */
    load: [] as string[],
    /** reload calls (`refresh_agent_request`): the host interrupts a loaded running agent on this call. */
    reload: [] as string[],
  };
  const script = {
    /** Per agent: the next N respond calls fail like a transport error; the request stays pending. */
    respondFailures: new Map<string, number>(),
    /** Awaited inside respondToPermission before the host applies the answer. */
    beforeRespond: undefined as undefined | ((call: RespondCall) => Promise<void> | void),
    /** Awaited after the host applied the answer, before the call resolves. */
    afterRespond: undefined as undefined | ((call: RespondCall) => Promise<void> | void),
    /** Per agent: refresh() rejects with this error. */
    refreshRejects: new Map<string, Error>(),
    /** Per agent: refresh() resolves null (the agent is unknown to the host). */
    refreshNull: new Set<string>(),
    /** Per agent: refresh() waits for this gate first. */
    refreshGate: new Map<string, Promise<void>>(),
    /** Per agent: send() waits for this gate before it settles (the message is already recorded). */
    sendGate: new Map<string, Promise<void>>(),
    /** Per agent: send() rejects with this value after recording the call. */
    sendRejects: new Map<string, unknown>(),
    /**
     * Per agent: what loading a closed agent leaves (host 0.15.3 `ensureAgentLoaded` resumes it from
     * persistence). Without an entry a closed agent loads idle with nothing pending.
     */
    onLoad: new Map<string, (a: FakeAgent) => void>(),
    /** Per agent: timeline.refetch rejects with this error (the load failed). */
    loadRejects: new Map<string, Error>(),
    /** Per agent: timeline.refetch waits for this gate first (a load the host has not answered yet). */
    loadGate: new Map<string, Promise<void>>(),
  };

  const snapshot = (a: FakeAgent) => ({
    id: a.id,
    provider: a.provider,
    cwd: a.cwd,
    ...(a.workspaceId !== undefined ? { workspaceId: a.workspaceId } : {}),
    model: null,
    ...(a.features !== undefined ? { features: a.features.map((f) => ({ ...f })) } : {}),
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
    lastUserMessageAt: null,
    status: a.status,
    capabilities: {},
    currentModeId: null,
    availableModes: [],
    pendingPermissions: a.pending.map((r) => structuredClone(r)),
    archivedAt: a.archivedAt,
  });

  const need = (agentId: string): FakeAgent => {
    const a = agents.get(agentId);
    if (a === undefined) throw new Error(`synthetic host: unknown agent ${agentId}`);
    return a;
  };

  const ref = (agentId: string) => ({
    id: agentId,
    get pendingPermissions() {
      const a = agents.get(agentId);
      return a ? a.pending.map((r) => structuredClone(r)) : null;
    },
    get status() {
      return agents.get(agentId)?.status ?? null;
    },
    get features() {
      return agents.get(agentId)?.features ?? null;
    },
    get archivedAt() {
      return agents.get(agentId)?.archivedAt ?? null;
    },
    current() {
      const a = agents.get(agentId);
      return a ? snapshot(a) : null;
    },
    async refresh() {
      calls.refresh.push(agentId);
      const waitFor = script.refreshGate.get(agentId);
      if (waitFor !== undefined) await waitFor;
      const rejection = script.refreshRejects.get(agentId);
      if (rejection !== undefined) throw rejection;
      if (script.refreshNull.has(agentId)) return null;
      const a = agents.get(agentId);
      return a ? { agent: snapshot(a), project: null } : null;
    },
    async respondToPermission(options: { requestId: string; response: AgentPermissionResponse }) {
      const call: RespondCall = { agentId, requestId: options.requestId, response: structuredClone(options.response) };
      calls.respond.push(call);
      await script.beforeRespond?.(call);
      const failures = script.respondFailures.get(agentId) ?? 0;
      if (failures > 0) {
        script.respondFailures.set(agentId, failures - 1);
        throw new Error("synthetic transport failure");
      }
      const a = need(agentId);
      const index = a.pending.findIndex((r) => r.id === options.requestId);
      if (index < 0) throw new Error(`synthetic host: No pending permission request ${options.requestId}`);
      a.pending.splice(index, 1);
      await script.afterRespond?.(call);
    },
    async send(text: string, options?: Record<string, unknown>) {
      const a = agents.get(agentId);
      calls.send.push({ agentId, text, ...(options !== undefined ? { options: structuredClone(options) } : {}), statusAtSend: a?.status, pendingAtSend: a?.pending.length });
      const waitFor = script.sendGate.get(agentId);
      if (waitFor !== undefined) await waitFor;
      const rejection = script.sendRejects.get(agentId);
      if (rejection !== undefined) throw rejection;
      // As the host does: a message to an idle chat starts a turn.
      if (a !== undefined && a.status === "idle") a.status = "running";
    },
    timeline: {
      async refetch() {
        calls.load.push(agentId);
        const held = script.loadGate.get(agentId);
        if (held !== undefined) await held;
        const rejection = script.loadRejects.get(agentId);
        if (rejection !== undefined) throw rejection;
        const a = agents.get(agentId);
        if (a !== undefined && a.status === "closed" && (a.archivedAt === null || a.archivedAt === "")) {
          const load = script.onLoad.get(agentId);
          if (load !== undefined) load(a);
          else a.status = "idle";
        }
        return { entries: [], agent: a ? snapshot(a) : null };
      },
    },
    async reload() {
      calls.reload.push(agentId);
    },
    async run(text: string) {
      calls.run.push({ agentId, text });
      return { status: "idle" };
    },
  });

  const paseo = { agents: { ref: (agent: string | { id: string }) => ref(typeof agent === "string" ? agent : agent.id) } };
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the agent members the pause engine may use exist
    paseo: paseo as unknown as PaseoApi,
    agents,
    calls,
    script,
    /** Adds a pending request to an agent (the host shows a question). */
    show(agentId: string, request: AgentPermissionRequest) {
      need(agentId).pending.push(request);
    },
    /** Removes a pending request without answering it (host supersede, restart). */
    drop(agentId: string, requestId: string) {
      const a = need(agentId);
      a.pending = a.pending.filter((r) => r.id !== requestId);
    },
  };
}
export type FakePaseoAgents = ReturnType<typeof fakePaseoAgents>;

/** The hook-side agent record of the 0.12 lifecycle events. */
export function hookAgent(id: string, cwd: string, provider = "claude"): PluginHookAgent {
  return { id, workspaceId: null, parentAgentId: null, provider, cwd, title: null };
}

/** The exact pause question text for an operation (the template of the task card, written out here). */
export const cardText = (operationId: string) => `Decision Roadmap: waiting for block acceptance (DR-OP-${operationId})`;

/** A Claude AskUserQuestion pause card as Paseo 0.12 forwards it, with Claude's own decoration. */
export function claudeCard(
  operationId: string,
  o: { requestId?: string; questions?: unknown[]; question?: Record<string, unknown> } = {},
): AgentPermissionRequest {
  const question = {
    question: cardText(operationId),
    header: "Roadmap",
    options: [
      { label: "Continue", description: "Continue after the owner accepts the block" },
      { label: "Stop", description: "Stop grilling" },
    ],
    multiSelect: false,
    allowOther: true,
    ...o.question,
  };
  return {
    id: o.requestId ?? "permission-req-1",
    provider: "claude",
    name: "AskUserQuestion",
    kind: "question",
    title: "Question",
    input: { questions: o.questions ?? [question] },
  };
}

/** A Codex synchronous request_user_input pause card, with Codex's own decoration. */
export function codexCard(
  operationId: string,
  o: { requestId?: string; name?: string; question?: Record<string, unknown> } = {},
): AgentPermissionRequest {
  return {
    id: o.requestId ?? "permission-req-1",
    provider: "codex",
    name: o.name ?? "request_user_input",
    kind: "question",
    input: {
      questions: [
        {
          id: "question-1",
          header: "Roadmap",
          question: cardText(operationId),
          options: [{ label: "Continue" }, { label: "Stop" }],
          isOther: false,
          isSecret: false,
          ...o.question,
        },
      ],
    },
  };
}
