import { embedContents, type GeminiClient } from "./gemini.js";

export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
export const DEFAULT_EMBEDDING_DIM = 768;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 16;
export const DEFAULT_EMBEDDING_LIMIT = 200;

type DecisionText = {
  title: string;
  summary: string;
  rationale: string;
  reason_quote: string;
};

export function decisionEmbeddingText(decision: DecisionText): string {
  const parts = [decision.title, decision.summary, decision.rationale];

  if (decision.reason_quote) {
    parts.push(`Reason: ${decision.reason_quote}`);
  }

  return parts.filter(Boolean).join("\n");
}

async function embedTexts(
  ai: GeminiClient,
  model: string,
  texts: string[],
  dim: number,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
): Promise<Float32Array[]> {
  if (texts.length === 0) {
    return [];
  }

  const vectors = await embedContents(ai, model, texts, taskType, dim);
  return vectors.map(normalizeEmbedding);
}

export function embedDocuments(
  ai: GeminiClient,
  model: string,
  texts: string[],
  dim = DEFAULT_EMBEDDING_DIM,
): Promise<Float32Array[]> {
  return embedTexts(ai, model, texts, dim, "RETRIEVAL_DOCUMENT");
}

export async function embedQuery(
  ai: GeminiClient,
  model: string,
  query: string,
  dim = DEFAULT_EMBEDDING_DIM,
): Promise<Float32Array> {
  const [embedding] = await embedTexts(
    ai,
    model,
    [query],
    dim,
    "RETRIEVAL_QUERY",
  );

  if (!embedding) {
    throw new Error("Embedding API returned no query embedding.");
  }

  return embedding;
}

export function normalizeEmbedding(values: number[]): Float32Array {
  const vector = Float32Array.from(values);
  let sumSquares = 0;

  for (const value of vector) {
    sumSquares += value * value;
  }

  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    return vector;
  }

  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm;
  }

  return vector;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `Cannot compare embeddings with different dimensions: ${a.length} vs ${b.length}.`,
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function encodeEmbedding(vector: Float32Array): Buffer {
  const bytes = new Uint8Array(vector.byteLength);
  bytes.set(
    new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
  );
  return Buffer.from(bytes);
}

export function decodeEmbedding(blob: Buffer): Float32Array {
  const bytes = new Uint8Array(blob.byteLength);
  bytes.set(blob);
  return new Float32Array(bytes.buffer);
}
