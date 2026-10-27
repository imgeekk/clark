import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBatchExtraction,
  parseExtraction,
  type Extraction,
} from "./gemini.js";
import type { Commit } from "./git.js";
import { resolveAffectedPaths, verifyExtraction } from "./verify.js";

const SHA = "a".repeat(40);

function makeCommit(overrides: Partial<Commit> = {}): Commit {
  return {
    sha: SHA,
    author: "Test Author",
    date: "2026-01-01T00:00:00Z",
    message: "Pin dependency because v4 broke streaming",
    files: ["package.json", "src/index.ts"],
    ...overrides,
  };
}

function makeExtraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    is_decision: true,
    title: "Pin dependency",
    summary: "Pinned the dependency.",
    rationale: "The new major version broke streaming.",
    reason_quote: "because v4 broke streaming",
    evidence: "stated",
    confidence: 0.9,
    affected_paths: ["package.json"],
    ...overrides,
  };
}

test("keeps a stated decision when the quote is present and causal", () => {
  const result = verifyExtraction(makeExtraction(), makeCommit());

  assert.equal(result.extraction.evidence, "stated");
  assert.equal(result.extraction.reason_quote, "because v4 broke streaming");
  assert.equal(result.extraction.confidence, 0.9);
  assert.equal(result.warning, undefined);
});

test("downgrades stated evidence when the quote is not in the message", () => {
  const result = verifyExtraction(
    makeExtraction({ reason_quote: "because v5 broke streaming" }),
    makeCommit(),
  );

  assert.equal(result.extraction.evidence, "inferred");
  assert.equal(result.extraction.reason_quote, "");
  assert.equal(result.extraction.confidence, 0.7);
  assert.match(result.warning ?? "", /downgraded/);
});

test("downgrades stated evidence when the quote changes capitalization", () => {
  const result = verifyExtraction(
    makeExtraction({ reason_quote: "Because v4 broke streaming" }),
    makeCommit(),
  );

  assert.equal(result.extraction.evidence, "inferred");
  assert.equal(result.extraction.reason_quote, "");
});

test("accepts a quote across a line break after whitespace normalization", () => {
  const result = verifyExtraction(
    makeExtraction(),
    makeCommit({ message: "Pin dependency\nbecause v4 broke streaming" }),
  );

  assert.equal(result.extraction.evidence, "stated");
});

test("downgrades a what-only quote with no causal marker", () => {
  const result = verifyExtraction(
    makeExtraction({ reason_quote: "Pin dependency" }),
    makeCommit({ message: "Pin dependency" }),
  );

  assert.equal(result.extraction.evidence, "inferred");
  assert.equal(result.extraction.reason_quote, "");
});

test("caps stated confidence at 0.95", () => {
  const result = verifyExtraction(
    makeExtraction({ confidence: 1 }),
    makeCommit(),
  );

  assert.equal(result.extraction.confidence, 0.95);
});

test("clears the quote and caps inferred confidence", () => {
  const result = verifyExtraction(
    makeExtraction({
      evidence: "inferred",
      reason_quote: "because v4 broke streaming",
      confidence: 0.95,
    }),
    makeCommit(),
  );

  assert.equal(result.extraction.evidence, "inferred");
  assert.equal(result.extraction.reason_quote, "");
  assert.equal(result.extraction.confidence, 0.7);
});

test("clears all fields for a non-decision", () => {
  const result = verifyExtraction(
    makeExtraction({
      is_decision: false,
      title: "not empty",
      summary: "not empty",
      rationale: "not empty",
      reason_quote: "not empty",
      evidence: "none",
      confidence: 0,
      affected_paths: ["package.json"],
    }),
    makeCommit(),
  );

  assert.deepEqual(result.extraction, {
    is_decision: false,
    title: "",
    summary: "",
    rationale: "",
    reason_quote: "",
    evidence: "none",
    confidence: 0,
    affected_paths: [],
  });
});

test("rejects a decision with evidence none", () => {
  assert.throws(
    () => verifyExtraction(makeExtraction({ evidence: "none" }), makeCommit()),
    /evidence 'none'/,
  );
});

test("rejects a decision missing its title", () => {
  assert.throws(
    () => verifyExtraction(makeExtraction({ title: " " }), makeCommit()),
    /missing title/,
  );
});

test("keeps only paths the commit actually touched", () => {
  const result = resolveAffectedPaths(makeCommit(), [
    "./package.json",
    "src\\index.ts",
    "src/missing.ts",
    "package.json",
  ]);

  assert.deepEqual(result.paths, ["package.json", "src/index.ts"]);
  assert.deepEqual(result.dropped, ["src/missing.ts"]);
});

test("does not fall back to the commit's full file list", () => {
  const result = resolveAffectedPaths(makeCommit(), ["src/missing.ts"]);

  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.dropped, ["src/missing.ts"]);
});

test("accepts a decision with no affected paths", () => {
  const result = resolveAffectedPaths(makeCommit(), []);

  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.dropped, []);
});

test("rejects invalid JSON from the single extractor", () => {
  assert.throws(() => parseExtraction("not json"), /invalid JSON/);
});

test("rejects single extraction output that fails the schema", () => {
  assert.throws(
    () => parseExtraction(JSON.stringify({ is_decision: true })),
    /does not match the schema/,
  );
});

test("accepts a valid single extraction", () => {
  const parsed = parseExtraction(JSON.stringify(makeExtraction()));

  assert.equal(parsed.title, "Pin dependency");
});

test("validates every batch SHA against the input batch", () => {
  const raw = JSON.stringify({
    results: [{ sha: SHA, ...makeExtraction() }],
  });
  const parsed = parseBatchExtraction(raw, [SHA]);

  assert.equal(parsed.get(SHA)?.title, "Pin dependency");
});

test("rejects a batch result without a SHA", () => {
  const raw = JSON.stringify({ results: [makeExtraction()] });

  assert.throws(() => parseBatchExtraction(raw, [SHA]), /missing its sha/);
});

test("rejects a batch result with an unexpected SHA", () => {
  const raw = JSON.stringify({
    results: [{ sha: "b".repeat(40), ...makeExtraction() }],
  });

  assert.throws(() => parseBatchExtraction(raw, [SHA]), /Unexpected SHA/);
});

test("rejects duplicate batch results", () => {
  const raw = JSON.stringify({
    results: [
      { sha: SHA, ...makeExtraction() },
      { sha: SHA, ...makeExtraction() },
    ],
  });

  assert.throws(() => parseBatchExtraction(raw, [SHA]), /Duplicate SHA/);
});

test("rejects a batch that is missing a commit", () => {
  const raw = JSON.stringify({ results: [] });

  assert.throws(() => parseBatchExtraction(raw, [SHA]), /Missing result/);
});

test("rejects a batch result that fails the schema", () => {
  const raw = JSON.stringify({
    results: [{ sha: SHA, ...makeExtraction({ confidence: 2 }) }],
  });

  assert.throws(
    () => parseBatchExtraction(raw, [SHA]),
    /does not match the schema/,
  );
});
