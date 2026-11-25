// The decision-references row: links that an agent writes in chat are not host links (the host
// renders the message body itself), so at the end of a turn the observer appends one separate,
// plugin-rendered row listing the roadmap references of that turn, to that agent's own timeline.
// Only this project's links to known sessions count, from assistant messages and completed tool
// results; they are deduplicated and capped at 20; the row carries references only. Re-scanning the
// same turn reuses the row id, so the host replaces the row in place.
//
// Fake lifecycle `on` server and a fake PaseoApi recording timeline appends, over a REAL temp store.
// Event and item shapes follow the installed SDK declarations (agent.turn_ended carries turnId and
// the turn's timeline; tool results sit in a tool_call item's detail.output).
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createPaseoHolder } from "./paseo-holder";
import { openStore } from "./store";
import { fixedClock, nextId, q, session } from "./test-support/build";
import { fakeDirectory } from "./test-support/fake-dir";
import { makeProject, type TestProject } from "./test-support/service";
import { registerTimelineObserver } from "./timeline-rows";

const P = "prj_test";
const AGENT = "agent-refs-1";
const TEXT_MARKER = "ASSISTANT-TEXT-MARKER-4471";

type Handler = (event: unknown, ctx: { paseo: PaseoApi; signal: AbortSignal }) => unknown;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** An opted-in project with sessions s1 (q1..q25) and s2 (q1). */
async function optedIn(): Promise<TestProject> {
  const project = await makeProject();
  cleanups.push(project.cleanup);
  const store = openStore({ storeRoot: project.root, projectId: P, now: fixedClock, newId: nextId, log: () => undefined });
  await store.init();
  await store.transact(1, (d) => {
    d.sessions.push(session("s1", Array.from({ length: 25 }, (_, i) => q(`q${i + 1}`, { order: i }))));
    d.sessions.push(session("s2", [q("q1")]));
  });
  return project;
}

function observe(project: { root: string }) {
  const appends: Array<{ agentId: string; item: Record<string, unknown> }> = [];
  const handlers = new Map<string, Handler[]>();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PaseoApi test stub: only the members the observer uses exist
  const paseo = {
    agents: {
      ref: (id: string) => ({
        id,
        timeline: {
          subscribe: () => Object.assign(() => undefined, { ready: Promise.resolve(), subscriptionId: "sub-1", release: async () => undefined }),
          append: async (item: Record<string, unknown>) => (appends.push({ agentId: id, item }), { seq: appends.length, epoch: "e1" }),
          refetch: async () => ({ entries: [] }),
        },
      }),
    },
  } as unknown as PaseoApi;
  const server = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => undefined;
    },
    async emit(name: string, event: unknown) {
      for (const h of handlers.get(name) ?? []) await h(event, { paseo, signal: new AbortController().signal });
    },
  };
  const dir = fakeDirectory({ projects: [{ projectId: P, projectRootPath: project.root, projectKind: "git" }] });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test recorder for the SDK's generic `on`
  const stop = registerTimelineObserver(server as never, { directory: () => dir, openStore, holder: createPaseoHolder(), log: () => undefined });
  cleanups.push(async () => void (await Promise.resolve().then(stop).catch(() => undefined)));
  const turnEnded = (cwd: string, turnId: string, timeline: unknown[]) =>
    server.emit("agent.turn_ended", { agent: { id: AGENT, workspaceId: "ws-1", parentAgentId: null, provider: "claude", cwd, title: null }, turnId, outcome: { kind: "completed" }, timeline });
  const refRows = () => appends.filter((a) => a.item.kind === "decision-references");
  return { appends, refRows, turnEnded };
}

const assistant = (text: string) => ({ type: "assistant_message", text });
const user = (text: string) => ({ type: "user_message", text });
const toolResult = (output: string, status: "completed" | "running" = "completed") => ({ type: "tool_call", callId: "c1", name: "Read", detail: { type: "unknown", input: {}, output }, status, error: null });
const link = (session: string, n: number, suffix = "") => `roadmap://${P}/s/${session}/q/${n}${suffix}`;

const RefRow = z.looseObject({
  type: z.literal("plugin"),
  id: z.string(),
  kind: z.literal("decision-references"),
  version: z.number().int(),
  data: z.object({
    projectId: z.string(),
    turnId: z.string(),
    refs: z.array(z.object({ link: z.string(), sessionId: z.string(), number: z.number().int(), kind: z.enum(["question", "answer"]) })),
  }),
});

describe("the decision-references row", () => {
  it("lists this turn's references in one row on the agent's own timeline, keyed by the turn", async () => {
    const project = await optedIn();
    const o = observe(project);
    await o.turnEnded(project.root, "turn-1", [assistant(`${TEXT_MARKER} see ${link("s1", 2, "/answer")} and ${link("s2", 1)}`)]);
    expect(o.refRows()).toHaveLength(1);
    const [row] = o.refRows();
    expect(row.agentId).toBe(AGENT);
    const parsed = RefRow.parse(row.item);
    expect(parsed).toMatchObject({ id: "refs.turn-1", version: 1, data: { projectId: P, turnId: "turn-1" } });
    expect(parsed.data.refs).toEqual([
      { link: link("s1", 2, "/answer"), sessionId: "s1", number: 2, kind: "answer" },
      { link: link("s2", 1), sessionId: "s2", number: 1, kind: "question" },
    ]);
  });

  it("carries references only, never the message text", async () => {
    const project = await optedIn();
    const o = observe(project);
    await o.turnEnded(project.root, "turn-1", [assistant(`${TEXT_MARKER} ${link("s1", 3)}`)]);
    const [row] = o.refRows();
    expect(Object.keys(RefRow.parse(row.item).data).sort()).toEqual(["projectId", "refs", "turnId"]);
    expect(JSON.stringify(row.item)).not.toContain(TEXT_MARKER);
  });

  it("counts completed tool results, not user messages or running tools", async () => {
    const project = await optedIn();
    const o = observe(project);
    await o.turnEnded(project.root, "turn-1", [toolResult(`result ${link("s1", 4)}`), toolResult(link("s1", 5), "running"), user(`owner wrote ${link("s1", 6)}`)]);
    expect(RefRow.parse(o.refRows()[0].item).data.refs.map((r) => r.number)).toEqual([4]);
  });

  it("ignores other projects and unknown sessions, deduplicates, and keeps the first 20 in order", async () => {
    const project = await optedIn();
    const o = observe(project);
    const many = Array.from({ length: 25 }, (_, i) => link("s1", i + 1)).join(" ");
    await o.turnEnded(project.root, "turn-1", [
      assistant(`roadmap://prj_other/s/s1/q/1 ${link("unknown", 1)} ${link("s1", 1)} ${link("s1", 1)}`),
      assistant(many),
    ]);
    const refs = RefRow.parse(o.refRows()[0].item).data.refs;
    expect(refs).toHaveLength(20);
    expect(refs.map((r) => r.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(refs.every((r) => r.link.startsWith(`roadmap://${P}/s/s1/`))).toBe(true);
    expect(JSON.stringify(o.refRows()[0].item).length).toBeLessThan(64 * 1024);
  });

  it("appends nothing for a turn without references or for an agent outside an opted-in project", async () => {
    const project = await optedIn();
    const o = observe(project);
    await o.turnEnded(project.root, "turn-1", [assistant("no links here, only Q3 in prose")]);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "dr-refs-outside-")));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await o.turnEnded(outside, "turn-2", [assistant(link("s1", 1))]);
    expect(o.refRows()).toEqual([]);
  });

  it("re-scanning a turn reuses the row id; a turn with more references replaces the row's list", async () => {
    const project = await optedIn();
    const o = observe(project);
    await o.turnEnded(project.root, "turn-1", [assistant(link("s1", 1))]);
    await o.turnEnded(project.root, "turn-1", [assistant(link("s1", 1))]);
    await o.turnEnded(project.root, "turn-1", [assistant(`${link("s1", 1)} ${link("s1", 2)}`)]);
    const rows = o.refRows().map((r) => RefRow.parse(r.item));
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(["refs.turn-1"]));
    expect(rows.at(-1)?.data.refs.map((r) => r.number)).toEqual([1, 2]);
    // An identical re-scan does not add rows beyond the one already shown.
    const identical = rows.filter((r) => JSON.stringify(r.data.refs.map((x) => x.number)) === "[1]");
    expect(identical).toHaveLength(1);
  });
});
