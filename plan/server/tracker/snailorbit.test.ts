// SnailOrbit adapter (Stage 4 P4.6, T4.7) against a real loopback MCP server (official SDK 1.32.1).
// No real endpoint: URLs are 127.0.0.1 with a synthetic secret path.
import { afterEach, describe, expect, it } from "vitest";
import { startFakeSnailOrbit, richIssue, type FakeSnailOrbit } from "../test-support/fake-snailorbit";
import { TrackerError } from "./adapter";
import { ConnectionSnapshot, snapshotConnection } from "./connection";
import { createSnailOrbitAdapter, renderSnailOrbit } from "./snailorbit";

const KEY = Buffer.alloc(32, 7);
const settings = { provider: "snailorbit" as const, mode: "live" as const, projectKey: "SYN", closeByProject: { SYN: { field: "State", value: "Done" } } };
const neutral = { title: "Ship it", body: "Body\n\ndecision-roadmap intent I (dr:k)" };

let fakes: FakeSnailOrbit[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.stop().catch(() => undefined)));
  fakes = [];
});
async function fake(opts?: Parameters<typeof startFakeSnailOrbit>[0]) {
  const f = await startFakeSnailOrbit(opts);
  fakes.push(f);
  return f;
}
const snap = async (url: URL) => {
  const s = await snapshotConnection({ read: async () => ({ url }) }, KEY);
  if (!(s instanceof ConnectionSnapshot)) throw new Error(`snapshot failed: ${s.error}`);
  return s;
};
const signal = () => new AbortController().signal;
async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

/** The rejection narrowed to TrackerError; any other rejection fails here (its kind/code assertions could not hold). */
async function trackerFailure(p: Promise<unknown>): Promise<TrackerError> {
  const e = await failure(p);
  if (!(e instanceof TrackerError)) throw new Error(`expected a TrackerError rejection, got ${String(e)}`);
  return e;
}

describe("renderSnailOrbit (pure wire)", () => {
  it("create renders exactly { project_id, subject, text }; close renders { issue_id, fields }", () => {
    expect(renderSnailOrbit("create", neutral, { projectKey: "SYN" })).toEqual({ project_id: "SYN", subject: "Ship it", text: neutral.body });
    expect(renderSnailOrbit("close", { remoteKey: "SYN-7" }, { projectKey: "SYN" }, { field: "State", value: "Done" })).toEqual({ issue_id: "SYN-7", fields: { State: "Done" } });
  });
});

describe("SnailOrbit adapter", () => {
  it("sends exactly the rendered create wire and maps the rich response (url empty)", async () => {
    const f = await fake();
    const adapter = createSnailOrbitAdapter({});
    const wire = adapter.render({ kind: "create", neutral, destination: { projectKey: "SYN" }, settings });
    expect(wire).toEqual(renderSnailOrbit("create", neutral, { projectKey: "SYN" }));
    const session = await adapter.connect(await snap(f.url), signal());
    try {
      const issue = await session.send("create", wire, signal());
      expect(issue).toMatchObject({ remoteId: "3-1", remoteKey: "SYN-1", url: "", closed: false });
    } finally {
      await session.close();
    }
    expect(f.calls).toEqual([{ tool: "create_issue", args: wire }]);
  });

  it.each([
    ["isError", { kind: "isError" as const, text: "rejected: bad project" }, "tool_error"],
    ["unparsable text", { kind: "text" as const, text: "not json" }, "unparsed_response"],
    ["missing id_readable", { kind: "issue" as const, issue: (({ id_readable: _x, ...rest }) => rest)(richIssue(1)) }, "unparsed_response"],
    ["numeric id", { kind: "issue" as const, issue: { ...richIssue(1), id: 31 } }, "unparsed_response"],
  ])("a create %s after the write call started is ambiguous (%s)", async (_name, reply, code) => {
    const f = await fake({ replies: { create_issue: [reply] } });
    const adapter = createSnailOrbitAdapter({});
    const session = await adapter.connect(await snap(f.url), signal());
    const e = await trackerFailure(session.send("create", renderSnailOrbit("create", neutral, { projectKey: "SYN" }), signal()));
    await session.close();
    expect(e).toBeInstanceOf(TrackerError);
    expect(e.kind).toBe("ambiguous");
    expect(e.code).toBe(code);
    expect(f.writes()).toHaveLength(1);
  });

  it("a connection killed after the request started is ambiguous", async () => {
    const f = await fake({ replies: { create_issue: [{ kind: "destroy" }] } });
    const session = await createSnailOrbitAdapter({}).connect(await snap(f.url), signal());
    const e = await trackerFailure(session.send("create", renderSnailOrbit("create", neutral, { projectKey: "SYN" }), signal()));
    await session.close();
    expect(e.kind).toBe("ambiguous");
  });

  it("update_issue with is_closed:false is ambiguous close_unconfirmed; is_closed:true maps closed", async () => {
    // Both responses describe the same issue SYN-5 (3-5) that the wire targets.
    const f = await fake({ replies: { update_issue: [{ kind: "issue", issue: richIssue(5, false) }, { kind: "issue", issue: richIssue(5, true) }] } });
    const session = await createSnailOrbitAdapter({}).connect(await snap(f.url), signal());
    const wire = renderSnailOrbit("close", { remoteKey: "SYN-5" }, { projectKey: "SYN" }, { field: "State", value: "Done" });
    const e = await trackerFailure(session.send("close", wire, signal()));
    expect(e.kind).toBe("ambiguous");
    expect(e.code).toBe("close_unconfirmed");
    expect(await session.send("close", wire, signal())).toMatchObject({ remoteId: "3-5", remoteKey: "SYN-5", closed: true });
    await session.close();
    expect(f.calls.map((c) => c.args)).toEqual([wire, wire]);
  });

  it("a successful create response for another project is ambiguous, never a confirmed issue", async () => {
    const other = { ...richIssue(1), project: { id: "0-9", slug: "OTHER", name: "Other" } };
    const f = await fake({ replies: { create_issue: [{ kind: "issue", issue: other }] } });
    const session = await createSnailOrbitAdapter({}).connect(await snap(f.url), signal());
    const e = await trackerFailure(session.send("create", renderSnailOrbit("create", neutral, { projectKey: "SYN" }), signal()));
    await session.close();
    expect(e).toBeInstanceOf(TrackerError);
    expect(e.kind).toBe("ambiguous");
  });

  it("a close response for a different issue than the wire's issue_id is ambiguous, never a closed mapping", async () => {
    const f = await fake({ replies: { update_issue: [{ kind: "issue", issue: richIssue(8, true) }] } });
    const session = await createSnailOrbitAdapter({}).connect(await snap(f.url), signal());
    const wire = renderSnailOrbit("close", { remoteKey: "SYN-5" }, { projectKey: "SYN" }, { field: "State", value: "Done" });
    const e = await trackerFailure(session.send("close", wire, signal()));
    await session.close();
    expect(e).toBeInstanceOf(TrackerError);
    expect(e.kind).toBe("ambiguous");
  });

  it("a server missing update_issue is a definitive contract_mismatch with zero tool calls", async () => {
    const f = await fake({ tools: ["create_issue", "get_issue"] });
    const e = await trackerFailure(createSnailOrbitAdapter({}).connect(await snap(f.url), signal()));
    expect(e).toBeInstanceOf(TrackerError);
    expect(e.kind).toBe("definitive");
    expect(e.code).toBe("contract_mismatch");
    expect(f.calls).toEqual([]);
  });

  it("an unreachable endpoint fails before any write as definitive connect_failed", async () => {
    const f = await fake();
    const url = f.url;
    await f.stop();
    const e = await trackerFailure(createSnailOrbitAdapter({}).connect(await snap(url), signal()));
    expect(e.kind).toBe("definitive");
    expect(e.code).toBe("connect_failed");
    expect(String(e.message)).not.toContain("synthetic-secret-path");
  });

  it("a hanging create is aborted at timeoutMs: the server observes the abort, the result is ambiguous timeout, no second call", async () => {
    const f = await fake({ replies: { create_issue: [{ kind: "hang" }] } });
    const session = await createSnailOrbitAdapter({ timeoutMs: 50 }).connect(await snap(f.url), signal());
    const e = await trackerFailure(session.send("create", renderSnailOrbit("create", neutral, { projectKey: "SYN" }), signal()));
    expect(e.kind).toBe("ambiguous");
    expect(e.code).toBe("timeout");
    await session.close();
    await session.close(); // idempotent
    await expect.poll(() => f.aborted, { timeout: 2000 }).toEqual(["create_issue"]);
    expect(f.writes()).toHaveLength(1);
  });

  it("timeoutMs bounds send/get only: a 100 ms initialize still connects with timeoutMs 50, then a hanging write aborts at 50 ms", async () => {
    const f = await fake({ initializeDelayMs: 100, replies: { create_issue: [{ kind: "hang" }] } });
    const session = await createSnailOrbitAdapter({ timeoutMs: 50 }).connect(await snap(f.url), signal());
    const started = Date.now();
    const e = await trackerFailure(session.send("create", renderSnailOrbit("create", neutral, { projectKey: "SYN" }), signal()));
    expect(e.kind).toBe("ambiguous");
    expect(e.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
    await session.close();
    await expect.poll(() => f.aborted, { timeout: 2000 }).toEqual(["create_issue"]);
    expect(f.writes()).toHaveLength(1);
  });

  it("get maps a parsed issue and an isError to ambiguous", async () => {
    const f = await fake({ replies: { get_issue: [{ kind: "issue", issue: richIssue(9) }, { kind: "isError", text: "nope" }] } });
    const session = await createSnailOrbitAdapter({}).connect(await snap(f.url), signal());
    expect(await session.get("SYN-9", signal())).toMatchObject({ remoteKey: "SYN-9", url: "" });
    const e = await trackerFailure(session.get("SYN-9", signal()));
    expect(e.kind).toBe("ambiguous");
    await session.close();
  });
});
