import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase, storeProcessedCommit, type Db } from "./db.js";
import type { Commit } from "./git.js";
import { createMcpServer } from "./mcp.js";

type Seed = {
  sha: string;
  date: string;
  files: string[];
  title: string;
};

type Harness = {
  client: Client;
  close: () => Promise<void>;
};

function seed(db: Db, decision: Seed): void {
  const commit: Commit = {
    sha: decision.sha,
    author: "Test Author",
    date: decision.date,
    message: decision.title,
    files: decision.files,
  };

  storeProcessedCommit(
    db,
    commit,
    "test-model",
    {
      is_decision: true,
      title: decision.title,
      summary: `${decision.title} summary`,
      rationale: "The commit message explains the trade-off.",
      reason_quote: "because the old behavior broke",
      evidence: "stated",
      confidence: 0.9,
      affected_paths: decision.files,
    },
    decision.files,
    false,
  );
}

async function createHarness(decisions: Seed[]): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "clark-mcp-test-"));
  const db = openDatabase(root);

  for (const decision of decisions) {
    seed(db, decision);
  }

  const server = createMcpServer(db);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "clark-test", version: "0.0.1" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));

  const [first] = content as Array<{ type: string; text?: string }>;
  assert.ok(first && typeof first.text === "string");

  return first.text;
}

test("registers the decision tools as read-only", async () => {
  const harness = await createHarness([]);

  try {
    const tools = await harness.client.listTools();

    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["check_change", "search_decisions", "why"],
    );

    for (const tool of tools.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
  } finally {
    await harness.close();
  }
});

test("why returns the decision that touched the path", async () => {
  const harness = await createHarness([
    {
      sha: "a".repeat(40),
      date: "2026-01-01T00:00:00Z",
      files: ["src/index.ts"],
      title: "Entry point decision",
    },
  ]);

  try {
    const result = await harness.client.callTool({
      name: "why",
      arguments: { path: "./src/index.ts" },
    });
    const payload = JSON.parse(textOf(result));

    assert.equal(payload.path, "src/index.ts");
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].title, "Entry point decision");
    assert.equal(payload.results[0].evidence, "stated");
    assert.equal(payload.results[0].reason_quote, "because the old behavior broke");
  } finally {
    await harness.close();
  }
});

test("why stays empty for an unknown path", async () => {
  const harness = await createHarness([
    {
      sha: "a".repeat(40),
      date: "2026-01-01T00:00:00Z",
      files: ["src/index.ts"],
      title: "Entry point decision",
    },
  ]);

  try {
    const result = await harness.client.callTool({
      name: "why",
      arguments: { path: "src/missing.ts" },
    });

    assert.deepEqual(JSON.parse(textOf(result)), {
      path: "src/missing.ts",
      results: [],
    });
  } finally {
    await harness.close();
  }
});

test("check_change reports overlapping files", async () => {
  const harness = await createHarness([
    {
      sha: "a".repeat(40),
      date: "2026-01-01T00:00:00Z",
      files: ["src/a.ts"],
      title: "Narrow decision",
    },
    {
      sha: "b".repeat(40),
      date: "2026-02-01T00:00:00Z",
      files: ["src/a.ts", "src/b.ts"],
      title: "Wide decision",
    },
  ]);

  try {
    const result = await harness.client.callTool({
      name: "check_change",
      arguments: { files: ["src/a.ts", "src/b.ts"] },
    });
    const payload = JSON.parse(textOf(result));

    assert.deepEqual(
      payload.results.map((decision: { title: string }) => decision.title),
      ["Wide decision", "Narrow decision"],
    );
    assert.equal(payload.results[0].overlap, 2);
    assert.deepEqual(payload.results[0].matched_files, ["src/a.ts", "src/b.ts"]);
  } finally {
    await harness.close();
  }
});
