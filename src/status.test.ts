import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getLastIndexed, openDatabase, storeProcessedCommit } from "./db.js";
import type { Extraction } from "./gemini.js";
import type { Commit } from "./git.js";

const extraction: Extraction = {
  is_decision: false,
  title: "",
  summary: "",
  rationale: "",
  reason_quote: "",
  evidence: "none",
  confidence: 0,
  affected_paths: [],
};

function commit(sha: string, date: string, message: string): Commit {
  return { sha, author: "Test Author", date, message, files: ["src/a.ts"] };
}

function withDb(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "clark-status-"));

  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("reports nothing for a database with no commits", () => {
  withDb((root) => {
    const db = openDatabase(root);

    try {
      assert.deepEqual(getLastIndexed(db), {
        indexedAt: null,
        commit: null,
      });
    } finally {
      db.close();
    }
  });
});

test("picks the newest commit by time, not by string order", () => {
  withDb((root) => {
    const db = openDatabase(root);

    try {
      storeProcessedCommit(
        db,
        commit(
          "a".repeat(40),
          "2026-01-01T10:00:00+05:30",
          "Older in real time\n\nBody",
        ),
        "test-model",
        extraction,
        [],
        false,
      );
      storeProcessedCommit(
        db,
        commit("b".repeat(40), "2026-01-01T06:00:00+00:00", "Newer in real time"),
        "test-model",
        extraction,
        [],
        false,
      );

      const last = getLastIndexed(db);

      assert.equal(last.commit?.sha, "b".repeat(40));
      assert.equal(last.commit?.subject, "Newer in real time");
      assert.ok(last.indexedAt);
    } finally {
      db.close();
    }
  });
});

test("uses the first line of a multi-line message as the subject", () => {
  withDb((root) => {
    const db = openDatabase(root);

    try {
      storeProcessedCommit(
        db,
        commit("c".repeat(40), "2026-02-02T00:00:00+00:00", "Subject\n\nWhy: body"),
        "test-model",
        extraction,
        [],
        false,
      );

      assert.equal(getLastIndexed(db).commit?.subject, "Subject");
    } finally {
      db.close();
    }
  });
});
