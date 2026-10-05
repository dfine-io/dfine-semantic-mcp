# Changelog

## 0.1.4

- Added `find_duplicates`, off by default, to find near-identical TypeScript and JavaScript code in other files
- Added `duplicates: true` to `index_project` to turn duplicate search on for a project; `false` turns it off
- Added structured results to `semantic_search` and `find_duplicates`, with a status that tells "off" from "none found"
- Added a prompt, in clients that support it, before a search re-indexes for more than about a minute
- Added progress updates while `index_project` runs and while a search re-indexes changed files
- Added an offer to rebuild indexes made by 0.1.3 or older in clients that support it; old results stay until then
- Added `.mjs` files to the file types a new index covers by default
- Added tool titles and read-only hints for MCP clients that show or use them
- Improved indexing speed: files are embedded together instead of one at a time
- Improved how files are split: every line is searchable, including interfaces, types and short declarations
- Improved memory use on very long lines, such as minified files
- Changed to MCP protocol revision 2026-07-28; clients on the 2025 revisions keep working without the prompt
- Changed searches to check for changed files on every call, without the old 30-second pause or 1,000-file cap
- Changed `index_project` to keep a project's file types when a call leaves out `extensions`
- Changed the index format: restart sessions still running 0.1.3 or older after upgrading
- Changed the model folder to `~/.dfine-semantic/models`: 0.1.4 downloads the model once more, later upgrades reuse it
- Changed a second `index_project` call during a run to return the run's progress instead of waiting
- Changed failed searches and index runs to return an error result instead of plain text
- Changed `index_status` with a path to report exactly that project and to reject paths outside the allowed roots
- Changed the working directory to no longer count as an allowed root when it is `/` or your home folder
- Fixed a failing `git` call emptying the whole index
- Fixed files with spaces or non-ASCII characters in their path being skipped
- Fixed searches missing files from new folders, commits, pulls and branch switches
- Fixed searches not re-indexing changed files of types outside the defaults, such as `.py`
- Fixed tracked files that a nested `.gitignore` excludes being indexed
- Fixed searches with `include` returning fewer results than `limit` when more matches existed
- Fixed a search on a project that was never indexed creating an empty index for it
- Fixed `index_status` failing when the data folder held an unreadable index file
- Fixed file listing writing to the repository's git index or running its `core.fsmonitor` command
- Fixed a failed model download breaking every search until the server restarted
- Removed the `semantic://usage-guide` resource; its guidance now arrives as server instructions

## 0.1.3

- Added `force: true` to `index_project` to discard the index and rebuild it
- Changed the minimum Node.js version to 22
- Changed a second `index_project` call with the same settings to join the running one
- Fixed interrupted or overlapping index runs duplicating a file's chunks, and removed duplicates left by older versions
- Fixed cancelling `index_project` not stopping the run
- Fixed the MCP handshake reporting an outdated server version

## 0.1.2

- Fixed tracked symlinks being able to lead outside the project
- Changed `semantic_search` to cap the query length and accept only allow-listed `include` extensions

## 0.1.1

- Added a security policy with a private reporting channel
- Fixed the usage guide showing a platform-specific example path
- Fixed all known vulnerabilities in dependencies

## 0.1.0

- Added the semantic code search MCP server, which embeds code locally with a code-tuned model
- Added `semantic_search`, `index_project` and `index_status`, plus a usage guide resource
- Added automatic sync of changed files on search
- Added a path sandbox through `SEMANTIC_ALLOWED_ROOTS`, validated tool inputs and a file extension allow-list
- Added one index per project in `~/.dfine-semantic` that survives upgrades, movable with `SEMANTIC_DATA_DIR`
- Added prebuilt native binaries for macOS, Linux and Windows
