import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase } from "./db.js";
import { loadDotEnv } from "./gemini.js";
import { resolveRepoRoot } from "./git.js";
import { createMcpServer } from "./mcp.js";

function usage(): string {
  return [
    "Usage: npx tsx src/serve.ts [repo-path]",
    "",
    "Start the clark MCP server over stdio.",
    "",
    "The repository defaults to the current directory.",
  ].join("\n");
}

function parseArgs(argv: string[]): { repoPath: string } {
  let repoPath = ".";
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.error(usage());
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new Error(
      `Expected at most one repo path, got: ${positional.join(", ")}`,
    );
  }

  if (positional.length === 1) {
    repoPath = positional[0];
  }

  return { repoPath };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = await resolveRepoRoot(options.repoPath);
  // The editor spawns this server from its own working directory, so read
  // the key from the repository the server was pointed at, not from cwd.
  loadDotEnv(repoRoot);
  const db = openDatabase(repoRoot);
  const server = createMcpServer(db);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error(`clark MCP server ready: ${repoRoot}`);

  const shutdown = async (): Promise<void> => {
    await server.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
