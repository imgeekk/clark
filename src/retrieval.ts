import type { GeminiClient } from "./gemini.js";
import {
  getDecisionsForPath,
  getDecisionsForPaths,
  getEmbeddedDecisions,
  type Db,
  type DecisionPathRow,
  type DecisionRow,
  type EmbeddedDecisionRow,
} from "./db.js";
import {
  cosineSimilarity,
  decodeEmbedding,
  embedQuery,
} from "./embeddings.js";

const MIN_CHECK_CONFIDENCE = 0.5;

export type DecisionRecord = {
  id: number;
  title: string;
  summary: string;
  rationale: string;
  reason_quote: string;
  evidence: "stated" | "inferred";
  confidence: number;
  commit_sha: string;
  committed_at: string;
  author: string;
  paths: string[];
};

export type SearchResult = DecisionRecord & {
  score: number;
};

export type ChangeResult = DecisionRecord & {
  overlap: number;
  matched_files: string[];
};

function splitPaths(paths: string | null): string[] {
  return paths ? paths.split("\x1f").filter(Boolean).sort() : [];
}

function commitTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toDecisionRecord(
  row: DecisionRow | EmbeddedDecisionRow | DecisionPathRow,
): DecisionRecord {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    rationale: row.rationale,
    reason_quote: row.reason_quote,
    evidence: row.evidence_type,
    confidence: row.confidence,
    commit_sha: row.commit_sha,
    committed_at: row.committed_at,
    author: row.author,
    paths: splitPaths(row.paths),
  };
}

export function normalizeQueryPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "")
    .trim();
}

export function rankEmbeddedDecisions(
  rows: EmbeddedDecisionRow[],
  queryVector: Float32Array,
  limit: number,
): SearchResult[] {
  const seen = new Set<number>();
  const results: SearchResult[] = [];

  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);

    results.push({
      ...toDecisionRecord(row),
      score: Number(
        cosineSimilarity(queryVector, decodeEmbedding(row.embedding)).toFixed(
          4,
        ),
      ),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function searchDecisions(
  db: Db,
  ai: GeminiClient,
  query: string,
  options: { model: string; dim: number; limit: number },
): Promise<{ query: string; results: SearchResult[]; note?: string }> {
  const rows = getEmbeddedDecisions(db, options.model, options.dim);

  if (rows.length === 0) {
    return {
      query,
      results: [],
      note: "No embedded decisions for this model. Run `npm run index` (or `npx tsx src/indexer.ts`) to generate embeddings.",
    };
  }

  const queryVector = await embedQuery(
    ai,
    options.model,
    query,
    options.dim,
  );

  return {
    query,
    results: rankEmbeddedDecisions(rows, queryVector, options.limit),
  };
}

export function whyPath(
  db: Db,
  path: string,
  options: { limit: number },
): { path: string; results: DecisionRecord[] } {
  const normalized = normalizeQueryPath(path);

  if (!normalized) {
    return { path: normalized, results: [] };
  }

  const rows = getDecisionsForPath(db, normalized, options.limit);
  const seen = new Set<number>();
  const results: DecisionRecord[] = [];

  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    results.push(toDecisionRecord(row));
  }

  return { path: normalized, results };
}

export function checkChange(
  db: Db,
  files: string[],
  options: { limit: number },
): { files: string[]; results: ChangeResult[] } {
  const normalized = [
    ...new Set(files.map(normalizeQueryPath).filter(Boolean)),
  ].slice(0, 50);

  if (normalized.length === 0) {
    return { files: [], results: [] };
  }

  const rows = getDecisionsForPaths(db, normalized);
  const grouped = new Map<
    number,
    { record: DecisionRecord; matched: Set<string> }
  >();

  for (const row of rows) {
    const record = toDecisionRecord(row);
    const existing = grouped.get(record.id);

    if (existing) {
      existing.matched.add(row.matched_path);
    } else {
      grouped.set(record.id, {
        record,
        matched: new Set([row.matched_path]),
      });
    }
  }

  const results = [...grouped.values()]
    .filter((entry) => entry.record.confidence >= MIN_CHECK_CONFIDENCE)
    .map((entry) => ({
      ...entry.record,
      overlap: entry.matched.size,
      matched_files: [...entry.matched].sort(),
    }))
    .sort(
      (a, b) =>
        b.overlap - a.overlap ||
        commitTime(b.committed_at) - commitTime(a.committed_at) ||
        b.confidence - a.confidence,
    )
    .slice(0, options.limit);

  return { files: normalized, results };
}
