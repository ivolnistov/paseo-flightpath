# Stage 2 host-runtime evidence summary (installed custom Paseo 0.12.0)

Read-only inspection of the installed daemon package `@getpaseo/server` (daemon 0.12.0). The
full coordinator record is in the task ledger (`stage2-host-runtime-evidence.md`).

- **One `PaseoApi` per plugin subprocess.** `dist/server/server/plugins/plugin-process.js`:
  - `:37`: a module-level `paseo`.
  - `:220-231`: `initialize()` creates it over a reconnecting IPC `DaemonClient`.
  - `:443`: handlers receive `{ paseo }`.
  - `:463`: hooks receive the same instance.
  - `:270-289`: it is disposed once at shutdown.

  This is not part of the public type contract. Re-verify after upgrades.
- **No start-time acquisition.** `:236-244`: `contribute()` gets `handle`,
  `registerProvider`, `registerUsageSource`, `registerSettings`, `on` and `before` only.
- **Hydration without UI.**
  - `agent/agent-manager.js:1768,1803` emit `turn_started` for any turn source.
  - `plugins/lifecycle/index.js:55-56` maps it to `agent.turn_started`.
  - `plugins/runtime.js:344-358` fans events out to loaded plugins.
  - The `agent.session_open` before-hook (`agent-manager.js:3817`) may change only `env`
    (`lifecycle/index.js:95-104`).
- **Limits.** Fan-out is asynchronous, so no ordering relative to tool calls is assumed. No
  replay of events missed while the plugin was unloaded was found (absence evidence only).
