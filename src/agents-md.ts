const START_MARKER = "<!-- clark -->";
const END_MARKER = "<!-- /clark -->";

// Agents do not call an MCP tool just because it exists, and an AGENTS.md
// instruction to call one is routinely skipped. A shell command in the same
// file is followed, so the block points at the CLI.
export const AGENTS_MD_BLOCK = [
  START_MARKER,
  "## Engineering decisions",
  "",
  "This repository has a clark index of past engineering decisions.",
  "",
  "- Before editing a file, run `clark why <file>` and read the result.",
  "- If it reports no decisions, continue.",
  "- Results marked `inferred` are guesses, not stated facts.",
  END_MARKER,
].join("\n");

// Returns the file to write, or undefined when it already matches.
export function mergeAgentsMd(existing: string): string | undefined {
  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER, start + START_MARKER.length);

  if (start !== -1 && end !== -1) {
    const updated = `${existing.slice(0, start)}${AGENTS_MD_BLOCK}${existing.slice(end + END_MARKER.length)}`;
    return updated === existing ? undefined : updated;
  }

  const trimmed = existing.replace(/\s*$/, "");

  if (trimmed === "") {
    return `${AGENTS_MD_BLOCK}\n`;
  }

  return `${trimmed}\n\n${AGENTS_MD_BLOCK}\n`;
}
