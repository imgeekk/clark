import {
  createGeminiClient,
  getApiKey,
  loadDotEnv,
  MAX_DIFF_CHARS,
  parseExtraction,
  requestSingleExtraction,
  type Extraction,
} from "./gemini.js";
import {
  classifyCommit,
  getCommitDiff,
  readCommits,
  resolveRepoRoot,
  type Commit,
} from "./git.js";

const DEFAULT_LIMIT = 20;
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

type Options = {
  repoPath: string;
  limit: number;
  offset: number;
  model: string;
};

type Result = {
  commit: Commit;
  extraction: Extraction | null;
  raw: string;
  error?: string;
};

function usage(): string {
  return [
    "Usage: npx tsx src/extract.ts [repo-path] [options]",
    "",
    "Run Gemini extraction on a small sample of commits and print raw JSON.",
    "",
    "Options:",
    `  --limit <n>    Number of non-merge commits to sample (default: ${DEFAULT_LIMIT})`,
    "  --offset <n>   Skip the newest N commits before sampling (default: 0)",
    `  --model <id>   Gemini model to use (default: ${DEFAULT_MODEL})`,
    "  -h, --help     Show this help",
    "",
    "Requires GEMINI_API_KEY, either in the environment or in .env.",
  ].join("\n");
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--limit must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseOffset(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--offset must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Options {
  let repoPath = ".";
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  let model = DEFAULT_MODEL;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--limit") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--limit requires a number");
      }
      limit = parseLimit(value);
      i += 1;
    } else if (arg.startsWith("--limit=")) {
      limit = parseLimit(arg.slice("--limit=".length));
    } else if (arg === "--offset") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--offset requires a number");
      }
      offset = parseOffset(value);
      i += 1;
    } else if (arg.startsWith("--offset=")) {
      offset = parseOffset(arg.slice("--offset=".length));
    } else if (arg === "--model") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--model requires a model ID");
      }
      model = value;
      i += 1;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
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

  return { repoPath, limit, offset, model };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = await resolveRepoRoot(options.repoPath);
  // The working directory wins, then the target repository fills in the rest.
  loadDotEnv();
  loadDotEnv(repoRoot);
  const apiKey = getApiKey();
  const commits = await readCommits(repoRoot, options.limit, options.offset);
  const kept = commits.filter((commit) => classifyCommit(commit) === null);

  console.error(`Repo: ${repoRoot}`);
  console.error(`Model: ${options.model}`);
  console.error(
    `Scanned ${commits.length} non-merge commits (offset ${options.offset}), kept ${kept.length} after skip rules`,
  );

  if (kept.length === 0) {
    console.error("No commits to extract.");
    return;
  }

  const ai = createGeminiClient(apiKey);
  const results: Result[] = [];

  for (const [index, commit] of kept.entries()) {
    const subject = commit.message.split("\n")[0]?.trim() ?? "";
    console.error(
      `\n=== [${index + 1}/${kept.length}] ${commit.sha.slice(0, 7)} ${subject} ===`,
    );

    try {
      const diff = await getCommitDiff(repoRoot, commit.sha, MAX_DIFF_CHARS);
      const raw = await requestSingleExtraction(
        ai,
        options.model,
        commit,
        diff,
      );
      console.log(raw);

      try {
        const extraction = parseExtraction(raw);
        results.push({ commit, extraction, raw });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ commit, extraction: null, raw, error: message });
        console.error(`  schema error: ${message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ commit, extraction: null, raw: "", error: message });
      console.error(`  request failed: ${message}`);
    }
  }

  const decisions = results.filter(
    (result) => result.extraction?.is_decision === true,
  );
  const failures = results.filter((result) => result.error !== undefined);

  console.error(
    `\nSummary: ${kept.length} commits, ${decisions.length} decisions, ${failures.length} failures`,
  );

  for (const result of decisions) {
    const extraction = result.extraction;
    if (!extraction) {
      continue;
    }

    console.error(
      `${result.commit.sha.slice(0, 7)}  ${extraction.evidence.padEnd(8)}  ${extraction.confidence.toFixed(2)}  ${extraction.title}`,
    );
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
