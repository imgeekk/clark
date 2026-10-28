import {
  classifyCommit,
  readCommits,
  resolveRepoRoot,
  type Commit,
  type SkipReason,
} from "./git.js";

const DEFAULT_LIMIT = 100;
const DEFAULT_BATCH_SIZE = 5;

type Options = {
  repoPath: string;
  limit: number;
  batchSize: number;
  json: boolean;
};

function usage(): string {
  return [
    "Usage: npm run ingest -- [repo-path] [options]",
    "",
    "Scan a git repository and print structured commit data.",
    "",
    "Options:",
    `  --limit <n>       Number of non-merge commits to scan (default: ${DEFAULT_LIMIT})`,
    `  --batch-size <n>  Commits per Gemini request, for the estimate (default: ${DEFAULT_BATCH_SIZE})`,
    "  --json            Print full commit records as JSON (summary goes to stderr)",
    "  -h, --help        Show this help",
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
  let repoPath = ".";
  let limit = DEFAULT_LIMIT;
  let batchSize = DEFAULT_BATCH_SIZE;
  let json = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--limit") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--limit requires a number");
      }
      limit = parsePositiveInt(value, "--limit");
      i += 1;
    } else if (arg.startsWith("--limit=")) {
      limit = parsePositiveInt(arg.slice("--limit=".length), "--limit");
    } else if (arg === "--batch-size") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--batch-size requires a number");
      }
      batchSize = parsePositiveInt(value, "--batch-size");
      i += 1;
    } else if (arg.startsWith("--batch-size=")) {
      batchSize = parsePositiveInt(
        arg.slice("--batch-size=".length),
        "--batch-size",
      );
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new Error(`Expected at most one repo path, got: ${positional.join(", ")}`);
  }

  if (positional.length === 1) {
    repoPath = positional[0];
  }

  return { repoPath, limit, batchSize, json };
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength - 1)}…`;
}

function printSummary(
  repoRoot: string,
  scanned: number,
  limit: number,
  kept: number,
  skipped: Record<SkipReason, number>,
  batchSize: number,
  log: (message: string) => void,
): void {
  const skippedTotal = Object.values(skipped).reduce(
    (total, count) => total + count,
    0,
  );
  const breakdown = (Object.entries(skipped) as Array<[SkipReason, number]>)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");

  log(`Repo: ${repoRoot}`);
  log(`Scanned ${scanned} non-merge commits (newest first, limit ${limit})`);
  log(
    `Kept ${kept}, skipped ${skippedTotal}${breakdown ? ` (${breakdown})` : ""}`,
  );

  if (kept === 0) {
    log("Estimated Gemini requests: 0");
    return;
  }

  // A lower bound: the indexer also splits a batch when its diffs are large.
  const requests = Math.ceil(kept / batchSize);
  log(
    `Estimated Gemini requests: at least ${requests} (${kept} commit${kept === 1 ? "" : "s"} at batch size ${batchSize}; large diffs split batches)`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = await resolveRepoRoot(options.repoPath);
  const commits = await readCommits(repoRoot, options.limit);

  const kept: Commit[] = [];
  const skipped: Record<SkipReason, number> = {
    empty: 0,
    "lockfile-only": 0,
    "generated-only": 0,
    "docs-only": 0,
    "ci-only": 0,
    "test-only": 0,
    "non-code-only": 0,
  };

  for (const commit of commits) {
    const reason = classifyCommit(commit);
    if (reason) {
      skipped[reason] += 1;
    } else {
      kept.push(commit);
    }
  }

  if (options.json) {
    printSummary(repoRoot, commits.length, options.limit, kept.length, skipped, options.batchSize, (line) =>
      console.error(line),
    );
    console.log(JSON.stringify(kept, null, 2));
    return;
  }

  printSummary(repoRoot, commits.length, options.limit, kept.length, skipped, options.batchSize, (line) =>
    console.log(line),
  );
  console.log("");

  for (const commit of kept) {
    const subject = commit.message.split("\n")[0]?.trim() ?? "";
    const fileCount = `${commit.files.length} file${commit.files.length === 1 ? "" : "s"}`;
    console.log(
      `${commit.sha.slice(0, 7)}  ${commit.date.slice(0, 10)}  ${truncate(commit.author, 24)}  ${truncate(subject, 80)}  (${fileCount})`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
