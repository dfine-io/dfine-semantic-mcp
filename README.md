# @dfine-io-gmbh/semantic-mcp

Semantic code search as an [MCP](https://modelcontextprotocol.io) server. It embeds a project's code into a
local SQLite vector store and answers natural-language questions that a plain `grep` cannot match.
Everything runs locally once the model is downloaded.

## How it works

- Code is split into chunks and embedded with `jinaai/jina-embeddings-v2-base-code` (768 dimensions)
  through `@huggingface/transformers`.
- Vectors live in one local SQLite database per project (`sqlite-vec`).
- The server speaks MCP over stdio, revision 2026-07-28 and the 2025 revisions, and works with any
  MCP client, for example Claude Code or Cursor.
- Each search first re-indexes the files that changed since the last one. If that would take longer
  than about a minute, clients on MCP 2026-07-28 that support forms ask you first. Other clients
  re-index without asking.
- Long runs report progress to clients that ask for it. Claude Code and other clients that reset
  their timeout on progress keep such a call open until it finishes.

## Requirements

- Node.js 22 or newer
- Git on the `PATH`. Every indexed root must be inside a git work tree, because files are listed with
  `git ls-files`.
- Network access to download the model (about 640 MB) into `~/.dfine-semantic/models` when it is
  not there yet
- `better-sqlite3` and `sqlite-vec` ship prebuilt binaries for macOS (arm64, x64), Linux (x64, arm64)
  and Windows (x64). Other targets build from source and need a C/C++ toolchain.

## Use it with an MCP client

No install step is needed: `npx` fetches and runs the server. Add it to your MCP client config
(`.mcp.json` for Claude Code project scope, or `~/.claude.json` for user scope):

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

The server sends short usage instructions to the client when it connects.

## Tools

| Name              | Purpose                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `semantic_search` | Natural-language query, returns ranked `file:line` references            |
| `index_project`   | Index or refresh a project root, embedding only what changed             |
| `index_status`    | List indexed projects with file, chunk and size counts                   |
| `find_duplicates` | List similar code for files or line ranges (opt-in, see below)          |

`semantic_search` and `find_duplicates` also return their results as structured data, described by
each tool's output schema. Its `status` field tells an agent that duplicate search is `off` for a
project, which is not the same as finding no duplicates.

`semantic_search` covers `.ts` and `.tsx` by default. Pass `include` (for example `[".md", ".vue"]`)
to search other indexed file types. `index_project` indexes the allow-listed `extensions` you pass
and keeps that list, so a later call without `extensions` indexes the same file types.

## Duplicate search (opt-in)

`find_duplicates` is off until you turn it on for a project. It needs a second index of short code
windows, and building that index takes time and disk space, so projects that never use it never pay
for it.

1. Ask your agent to run `index_project` with `duplicates: true` once for the project. On an
   indexed repository with about 1,400 TypeScript files, this takes about 50 minutes and 75 MB. A
   project without a search index yet needs about 35 minutes more.
2. Ask for duplicates of files or line ranges, for example `src/a.ts:10-40`, and your agent calls
   `find_duplicates`. Searches and index runs keep the windows of edited files current. When a
   result says windows are missing, run `index_project` again.
3. Run `index_project` with `duplicates: false` to switch it off and delete the duplicate index.

Each result pairs a range of your file with a similar range in another file. It comes with a
similarity score and a band: `likely` from 0.88, `check` from 0.80 up to 0.88. The tool only lists
candidates, and your agent reads both ranges before it merges anything. The tool description tells
the agent what counts as a duplicate: both ranges follow the same rule, or a block repeats with only
names, data or texts swapped. A shared call or a short idiom does not count.

In a measured TypeScript project with about 1,400 files, the default threshold of 0.80 listed about
three in four of the real duplicates, and about half scored 0.88 or more. Short functions get an
entry of their own, so a word-for-word copy of a five-line function is found as well. Pass
`threshold: 0.88` to list only likely pairs.

The tool covers `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` files and skips tests, specs and `.d.ts`
files. Pass `exclude` with folders such as `src/generated` to leave generated or vendored code out.

## Configuration

| Variable                 | Default             | Purpose                                                     |
| ------------------------ | ------------------- | ----------------------------------------------------------- |
| `SEMANTIC_ALLOWED_ROOTS` | `cwd`, `~/.claude`  | Extra absolute roots the server may index (comma-separated) |
| `SEMANTIC_DATA_DIR`      | `~/.dfine-semantic` | Where the indexes and the model are stored                  |

The working directory counts as a root unless it is `/` or your home folder. Indexes are keyed by
project path and survive upgrades. Run `index_project` with `force: true` for a clean rebuild.

## Upgrading from 0.1.4

- In projects with duplicate search on, run `index_project` once. It rebuilds the duplicate index
  with the new entries for short functions, which takes about as long as the first build. Until
  then `find_duplicates` keeps working with the old index.
- `find_duplicates` now lists pairs from 0.80 instead of 0.88. Pass `threshold: 0.88` for the
  shorter list.

## Upgrading from 0.1.3 or older

- Restart every session that still runs 0.1.3 or older. An old server cannot read an upgraded index.
- The model downloads once more into its new folder. Copies inside old `npx` caches can be deleted.
- Files are now split into chunks differently. Searches keep using your existing index, and clients
  that support forms offer a rebuild. You can also run `index_project`.
- `find_duplicates` is new and stays off until your agent runs `index_project` with `duplicates: true`.

## Security

See [SECURITY.md](./SECURITY.md) for the security model and how to report a vulnerability.

## Local development

```bash
pnpm install
pnpm build        # tsc
pnpm lint:dlint   # dlint, the dfine linter on the TypeScript compiler
pnpm check        # tsc, dlint and prettier
pnpm start
```

## License and support

MIT, see [LICENSE](./LICENSE). Questions or issues: <support@dfine.io> or the
[issue tracker](https://github.com/dfine-io/dfine-semantic-mcp/issues).
