/** Agent providers that accept MCP servers at agent creation. */
export const MCP_PROVIDERS = ["claude", "codex", "opencode", "copilot"] as const;

export const providerSupportsMcp = (p: string) => (MCP_PROVIDERS as readonly string[]).includes(p);
