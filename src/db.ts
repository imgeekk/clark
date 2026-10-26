import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Commit } from "./git.js";
import type { Extraction } from "./gemini.js";

export type Db = Database.Database;

const SCHEMA_VERSION = 1;

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
  const version = db.pragma("user_version", { simple: true }) as number;

  if (version === SCHEMA_VERSION) {
    return;
  }

  if (version !== 0) {
    throw new Error(
      `Unsupported database schema version ${version}. Delete .repo-memory/db.sqlite to start over.`,
    );
  }

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
      evidence_type TEXT NOT NULL CHECK (evidence_type IN ('stated', 'inferred')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      embedding BLOB,
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
        (title, summary, rationale, evidence_type, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      extraction.title,
      extraction.summary,
      extraction.rationale,
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
): void {
  const transaction = db.transaction(() => {
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

    if (extraction?.is_decision) {
      storeDecision(db, commit.sha, extraction, affectedPaths);
    }
  });

  transaction();
}

export function getStats(db: Db): {
  commits: number;
  decisions: number;
  stated: number;
  inferred: number;
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
  };
}
