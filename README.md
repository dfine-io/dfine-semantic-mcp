# @dfine-io-gmbh/semantic-mcp

Semantic codebase search as an [MCP](https://modelcontextprotocol.io) server. It embeds your
project's code into a local SQLite vector store and answers natural-language questions over it —
conceptual matches that a plain `grep` misses. Fully local after a one-time model download.

## How it works

- **Embeddings** — code chunks are embedded with `jinaai/jina-embeddings-v2-base-code`
  (768-dim, code-tuned) via `@huggingface/transformers` (ONNX runtime).
- **Storage** — vectors live in a local SQLite database (`sqlite-vec`), one per indexed project.
- **Transport** — stdio; drops into any MCP client (Claude Code, Cursor, …).

The model is **not** bundled. It is downloaded from the Hugging Face Hub on first use (~130 MB) and
cached under `~/.cache/huggingface/` — fetched once, then reused across runs, projects and `npx`
invocations. After the first download the server runs fully offline.

## Requirements

- **Node.js ≥ 20**
- **Network on first run** (one-time model download); offline afterwards
- **~130 MB** disk for the model, plus space for the per-project index
- **Git** on the `PATH` — files are enumerated via `git ls-files` / `git status`
- `better-sqlite3` and `sqlite-vec` ship prebuilt binaries for macOS (arm64/x64), Linux (x64/arm64)
  and Windows (x64); other targets compile from source and need a C/C++ toolchain.

## Use it with an MCP client

No install step — `npx` fetches and runs it. Add to your MCP client config (`.mcp.json` for
Claude Code project scope, or `~/.claude.json` for user scope):

```json
{
  "mcpServers": {
    "dfine-semantic": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@dfine-io-gmbh/semantic-mcp"]
    }
  }
}
```

By default the server only indexes the **current working directory** (and `~/.claude`). To allow
other roots, set `SEMANTIC_ALLOWED_ROOTS` (comma-separated absolute paths) in the server `env`.

## Tools & resource

| Name                     | Kind     | Purpose                                                            |
| ------------------------ | -------- | ------------------------------------------------------------------ |
| `semantic_search`        | tool     | Natural-language query → ranked chunks with `file:line` references |
| `index_project`          | tool     | Scan, chunk and embed all matching files under a project root      |
| `index_status`           | tool     | List indexed projects with file / chunk / size counts              |
| `semantic://usage-guide` | resource | When to use semantic search vs. exact `grep`                       |

Default file types: `.ts`, `.tsx`. Pass `include` on `semantic_search` (e.g. `[".md", ".vue"]`) to
widen a single query; `index_project` coverage is controlled by its allow-listed `extensions`.

## Configuration

| Variable                 | Default             | Purpose                                                     |
| ------------------------ | ------------------- | ----------------------------------------------------------- |
| `SEMANTIC_ALLOWED_ROOTS` | `cwd`, `~/.claude`  | Extra absolute roots the server may index (comma-separated) |
| `SEMANTIC_DATA_DIR`      | `~/.dfine-semantic` | Where per-project index databases are stored                |

The index is keyed by project path, so it persists across upgrades and is reused across `npx`
runs. Delete a project's `.db` to force a clean re-index.

## Security

- **Path sandbox** — only `cwd`, `~/.claude` and any `SEMANTIC_ALLOWED_ROOTS` are accepted; all
  inputs resolve and are checked against that allow-list.
- **Validated inputs** — every tool argument is schema-validated (Zod); file extensions are
  allow-listed.
- **Read-only & no code execution** — the server only reads files that `git` tracks within an
  allowed root; it never runs project code, and git is invoked with fixed arguments.

## Local development

```bash
pnpm install
pnpm build        # tsc
pnpm check        # tsc + eslint (security / no-secrets / sonarjs) + prettier
pnpm start
```

## License & support

MIT — see [LICENSE](./LICENSE). Questions or issues: <support@dfine.io> or the
[issue tracker](https://github.com/dfine-io/dfine-semantic-mcp/issues).
