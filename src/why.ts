import { openDatabase } from "./db.js";
import { resolveRepoRoot } from "./git.js";
import { whyPath, type DecisionRecord } from "./retrieval.js";

const DEFAULT_LIMIT = 5;

type Options = {
  path: string;
  repoPath: string;
  limit: number;
  json: boolean;
};

function usage(): string {
  return [
    "Usage: npx tsx src/why.ts <path> [repo-path] [options]",
    "",
    "Show decisions that touched a file or directory.",
    "",
    "Options:",
    `  --limit <n>  Maximum decisions to show (default: ${DEFAULT_LIMIT})`,
    "  --json       Print JSON instead of text",
    "  -h, --help   Show this help",
  ].join("\n");
}

function parsePositiveInt(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Options {
  let limit = DEFAULT_LIMIT;
  let json = false;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--limit") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--limit requires a number");
      }
      limit = parsePositiveInt(value, "--limit");
      index += 1;
    } else if (arg.startsWith("--limit=")) {
      limit = parsePositiveInt(arg.slice("--limit=".length), "--limit");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new Error(`A path is required.\n\n${usage()}`);
  }

  if (positional.length > 2) {
    throw new Error(
      `Expected a path and at most one repo path, got: ${positional.join(", ")}`,
    );
  }

  return {
    path: positional[0],
    repoPath: positional[1] ?? ".",
    limit,
    json,
  };
}

function printDecision(decision: DecisionRecord): void {
  const evidence =
    decision.evidence === "inferred"
      ? "inferred (a guess, not a stated fact)"
      : "stated";

  console.log(`\n${decision.title}`);
  console.log(`  Evidence: ${evidence} (${decision.confidence.toFixed(2)})`);

  if (decision.reason_quote) {
    console.log(`  Quote: "${decision.reason_quote}"`);
  }

  console.log(`  Rationale: ${decision.rationale}`);
  console.log(
    `  Commit: ${decision.commit_sha.slice(0, 7)} ${decision.committed_at.slice(0, 10)}`,
  );

  if (decision.paths.length > 0) {
    console.log(`  Files: ${decision.paths.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = await resolveRepoRoot(options.repoPath);
  const db = openDatabase(repoRoot);

  try {
    const result = whyPath(db, options.path, { limit: options.limit });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.results.length === 0) {
      console.log(`No decisions found for ${result.path}.`);
      return;
    }

    console.log(`Decisions for ${result.path}:`);
    for (const decision of result.results) {
      printDecision(decision);
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
