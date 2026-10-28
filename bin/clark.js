#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The CLI entry points in dist/ read process.argv themselves, so this
// dispatcher runs them as child processes instead of mutating argv.
const COMMANDS = {
  serve: "serve.js",
  index: "indexer.js",
  why: "why.js",
  ingest: "ingest.js",
  extract: "extract.js",
};

function usage() {
  return [
    "Usage: clark <command> [repo-path] [options]",
    "",
    "Commands:",
    "  serve     Start the MCP server over stdio (default)",
    "  index     Mine decisions from git history into .repo-memory/db.sqlite",
    "  why       Show decisions that touched a file or directory",
    "  ingest    List the commits the indexer would keep (diagnostic)",
    "  extract   Run extraction on a sample and print raw JSON (diagnostic)",
    "",
    "Run `clark <command> --help` for command options.",
  ].join("\n");
}

const [, , first, ...rest] = process.argv;

if (first === "-h" || first === "--help" || first === "help") {
  console.error(usage());
  process.exit(0);
}

let entry;

if (first === undefined) {
  entry = COMMANDS.serve;
} else if (Object.hasOwn(COMMANDS, first)) {
  entry = COMMANDS[first];
} else if (first.startsWith("-")) {
  console.error(usage());
  process.exit(1);
} else {
  // A bare path argument means "serve this repository".
  entry = COMMANDS.serve;
  rest.unshift(first);
}

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const script = join(distDir, entry);

if (!existsSync(script)) {
  console.error(
    `clark is not built: ${script} is missing. Run \`npm run build\` in the clark checkout.`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [script, ...rest], {
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`clark failed to start ${entry}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
