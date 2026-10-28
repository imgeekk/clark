import type { GeminiClient } from "./gemini.js";
import {
  countDecisionsMissingEmbeddings,
  getDecisionsMissingEmbeddings,
  storeDecisionEmbedding,
  type Db,
} from "./db.js";
import {
  decisionEmbeddingText,
  embedDocuments,
  encodeEmbedding,
} from "./embeddings.js";

type Options = {
  model: string;
  dim: number;
  batchSize: number;
  limit: number;
  onProgress?: (done: number, total: number) => void;
};

export type EmbeddingResult = {
  embedded: number;
  remaining: number;
};

export async function ensureDecisionEmbeddings(
  db: Db,
  ai: GeminiClient,
  options: Options,
): Promise<EmbeddingResult> {
  const missing = getDecisionsMissingEmbeddings(
    db,
    options.model,
    options.dim,
    options.limit,
  );

  if (missing.length === 0) {
    return { embedded: 0, remaining: 0 };
  }

  let embedded = 0;

  for (let offset = 0; offset < missing.length; offset += options.batchSize) {
    const batch = missing.slice(offset, offset + options.batchSize);
    const vectors = await embedDocuments(
      ai,
      options.model,
      batch.map(decisionEmbeddingText),
      options.dim,
    );

    db.transaction(() => {
      for (let index = 0; index < batch.length; index += 1) {
        const vector = vectors[index];
        if (!vector) {
          throw new Error(`Missing embedding for decision ${batch[index].id}.`);
        }

        storeDecisionEmbedding(
          db,
          batch[index].id,
          options.model,
          options.dim,
          encodeEmbedding(vector),
        );
      }
    })();

    embedded += batch.length;
    options.onProgress?.(embedded, missing.length);
  }

  return {
    embedded,
    remaining: countDecisionsMissingEmbeddings(
      db,
      options.model,
      options.dim,
    ),
  };
}
