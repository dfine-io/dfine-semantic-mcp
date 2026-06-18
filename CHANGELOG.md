# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-06-19

### Security

- Sandbox now resolves symlinks before the allowed-roots check and guards every file read, so a
  tracked symlink can no longer escape the project root (hardens `SEMANTIC_ALLOWED_ROOTS`).

### Changed

- Stricter tool-input validation: `semantic_search` caps query length and allow-lists the
  `include` extensions, consistent with the `index_project` extension allow-list.

## [0.1.1] - 2026-06-15

### Changed

- Updated all dependencies to their latest versions; `npm audit` reports no known vulnerabilities.

### Added

- Security policy (`SECURITY.md`) with a private reporting channel.

### Fixed

- Use a platform-neutral example path in the usage guide.

## [0.1.0] - 2026-06-15

Initial public release.

### Added

- MCP server (stdio) for semantic codebase search over a local `sqlite-vec` vector store.
- Code-tuned embeddings via `jinaai/jina-embeddings-v2-base-code` (768-dim), downloaded on first
  run and cached under `~/.cache/huggingface/` — no network calls afterwards.
- Tools `semantic_search`, `index_project`, `index_status` and the `semantic://usage-guide` resource.
- Git-aware incremental auto-sync of changed files on search, with stale-entry reconciliation.
- Path sandbox via `SEMANTIC_ALLOWED_ROOTS`, Zod-validated tool inputs and a file-extension allow-list.
- Per-project index stored in a stable user directory (`~/.dfine-semantic`, override with
  `SEMANTIC_DATA_DIR`) so it survives `npx` runs and package upgrades.
- Batched embedding during indexing for a faster initial index.
- Cross-platform support: native prebuilds for macOS, Linux and Windows, and CRLF-safe git parsing.

[0.1.2]: https://github.com/dfine-io/dfine-semantic-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/dfine-io/dfine-semantic-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/dfine-io/dfine-semantic-mcp/releases/tag/v0.1.0
