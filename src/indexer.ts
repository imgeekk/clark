import {
  createGeminiClient,
  getApiKey,
  loadDotEnv,
  MAX_DIFF_CHARS,
  parseBatchExtraction,
  parseExtraction,
  requestBatchExtraction,
  requestSingleExtraction,
  type BatchItem,
  type Extraction,
} from "./gemini.js";
import {
  classifyCommit,
  getCommitDiff,
  readCommits,
  resolveRepoRoot,
  type Commit,
} from "./git.js";
import {
  databasePath,
  getIndexedShas,
  getStats,
  openDatabase,
  storeProcessedCommit,
} from "./db.js";

const DEFAULT_LIMIT = 100;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_MODEL = "gemini-3-flash-preview";
const MAX_BATCH_DIFF_CHARS = 48_000;

type Options = {
  repoPath: string;
  limit: number;
  offset: number;
  batchSize: number;
  model: string;
  force: boolean;
};

function usage(): string {
  return [
    "Usage: npx tsx src/indexer.ts [repo-path] [options]",
    "",
    "Index git history into <repo>/.repo-memory/db.sqlite.",
    "",
    "Options:",
    `  --limit <n>       Non-merge commits to scan (default: ${DEFAULT_LIMIT})`,
    "  --offset <n>      Skip the newest N commits (default: 0)",
    `  --batch-size <n>  Commits per Gemini request (default: ${DEFAULT_BATCH_SIZE})`,
    `  --model <id>      Gemini model (default: ${DEFAULT_MODEL})`,
    "  --force           Re-index commits already in the database",
    "  -h, --help        Show this help",
    "",
    "Requires GEMINI_API_KEY, either in the environment or in .env.",
  ].join("\n");
}

function parsePositiveInt(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Options {
  let repoPath = ".";
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  let batchSize = DEFAULT_BATCH_SIZE;
  let model = DEFAULT_MODEL;
  let force = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--limit") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--limit requires a number");
      }
      limit = parsePositiveInt(value, "--limit");
      i += 1;
    } else if (arg.startsWith("--limit=")) {
      limit = parsePositiveInt(arg.slice("--limit=".length), "--limit");
    } else if (arg === "--offset") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--offset requires a number");
      }
      offset = parseNonNegativeInt(value, "--offset");
      i += 1;
    } else if (arg.startsWith("--offset=")) {
      offset = parseNonNegativeInt(arg.slice("--offset=".length), "--offset");
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

  return { repoPath, limit, offset, batchSize, model, force };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function resolveAffectedPaths(
  commit: Commit,
  affectedPaths: string[],
): { paths: string[]; dropped: string[] } {
  const files = new Set(commit.files);
  const normalized = [
    ...new Set(affectedPaths.map(normalizePath).filter(Boolean)),
  ];
  const valid = normalized.filter((path) => files.has(path));
  const dropped = normalized.filter((path) => !files.has(path));

  // If the model returned no usable paths, keep the commit's full file list
  // so path-based lookups can still find the decision.
  if (valid.length > 0) {
    return { paths: valid, dropped };
  }

  return { paths: commit.files, dropped };
}

const REASON_MARKERS =
  /\b(because|since|so that|so|to avoid|to fix|to handle|to prevent|to support|to make|to keep|to ensure|to reduce|to improve|to match|to align|to work around|due to|in order to|for|when|broke|breaks|broken|regression|crash|crashes|fails|failing|incompatible|deprecated|removed|removes|workaround|instead|rather than|otherwise|without)\b/i;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeExtraction(
  extraction: Extraction,
  commit: Commit,
): { extraction: Extraction; warning?: string } {
  if (!extraction.is_decision) {
    return {
      extraction: {
        is_decision: false,
        title: "",
        summary: "",
        rationale: "",
        reason_quote: "",
        evidence: "none",
        confidence: 0,
        affected_paths: [],
      },
    };
  }

  if (extraction.evidence === "none") {
    throw new Error("Decision has evidence 'none'.");
  }

  const title = extraction.title.trim();
  const summary = extraction.summary.trim();
  const rationale = extraction.rationale.trim();

  if (!title || !summary || !rationale) {
    throw new Error("Decision is missing title, summary, or rationale.");
  }

  let evidence = extraction.evidence;
  let confidence = extraction.confidence;
  let reasonQuote = extraction.reason_quote.trim();
  let warning: string | undefined;

  if (evidence === "stated") {
    const message = normalizeWhitespace(commit.message).toLowerCase();
    const quote = normalizeWhitespace(reasonQuote).toLowerCase();
    const isSubstring = quote.length >= 8 && message.includes(quote);
    const looksCausal = REASON_MARKERS.test(quote);

    if (!isSubstring || !looksCausal) {
      warning =
        "stated evidence had no valid causal reason_quote; downgraded to inferred";
      evidence = "inferred";
      confidence = Math.min(confidence, 0.7);
      reasonQuote = "";
    }
  } else {
    reasonQuote = "";
  }

  // Enforce the moderate-scope policy even if the model ignores the prompt.
  if (evidence === "inferred") {
    confidence = Math.min(confidence, 0.7);
  }

  return {
    extraction: {
      ...extraction,
      title,
      summary,
      rationale,
      reason_quote: reasonQuote,
      evidence,
      confidence,
    },
    warning,
  };
}

function chunkItems(
  items: BatchItem[],
  maxSize: number,
  maxChars: number,
): BatchItem[][] {
  const batches: BatchItem[][] = [];
  let current: BatchItem[] = [];
  let currentChars = 0;

  for (const item of items) {
    const size = item.diff.length + item.commit.message.length + 300;
    const wouldExceed =
      current.length > 0 &&
      (current.length >= maxSize || currentChars + size > maxChars);

    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(item);
    currentChars += size;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

async function main(): Promise<void> {
  loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  const apiKey = getApiKey();
  const repoRoot = await resolveRepoRoot(options.repoPath);
  const db = openDatabase(repoRoot);

  try {
    const commits = await readCommits(repoRoot, options.limit, options.offset);
    const kept = commits.filter((commit) => classifyCommit(commit) === null);
    const indexed = getIndexedShas(
      db,
      kept.map((commit) => commit.sha),
    );
    const todo = options.force
      ? kept
      : kept.filter((commit) => !indexed.has(commit.sha));

    console.error(`Repo: ${repoRoot}`);
    console.error(`Database: ${databasePath(repoRoot)}`);
    console.error(`Model: ${options.model}`);
    console.error(
      `Scanned ${commits.length} non-merge commits (offset ${options.offset}), kept ${kept.length}, already indexed ${indexed.size}, to process ${todo.length}`,
    );

    if (todo.length === 0) {
      const stats = getStats(db);
      console.error(
        `Nothing to do. DB has ${stats.commits} commits and ${stats.decisions} decisions.`,
      );
      return;
    }

    const items: BatchItem[] = [];
    for (const commit of todo) {
      const diff = await getCommitDiff(repoRoot, commit.sha, MAX_DIFF_CHARS);
      items.push({ commit, diff });
    }

    const batches = chunkItems(items, options.batchSize, MAX_BATCH_DIFF_CHARS);
    const ai = createGeminiClient(apiKey);
    let processed = 0;
    let decisionCount = 0;
    let nonDecisionCount = 0;
    let failureCount = 0;

    for (const [batchIndex, batch] of batches.entries()) {
      const shas = batch
        .map((item) => item.commit.sha.slice(0, 7))
        .join(", ");
      console.error(
        `\nBatch ${batchIndex + 1}/${batches.length}: ${batch.length} commit(s) [${shas}]`,
      );

      let raw = "";

      try {
        let results: Map<string, Extraction>;

        if (batch.length === 1) {
          const item = batch[0];
          raw = await requestSingleExtraction(
            ai,
            options.model,
            item.commit,
            item.diff,
          );
          results = new Map([[item.commit.sha, parseExtraction(raw)]]);
        } else {
          raw = await requestBatchExtraction(ai, options.model, batch);
          results = parseBatchExtraction(
            raw,
            batch.map((item) => item.commit.sha),
          );
        }

        const prepared = batch.map((item) => {
          const extraction = results.get(item.commit.sha);
          if (!extraction) {
            throw new Error(`Missing result for ${item.commit.sha}.`);
          }

          const normalized = normalizeExtraction(extraction, item.commit);
          const { paths, dropped } = resolveAffectedPaths(
            item.commit,
            normalized.extraction.affected_paths,
          );

          return {
            item,
            normalized: normalized.extraction,
            warning: normalized.warning,
            paths,
            dropped,
          };
        });

        for (const entry of prepared) {
          if (entry.warning) {
            console.error(
              `  warning ${entry.item.commit.sha.slice(0, 7)}: ${entry.warning}`,
            );
          }

          if (entry.dropped.length > 0) {
            console.error(
              `  warning ${entry.item.commit.sha.slice(0, 7)}: dropped paths not in commit: ${entry.dropped.join(", ")}`,
            );
          }

          storeProcessedCommit(
            db,
            entry.item.commit,
            options.model,
            entry.normalized,
            entry.paths,
            options.force,
          );

          processed += 1;
          if (entry.normalized.is_decision) {
            decisionCount += 1;
          } else {
            nonDecisionCount += 1;
          }
        }
      } catch (error) {
        failureCount += batch.length;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  batch failed: ${message}`);
        if (raw) {
          console.error(`  raw response:\n${raw}`);
        }
      }
    }

    const stats = getStats(db);
    console.error(
      `\nIndexed ${processed} commit(s): ${decisionCount} decisions, ${nonDecisionCount} non-decisions, ${failureCount} failure(s).`,
    );
    console.error(
      `DB totals: ${stats.commits} commits, ${stats.decisions} decisions (${stats.stated} stated, ${stats.inferred} inferred).`,
    );

    if (failureCount > 0) {
      process.exitCode = 1;
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
