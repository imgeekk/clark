import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { databasePath } from "./db.js";
import { resolveRepoRoot } from "./git.js";
import {
  buildCommand,
  buildEntry,
  type McpConfig,
  SERVER_NAME,
} from "./mcp-config.js";

type Options = {
  repoPath: string;
  json: boolean;
};

function usage(): string {
  return [
    "Usage: clark init [repo-path] [options]",
    "",
    "Print the command that registers clark with an MCP client.",
    "",
    "Options:",
    "  --json       Print the mcpServers JSON instead of the commands",
    "  -h, --help   Show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  let repoPath = ".";
  let json = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.error(usage());
      process.exit(0);
    } else if (arg === "--json") {
      json = true;
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

  return { repoPath, json };
}

// dist/init.js sits next to dist/serve.js. When this runs from source through
// tsx, fall back to the built server in dist/.
function findServePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "serve.js"),
    join(here, "..", "dist", "serve.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not find serve.js. Run `npm run build` first.");
}

function warnIfUnindexed(repoRoot: string): void {
  if (!existsSync(databasePath(repoRoot))) {
    console.error(`No index yet. Run: clark index ${repoRoot}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = await resolveRepoRoot(options.repoPath);
  const servePath = findServePath();

  if (options.json) {
    const config: McpConfig = {
      mcpServers: { [SERVER_NAME]: buildEntry(servePath, repoRoot) },
    };

    console.log(JSON.stringify(config, null, 2));
    console.error("Paste this into the config file your client reads.");
    console.error("To register by command instead, rerun without --json.");
    warnIfUnindexed(repoRoot);
    return;
  }

  const command = buildCommand(servePath, repoRoot);

  console.log(
    `claude mcp add --scope project ${SERVER_NAME} -- ${command}`,
  );
  console.log(`codex mcp add ${SERVER_NAME} -- ${command}`);
  console.log(`opencode mcp add ${SERVER_NAME} -- ${command}`);

  console.error("");
  console.error("Run the line for your client, then restart it.");
  console.error(
    "Claude Code asks you to approve a project-scoped server on first launch.",
  );
  console.error(
    "Codex stores servers globally: use a different name per repository, e.g. clark-oxygen.",
  );
  console.error("For clients that read config files instead, rerun with --json.");
  warnIfUnindexed(repoRoot);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
