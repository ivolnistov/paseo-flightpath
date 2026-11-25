import { describe, expect, it, vi } from "vitest";
import type { RunDetail, RunDetailResult, ViewResult, WorkflowView } from "../shared/rpc";
import { createRunFeed, canSave, WorkflowSession, type FeedSubscription, type RunFeedState, type Timers, type WorkflowRpc } from "./hooks";
import { runDetail, runJob, runView } from "./test-support/graphs";

/** Timers the test advances by hand. */
function manualTimers() {
  let queue: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  let now = 0;
  const timers: Timers = {
    set(callback, ms) {
      const entry = { at: now + ms, run: callback, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  return {
    timers,
    pending: () => queue.filter((entry) => !entry.cancelled).length,
    async advance(ms: number) {
      now += ms;
      const due = queue.filter((entry) => !entry.cancelled && entry.at <= now);
      queue = queue.filter((entry) => !due.includes(entry));
      for (const entry of due) entry.run();
      await flush();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function detail(status: RunDetail["view"]["status"], jobStatus: Parameters<typeof runJob>[1] = "running"): RunDetail {
  return runDetail(runView([runJob("lint", jobStatus)], { status }));
}

describe("run feed", () => {
  it("polls run.get when the host has no subscriptions, and stops once the run ends", async () => {
    const clock = manualTimers();
    const answers: RunDetail[] = [detail("running"), detail("running", "checking"), detail("finished", "succeeded")];
    const get = vi.fn((): Promise<RunDetailResult> => Promise.resolve({ ok: true, value: answers.shift() ?? detail("finished", "succeeded") }));
    const states: RunFeedState[] = [];
    createRunFeed({ runId: "r1", get, subscribe: null, onChange: (state) => states.push(state), timers: clock.timers, pollMs: 1000 });
    await flush();
    expect(states.at(-1)).toMatchObject({ mode: "poll", detail: { view: { status: "running" } } });
    await clock.advance(1000);
    expect(states.at(-1)?.detail?.view.jobs[0]?.status).toBe("checking");
    await clock.advance(1000);
    expect(states.at(-1)?.detail?.view.status).toBe("finished");
    expect(get).toHaveBeenCalledTimes(3);
    expect(clock.pending()).toBe(0);
  });

  it("never lets a slow initial run.get revert a finished run, nor a stale error replace it", async () => {
    const clock = manualTimers();
    const pending: Array<(result: RunDetailResult) => void> = [];
    const failing: Array<(error: Error) => void> = [];
    let call = 0;
    const get = vi.fn(
      () =>
        new Promise<RunDetailResult>((resolve, reject) => {
          call += 1;
          if (call === 1) pending.push(resolve);
          else if (call === 2) resolve({ ok: true, value: detail("finished", "succeeded") });
          else failing.push(reject);
        }),
    );
    const states: RunFeedState[] = [];
    const feed = createRunFeed({ runId: "r1", get, subscribe: null, onChange: (state) => states.push(state), timers: clock.timers, pollMs: 100 });
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    await clock.advance(100);
    expect(get).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.detail?.view.status).toBe("finished");
    expect(clock.pending()).toBe(0);

    const refresh = feed.refresh();
    expect(get).toHaveBeenCalledTimes(3);
    pending[0]?.({ ok: true, value: detail("running") });
    await flush();
    expect(states.at(-1)).toMatchObject({ error: null, detail: { view: { status: "finished" } } });

    // The refresh is the newest request, so its error is shown; the finished detail stays.
    failing[0]?.(new Error("offline"));
    await refresh;
    expect(states.at(-1)).toMatchObject({ error: { message: "offline" }, detail: { view: { status: "finished" } } });
  });

  it("drops an error from a request older than the latest answer", async () => {
    const rejects: Array<(error: Error) => void> = [];
    let call = 0;
    const get = vi.fn(
      () =>
        new Promise<RunDetailResult>((resolve, reject) => {
          call += 1;
          if (call === 1) rejects.push(reject);
          else resolve({ ok: true, value: detail("running", "checking") });
        }),
    );
    const states: RunFeedState[] = [];
    const feed = createRunFeed({ runId: "r1", get, subscribe: null, onChange: (state) => states.push(state), timers: manualTimers().timers, pollMs: 100 });
    await feed.refresh();
    rejects[0]?.(new Error("late failure"));
    await flush();
    expect(states.at(-1)).toMatchObject({ error: null, detail: { view: { jobs: [{ status: "checking" }] } } });
  });

  it("uses run.watch events and drops an older run.get answer that arrives after one", async () => {
    let resolveGet: (value: RunDetailResult) => void = () => undefined;
    const get = vi.fn(() => new Promise<RunDetailResult>((resolve) => (resolveGet = resolve)));
    let push: (detail: RunDetail) => void = () => undefined;
    const release = vi.fn();
    const subscribe = vi.fn((_runId: string, onEvent: (detail: RunDetail) => void): FeedSubscription => {
      push = onEvent;
      return { ready: Promise.resolve(), release };
    });
    const states: RunFeedState[] = [];
    const feed = createRunFeed({ runId: "r1", get, subscribe, onChange: (state) => states.push(state), timers: manualTimers().timers });
    push(detail("running", "checking"));
    resolveGet({ ok: true, value: detail("running", "waiting") });
    await flush();
    expect(states.at(-1)).toMatchObject({ mode: "watch" });
    expect(states.at(-1)?.detail?.view.jobs[0]?.status).toBe("checking");
    feed.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("falls back to polling when the subscription is refused or closes", async () => {
    const clock = manualTimers();
    const get = vi.fn((): Promise<RunDetailResult> => Promise.resolve({ ok: true, value: detail("running") }));
    const refused: FeedSubscription = { ready: Promise.reject(new Error("unsupported")), release: vi.fn() };
    const states: RunFeedState[] = [];
    createRunFeed({ runId: "r1", get, subscribe: () => refused, onChange: (state) => states.push(state), timers: clock.timers, pollMs: 500 });
    await flush();
    expect(states.at(-1)?.mode).toBe("poll");
    await clock.advance(500);
    expect(get).toHaveBeenCalledTimes(2);

    let close: (error?: Error) => void = () => undefined;
    const closing = vi.fn((_runId: string, _onEvent: unknown, onClosed: (error?: Error) => void): FeedSubscription => {
      close = onClosed;
      return { ready: Promise.resolve(), release: vi.fn() };
    });
    const later: RunFeedState[] = [];
    const clock2 = manualTimers();
    createRunFeed({ runId: "r1", get, subscribe: closing, onChange: (state) => later.push(state), timers: clock2.timers, pollMs: 500 });
    await flush();
    expect(later.at(-1)?.mode).toBe("watch");
    close(new Error("plugin stopped"));
    expect(later.at(-1)?.mode).toBe("poll");
    expect(clock2.pending()).toBe(1);
  });

  it("reports a refused run.get without dropping the last detail", async () => {
    const results: RunDetailResult[] = [{ ok: true, value: detail("running") }, { ok: false, error: { code: "journal_corrupt", message: "bad journal" } }];
    const clock = manualTimers();
    const states: RunFeedState[] = [];
    createRunFeed({ runId: "r1", get: () => Promise.resolve(results.shift() ?? { ok: false, error: { code: "x", message: "x" } }), subscribe: null, onChange: (state) => states.push(state), timers: clock.timers, pollMs: 10 });
    await flush();
    await clock.advance(10);
    expect(states.at(-1)).toMatchObject({ error: { code: "journal_corrupt" }, detail: { view: { status: "running" } } });
  });
});

const SAVED = "jobs:\n  a: { uses: checks, with: { run: [x] } }\n";

function view(extra: Partial<WorkflowView> = {}): WorkflowView {
  return { saved: { yaml: SAVED, digest: "s".repeat(64) }, draft: null, editableDigest: "s".repeat(64), diagnostics: [], model: null, graph: null, savedPlan: null, proposals: [], ...extra };
}

function draftView(yaml: string, digest: string, diagnostics: WorkflowView["diagnostics"] = []): WorkflowView {
  return view({ draft: { yaml, digest }, editableDigest: digest, diagnostics });
}

function fakeRpc(initial: WorkflowView) {
  const calls: Array<[string, ...unknown[]]> = [];
  let current = initial;
  const ok = (next: WorkflowView): Promise<ViewResult> => {
    current = next;
    return Promise.resolve({ ok: true, value: next });
  };
  const conflict = (): Promise<ViewResult> => Promise.resolve({ ok: false, error: { code: "workflow_conflict", message: "The workflow changed since it was read." } });
  let digestCounter = 0;
  const rpc: WorkflowRpc = {
    get: () => {
      calls.push(["get"]);
      return Promise.resolve({ ok: true, value: current });
    },
    setText: (digest, yaml) => {
      calls.push(["setText", digest, yaml]);
      if (digest !== current.editableDigest) return conflict();
      return ok(draftView(yaml, String(++digestCounter).padStart(64, "d")));
    },
    edit: (digest, op) => {
      calls.push(["edit", digest, op]);
      if (digest !== current.editableDigest) return conflict();
      return ok(draftView(`${current.draft?.yaml ?? SAVED}# edited\n`, String(++digestCounter).padStart(64, "e")));
    },
    discard: (digest) => {
      calls.push(["discard", digest]);
      if (digest !== current.editableDigest) return conflict();
      return ok(view());
    },
    save: (saved, draft) => {
      calls.push(["save", saved, draft]);
      const text = current.draft?.yaml ?? SAVED;
      return ok(view({ saved: { yaml: text, digest: "n".repeat(64) }, editableDigest: "n".repeat(64) }));
    },
    applyProposal: (digest, id) => {
      calls.push(["apply", digest, id]);
      return ok(current);
    },
    discardProposal: (id) => {
      calls.push(["discardProposal", id]);
      return ok(current);
    },
  };
  return { rpc, calls, setCurrent: (next: WorkflowView) => (current = next) };
}

describe("workflow session", () => {
  it("sends typed YAML after a pause with the last-read editable digest", async () => {
    const clock = manualTimers();
    const { rpc, calls } = fakeRpc(view());
    const session = new WorkflowSession(rpc, clock.timers, 400);
    await session.load();
    session.setText(`${SAVED}# one\n`);
    session.setText(`${SAVED}# two\n`);
    expect(session.snapshot()).toMatchObject({ unsent: true });
    await clock.advance(400);
    expect(calls.filter((call) => call[0] === "setText")).toEqual([["setText", "s".repeat(64), `${SAVED}# two\n`]]);
    expect(session.snapshot()).toMatchObject({ unsent: false, text: `${SAVED}# two\n` });
    expect(session.snapshot().view?.draft?.yaml).toBe(`${SAVED}# two\n`);
  });

  it("keeps the unsent text on a conflict, asks for a reload, and resends it on top of the new digest", async () => {
    const clock = manualTimers();
    const fake = fakeRpc(view());
    const session = new WorkflowSession(fake.rpc, clock.timers, 10);
    await session.load();
    fake.setCurrent(draftView("jobs: {}\n", "o".repeat(64)));
    const mine = `${SAVED}# mine\n`;
    session.setText(mine);
    await clock.advance(10);
    expect(session.snapshot().conflict).toEqual({ message: "The workflow changed since it was read.", unsentText: mine });
    expect(session.snapshot().text).toBe(mine);
    expect(canSave(session.snapshot())).toBe(false);
    await session.reload();
    expect(session.snapshot().view?.editableDigest).toBe("o".repeat(64));
    expect(session.snapshot().conflict?.unsentText).toBe(mine);
    await session.useKeptText();
    await clock.advance(10);
    expect(fake.calls.filter((call) => call[0] === "setText").at(-1)).toEqual(["setText", "o".repeat(64), mine]);
    expect(session.snapshot()).toMatchObject({ conflict: null, unsent: false, text: mine });
  });

  it("flushes unsent YAML before a visual edit, so the edit applies on top of it", async () => {
    const clock = manualTimers();
    const fake = fakeRpc(view());
    const session = new WorkflowSession(fake.rpc, clock.timers, 1000);
    await session.load();
    session.setText(`${SAVED}# typed\n`);
    expect(await session.edit({ kind: "job.update", id: "a", set: { name: "A" } })).toBe(true);
    expect(fake.calls.map((call) => call[0])).toEqual(["get", "setText", "edit"]);
    expect(fake.calls[2]?.[1]).toBe("1".padStart(64, "d"));
    expect(session.snapshot().text).toBe(`${SAVED}# typed\n# edited\n`);
    expect(clock.pending()).toBe(0);
  });

  it("saves with both digests only when the draft has no diagnostics, and Discard restores the saved text", async () => {
    const fake = fakeRpc(draftView("bad: [", "b".repeat(64), [{ code: "yaml_syntax", message: "x", line: 1, column: 6, range: null }]));
    const session = new WorkflowSession(fake.rpc, manualTimers().timers);
    await session.load();
    expect(canSave(session.snapshot())).toBe(false);
    expect(await session.discard()).toBe(true);
    expect(fake.calls.at(-1)).toEqual(["discard", "b".repeat(64)]);
    expect(session.snapshot().text).toBe(SAVED);

    fake.setCurrent(draftView(`${SAVED}# ok\n`, "g".repeat(64)));
    await session.load();
    expect(canSave(session.snapshot())).toBe(true);
    await session.save();
    expect(fake.calls.at(-1)).toEqual(["save", "s".repeat(64), "g".repeat(64)]);
    expect(session.snapshot().view?.draft).toBeNull();
  });

  it("keeps YAML typed while Save is pending and sends it next", async () => {
    const clock = manualTimers();
    const fake = fakeRpc(draftView(`${SAVED}# ok\n`, "g".repeat(64)));
    let release = (): void => undefined;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const save = fake.rpc.save;
    fake.rpc.save = async (...args) => {
      await pending;
      return save(...args);
    };
    const session = new WorkflowSession(fake.rpc, clock.timers, 10);
    await session.load();
    const saving = session.save();
    await Promise.resolve();
    const typed = `${SAVED}# ok\n# typed during save\n`;
    session.setText(typed);
    release();
    expect(await saving).toBe(true);
    expect(session.snapshot()).toMatchObject({ text: typed, unsent: true });
    await clock.advance(10);
    expect(fake.calls.at(-1)).toEqual(["setText", "n".repeat(64), typed]);
  });

  it("keeps the newest conflict text typed while Reload or Use my text is reading", async () => {
    for (const action of ["reload", "useKeptText"] as const) {
      const clock = manualTimers();
      const fake = fakeRpc(view());
      const session = new WorkflowSession(fake.rpc, clock.timers, 10);
      await session.load();
      fake.setCurrent(draftView("jobs: {}\n", "o".repeat(64)));
      session.setText(`${SAVED}# first\n`);
      await clock.advance(10);
      expect(session.snapshot().conflict).not.toBeNull();
      let release = (): void => undefined;
      const pending = new Promise<void>((resolve) => (release = resolve));
      const get = fake.rpc.get;
      fake.rpc.get = async () => {
        await pending;
        return get();
      };
      const running = session[action]();
      const newest = `${SAVED}# newest\n`;
      session.setText(newest);
      release();
      await running;
      if (action === "reload") expect(session.snapshot().conflict?.unsentText).toBe(newest);
      else expect(session.snapshot()).toMatchObject({ conflict: null, text: newest });
    }
  });

  it("discards unsent local text without a server call when there is no draft", async () => {
    const clock = manualTimers();
    const fake = fakeRpc(view());
    const session = new WorkflowSession(fake.rpc, clock.timers, 100);
    await session.load();
    session.setText("changed");
    await session.discard();
    await clock.advance(100);
    expect(fake.calls.map((call) => call[0])).toEqual(["get"]);
    expect(session.snapshot()).toMatchObject({ text: SAVED, unsent: false });
  });
});
