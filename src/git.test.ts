import assert from "node:assert/strict";
import test from "node:test";
import { classifyCommit, type Commit } from "./git.js";

function makeCommit(files: string[]): Commit {
  return {
    sha: "a".repeat(40),
    author: "Test Author",
    date: "2026-01-01T00:00:00Z",
    message: "test",
    files,
  };
}

test("skips empty commits", () => {
  assert.equal(classifyCommit(makeCommit([])), "empty");
});

test("skips lockfile-only commits", () => {
  assert.equal(
    classifyCommit(makeCommit(["package-lock.json", "yarn.lock"])),
    "lockfile-only",
  );
});

test("skips generated and lockfile-only commits", () => {
  assert.equal(
    classifyCommit(makeCommit(["dist/index.js", "package-lock.json"])),
    "generated-only",
  );
});

test("skips docs-only commits", () => {
  assert.equal(
    classifyCommit(
      makeCommit(["README.md", "docs/guide.md", "LICENSE", "LICENSE.txt"]),
    ),
    "docs-only",
  );
});

test("keeps source files whose names start with doc words", () => {
  assert.equal(
    classifyCommit(makeCommit(["authors.ts", "license-checker.ts"])),
    null,
  );
});

test("skips CI-only commits", () => {
  assert.equal(
    classifyCommit(makeCommit([".github/workflows/ci.yml", "Jenkinsfile"])),
    "ci-only",
  );
});

test("skips test-only commits", () => {
  assert.equal(
    classifyCommit(
      makeCommit(["src/index.test.ts", "tests/helper.ts", "pkg/main_test.go"]),
    ),
    "test-only",
  );
});

test("skips mixed non-code commits", () => {
  assert.equal(
    classifyCommit(makeCommit(["README.md", "src/index.test.ts"])),
    "non-code-only",
  );
});

test("keeps commits that touch source and docs", () => {
  assert.equal(
    classifyCommit(makeCommit(["src/index.ts", "README.md"])),
    null,
  );
});

test("keeps commits that touch package.json and a lockfile", () => {
  assert.equal(
    classifyCommit(makeCommit(["package.json", "package-lock.json"])),
    null,
  );
});
