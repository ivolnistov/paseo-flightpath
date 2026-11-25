// Automatic grilling S2/G3 (task card §4.2 pause-support, TR1, TR5): whether a planner can pause
// natively. Claude: every mode. Codex: only with the `plan_mode` feature toggle on (a feature, not a
// mode id). Other providers: unsupported. The host read is bounded (2 s by default) and every
// uncertain outcome is `unknown`, never `unsupported`. Fake timers, no real waits.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakePaseoAgents, gate } from "./test-support/fake-paseo-agents";
import { need } from "./test-support/grilling";

const load = () =>
  import("./pause-support").catch((e: unknown) => {
    throw new Error(`missing module server/pause-support.ts: ${String(e)}`);
  });

const toggle = (id: string, value: boolean) => ({ type: "toggle", id, value });

afterEach(() => {
  vi.useRealTimers();
});

describe("pauseSupport(agent snapshot)", () => {
  it("CODEX_PLAN_FEATURE_ID is plan_mode", async () => {
    expect(need((await load()).CODEX_PLAN_FEATURE_ID, "pause-support.CODEX_PLAN_FEATURE_ID")).toBe("plan_mode");
  });

  it("claude is supported in every mode, whatever features it reports", async () => {
    const pauseSupport = need((await load()).pauseSupport, "pause-support.pauseSupport");
    expect(pauseSupport({ provider: "claude" })).toEqual({ kind: "supported" });
    expect(pauseSupport({ provider: "claude", features: [] })).toEqual({ kind: "supported" });
    expect(pauseSupport({ provider: "claude", features: [toggle("plan_mode", false)] })).toEqual({ kind: "supported" });
  });

  it("codex: plan_mode toggle on → supported; off → unsupported codex default mode; no toggle in a list → unsupported codex plan mode unavailable", async () => {
    const pauseSupport = need((await load()).pauseSupport, "pause-support.pauseSupport");
    expect(pauseSupport({ provider: "codex", features: [toggle("fast_mode", false), toggle("plan_mode", true)] })).toEqual({ kind: "supported" });
    expect(pauseSupport({ provider: "codex", features: [toggle("plan_mode", false)] })).toEqual({ kind: "unsupported", reason: "codex default mode" });
    expect(pauseSupport({ provider: "codex", features: [] })).toEqual({ kind: "unsupported", reason: "codex plan mode unavailable" });
    expect(pauseSupport({ provider: "codex", features: [toggle("fast_mode", true)] })).toEqual({ kind: "unsupported", reason: "codex plan mode unavailable" });
  });

  it("codex without a features list, and a null snapshot, are unknown (never unsupported)", async () => {
    const pauseSupport = need((await load()).pauseSupport, "pause-support.pauseSupport");
    expect(pauseSupport({ provider: "codex" })).toEqual({ kind: "unknown" });
    expect(pauseSupport({ provider: "codex", features: null })).toEqual({ kind: "unknown" });
    expect(pauseSupport(null)).toEqual({ kind: "unknown" });
  });

  it("a mode id is not the signal: codex in a plan-like currentModeId without the toggle is still not supported", async () => {
    const pauseSupport = need((await load()).pauseSupport, "pause-support.pauseSupport");
    const agent = { provider: "codex", currentModeId: "plan", features: [toggle("plan_mode", false)] };
    expect(pauseSupport(agent)).toEqual({ kind: "unsupported", reason: "codex default mode" });
  });

  it("any other provider is unsupported with '<provider>: no blocking native question'", async () => {
    const pauseSupport = need((await load()).pauseSupport, "pause-support.pauseSupport");
    expect(pauseSupport({ provider: "opencode" })).toEqual({ kind: "unsupported", reason: "opencode: no blocking native question" });
    expect(pauseSupport({ provider: "acp", features: [toggle("plan_mode", true)] })).toEqual({ kind: "unsupported", reason: "acp: no blocking native question" });
  });
});

describe("readPauseSupport(paseo, agentId, timeoutMs)", () => {
  it("refreshes the agent once and classifies its snapshot", async () => {
    const read = need((await load()).readPauseSupport, "pause-support.readPauseSupport");
    const fake = fakePaseoAgents([
      { id: "agent-claude", provider: "claude" },
      { id: "agent-codex-plan", provider: "codex", features: [{ type: "toggle", id: "plan_mode", label: "Plan", value: true }] },
      { id: "agent-codex-default", provider: "codex", features: [{ type: "toggle", id: "plan_mode", label: "Plan", value: false }] },
    ]);
    expect(await read(fake.paseo, "agent-claude")).toEqual({ kind: "supported" });
    expect(await read(fake.paseo, "agent-codex-plan")).toEqual({ kind: "supported" });
    expect(await read(fake.paseo, "agent-codex-default")).toEqual({ kind: "unsupported", reason: "codex default mode" });
    expect(fake.calls.refresh).toEqual(["agent-claude", "agent-codex-plan", "agent-codex-default"]);
  });

  it("an archived agent is unsupported 'archived'; a null refresh, a rejection or a null PaseoApi are unknown", async () => {
    const read = need((await load()).readPauseSupport, "pause-support.readPauseSupport");
    const fake = fakePaseoAgents([
      { id: "agent-archived", provider: "claude", archivedAt: "2026-10-19T10:00:00.000Z" },
      { id: "agent-null" },
      { id: "agent-throws" },
    ]);
    fake.script.refreshNull.add("agent-null");
    fake.script.refreshRejects.set("agent-throws", new Error("synthetic host failure"));
    expect(await read(fake.paseo, "agent-archived")).toEqual({ kind: "unsupported", reason: "archived" });
    expect(await read(fake.paseo, "agent-null")).toEqual({ kind: "unknown" });
    expect(await read(fake.paseo, "agent-throws")).toEqual({ kind: "unknown" });
    expect(await read(null, "agent-null")).toEqual({ kind: "unknown" });
  });

  it("a host read slower than the default 2 s bound resolves unknown at 2000 ms, not before", async () => {
    const read = need((await load()).readPauseSupport, "pause-support.readPauseSupport");
    vi.useFakeTimers();
    const fake = fakePaseoAgents([{ id: "agent-slow", provider: "claude" }]);
    const held = gate();
    fake.script.refreshGate.set("agent-slow", held.promise);
    let settled: unknown = "pending";
    void read(fake.paseo, "agent-slow").then((v) => {
      settled = v;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ kind: "unknown" });
    held.release();
  });

  it("an explicit timeoutMs bounds the read instead", async () => {
    const read = need((await load()).readPauseSupport, "pause-support.readPauseSupport");
    vi.useFakeTimers();
    const fake = fakePaseoAgents([{ id: "agent-slow", provider: "claude" }]);
    const held = gate();
    fake.script.refreshGate.set("agent-slow", held.promise);
    let settled: unknown = "pending";
    void read(fake.paseo, "agent-slow", 500).then((v) => {
      settled = v;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ kind: "unknown" });
    held.release();
  });
});
