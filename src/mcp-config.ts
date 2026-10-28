export type McpServerEntry = {
  command: string;
  args: string[];
};

export type McpConfig = {
  mcpServers: Record<string, McpServerEntry>;
};

export const SERVER_NAME = "clark";

export function buildEntry(
  servePath: string,
  repoRoot: string,
): McpServerEntry {
  return { command: "node", args: [servePath, repoRoot] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameEntry(a: unknown, b: McpServerEntry): boolean {
  if (!isRecord(a)) {
    return false;
  }

  if (a.command !== b.command) {
    return false;
  }

  if (!Array.isArray(a.args) || a.args.length !== b.args.length) {
    return false;
  }

  return a.args.every((arg, index) => arg === b.args[index]);
}

// Adds or updates the clark entry while leaving other servers untouched.
// An existing entry that differs is only replaced when `force` is set.
export function mergeConfig(
  existing: unknown,
  entry: McpServerEntry,
  force: boolean,
): McpConfig {
  if (existing === undefined || existing === null) {
    return { mcpServers: { [SERVER_NAME]: entry } };
  }

  if (!isRecord(existing)) {
    throw new Error("Existing .mcp.json is not a JSON object.");
  }

  const servers = existing.mcpServers ?? {};

  if (!isRecord(servers)) {
    throw new Error('Existing .mcp.json has a "mcpServers" that is not an object.');
  }

  if (sameEntry(servers[SERVER_NAME], entry)) {
    return existing as McpConfig;
  }

  if (servers[SERVER_NAME] !== undefined && !force) {
    throw new Error(
      `Existing .mcp.json already defines "${SERVER_NAME}". Rerun with --force to replace it.`,
    );
  }

  return {
    ...existing,
    mcpServers: { ...servers, [SERVER_NAME]: entry },
  };
}
