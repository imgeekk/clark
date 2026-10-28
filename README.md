# clark

Mine the engineering decisions buried in a repository's git history, then serve them to a coding agent over MCP.

An agent reading `src/` can see what the code does. It cannot see why a dependency is pinned, why two arguments are coerced differently, or why a hot path skips an obvious abstraction. clark turns those choices into records with a rationale, a confidence, and a commit to point at — and exposes them as MCP tools an agent can call before it edits.

Early release. The CLI and MCP surface work, but expect changes.

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

## Install

```bash
npm install -g @imgeekk/clark
```

Or run it without installing:

```bash
npx @imgeekk/clark index .
```

## Quickstart

```bash
# 1. give clark a key: environment, .env in the current directory, or .env in
#    the repository you index or serve
echo "GEMINI_API_KEY=your-key" > .env

# 2. mine the repository you want an agent to understand
clark index /path/to/that/repo

# 3. check what it found
clark status /path/to/that/repo

# 4. write the MCP config for that repository
clark init /path/to/that/repo --write

# 5. restart your MCP client
```

Without `--write`, `clark init` prints the same config to stdout so you can paste it into whatever file your client reads.

## Commands

| Command | What it does |
| --- | --- |
| `clark index [repo]` | Mine commits into `<repo>/.repo-memory/db.sqlite`, then backfill embeddings |
| `clark status [repo]` | Show what is indexed and whether HEAD has moved since |
| `clark init [repo]` | Print the MCP config; `--write` creates `.mcp.json` in the repository |
| `clark why <path> [repo]` | Print decisions that touched a file or any file under a directory |
| `clark serve [repo]` | Start the MCP server over stdio (the default command) |
| `clark ingest [repo]` | List the commits the indexer would keep and estimate the request count |
| `clark extract [repo]` | Run extraction on a sample and print raw JSON (diagnostic) |

`clark index` options: `--limit <n>` (default 100), `--offset <n>`, `--batch-size <n>` (commits per request, default 5), `--model <id>`, `--force` (re-index commits already stored).

Indexing is incremental: re-running `index` only processes commits that are not in the database yet, and `--offset` lets you walk further back through history in chunks. Completed batches are written as they finish, so hitting a quota limit or pressing Ctrl-C keeps the work already done; rerun the same command to continue.

The database lives at `<repo>/.repo-memory/` and that directory ignores itself, so you never need to edit the target repository's `.gitignore`. It is local to your machine: a teammate who clones the same repository starts with no index.

## Wire it into your MCP client

clark is a stdio MCP server, so any MCP client can run it. The configuration is the common `mcpServers` shape; only the file it lives in differs per client.

```json
{
  "mcpServers": {
    "clark": {
      "command": "node",
      "args": [
        "/absolute/path/to/dist/serve.js",
        "/absolute/path/to/your-repo"
      ]
    }
  }
}
```

`clark init` fills in both absolute paths for you. If you installed globally, you can use `"command": "clark"` with `"args": ["serve", "/absolute/path/to/your-repo"]` instead.

Restart the client after editing its config. The server reads `GEMINI_API_KEY` from its environment, or from `.env` in the repository you pointed it at. Most MCP clients do not forward their whole environment to the server, so the `.env` in the target repository is the reliable option.

`search_decisions` embeds the query, so it needs the API key at call time. `why` and `check_change` only read SQLite and work offline.

Verified with the official `@modelcontextprotocol/sdk` client over stdio. The same transport is what MCP clients use, but this README does not claim per-client testing.

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

The tool descriptions tell the agent this. Treat an inferred record as "worth checking", not as a fact. A repository whose commit messages only say what changed will produce mostly inferred records, which is the honest outcome.

## Cost

Every kept commit is sent to Gemini once. `clark ingest <repo>` prints how many commits would be kept and a lower bound on the request count, so you can size a run before spending anything:

```
Kept 25, skipped 10 (docs-only 2, test-only 7, non-code-only 1)
Estimated Gemini requests: at least 5 (25 commits at batch size 5; large diffs split batches)
```

The default model is `gemini-3.5-flash-lite`. The free tier is enough for a small repository but not for a large history; use `--limit` and `--offset` to walk it in chunks across days, and `--model` to trade cost for quality.

## Known limits

- Merge commits are skipped, so a rationale that only exists in a pull request description is invisible to clark.
- Diffs are truncated at 12,000 characters per commit; a decision whose reasoning lives deep in a large diff can be missed.
- One repository per server process.
- Semantic search loads every stored embedding into memory per query. Fine for a few thousand decisions, not for tens of thousands.
- A decision that is later reverted by another commit is not marked stale yet.
- Decisions with no verifiable file paths are stored but only reachable through `search_decisions`, not `why` or `check_change`.

## Development

```bash
npm install
npm test          # 70 tests, no network
npm run typecheck
npm run build     # emits dist/, which the clark bin runs
npm pack          # builds dist/ first, then lists the shipped files
```

The source entry points are `src/indexer.ts` (extraction), `src/retrieval.ts` (queries), `src/mcp.ts` (tool definitions), and `src/serve.ts` (stdio transport). Running `npm run <script>` uses `tsx` directly and needs no build.

## License

MIT
