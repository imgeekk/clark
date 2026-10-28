import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import {
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_EMBEDDING_MODEL,
} from "./embeddings.js";
import {
  createGeminiClient,
  getApiKey,
  type GeminiClient,
} from "./gemini.js";
import {
  checkChange,
  searchDecisions,
  whyPath,
} from "./retrieval.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function createMcpServer(db: Db): McpServer {
  const server = new McpServer({
    name: "clark",
    version: "0.1.0",
  });

  let ai: GeminiClient | undefined;

  const getAi = (): GeminiClient => {
    if (!ai) {
      ai = createGeminiClient(getApiKey());
    }
    return ai;
  };

  server.registerTool(
    "search_decisions",
    {
      title: "Search decisions",
      description:
        "Call this for questions about why the codebase works a certain way, especially when no single path is involved. Semantic search over engineering decisions mined from this repository's git history. Treat inferred rationale as a guess, not a stated fact.",
      inputSchema: {
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(20).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      try {
        const result = await searchDecisions(db, getAi(), query, {
          model: DEFAULT_EMBEDDING_MODEL,
          dim: DEFAULT_EMBEDDING_DIM,
          limit: limit ?? 5,
        });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "why",
    {
      title: "Why this path changed",
      description:
        "Call this to learn why a file or directory is the way it is. Returns decisions mined from this repository's git history that touched that path. Treat inferred rationale as a guess, not a stated fact.",
      inputSchema: {
        path: z.string().min(1).max(1000),
        limit: z.number().int().min(1).max(20).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, limit }) => {
      try {
        return jsonResult(whyPath(db, path, { limit: limit ?? 5 }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "check_change",
    {
      title: "Check before editing",
      description:
        "Call this before editing any file in this repository, passing every file you intend to change. Returns prior engineering decisions with direct file overlap, or an empty list when nothing relevant is known. Treat inferred rationale as a guess, not a stated fact.",
      inputSchema: {
        files: z.array(z.string().min(1).max(1000)).min(1).max(50),
        limit: z.number().int().min(1).max(10).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ files, limit }) => {
      try {
        return jsonResult(checkChange(db, files, { limit: limit ?? 3 }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
