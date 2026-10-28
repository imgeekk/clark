import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDotEnv } from "./gemini.js";

function withEnvFile(contents: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "clark-env-"));

  try {
    writeFileSync(join(dir, ".env"), contents, "utf8");
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loads a .env file written with a byte order mark", () => {
  const key = "CLARK_TEST_BOM_KEY";
  delete process.env[key];

  withEnvFile(`\uFEFF${key}=value\n`, (dir) => {
    loadDotEnv(dir);
    assert.equal(process.env[key], "value");
  });

  delete process.env[key];
});

test("strips quotes and ignores comments and blank lines", () => {
  const key = "CLARK_TEST_QUOTED_KEY";
  delete process.env[key];

  withEnvFile(`# comment\n\n${key}="quoted value"\n`, (dir) => {
    loadDotEnv(dir);
    assert.equal(process.env[key], "quoted value");
  });

  delete process.env[key];
});

test("does not override an existing environment variable", () => {
  const key = "CLARK_TEST_EXISTING_KEY";
  process.env[key] = "from-environment";

  withEnvFile(`${key}=from-file\n`, (dir) => {
    loadDotEnv(dir);
    assert.equal(process.env[key], "from-environment");
  });

  delete process.env[key];
});

test("ignores a missing .env file", () => {
  assert.doesNotThrow(() => {
    loadDotEnv(join(tmpdir(), "clark-env-does-not-exist"));
  });
});
