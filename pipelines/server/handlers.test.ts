import { describe, expect, it, vi } from "vitest";
import { runWatch, type RunDetail } from "../shared/rpc";
import { registerRunHandlers, type RunRegistrar } from "./handlers";
import type { RunService } from "./run-service";

type WatchService = Pick<RunService, "get">;

type WatchHandler = (input: { runId: string }, context: { paseo: unknown; push(event: unknown): Promise<void>; signal: AbortSignal }) => unknown;

function detail(seq: number): RunDetail {
  return {
    view: { runId: "r1", projectId: "p", status: "running", pauseReason: null, workspace: null, jobs: [], evidence: [], invalidatedCycles: [], barrier: null, unresolvedIntents: [] },
    graph: { jobs: [], edges: [], groups: [], reworks: [], maxParallel: seq },
    settings: {},
    workflowName: null,
    startKey: "k",
    createdAt: "2026-11-21T00:00:00.000Z",
    health: "ok",
    waits: null,
  };
}

function setup(ready?: () => Promise<WatchService>) {
  let watch: WatchHandler | null = null;
  const registrar: RunRegistrar = {
    handle(contract: { name: string }, handler: unknown) {
      if (contract.name === runWatch.name && typeof handler === "function") watch = (input, context) => Reflect.apply(handler, undefined, [input, context]) as unknown;
    },
  };
  let reads = 0;
  const service: WatchService = { get: () => Promise.resolve(detail(++reads)) };
  let listener: (() => void) | null = null;
  const unsubscribe = vi.fn();
  const options = {
    log: (): void => undefined,
    // run.watch reads only `get`; the other service methods stay absent.
    ready: ready ?? ((): Promise<WatchService> => Promise.resolve(service)),
    onContext: (): Promise<void> => Promise.resolve(),
    subscribe: (_runId: string, next: () => void): (() => void) => {
      listener = next;
      return unsubscribe;
    },
  };
  Reflect.apply(registerRunHandlers, undefined, [registrar, options]);
  if (watch === null) throw new Error("run.watch was not registered");
  return { watch: watch as WatchHandler, notify: () => listener?.(), unsubscribe, reads: () => reads };
}

describe("run.watch", () => {
  it("stays open, pushes the current detail and every change, and releases on abort", async () => {
    const { watch, notify, unsubscribe, reads } = setup();
    const pushed: unknown[] = [];
    const controller = new AbortController();
    const returned = watch({ runId: "r1" }, { paseo: {}, push: (event) => Promise.resolve(void pushed.push(event)), signal: controller.signal });
    if (!(returned instanceof Promise)) throw new Error("run.watch must return its subscription lifetime");
    let settled = false;
    void returned.then(() => (settled = true));
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    notify();
    await vi.waitFor(() => expect(pushed).toHaveLength(2));
    expect(settled).toBe(false);
    controller.abort();
    await returned;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    // A change reported after release is dropped before the run is even read.
    notify();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(reads()).toBe(2);
    expect(pushed).toHaveLength(2);
  });

  it("closes the subscription with the startup error so the client can fall back to polling", async () => {
    const { watch, unsubscribe } = setup(() => Promise.reject(new Error("core startup failed")));
    const returned = watch({ runId: "r1" }, { paseo: {}, push: () => Promise.resolve(), signal: new AbortController().signal });
    await expect(returned).rejects.toThrow("core startup failed");
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});
