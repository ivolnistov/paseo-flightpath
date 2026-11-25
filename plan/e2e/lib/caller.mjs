// The RPC call discipline, independent of the daemon connection so it can be checked with a fake
// client (e2e/guards.test.mjs): guards.buildRpcInput decides every call; after the run's halt only
// final reads are sent; an unanswered or unreadable answer is recorded as ambiguous (a write may or
// may not have applied) and halts the run, so nothing after it writes again.
import { buildRpcInput, callAllowed, isWrite, unansweredOutcome, withTimeout } from "./guards.mjs";

export function createCaller({ client, pluginId, projectId, halt, timeoutMs, writeGuard = () => null, plannerAgentId = null }) {
  const transcript = [];
  const owned = new Set();
  const refuse = (method) => new Error(`${method} refused: the run is halted (${halt.reason})`);

  async function call(method, input = {}, { final = false } = {}) {
    // Refusals happen before anything is sent; the revision read for a write is itself a call.
    if (!callAllowed(halt.reason, method, final)) throw refuse(method);
    buildRpcInput(method, input, { projectId, owned, plannerAgentId });
    const withRevision = isWrite(method) && input.expectedRevision === undefined ? { ...input, expectedRevision: (await call("roadmap.version", {}, { final })).revision } : input;
    if (!callAllowed(halt.reason, method, final)) throw refuse(method);
    // A write also needs the run's own guard (the sandbox lock still held); a refusal halts.
    if (isWrite(method)) {
      const why = writeGuard();
      if (why) {
        halt.trigger(why);
        throw refuse(method);
      }
    }
    const full = buildRpcInput(method, withRevision, { projectId, owned, plannerAgentId });
    const entry = { at: new Date().toISOString(), method, write: isWrite(method), input: full };
    transcript.push(entry);
    let out;
    try {
      out = await withTimeout(Promise.resolve().then(() => client.invokePluginRpc(pluginId, method, full)), timeoutMs, method);
    } catch (e) {
      entry.ok = null;
      entry.error = e instanceof Error ? e.message : String(e);
      entry.outcome = unansweredOutcome(entry.write);
      halt.trigger(`${method} got no answer${entry.write ? " (an ambiguous write)" : ""}`);
      throw e;
    }
    if (out?.ok !== true && out?.ok !== false) {
      entry.ok = null;
      entry.outcome = unansweredOutcome(entry.write);
      halt.trigger(`${method} gave an unreadable answer${entry.write ? " (an ambiguous write)" : ""}`);
      throw new Error(`${method}: unreadable answer`);
    }
    entry.ok = out.ok;
    if (out.ok === false) {
      entry.error = out.error;
      throw new Error(`${method} failed: ${JSON.stringify(out.error)}`);
    }
    if (isWrite(method)) entry.value = out.value;
    if (method === "session.create") owned.add(out.value.sessionId);
    return out.value;
  }

  return { call, transcript, owned };
}
