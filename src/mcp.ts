import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { Db } from "./db.js";
import {
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_EMBEDDING_MODEL,
} from "./embeddings.js";
import { createGeminiClient, getApiKey } from "./gemini.js";
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

  let ai: GoogleGenAI | undefined;

  const getAi = (): GoogleGenAI => {
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
        "Semantic search over engineering decisions mined from this repository's git history. Use this for questions about why the codebase works a certain way. Results include evidence type and confidence; inferred rationale is a guess, not a stated fact.",
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
      title: "Why a file changed",
      description:
        "Find decisions that touched a file or directory. Use this before changing a path. Returns evidence type and confidence; inferred rationale is a guess, not a stated fact.",
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
      title: "Check a planned change",
      description:
        "Given files you are about to change, return at most a few prior decisions with direct file overlap. Returns an empty list when nothing relevant is known. Treat inferred rationale as a guess, not a stated fact.",
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
