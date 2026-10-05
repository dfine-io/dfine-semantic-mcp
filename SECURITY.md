# Security Policy

## Reporting a vulnerability

Please report security issues privately by email to support@dfine.io and do not open a public
GitHub issue for them. We acknowledge reports within a few business days and coordinate the fix
and its disclosure with you.

## Security model

`@dfine-io-gmbh/semantic-mcp` is a local MCP server that talks over stdio.

- Path sandbox: it reads files only under the working directory, `~/.claude` and roots added with
  `SEMANTIC_ALLOWED_ROOTS`, and rejects every other path. The working directory does not count when
  it is `/` or the home folder.
- Validated inputs: every tool argument is checked with Zod, and file extensions come from an
  allow-list.
- No code execution: it reads the files git lists inside an allowed root, embeds them and stores
  the vectors in local SQLite. It never runs project code. Git runs with fixed arguments, and the
  repository's `core.fsmonitor` command is disabled for those calls.
- No runtime network: the only network access is the model download from the Hugging Face Hub
  while the model is missing.

## Dependencies

We keep dependencies current and run `pnpm audit` before each release. The published package
contains built JavaScript only, without source maps or tooling configuration.
