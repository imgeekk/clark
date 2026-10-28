# clark

Mine the engineering decisions buried in a repository's git history, then serve them to a coding agent over MCP.

An agent reading `src/` can see what the code does. It cannot see why a dependency is pinned, why two arguments are coerced differently, or why a hot path skips an obvious abstraction. clark turns those choices into records with a rationale, a confidence, and a commit to point at — and exposes them as MCP tools an agent can call before it edits.

## How it works

Indexing:

1. Read non-merge commits from `git log`.
2. Drop the commits that cannot carry a decision: lockfiles, build output, docs, CI, tests.
3. Send each remaining commit message and diff to Gemini with a three-part gate: does this change runtime behavior, public API, data format, security, or a hot-path contract; would a future agent plausibly choose differently; would undoing it require knowing the reason?
4. Verify the model's answer in code: a `stated` rationale must quote the commit message verbatim and contain a causal marker, otherwise it is downgraded to `inferred`; confidence is capped per evidence type; file paths the commit did not touch are dropped.
5. Store decisions in SQLite and embed them for semantic search.

Serving:

Three MCP tools over stdio: `search_decisions`, `why`, `check_change`.

## Requirements

- Node.js 22 or newer
- git on `PATH`
- a Gemini API key (`GEMINI_API_KEY`)

## Quickstart

```bash
npm install
npm run build
npm link            # puts `clark` on your PATH

# the key comes from the environment, then .env in the current directory,
# then .env in the repository you index or serve
echo "GEMINI_API_KEY=your-key" > .env

# mine decisions from the repository you want an agent to understand
clark index /path/to/that/repo --limit 100

# inspect what was found
clark why src/index.ts /path/to/that/repo
```

Without `npm link`, run the same commands as `node bin/clark.js <command> ...`.

## Wire it into your MCP client

clark is a stdio MCP server, so any MCP client can run it. The configuration
below is the common `mcpServers` shape; only the file it lives in differs per
client. Absolute paths are required, and the repository argument is what clark
reads decisions for.

```json
{
  "mcpServers": {
    "clark": {
      "command": "node",
      "args": ["/absolute/path/to/clark/dist/serve.js", "/absolute/path/to/your-repo"]
    }
  }
}
```

If you ran `npm link`, use `"command": "clark"` and
`"args": ["serve", "/absolute/path/to/your-repo"]` instead.

Restart the client after editing its config. The server reads
`GEMINI_API_KEY` from its environment, or from `.env` in the repository you
pointed it at, so it works no matter which directory the client starts it from.
Most MCP clients do not forward their whole environment to the server, so the
`.env` in the target repository is the reliable option.

`search_decisions` embeds the query, so it needs the API key at call time.
`why` and `check_change` only read SQLite and work offline.

Verified with the official `@modelcontextprotocol/sdk` client over stdio. The
same transport is what MCP clients use, but this README does not claim
per-client testing.

## Commands

| Command | What it does |
| --- | --- |
| `clark serve [repo]` | Start the MCP server over stdio (default command) |
| `clark index [repo]` | Mine commits into `<repo>/.repo-memory/db.sqlite`, then backfill embeddings |
| `clark why <path> [repo]` | Print decisions that touched a file or any file under a directory |
| `clark ingest [repo] --limit <n>` | List the commits the indexer would keep (diagnostic) |
| `clark extract [repo] --limit <n>` | Run extraction on a sample and print raw JSON (diagnostic) |

`clark index` options: `--limit <n>` (default 100), `--offset <n>`, `--batch-size <n>` (commits per request, default 5), `--model <id>`, `--force` (re-index commits already stored).

Indexing is incremental: re-running `index` only processes commits that are not in the database yet, and `--offset` lets you walk further back through history in chunks. The database lives at `<repo>/.repo-memory/` and ignores itself, so you never need to edit the target repository's `.gitignore`.

## MCP tools

| Tool | Input | Use it for |
| --- | --- | --- |
| `search_decisions` | `query`, `limit` | Semantic search: "why is coercion different for two arguments" |
| `why` | `path`, `limit` | Decisions attached to a file, or to anything under a directory |
| `check_change` | `files`, `limit` | Before editing: prior decisions with direct file overlap, ranked by overlap then recency |

All three are read-only. `check_change` stays silent below 0.5 confidence and returns an empty list rather than a guess.

## How to read a result

Every record carries `evidence`, `confidence`, `reason_quote`, and `commit_sha`.

- `evidence: "stated"` — the commit message itself explains the reason, and `reason_quote` is the verbatim fragment that does.
- `evidence: "inferred"` — the reason is inferred from the diff. It is a hypothesis. Confidence is capped at 0.7 and the rationale is phrased as a guess.

The tool descriptions tell the agent this. Treat an inferred record as "worth checking", not as a fact.

## Known limits

- Merge commits are skipped, so a rationale that only exists in a pull request description is invisible to clark.
- Diffs are truncated at 12,000 characters per commit; a decision whose reasoning lives deep in a large diff can be missed.
- One repository per server process.
- Semantic search loads every stored embedding into memory per query. Fine for a few thousand decisions, not for tens of thousands.
- A decision that is later reverted by another commit is not marked stale yet.
- Gemini's free-tier quota is the practical limit on indexing speed. The default
  model is `gemini-3.5-flash-lite`; check your project's current quota before a
  large run, and use `--limit` to walk history in chunks.

## Development

```bash
npm test          # 56 tests, no network
npm run typecheck
npm run build     # emits dist/, which the clark bin runs
npm pack          # builds dist/ first, then shows the shipped files
```

The source entry points are `src/indexer.ts` (extraction), `src/retrieval.ts` (queries), `src/mcp.ts` (tool definitions), and `src/serve.ts` (stdio transport). Running `npm run <script>` uses `tsx` directly and needs no build.
