import { existsSync } from "node:fs";
import {
  databasePath,
  getLastIndexed,
  getStats,
  openDatabase,
  type IndexedCommitSummary,
} from "./db.js";
import {
  countCommitsSince,
  readHead,
  resolveRepoRoot,
  type HeadInfo,
} from "./git.js";

type Options = {
  repoPath: string;
  json: boolean;
};

type StatusReport = {
  repo: string;
  database: string;
  indexed: boolean;
  commits: number;
  decisions: {
    total: number;
    stated: number;
    inferred: number;
    embedded: number;
  };
  lastIndexedAt: string | null;
  lastIndexedCommit: IndexedCommitSummary | null;
  head: HeadInfo | null;
  commitsSinceIndexed: number | null;
  upToDate: boolean;
};

function usage(): string {
  return [
    "Usage: npx tsx src/status.ts [repo-path] [options]",
    "",
    "Show what clark has indexed for a repository and whether it is current.",
    "",
    "Options:",
    "  --json       Print JSON instead of text",
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

async function buildReport(repoRoot: string): Promise<StatusReport> {
  const database = databasePath(repoRoot);
  const head = await readHead(repoRoot);
  const empty: StatusReport = {
    repo: repoRoot,
    database,
    indexed: false,
    commits: 0,
    decisions: { total: 0, stated: 0, inferred: 0, embedded: 0 },
    lastIndexedAt: null,
    lastIndexedCommit: null,
    head,
    commitsSinceIndexed: null,
    upToDate: false,
  };

  // Do not create the database just to report that it is missing.
  if (!existsSync(database)) {
    return empty;
  }

  const db = openDatabase(repoRoot);

  try {
    const stats = getStats(db);
    const last = getLastIndexed(db);
    const upToDate = Boolean(head && last.commit && head.sha === last.commit.sha);
    let commitsSinceIndexed: number | null = null;

    if (head && last.commit && !upToDate) {
      commitsSinceIndexed = await countCommitsSince(repoRoot, last.commit.sha);
    } else if (upToDate) {
      commitsSinceIndexed = 0;
    }

    return {
      ...empty,
      indexed: stats.commits > 0,
      commits: stats.commits,
      decisions: {
        total: stats.decisions,
        stated: stats.stated,
        inferred: stats.inferred,
        embedded: stats.embedded,
      },
      lastIndexedAt: last.indexedAt,
      lastIndexedCommit: last.commit,
      commitsSinceIndexed,
      upToDate,
    };
  } finally {
    db.close();
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function day(date: string): string {
  return date.slice(0, 10);
}

function minute(date: string): string {
  // Stored timestamps are UTC. Keep the Z so the time is not read as local.
  return `${date.replace("T", " ").slice(0, 16)}Z`;
}

function formatReport(report: StatusReport): string {
  const lines = [`Repo:    ${report.repo}`, `DB:      ${report.database}`];

  if (!report.indexed) {
    lines.push("Commits: none indexed");

    if (report.head) {
      lines.push(`HEAD:    ${short(report.head.sha)}  ${report.head.subject}`);
    }

    lines.push(
      `Status:  not indexed yet; run \`clark index ${report.repo}\``,
    );
    return lines.join("\n");
  }

  const { decisions } = report;
  lines.push(
    `Commits: ${report.commits} indexed, ${decisions.total} decisions (${decisions.stated} stated, ${decisions.inferred} inferred), ${decisions.embedded} embedded`,
  );

  if (report.lastIndexedAt) {
    lines.push(`Last run: ${minute(report.lastIndexedAt)}`);
  }

  if (report.lastIndexedCommit) {
    lines.push(
      `Newest:  ${short(report.lastIndexedCommit.sha)}  ${day(report.lastIndexedCommit.date)}  ${report.lastIndexedCommit.subject}`,
    );
  }

  if (report.head) {
    lines.push(`HEAD:    ${short(report.head.sha)}  ${report.head.subject}`);
  }

  if (report.upToDate) {
    lines.push("Status:  up to date");
  } else if (report.commitsSinceIndexed !== null) {
    const count = report.commitsSinceIndexed;
    lines.push(
      `Status:  ${count} commit${count === 1 ? "" : "s"} since the newest indexed commit; run \`clark index ${report.repo}\``,
    );
  } else {
    lines.push(
      `Status:  HEAD has moved since the last index; run \`clark index ${report.repo}\``,
    );
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = await resolveRepoRoot(options.repoPath);
  const report = await buildReport(repoRoot);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatReport(report));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
