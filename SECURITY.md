# Security Policy

## Reporting a vulnerability

Please report security issues **privately** by email to **support@dfine.io** — do not
open public GitHub issues for security reports. We aim to acknowledge within a few
business days and will coordinate a fix and disclosure with you.

## Security model

`@dfine-io-gmbh/semantic-mcp` is a local, stdio-based MCP server:

- **Path sandbox** — it only reads files under the current working directory, `~/.claude`,
  and any roots explicitly added via `SEMANTIC_ALLOWED_ROOTS`. Paths outside are rejected.
- **Validated inputs** — every tool argument is schema-validated (Zod); file extensions are
  allow-listed.
- **No code execution** — it reads git-tracked files within an allowed root, embeds them, and
  stores vectors in local SQLite. It never runs project code, and `git` is invoked with fixed
  arguments (no shell interpolation of user input).
- **No runtime network** — except the one-time embedding-model download from the Hugging Face Hub.

## Dependencies

Dependencies are kept current and `npm audit` is part of our release checks. The published package
is built JavaScript only; it ships no source maps or tooling configuration.
