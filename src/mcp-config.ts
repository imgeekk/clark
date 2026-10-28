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

// Always quote: an unquoted Windows path loses its separators in bash, and a
// path with a space breaks in every shell.
export function quoteArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

// The launch command shared by clients whose CLI takes
// `mcp add <name> -- <command>`. `node` is used instead of the clark shim
// because clients spawn the process directly and may not resolve a Windows
// .cmd wrapper.
export function buildCommand(servePath: string, repoRoot: string): string {
  return `node ${quoteArg(servePath)} ${quoteArg(repoRoot)}`;
}
