# Paseo 0.12.0 plugin contract evidence (installed declarations)

**Type-contract evidence, not live proof.** These are verbatim excerpts of the TypeScript declarations installed
with the dev dependencies, against which this repository's typechecks, lint and entry builds pass. They show the
declared host contracts the client binds to; they do not prove runtime behaviour on a live host or device.

- Packages: `@getpaseo/plugin` 0.12.0 and `@getpaseo/client` 0.12.0 (exact devDependencies in `package.json`).
- Paths are relative to `node_modules/`. Each file's SHA-256 is of the whole installed file; line ranges are 1-based.
- Rechecked on 2026-10-31: every hash and every excerpt below matches the installed files byte for byte.

## `@getpaseo/plugin/dist/client/contracts.d.ts`

SHA-256 `5a163ba92685cdd59916d9224675cee5bf94c18589c24c8519b5a0714df1ed69`

Lines 35-55: Screen parameters and surface props (`PluginScreenParams`, `PluginOpenScreenInput`, `PluginScreenProps`).

```typescript
        }) => void;
    };
}
/** String keys and values: params travel in the screen's URL. */
export type PluginScreenParams = Record<string, string>;
export interface PluginOpenScreenInput {
    screenId: string;
    params?: PluginScreenParams;
}
export interface PluginScreenLocation {
    screenId: string;
    params: PluginScreenParams;
}
export interface PluginSurfaceProps extends PluginNavigableHostProps {
}
export interface PluginScreenProps extends PluginSurfaceProps {
    /** The params the screen was opened with; `{}` when none. */
    params: PluginScreenParams;
}
export interface PluginPopoverProps extends PluginHostProps {
    close(): void;
```

Lines 190-240: Command contexts and slash commands (`PluginWorkspaceCommandContext.openPanel`, `PluginClientSlashCommandContribution` with `argumentHint` and `onSubmit(... & { args })`).

```typescript
    /** @deprecated Use `openScreen`. */
    openSurface(id: string): void;
    openSettings(id: string): void;
}
export interface PluginGlobalCommandContext extends PluginCommandCapabilities {
    context: "global";
}
export interface PluginWorkspaceCommandContext extends PluginCommandCapabilities {
    context: "workspace";
    workspace: PluginWorkspaceSnapshot;
    openPanel(id: string, options?: PluginOpenPanelOptions): void;
}
export interface PluginAgentCommandContext extends PluginCommandCapabilities {
    context: "agent";
    workspace: PluginWorkspaceSnapshot;
    agent: PluginAgentSnapshot;
    openPanel(id: string, options?: PluginOpenPanelOptions): void;
}
interface PluginCommandCenterItemBase {
    id: string;
    title: string;
    icon: string;
    keywords?: readonly string[];
}
export type PluginCommandCenterItemContribution = (PluginCommandCenterItemBase & {
    context: "global";
    onSelect(context: PluginGlobalCommandContext): void | Promise<void>;
}) | (PluginCommandCenterItemBase & {
    context: "workspace";
    onSelect(context: PluginWorkspaceCommandContext): void | Promise<void>;
}) | (PluginCommandCenterItemBase & {
    context: "agent";
    onSelect(context: PluginAgentCommandContext): void | Promise<void>;
});
interface PluginClientSlashCommandBase {
    name: string;
    description: string;
    argumentHint: string;
}
export type PluginClientSlashCommandContribution = (PluginClientSlashCommandBase & {
    context: "workspace";
    onSubmit(context: PluginWorkspaceCommandContext & {
        args: string;
    }): void | Promise<void>;
}) | (PluginClientSlashCommandBase & {
    context: "agent";
    onSubmit(context: PluginAgentCommandContext & {
        args: string;
    }): void | Promise<void>;
});
export type SettingsState<Schema extends ZodType> = ({
```

## `@getpaseo/plugin/dist/client/ui.d.ts`

SHA-256 `21a9277637002ac38f7b8a7d331e924cddd19ace228b2c25c1ec9c35afb343c0`

Lines 30-60: Settings components (`SettingsInput`, `SettingsAction`, `SettingsSelect`, `SettingsSwitch`).

```typescript
export interface SettingsInputHandle {
    focus(): void;
    blur(): void;
    getText(): string;
    replaceText(text: string): void;
}
export interface SettingsInputProps extends SettingsRowProps {
    initialValue?: string;
    onChangeText(text: string): void;
    placeholder?: string;
    disabled?: boolean;
    secureTextEntry?: boolean;
    ref?: Ref<SettingsInputHandle>;
}
export interface SettingsActionProps extends SettingsRowProps {
    actionLabel: string;
    onPress(): void;
    disabled?: boolean;
}
export declare const SettingsGroup: ComponentType<SettingsSectionProps>;
export declare const SettingsSection: ComponentType<SettingsSectionProps>;
export declare const SettingsCard: ComponentType<{
    children: ReactNode;
    testID?: string;
}>;
export declare const SettingsRow: ComponentType<SettingsRowProps>;
export declare const SettingsSwitch: ComponentType<SettingsSwitchProps>;
export declare function SettingsSelect<Value extends string>(props: SettingsSelectProps<Value>): ReactNode;
export declare const SettingsInput: ComponentType<SettingsInputProps>;
export declare const SettingsAction: ComponentType<SettingsActionProps>;
export interface ExternalLinkProps {
```

## `@getpaseo/client/dist/index.d.ts`

SHA-256 `c695801df4fa20305d52cc2526ec227cd20344a62fd2ed0169c42ce3e23e9eb9`

Lines 215-260: Agent timeline events and handle (`replacement`, `subscription_restored`, `error`; `refetch`; `subscribe` semantics).

```typescript
export type PaseoAgentStream = Extract<SessionOutboundMessage, {
    type: "agent_stream";
}>["payload"];
export type PaseoAgentUpdateHandler = (update: PaseoAgentUpdate) => void;
export type PaseoAgentTimelineEvent = PaseoAgentStream | {
    agentId: string;
    event: {
        type: "replacement";
        epoch: string;
    };
} | {
    agentId: string;
    subscriptionId: string;
    event: {
        type: "subscription_restored";
    };
} | {
    agentId: string;
    event: {
        type: "error";
        error: string;
    };
};
export type PaseoAgentTimelineSubscription = ReturnType<DaemonClient["subscribeAgentTimeline"]>;
export interface PaseoAgentTimelineHandle {
    append(item: Omit<PluginTimelineItem, "pluginId">): Promise<{
        seq: number;
        epoch: string;
    }>;
    /**
     * Fetches a fresh timeline page through the existing daemon RPC. If the daemon
     * includes an agent snapshot in the response, the parent handle is updated to
     * that value.
     */
    refetch(options?: PaseoAgentTimelineRefetchOptions): Promise<FetchAgentTimelinePayload>;
    /**
     * Delivers live events only. After reconnect, subscription_restored precedes
     * subsequent updates. History may have been missed; use refetch() to request
     * the range you need. No history is fetched automatically. A replacement event
     * invalidates the previous epoch. Subscription errors release this observation.
     * Await the returned unsubscribe function's `ready` promise before starting
     * work that must be observed. It rejects if establishment fails.
     */
    subscribe(handler: (event: PaseoAgentTimelineEvent) => void): PaseoAgentTimelineSubscription;
}
export interface PaseoAgentHandle {
```

Lines 263-305: Agent handle (`timeline`, `send(text, options)`, `respondToPermission`, snapshot fields).

```typescript
     * `workspaceId` through `archivedAt` mirror the last snapshot this handle
     * observed. A handle from `ref()` reads `null` for all of them until
     * `refresh()`, `run()`, `waitForFinish()`, a timeline refetch, or
     * `subscribe()` delivers a snapshot. Optional snapshot values also read as
     * `null`; use `current()` when you need to distinguish those states.
     */
    readonly workspaceId: string | null;
    readonly cwd: string | null;
    readonly status: PaseoAgent["status"] | null;
    readonly capabilities: PaseoAgent["capabilities"] | null;
    readonly availableModes: PaseoAgent["availableModes"] | null;
    readonly pendingPermissions: PaseoAgent["pendingPermissions"] | null;
    readonly activeTurn: NonNullable<PaseoAgent["activeTurn"]> | null;
    readonly lastUsage: NonNullable<PaseoAgent["lastUsage"]> | null;
    readonly lastError: NonNullable<PaseoAgent["lastError"]> | null;
    readonly features: NonNullable<PaseoAgent["features"]> | null;
    readonly runtimeInfo: NonNullable<PaseoAgent["runtimeInfo"]> | null;
    readonly archivedAt: NonNullable<PaseoAgent["archivedAt"]> | null;
    readonly timeline: PaseoAgentTimelineHandle;
    current(): PaseoAgent | null;
    refresh(requestId?: string): Promise<PaseoAgentRefetchResult | null>;
    send(text: string, options?: PaseoAgentSendOptions): Promise<void>;
    respondToPermission(options: PaseoAgentRespondToPermissionOptions): Promise<void>;
    /** Sends a prompt and resolves when that turn finishes or needs attention. */
    run(text: string, options?: PaseoAgentRunOptions): Promise<PaseoAgentRunResult>;
    /** Waits for the current turn, including one started with `prompt`. */
    waitForFinish(timeoutMs?: number): Promise<PaseoAgentRunResult>;
    /**
     * Asks the running session for the slash commands and skills it actually
     * loaded. Providers answer from the live session, so this sees built-in and
     * bundled entries that no directory scan can find. The payload carries its own
     * `error` string; a provider that cannot answer reports it there rather than
     * rejecting.
     */
    commands(options?: PaseoAgentCommandsOptions): Promise<PaseoAgentCommandsResult>;
    archive(): Promise<{
        archivedAt: string;
    }>;
    detach(): Promise<void>;
    subscribe(handler: (update: PaseoAgentUpdate) => void): () => void;
}
export interface PaseoAgentActions {
    list(options: PaseoAgentListOptions & {
```
