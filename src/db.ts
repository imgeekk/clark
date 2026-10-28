import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Commit } from "./git.js";
import type { Extraction } from "./gemini.js";

export type Db = Database.Database;

const SCHEMA_VERSION = 3;

export type DecisionRow = {
  id: number;
  title: string;
  summary: string;
  rationale: string;
  reason_quote: string;
  evidence_type: "stated" | "inferred";
  confidence: number;
  commit_sha: string;
  committed_at: string;
  author: string;
  paths: string | null;
};

export type EmbeddedDecisionRow = DecisionRow & {
  embedding: Buffer;
  embedding_dim: number;
};

export type DecisionPathRow = DecisionRow & {
  matched_path: string;
};

export type DecisionForEmbedding = {
  id: number;
  title: string;
  summary: string;
  rationale: string;
  reason_quote: string;
};

export function repoMemoryDir(repoRoot: string): string {
  return join(repoRoot, ".repo-memory");
}

export function databasePath(repoRoot: string): string {
  return join(repoMemoryDir(repoRoot), "db.sqlite");
}

export function openDatabase(repoRoot: string): Db {
  const dir = repoMemoryDir(repoRoot);
  mkdirSync(dir, { recursive: true });

  // Make the directory self-ignoring so target repositories do not need a
  // root .gitignore change. The DB and WAL files stay local.
  const ignoreFile = join(dir, ".gitignore");
  if (!existsSync(ignoreFile)) {
    writeFileSync(ignoreFile, "*\n", "utf8");
  }

  const db = new Database(databasePath(repoRoot));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  let version = db.pragma("user_version", { simple: true }) as number;

  if (version === SCHEMA_VERSION) {
    return;
  }

  if (version === 0) {
    db.exec(`
      CREATE TABLE commits (
        sha TEXT PRIMARY KEY,
        author TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        message TEXT NOT NULL,
        model TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        rationale TEXT NOT NULL,
        reason_quote TEXT NOT NULL DEFAULT '',
        evidence_type TEXT NOT NULL CHECK (evidence_type IN ('stated', 'inferred')),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        embedding BLOB,
        embedding_model TEXT,
        embedding_dim INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE decision_commits (
        decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        commit_sha TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
        PRIMARY KEY (decision_id, commit_sha)
      );

      CREATE TABLE decision_files (
        decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        PRIMARY KEY (decision_id, path)
      );

      CREATE INDEX idx_decision_files_path ON decision_files(path);
      CREATE INDEX idx_decision_commits_sha ON decision_commits(commit_sha);
      CREATE INDEX idx_decisions_confidence ON decisions(confidence);
    `);

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }

  if (version === 1) {
    db.exec(
      "ALTER TABLE decisions ADD COLUMN reason_quote TEXT NOT NULL DEFAULT '';",
    );
    version = 2;
  }

  if (version === 2) {
    db.exec(`
      ALTER TABLE decisions ADD COLUMN embedding_model TEXT;
      ALTER TABLE decisions ADD COLUMN embedding_dim INTEGER;
    `);
    version = 3;
  }

  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported database schema version ${version}. Delete .repo-memory/db.sqlite to start over.`,
    );
  }

  db.pragma(`user_version = ${version}`);
}

export function getIndexedShas(db: Db, shas: string[]): Set<string> {
  const indexed = new Set<string>();

  // Stay below SQLite's parameter limit even if a future index grows.
  for (let offset = 0; offset < shas.length; offset += 500) {
    const chunk = shas.slice(offset, offset + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT sha FROM commits WHERE sha IN (${placeholders})`)
      .all(...chunk) as Array<{ sha: string }>;

    for (const row of rows) {
      indexed.add(row.sha);
    }
  }

  return indexed;
}

export function deleteCommit(db: Db, sha: string): void {
  const linked = db
    .prepare("SELECT decision_id FROM decision_commits WHERE commit_sha = ?")
    .all(sha) as Array<{ decision_id: number }>;

  // Current extraction is per-commit, so deleting those decisions is safe.
  const deleteDecision = db.prepare("DELETE FROM decisions WHERE id = ?");
  for (const row of linked) {
    deleteDecision.run(row.decision_id);
  }

  db.prepare("DELETE FROM commits WHERE sha = ?").run(sha);
}

function storeDecision(
  db: Db,
  sha: string,
  extraction: Extraction,
  affectedPaths: string[],
): number {
  const info = db
    .prepare(
      `INSERT INTO decisions
        (title, summary, rationale, reason_quote, evidence_type, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      extraction.title,
      extraction.summary,
      extraction.rationale,
      extraction.reason_quote,
      extraction.evidence,
      extraction.confidence,
      new Date().toISOString(),
    );

  const decisionId = Number(info.lastInsertRowid);

  db.prepare(
    "INSERT INTO decision_commits (decision_id, commit_sha) VALUES (?, ?)",
  ).run(decisionId, sha);

  const insertFile = db.prepare(
    "INSERT OR IGNORE INTO decision_files (decision_id, path) VALUES (?, ?)",
  );
  for (const path of affectedPaths) {
    insertFile.run(decisionId, path);
  }

  return decisionId;
}

export function storeProcessedCommit(
  db: Db,
  commit: Commit,
  model: string,
  extraction: Extraction | null,
  affectedPaths: string[],
  force: boolean,
): number[] {
  return db.transaction(() => {
    if (force) {
      deleteCommit(db, commit.sha);
    }

    db.prepare(
      `INSERT INTO commits
        (sha, author, committed_at, message, model, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(sha) DO UPDATE SET
         author = excluded.author,
         committed_at = excluded.committed_at,
         message = excluded.message,
         model = excluded.model,
         indexed_at = excluded.indexed_at`,
    ).run(
      commit.sha,
      commit.author,
      commit.date,
      commit.message,
      model,
      new Date().toISOString(),
    );

    const decisionIds: number[] = [];
    if (extraction?.is_decision) {
      decisionIds.push(
        storeDecision(db, commit.sha, extraction, affectedPaths),
      );
    }

    return decisionIds;
  })();
}

export type IndexedCommitSummary = {
  sha: string;
  date: string;
  subject: string;
};

export function getLastIndexed(db: Db): {
  indexedAt: string | null;
  commit: IndexedCommitSummary | null;
} {
  const indexedAt = db
    .prepare("SELECT MAX(indexed_at) AS at FROM commits")
    .get() as { at: string | null };

  // julianday() compares the timestamps chronologically. Comparing the raw
  // strings would misorder commits written in different timezone offsets.
  const row = db
    .prepare(
      "SELECT sha, committed_at AS date, message FROM commits ORDER BY julianday(committed_at) DESC LIMIT 1",
    )
    .get() as { sha: string; date: string; message: string } | undefined;

  return {
    indexedAt: indexedAt.at,
    commit: row
      ? {
          sha: row.sha,
          date: row.date,
          subject: row.message.split("\n")[0] ?? "",
        }
      : null,
  };
}

export function getStats(db: Db): {
  commits: number;
  decisions: number;
  stated: number;
  inferred: number;
  embedded: number;
} {
  const count = (sql: string): number =>
    (db.prepare(sql).get() as { count: number }).count;

  return {
    commits: count("SELECT COUNT(*) AS count FROM commits"),
    decisions: count("SELECT COUNT(*) AS count FROM decisions"),
    stated: count(
      "SELECT COUNT(*) AS count FROM decisions WHERE evidence_type = 'stated'",
    ),
    inferred: count(
      "SELECT COUNT(*) AS count FROM decisions WHERE evidence_type = 'inferred'",
    ),
    embedded: count(
      "SELECT COUNT(*) AS count FROM decisions WHERE embedding IS NOT NULL",
    ),
  };
}

export function getDecisionsMissingEmbeddings(
  db: Db,
  model: string,
  dim: number,
  limit: number,
): DecisionForEmbedding[] {
  return db
    .prepare(
      `SELECT id, title, summary, rationale, reason_quote
       FROM decisions
       WHERE embedding IS NULL
          OR embedding_model IS NULL
          OR embedding_model != ?
          OR embedding_dim IS NULL
          OR embedding_dim != ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(model, dim, limit) as DecisionForEmbedding[];
}

export function countDecisionsMissingEmbeddings(
  db: Db,
  model: string,
  dim: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM decisions
       WHERE embedding IS NULL
          OR embedding_model IS NULL
          OR embedding_model != ?
          OR embedding_dim IS NULL
          OR embedding_dim != ?`,
    )
    .get(model, dim) as { count: number };

  return row.count;
}

export function storeDecisionEmbedding(
  db: Db,
  id: number,
  model: string,
  dim: number,
  embedding: Buffer,
): void {
  db.prepare(
    `UPDATE decisions
     SET embedding = ?, embedding_model = ?, embedding_dim = ?
     WHERE id = ?`,
  ).run(embedding, model, dim, id);
}

export function getEmbeddedDecisions(
  db: Db,
  model: string,
  dim: number,
): EmbeddedDecisionRow[] {
  return db
    .prepare(
      `SELECT d.id, d.title, d.summary, d.rationale, d.reason_quote,
              d.evidence_type, d.confidence, d.embedding, d.embedding_dim,
              c.sha AS commit_sha, c.committed_at, c.author,
              (SELECT GROUP_CONCAT(df.path, char(31))
               FROM decision_files df
               WHERE df.decision_id = d.id) AS paths
       FROM decisions d
       JOIN decision_commits dc ON dc.decision_id = d.id
       JOIN commits c ON c.sha = dc.commit_sha
       WHERE d.embedding IS NOT NULL
         AND d.embedding_model = ?
         AND d.embedding_dim = ?
       ORDER BY d.id`,
    )
    .all(model, dim) as EmbeddedDecisionRow[];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function getDecisionsForPath(
  db: Db,
  path: string,
  limit: number,
): DecisionRow[] {
  const like = `${escapeLike(path)}/%`;

  return db
    .prepare(
      `SELECT d.id, d.title, d.summary, d.rationale, d.reason_quote,
              d.evidence_type, d.confidence,
              c.sha AS commit_sha, c.committed_at, c.author,
              (SELECT GROUP_CONCAT(df2.path, char(31))
               FROM decision_files df2
               WHERE df2.decision_id = d.id) AS paths
       FROM decision_files df
       JOIN decisions d ON d.id = df.decision_id
       JOIN decision_commits dc ON dc.decision_id = d.id
       JOIN commits c ON c.sha = dc.commit_sha
       WHERE df.path = ? OR df.path LIKE ? ESCAPE '\\'
       ORDER BY julianday(c.committed_at) DESC, d.confidence DESC, d.id DESC
       LIMIT ?`,
    )
    .all(path, like, limit) as DecisionRow[];
}

export function getDecisionsForPaths(
  db: Db,
  paths: string[],
): DecisionPathRow[] {
  const unique = [...new Set(paths)].slice(0, 50);
  if (unique.length === 0) {
    return [];
  }

  const placeholders = unique.map(() => "?").join(", ");

  return db
    .prepare(
      `SELECT d.id, d.title, d.summary, d.rationale, d.reason_quote,
              d.evidence_type, d.confidence,
              c.sha AS commit_sha, c.committed_at, c.author,
              df.path AS matched_path,
              (SELECT GROUP_CONCAT(df2.path, char(31))
               FROM decision_files df2
               WHERE df2.decision_id = d.id) AS paths
       FROM decision_files df
       JOIN decisions d ON d.id = df.decision_id
       JOIN decision_commits dc ON dc.decision_id = d.id
       JOIN commits c ON c.sha = dc.commit_sha
       WHERE df.path IN (${placeholders})
       ORDER BY julianday(c.committed_at) DESC, d.confidence DESC, d.id DESC`,
    )
    .all(...unique) as DecisionPathRow[];
}
