import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  countDecisionsMissingEmbeddings,
  getDecisionsMissingEmbeddings,
  getEmbeddedDecisions,
  getStats,
  openDatabase,
  storeDecisionEmbedding,
  storeProcessedCommit,
  type Db,
  type EmbeddedDecisionRow,
} from "./db.js";
import {
  encodeEmbedding,
  normalizeEmbedding,
} from "./embeddings.js";
import type { Extraction } from "./gemini.js";
import type { Commit } from "./git.js";
import {
  checkChange,
  normalizeQueryPath,
  rankEmbeddedDecisions,
  whyPath,
} from "./retrieval.js";

type DecisionOptions = {
  sha: string;
  date: string;
  files: string[];
  title?: string;
  summary?: string;
  rationale?: string;
  evidence?: Extraction["evidence"];
  confidence?: number;
  reasonQuote?: string;
};

function makeCommit(sha: string, date: string, files: string[]): Commit {
  return {
    sha,
    author: "Test Author",
    date,
    message: `Commit ${sha}`,
    files,
  };
}

function makeExtraction(options: DecisionOptions): Extraction {
  return {
    is_decision: true,
    title: options.title ?? "Decision",
    summary: options.summary ?? "Summary",
    rationale: options.rationale ?? "The diff suggests a reason.",
    reason_quote: options.reasonQuote ?? "",
    evidence: options.evidence ?? "inferred",
    confidence: options.confidence ?? 0.6,
    affected_paths: options.files,
  };
}

function addDecision(db: Db, options: DecisionOptions): number {
  const ids = storeProcessedCommit(
    db,
    makeCommit(options.sha, options.date, options.files),
    "test-model",
    makeExtraction(options),
    options.files,
    false,
  );

  assert.equal(ids.length, 1);
  return ids[0];
}

function withDb(fn: (db: Db) => void): void {
  const root = mkdtempSync(join(tmpdir(), "clark-test-"));
  const db = openDatabase(root);

  try {
    fn(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function embeddedRow(
  id: number,
  title: string,
  values: number[],
): EmbeddedDecisionRow {
  return {
    id,
    title,
    summary: "Summary",
    rationale: "Rationale",
    reason_quote: "",
    evidence_type: "inferred",
    confidence: 0.6,
    commit_sha: `sha-${id}`,
    committed_at: "2026-01-01T00:00:00.000Z",
    author: "Test Author",
    paths: "src/a.ts",
    embedding: encodeEmbedding(normalizeEmbedding(values)),
    embedding_dim: values.length,
  };
}

test("normalizes repository-relative query paths", () => {
  assert.equal(normalizeQueryPath(".\\src\\index.ts"), "src/index.ts");
  assert.equal(normalizeQueryPath("./src/index.ts/"), "src/index.ts");
  assert.equal(normalizeQueryPath("  src/index.ts  "), "src/index.ts");
});

test("whyPath finds exact files and directory children", () => {
  withDb((db) => {
    addDecision(db, {
      sha: "a",
      date: "2026-01-01T00:00:00.000Z",
      files: ["src/index.ts", "package.json"],
      title: "Index decision",
    });
    addDecision(db, {
      sha: "b",
      date: "2026-01-02T00:00:00.000Z",
      files: ["src/other.ts"],
      title: "Other decision",
    });
    addDecision(db, {
      sha: "c",
      date: "2026-01-03T00:00:00.000Z",
      files: ["docs/readme.md"],
      title: "Docs decision",
    });

    const exact = whyPath(db, "src/index.ts", { limit: 5 });
    assert.equal(exact.results.length, 1);
    assert.equal(exact.results[0].title, "Index decision");
    assert.deepEqual(exact.results[0].paths, ["package.json", "src/index.ts"]);

    const directory = whyPath(db, "src", { limit: 5 });
    assert.deepEqual(
      directory.results.map((decision) => decision.title),
      ["Other decision", "Index decision"],
    );

    assert.equal(whyPath(db, "src/missing.ts", { limit: 5 }).results.length, 0);
  });
});

test("whyPath treats LIKE wildcard characters literally", () => {
  withDb((db) => {
    addDecision(db, {
      sha: "underscore",
      date: "2026-01-01T00:00:00.000Z",
      files: ["src/a_b/file.ts"],
      title: "Underscore path",
    });
    addDecision(db, {
      sha: "wildcard",
      date: "2026-01-02T00:00:00.000Z",
      files: ["src/axb/file.ts"],
      title: "Wildcard path",
    });

    const result = whyPath(db, "src/a_b", { limit: 5 });
    assert.deepEqual(
      result.results.map((decision) => decision.title),
      ["Underscore path"],
    );
  });
});

test("checkChange ranks by file overlap, then recency", () => {
  withDb((db) => {
    addDecision(db, {
      sha: "a",
      date: "2026-01-01T00:00:00.000Z",
      files: ["src/a.ts", "src/b.ts"],
      title: "Older but wider",
      confidence: 0.9,
      evidence: "stated",
      reasonQuote: "because the old behavior broke",
    });
    addDecision(db, {
      sha: "b",
      date: "2026-02-01T00:00:00.000Z",
      files: ["src/a.ts"],
      title: "Newer but narrower",
      confidence: 0.8,
    });
    addDecision(db, {
      sha: "c",
      date: "2026-03-01T00:00:00.000Z",
      files: ["src/c.ts"],
      title: "Unrelated",
      confidence: 0.9,
    });

    const result = checkChange(db, ["src/a.ts", "src/b.ts"], { limit: 3 });

    assert.deepEqual(
      result.results.map((decision) => decision.title),
      ["Older but wider", "Newer but narrower"],
    );
    assert.equal(result.results[0].overlap, 2);
    assert.deepEqual(
      [...result.results[0].matched_files].sort(),
      ["src/a.ts", "src/b.ts"],
    );
  });
});

test("checkChange prefers the newer decision when overlap is equal", () => {
  withDb((db) => {
    addDecision(db, {
      sha: "older",
      date: "2026-01-01T00:00:00.000Z",
      files: ["src/a.ts"],
      title: "Older",
    });
    addDecision(db, {
      sha: "newer",
      date: "2026-02-01T00:00:00.000Z",
      files: ["src/a.ts"],
      title: "Newer",
    });

    const result = checkChange(db, ["src/a.ts"], { limit: 3 });
    assert.deepEqual(
      result.results.map((decision) => decision.title),
      ["Newer", "Older"],
    );
  });
});

test("compares commit dates chronologically across timezones", () => {
  withDb((db) => {
    addDecision(db, {
      sha: "earlier",
      date: "2026-01-01T10:00:00+05:30",
      files: ["src/a.ts"],
      title: "Earlier",
    });
    addDecision(db, {
      sha: "later",
      date: "2026-01-01T05:00:00+00:00",
      files: ["src/a.ts"],
      title: "Later",
    });

    assert.deepEqual(
      whyPath(db, "src/a.ts", { limit: 5 }).results.map(
        (decision) => decision.title,
      ),
      ["Later", "Earlier"],
    );
    assert.deepEqual(
      checkChange(db, ["src/a.ts"], { limit: 3 }).results.map(
        (decision) => decision.title,
      ),
      ["Later", "Earlier"],
    );
  });
});

test("checkChange stays silent for low-confidence and unknown files", () => {
  withDb((db) => {
    addDecision(db, {
      sha: "low",
      date: "2026-01-01T00:00:00.000Z",
      files: ["src/a.ts"],
      title: "Weak guess",
      evidence: "inferred",
      confidence: 0.4,
    });

    assert.equal(checkChange(db, ["src/a.ts"], { limit: 3 }).results.length, 0);
    assert.deepEqual(checkChange(db, ["src/missing.ts"], { limit: 3 }), {
      files: ["src/missing.ts"],
      results: [],
    });
  });
});

test("checkChange caps the number of returned decisions", () => {
  withDb((db) => {
    for (let index = 0; index < 4; index += 1) {
      addDecision(db, {
        sha: `sha-${index}`,
        date: `2026-01-0${index + 1}T00:00:00.000Z`,
        files: ["src/a.ts"],
        title: `Decision ${index}`,
      });
    }

    assert.equal(checkChange(db, ["src/a.ts"], { limit: 2 }).results.length, 2);
  });
});

test("ranks embedded decisions by cosine similarity", () => {
  const query = normalizeEmbedding([1, 0]);
  const rows = [
    embeddedRow(1, "Orthogonal", [0, 1]),
    embeddedRow(2, "Exact", [1, 0]),
    embeddedRow(3, "Near", [0.8, 0.2]),
  ];

  const ranked = rankEmbeddedDecisions(rows, query, 2);

  assert.deepEqual(
    ranked.map((decision) => decision.title),
    ["Exact", "Near"],
  );
  assert.ok(ranked[0].score > ranked[1].score);
});

test("tracks missing embeddings and stores new ones", () => {
  withDb((db) => {
    const id = addDecision(db, {
      sha: "a",
      date: "2026-01-01T00:00:00.000Z",
      files: ["src/a.ts"],
    });

    assert.equal(countDecisionsMissingEmbeddings(db, "test-embedding", 2), 1);
    assert.equal(
      getDecisionsMissingEmbeddings(db, "test-embedding", 2, 10).length,
      1,
    );

    storeDecisionEmbedding(
      db,
      id,
      "test-embedding",
      2,
      encodeEmbedding(new Float32Array([1, 0])),
    );

    assert.equal(countDecisionsMissingEmbeddings(db, "test-embedding", 2), 0);
    const embedded = getEmbeddedDecisions(db, "test-embedding", 2);
    assert.equal(embedded.length, 1);
    assert.equal(embedded[0].paths, "src/a.ts");
    assert.equal(getStats(db).embedded, 1);
  });
});
