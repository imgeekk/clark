import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEntry, mergeConfig } from "./mcp-config.js";

const entry = buildEntry("/clark/dist/serve.js", "/repo");

test("builds a node entry with absolute paths", () => {
  assert.deepEqual(entry, {
    command: "node",
    args: ["/clark/dist/serve.js", "/repo"],
  });
});

test("creates a config when none exists", () => {
  assert.deepEqual(mergeConfig(undefined, entry, false), {
    mcpServers: { clark: entry },
  });
});

test("keeps other servers and adds clark", () => {
  const existing = {
    mcpServers: { other: { command: "other", args: [] } },
  };

  assert.deepEqual(mergeConfig(existing, entry, false), {
    mcpServers: { other: { command: "other", args: [] }, clark: entry },
  });
});

test("is idempotent when the entry already matches", () => {
  const existing = mergeConfig(undefined, entry, false);

  assert.deepEqual(mergeConfig(existing, entry, false), existing);
});

test("refuses to replace a different entry without force", () => {
  const existing = {
    mcpServers: { clark: { command: "node", args: ["/old/serve.js", "/old"] } },
  };

  assert.throws(
    () => mergeConfig(existing, entry, false),
    /already defines "clark"/,
  );
});

test("replaces a different entry with force", () => {
  const existing = {
    mcpServers: { clark: { command: "node", args: ["/old/serve.js", "/old"] } },
  };

  assert.deepEqual(mergeConfig(existing, entry, true), {
    mcpServers: { clark: entry },
  });
});

test("rejects a config whose mcpServers is not an object", () => {
  assert.throws(
    () => mergeConfig({ mcpServers: [] }, entry, false),
    /not an object/,
  );
});

test("rejects a config that is not an object", () => {
  assert.throws(() => mergeConfig([], entry, false), /not a JSON object/);
});
