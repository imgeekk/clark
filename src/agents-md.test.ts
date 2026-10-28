import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS_MD_BLOCK, mergeAgentsMd } from "./agents-md.js";

test("writes the block when there is no AGENTS.md", () => {
  assert.equal(mergeAgentsMd(""), `${AGENTS_MD_BLOCK}\n`);
});

test("appends the block after existing instructions", () => {
  const merged = mergeAgentsMd("# Repo\n\nUse pnpm.\n");

  assert.equal(merged, `# Repo\n\nUse pnpm.\n\n${AGENTS_MD_BLOCK}\n`);
});

test("leaves the file alone when the block is current", () => {
  assert.equal(mergeAgentsMd(`${AGENTS_MD_BLOCK}\n`), undefined);
});

test("replaces an outdated block in place", () => {
  const stale = "# Repo\n\n<!-- clark -->\nold instructions\n<!-- /clark -->\n";

  assert.equal(mergeAgentsMd(stale), `# Repo\n\n${AGENTS_MD_BLOCK}\n`);
});
