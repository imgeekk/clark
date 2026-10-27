import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./db.js";
import {
  cosineSimilarity,
  decisionEmbeddingText,
  decodeEmbedding,
  encodeEmbedding,
  normalizeEmbedding,
} from "./embeddings.js";

test("builds embedding text from the decision and its quote", () => {
  const text = decisionEmbeddingText({
    title: "Pin dependency",
    summary: "Pinned the dependency.",
    rationale: "The new major version broke streaming.",
    reason_quote: "because v4 broke streaming",
  });

  assert.match(text, /Pin dependency/);
  assert.match(text, /because v4 broke streaming/);
});

test("normalizes an embedding to unit length", () => {
  const vector = normalizeEmbedding([3, 4]);
  const norm = Math.sqrt(vector[0] ** 2 + vector[1] ** 2);

  assert.ok(Math.abs(norm - 1) < 1e-6);
  assert.ok(Math.abs(vector[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(vector[1] - 0.8) < 1e-6);
});

test("computes cosine similarity", () => {
  const a = normalizeEmbedding([1, 0]);
  const b = normalizeEmbedding([0, 1]);
  const c = normalizeEmbedding([1, 0]);

  assert.equal(cosineSimilarity(a, c), 1);
  assert.equal(cosineSimilarity(a, b), 0);
  assert.equal(cosineSimilarity(a, normalizeEmbedding([-1, 0])), -1);
});

test("rejects similarity across different dimensions", () => {
  assert.throws(
    () => cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1])),
    /different dimensions/,
  );
});

test("round-trips an embedding through the BLOB encoding", () => {
  const vector = new Float32Array([0.25, -0.5, 0.75]);
  const decoded = decodeEmbedding(encodeEmbedding(vector));

  assert.deepEqual([...decoded], [...vector]);
});

test("migrates a v2 database to the embedding columns", () => {
  const root = mkdtempSync(join(tmpdir(), "clark-test-"));
  const dir = join(root, ".repo-memory");
  mkdirSync(dir, { recursive: true });

  const old = new Database(databasePath(root));
  old.exec(`
    CREATE TABLE decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      rationale TEXT NOT NULL,
      reason_quote TEXT NOT NULL DEFAULT '',
      evidence_type TEXT NOT NULL,
      confidence REAL NOT NULL,
      embedding BLOB,
      created_at TEXT NOT NULL
    );
  `);
  old.pragma("user_version = 2");
  old.close();

  const db = openDatabase(root);

  try {
    const columns = db.pragma("table_info(decisions)") as Array<{
      name: string;
    }>;
    assert.ok(columns.some((column) => column.name === "embedding_model"));
    assert.ok(columns.some((column) => column.name === "embedding_dim"));
    assert.equal(db.pragma("user_version", { simple: true }), 3);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
