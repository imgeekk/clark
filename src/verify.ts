import type { Extraction } from "./gemini.js";
import type { Commit } from "./git.js";

const MIN_REASON_QUOTE_LENGTH = 8;
const MAX_INFERRED_CONFIDENCE = 0.7;
const MAX_STATED_CONFIDENCE = 0.95;

// These words are not a semantic judge. They are a cheap guard against
// "stated" quotes that only restate what changed.
const CAUSAL_MARKERS =
  /\b(because|since|so that|so|to avoid|to fix|to handle|to prevent|to support|to make|to keep|to ensure|to reduce|to improve|to match|to align|to work around|due to|in order to|for|when|broke|breaks|broken|regression|crash|crashes|fails|failing|incompatible|deprecated|removed|removes|workaround|instead|rather than|otherwise|without)\b/i;

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(\.\/)+/, "").trim();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function resolveAffectedPaths(
  commit: Commit,
  affectedPaths: string[],
): { paths: string[]; dropped: string[] } {
  const files = new Set(commit.files.map(normalizePath));
  const normalized = [
    ...new Set(affectedPaths.map(normalizePath).filter(Boolean)),
  ];

  // Store only paths the model cited that the commit actually touched.
  // If none survive, the decision still links to its commit through
  // decision_commits, but it gets no file links. Do not invent links.
  return {
    paths: normalized.filter((path) => files.has(path)),
    dropped: normalized.filter((path) => !files.has(path)),
  };
}

export function verifyExtraction(
  extraction: Extraction,
  commit: Commit,
): { extraction: Extraction; warning?: string } {
  if (!extraction.is_decision) {
    return {
      extraction: {
        is_decision: false,
        title: "",
        summary: "",
        rationale: "",
        reason_quote: "",
        evidence: "none",
        confidence: 0,
        affected_paths: [],
      },
    };
  }

  if (extraction.evidence === "none") {
    throw new Error("Decision has evidence 'none'.");
  }

  const title = extraction.title.trim();
  const summary = extraction.summary.trim();
  const rationale = extraction.rationale.trim();

  if (!title || !summary || !rationale) {
    throw new Error("Decision is missing title, summary, or rationale.");
  }

  let evidence = extraction.evidence;
  let confidence = extraction.confidence;
  let reasonQuote = extraction.reason_quote.trim();
  let warning: string | undefined;

  if (evidence === "stated") {
    const message = normalizeWhitespace(commit.message);
    const quote = normalizeWhitespace(reasonQuote);
    // Whitespace is formatting, so collapse it before comparing. Case and
    // wording are content, so the quote must still be exact.
    const isSubstring =
      quote.length >= MIN_REASON_QUOTE_LENGTH && message.includes(quote);
    const looksCausal = CAUSAL_MARKERS.test(quote);

    if (!isSubstring || !looksCausal) {
      warning =
        "stated evidence had no valid causal reason_quote; downgraded to inferred";
      evidence = "inferred";
      confidence = Math.min(confidence, MAX_INFERRED_CONFIDENCE);
      reasonQuote = "";
    } else {
      confidence = Math.min(confidence, MAX_STATED_CONFIDENCE);
    }
  } else {
    reasonQuote = "";
    confidence = Math.min(confidence, MAX_INFERRED_CONFIDENCE);
  }

  return {
    extraction: {
      ...extraction,
      title,
      summary,
      rationale,
      reason_quote: reasonQuote,
      evidence,
      confidence,
    },
    warning,
  };
}
