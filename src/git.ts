import { execFile } from "node:child_process";

const MAX_BUFFER = 50 * 1024 * 1024;

export type Commit = {
  sha: string;
  author: string;
  date: string;
  message: string;
  files: string[];
};

export type SkipReason =
  | "empty"
  | "lockfile-only"
  | "generated-only"
  | "docs-only"
  | "ci-only"
  | "test-only"
  | "non-code-only";

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

const DOCS_DIRS = [
  "docs/",
  "doc/",
  "documentation/",
  ".github/issue_template/",
];

const DOC_EXTENSIONS = [".md", ".mdx", ".rst", ".markdown"];

const DOC_BASENAMES = new Set([
  "readme",
  "license",
  "licence",
  "copying",
  "changelog",
  "contributing",
  "authors",
  "notice",
  "code_of_conduct",
]);

const CI_DIRS = [
  ".github/workflows/",
  ".github/actions/",
  ".circleci/",
  ".buildkite/",
];

const CI_FILES = new Set([
  ".gitlab-ci.yml",
  ".travis.yml",
  "azure-pipelines.yml",
  "appveyor.yml",
  "bitbucket-pipelines.yml",
  "cloudbuild.yaml",
  "jenkinsfile",
  ".drone.yml",
]);

const TEST_DIRS = [
  "test/",
  "tests/",
  "__tests__/",
  "spec/",
  "specs/",
  "__mocks__/",
  "__snapshots__/",
  "bench/",
  "benchmarks/",
  "testdata/",
  "e2e/",
  "cypress/",
  "playwright/",
];

const TEST_CONFIG_PREFIXES = [
  "jest.config.",
  "vitest.config.",
  "karma.conf.",
  "playwright.config.",
  "cypress.config.",
  ".mocharc",
];

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

export async function resolveRepoRoot(input: string): Promise<string> {
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

export async function readCommits(
  repoRoot: string,
  limit: number,
  skip = 0,
): Promise<Commit[]> {
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
      "--skip",
      String(skip),
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

export async function getCommitDiff(
  repoRoot: string,
  sha: string,
  maxChars = 12_000,
): Promise<string> {
  try {
    const stdout = await runGit([
      "-C",
      repoRoot,
      "show",
      sha,
      "--format=",
      "--patch",
      "--unified=3",
      "--no-renames",
    ]);

    if (stdout.length <= maxChars) {
      return stdout;
    }

    return `${stdout.slice(0, maxChars)}\n\n[... diff truncated at ${maxChars} characters ...]`;
  } catch (error) {
    throw new Error(
      `git show failed for ${sha}\n${describeGitError(error)}`,
    );
  }
}

function parseLog(output: string): Commit[] {
  const commits: Commit[] = [];

  for (const chunk of output.split("\x1e")) {
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
  const first = raw.indexOf("\x1f");
  const second = raw.indexOf("\x1f", first + 1);
  const third = raw.indexOf("\x1f", second + 1);
  // The last separator is the one we put after the message. This keeps
  // parsing correct even if a commit message contains a field separator.
  const last = raw.lastIndexOf("\x1f");

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

function normalizedLowerPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .toLowerCase();
}

function isDocs(filePath: string): boolean {
  const normalized = normalizedLowerPath(filePath);

  if (
    DOCS_DIRS.some(
      (dir) => normalized === dir.slice(0, -1) || normalized.startsWith(dir),
    )
  ) {
    return true;
  }

  const name = basename(normalized);

  if (DOC_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return true;
  }

  const dot = name.lastIndexOf(".");
  if (dot === -1) {
    return DOC_BASENAMES.has(name);
  }

  const stem = name.slice(0, dot);
  return name.endsWith(".txt") && DOC_BASENAMES.has(stem);
}

function isCi(filePath: string): boolean {
  const normalized = normalizedLowerPath(filePath);

  if (
    CI_DIRS.some(
      (dir) => normalized === dir.slice(0, -1) || normalized.startsWith(dir),
    )
  ) {
    return true;
  }

  return CI_FILES.has(basename(normalized));
}

function isTest(filePath: string): boolean {
  const normalized = normalizedLowerPath(filePath);

  if (
    TEST_DIRS.some(
      (dir) => normalized === dir.slice(0, -1) || normalized.startsWith(dir),
    )
  ) {
    return true;
  }

  const name = basename(normalized);

  if (TEST_CONFIG_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return true;
  }

  if (name.endsWith(".snap")) {
    return true;
  }

  return (
    /\.(test|spec)\.[^.]+$/.test(name) ||
    /_(test|spec)\.[^.]+$/.test(name) ||
    /^test_.+\.py$/.test(name)
  );
}

function isNonCode(filePath: string): boolean {
  return (
    isLockfile(filePath) ||
    isGenerated(filePath) ||
    isDocs(filePath) ||
    isCi(filePath) ||
    isTest(filePath)
  );
}

export function classifyCommit(commit: Commit): SkipReason | null {
  if (commit.files.length === 0) {
    return "empty";
  }

  if (commit.files.every(isLockfile)) {
    return "lockfile-only";
  }

  if (commit.files.every((file) => isLockfile(file) || isGenerated(file))) {
    return "generated-only";
  }

  if (commit.files.every(isDocs)) {
    return "docs-only";
  }

  if (commit.files.every(isCi)) {
    return "ci-only";
  }

  if (commit.files.every(isTest)) {
    return "test-only";
  }

  if (commit.files.every(isNonCode)) {
    return "non-code-only";
  }

  return null;
}
