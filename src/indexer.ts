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
  type SkipReason,
} from "./git.js";
import {
  databasePath,
  getIndexedShas,
  getStats,
  openDatabase,
  storeProcessedCommit,
} from "./db.js";
import { resolveAffectedPaths, verifyExtraction } from "./verify.js";
import { ensureDecisionEmbeddings } from "./embedder.js";
import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_EMBEDDING_LIMIT,
  DEFAULT_EMBEDDING_MODEL,
} from "./embeddings.js";

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
    "Also embeds decisions that do not have a current embedding.",
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
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = await resolveRepoRoot(options.repoPath);
  // The working directory wins, then the target repository fills in the rest.
  loadDotEnv();
  loadDotEnv(repoRoot);
  const apiKey = getApiKey();
  const db = openDatabase(repoRoot);

  try {
    const commits = await readCommits(repoRoot, options.limit, options.offset);
    const kept: Commit[] = [];
    const skipped = new Map<SkipReason, number>();

    for (const commit of commits) {
      const reason = classifyCommit(commit);
      if (reason === null) {
        kept.push(commit);
      } else {
        skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
      }
    }

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
      `Embedding model: ${DEFAULT_EMBEDDING_MODEL} (${DEFAULT_EMBEDDING_DIM}d)`,
    );
    const skipSummary =
      skipped.size === 0
        ? "none"
        : [...skipped.entries()]
            .map(([reason, count]) => `${reason}=${count}`)
            .join(", ");
    console.error(
      `Scanned ${commits.length} non-merge commits (offset ${options.offset}), skipped ${commits.length - kept.length} (${skipSummary}), kept ${kept.length}, already indexed ${indexed.size}, to process ${todo.length}`,
    );

    const ai = createGeminiClient(apiKey);
    let processed = 0;
    let decisionCount = 0;
    let nonDecisionCount = 0;
    let failureCount = 0;

    if (todo.length > 0) {
      const items: BatchItem[] = [];
      for (const commit of todo) {
        const diff = await getCommitDiff(repoRoot, commit.sha, MAX_DIFF_CHARS);
        items.push({ commit, diff });
      }

      const batches = chunkItems(
        items,
        options.batchSize,
        MAX_BATCH_DIFF_CHARS,
      );

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

            const normalized = verifyExtraction(extraction, item.commit);
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

            if (
              entry.normalized.is_decision &&
              entry.paths.length === 0 &&
              entry.dropped.length === 0
            ) {
              console.error(
                `  warning ${entry.item.commit.sha.slice(0, 7)}: decision has no affected paths`,
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
    } else {
      console.error("Nothing new to index.");
    }

    try {
      const embeddingResult = await ensureDecisionEmbeddings(db, ai, {
        model: DEFAULT_EMBEDDING_MODEL,
        dim: DEFAULT_EMBEDDING_DIM,
        batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
        limit: DEFAULT_EMBEDDING_LIMIT,
        onProgress: (done, total) => {
          console.error(`  embedded ${done}/${total} decision(s)`);
        },
      });

      if (embeddingResult.embedded === 0 && embeddingResult.remaining === 0) {
        console.error("Embeddings: up to date.");
      } else {
        console.error(
          `Embeddings: embedded ${embeddingResult.embedded}, remaining ${embeddingResult.remaining}.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Embedding failed: ${message}`);
      process.exitCode = 1;
    }

    const stats = getStats(db);

    if (processed > 0) {
      console.error(
        `\nIndexed ${processed} commit(s): ${decisionCount} decisions, ${nonDecisionCount} non-decisions, ${failureCount} failure(s).`,
      );
    }

    console.error(
      `DB totals: ${stats.commits} commits, ${stats.decisions} decisions (${stats.stated} stated, ${stats.inferred} inferred, ${stats.embedded} embedded).`,
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
