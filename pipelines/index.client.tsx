import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { PluginCleanup } from "@getpaseo/plugin";
import { runWatch } from "./shared/rpc";
import { RunSubscribeContext, type RunSubscribe } from "./client/hooks";
import { PANEL_ID, PANEL_TITLE, PipelinePanel } from "./client/panel";

/** `run.watch` through the client context; null on a host that has no plugin subscriptions. */
export function runSubscribe(client: { readonly subscribe?: PluginClientContext["subscribe"] }): RunSubscribe | null {
  // Older hosts lack `subscribe`; the feed then polls `run.get`.
  if (typeof client.subscribe !== "function") return null;
  return (runId, onEvent, onClosed) => {
    if (typeof client.subscribe !== "function") return null;
    const handle = client.subscribe(runWatch, { runId }, onEvent, { onClosed: ({ error }) => onClosed(error) });
    return { ready: handle.ready, release: () => handle() };
  };
}

export default function contribute(client: PluginClientContext): PluginCleanup {
  const subscribe = runSubscribe(client);
  function Panel(props: PluginWorkspacePanelProps) {
    return (
      <RunSubscribeContext.Provider value={subscribe}>
        <PipelinePanel {...props} />
      </RunSubscribeContext.Provider>
    );
  }
  const remove = client.addWorkspacePanel({ id: PANEL_ID, title: PANEL_TITLE, icon: "Workflow", Component: Panel });
  return async () => {
    await remove();
  };
}
