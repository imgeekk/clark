import { execFile } from "node:child_process";

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";
const DEFAULT_LIMIT = 100;
const MAX_BUFFER = 50 * 1024 * 1024;

type Commit = {
  sha: string;
  author: string;
  date: string;
  message: string;
  files: string[];
};

type SkipReason = "empty" | "lockfile-only" | "generated-only";

type Options = {
  repoPath: string;
  limit: number;
  json: boolean;
};

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "go.work.sum",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "flake.lock",
  "pubspec.lock",
  "mix.lock",
]);

const GENERATED_DIRS = [
  "dist/",
  "build/",
  "node_modules/",
  "vendor/",
  "coverage/",
  ".next/",
  "target/",
  "third_party/",
];

const GENERATED_SUFFIXES = [".min.js", ".min.css", ".map"];

function usage(): string {
  return [
    "Usage: npm run ingest -- [repo-path] [options]",
    "",
    "Scan a git repository and print structured commit data.",
    "",
    "Options:",
    `  --limit <n>   Number of non-merge commits to scan (default: ${DEFAULT_LIMIT})`,
    "  --json        Print full commit records as JSON (summary goes to stderr)",
    "  -h, --help    Show this help",
  ].join("\n");
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--limit must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Options {
  let repoPath = ".";
  let limit = DEFAULT_LIMIT;
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
      limit = parseLimit(value);
      i += 1;
    } else if (arg.startsWith("--limit=")) {
      limit = parseLimit(arg.slice("--limit=".length));
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

  return { repoPath, limit, json };
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { encoding: "utf8", maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

type GitFailure = Error & {
  code?: string | number;
  stderr?: string;
};

function describeGitError(error: unknown): string {
  if (error instanceof Error) {
    const gitError = error as GitFailure;
    return gitError.stderr?.trim() || gitError.message;
  }

  return String(error);
}

async function resolveRepoRoot(input: string): Promise<string> {
  try {
    const stdout = await runGit(["-C", input, "rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch (error) {
    const gitError = error as GitFailure;

    if (gitError.code === "ENOENT") {
      throw new Error("git was not found on PATH.");
    }

    const detail = gitError.stderr?.trim();
    throw new Error(
      `Not a git repository: ${input}${detail ? `\n${detail}` : ""}`,
    );
  }
}

async function readCommits(repoRoot: string, limit: number): Promise<Commit[]> {
  // `git log` fails with a long "Command failed" message on an unborn branch.
  // Checking HEAD first lets us give the user a direct explanation instead.
  try {
    await runGit(["-C", repoRoot, "rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch (error) {
    const gitError = error as GitFailure;

    if (gitError.code === 1) {
      throw new Error(`Repository has no commits yet: ${repoRoot}`);
    }

    throw new Error(
      `Could not read repository HEAD: ${repoRoot}\n${describeGitError(error)}`,
    );
  }

  // Use control characters as separators so multi-line commit messages
  // cannot be confused with the file list that follows.
  // %cI is the committer date, which matches git log's ordering. The author
  // date (%aI) can be older after a rebase or cherry-pick.
  const format = "%x1e%H%x1f%an%x1f%cI%x1f%B%x1f";

  try {
    const stdout = await runGit([
      "-C",
      repoRoot,
      "log",
      "--no-merges",
      "--no-renames",
      "-n",
      String(limit),
      `--pretty=format:${format}`,
      "--name-only",
    ]);

    return parseLog(stdout);
  } catch (error) {
    throw new Error(
      `git log failed in ${repoRoot}\n${describeGitError(error)}`,
    );
  }
}

function parseLog(output: string): Commit[] {
  const commits: Commit[] = [];

  for (const chunk of output.split(RECORD_SEP)) {
    if (chunk.trim().length === 0) {
      continue;
    }

    const commit = parseRecord(chunk);
    if (commit) {
      commits.push(commit);
    }
  }

  return commits;
}

function parseRecord(raw: string): Commit | null {
  const first = raw.indexOf(FIELD_SEP);
  const second = raw.indexOf(FIELD_SEP, first + 1);
  const third = raw.indexOf(FIELD_SEP, second + 1);
  // The last separator is the one we put after the message. This keeps
  // parsing correct even if a commit message contains a field separator.
  const last = raw.lastIndexOf(FIELD_SEP);

  if (first < 0 || second < 0 || third < 0 || last <= third) {
    return null;
  }

  const sha = raw.slice(0, first).trim();
  const author = raw.slice(first + 1, second).trim();
  const date = raw.slice(second + 1, third).trim();
  const message = raw.slice(third + 1, last).replace(/\r\n/g, "\n").trimEnd();
  const files = raw
    .slice(last + 1)
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);

  if (!sha) {
    return null;
  }

  return { sha, author, date, message, files };
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function isLockfile(filePath: string): boolean {
  const name = basename(filePath);
  return LOCKFILES.has(name) || name.endsWith(".lock");
}

function isGenerated(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");

  if (
    GENERATED_DIRS.some(
      (dir) => normalized === dir.slice(0, -1) || normalized.startsWith(dir),
    )
  ) {
    return true;
  }

  return GENERATED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function classify(commit: Commit): SkipReason | null {
  if (commit.files.length === 0) {
    return "empty";
  }

  if (commit.files.every(isLockfile)) {
    return "lockfile-only";
  }

  if (commit.files.every((file) => isLockfile(file) || isGenerated(file))) {
    return "generated-only";
  }

  return null;
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
  log: (message: string) => void,
): void {
  const skippedTotal =
    skipped.empty + skipped["lockfile-only"] + skipped["generated-only"];
  const breakdown = (Object.entries(skipped) as Array<[SkipReason, number]>)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");

  log(`Repo: ${repoRoot}`);
  log(`Scanned ${scanned} non-merge commits (newest first, limit ${limit})`);
  log(
    `Kept ${kept}, skipped ${skippedTotal}${breakdown ? ` (${breakdown})` : ""}`,
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
  };

  for (const commit of commits) {
    const reason = classify(commit);
    if (reason) {
      skipped[reason] += 1;
    } else {
      kept.push(commit);
    }
  }

  if (options.json) {
    printSummary(repoRoot, commits.length, options.limit, kept.length, skipped, (line) =>
      console.error(line),
    );
    console.log(JSON.stringify(kept, null, 2));
    return;
  }

  printSummary(repoRoot, commits.length, options.limit, kept.length, skipped, (line) =>
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
