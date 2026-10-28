import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { databasePath } from "./db.js";
import { resolveRepoRoot } from "./git.js";
import { buildEntry, mergeConfig, SERVER_NAME } from "./mcp-config.js";

type Options = {
  repoPath: string;
  write: boolean;
  force: boolean;
};

const CONFIG_FILE = ".mcp.json";

function usage(): string {
  return [
    "Usage: npx tsx src/init.ts [repo-path] [options]",
    "",
    "Print the MCP client config that launches clark for a repository.",
    "",
    "Options:",
    `  --write      Create ${CONFIG_FILE} in the repository`,
    "  --force      Replace an existing clark entry in that file",
    "  -h, --help   Show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  let repoPath = ".";
  let write = false;
  let force = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.error(usage());
      process.exit(0);
    } else if (arg === "--write") {
      write = true;
    } else if (arg === "--force") {
      force = true;
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

  return { repoPath, write, force };
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

function readExisting(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }

  let text = readFileSync(path, "utf8");

  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON. Fix it or remove it first.`);
  }
}

function warnIfUnindexed(repoRoot: string): void {
  if (!existsSync(databasePath(repoRoot))) {
    console.error(`No index yet. Run: clark index ${repoRoot}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = await resolveRepoRoot(options.repoPath);
  const entry = buildEntry(findServePath(), repoRoot);

  if (!options.write) {
    const snippet = { mcpServers: { [SERVER_NAME]: entry } };
    console.log(JSON.stringify(snippet, null, 2));
    console.error(
      "Add this to your MCP client's config, or rerun with --write to create .mcp.json here.",
    );
    console.error(
      "The paths are absolute, so they only apply to this machine.",
    );
    warnIfUnindexed(repoRoot);
    return;
  }

  const configPath = join(repoRoot, CONFIG_FILE);
  const merged = mergeConfig(readExisting(configPath), entry, options.force);

  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.error(`Wrote ${configPath}`);
  console.error("Restart your MCP client to pick it up.");
  warnIfUnindexed(repoRoot);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
