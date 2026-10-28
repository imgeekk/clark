import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommand, buildEntry, quoteArg } from "./mcp-config.js";

test("builds a node entry with absolute paths", () => {
  assert.deepEqual(buildEntry("/clark/dist/serve.js", "/repo"), {
    command: "node",
    args: ["/clark/dist/serve.js", "/repo"],
  });
});

test("quotes a path that needs no quoting anyway", () => {
  assert.equal(quoteArg("/clark/dist/serve.js"), '"/clark/dist/serve.js"');
});

test("keeps a Windows path intact inside quotes", () => {
  assert.equal(
    quoteArg("C:\\Users\\me\\My Repo"),
    '"C:\\Users\\me\\My Repo"',
  );
});

test("quotes an empty argument", () => {
  assert.equal(quoteArg(""), '""');
});

test("escapes a double quote inside an argument", () => {
  assert.equal(quoteArg('a"b'), '"a\\"b"');
});

test("builds a command from node and both paths", () => {
  assert.equal(
    buildCommand("/clark/dist/serve.js", "/repo"),
    'node "/clark/dist/serve.js" "/repo"',
  );
});

test("builds a command for Windows paths with spaces", () => {
  assert.equal(
    buildCommand("C:\\Program Files\\clark\\serve.js", "C:\\repos\\oxygen"),
    'node "C:\\Program Files\\clark\\serve.js" "C:\\repos\\oxygen"',
  );
});
