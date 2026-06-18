# PROJECT GUARDRAILS

dfine-semantic-mcp - a local, stdio MCP server (TypeScript, Node >= 20) that embeds a project's
code into a per-project SQLite vector store and answers semantic-search queries grep misses.

## Constraints

1. Type strictly under the dfine-review tsconfig baseline - `strict` + `noUncheckedIndexedAccess`.
2. Lint with dlint (the dfine house linter) - config in `dlint.config.ts`, run via `pnpm lint:dlint`.
3. Prefer `readonly T[]` params and named type aliases - dlint `type-precision` expects it.
4. Validate every tool input with Zod and allow-list file extensions before use.
5. Check Git history for prior fixes and regressions before implementation.
6. Create a detailed task list and track progress - stay organized.
7. You MUST use `dfine:analyze-agent` for codebase exploration and pattern discovery.

## Architecture

- G1.1: Keep the server stdio-only and fully local - no network transport, no remote calls.
- G1.2: Sandbox access to cwd, `~/.claude`, `SEMANTIC_ALLOWED_ROOTS` - resolve + check every path.
- G1.3: Stay read-only - index only git-tracked files, never run project code, invoke git with fixed args.
- G1.4: Store vectors in `sqlite-vec`, one DB per project under `~/.dfine-semantic` - never co-mingle.
- G1.5: Treat the HF embedding model as an external ~130 MB download - never bundle it.

## Conventions

- G2.1: Centralize shared constants in `src/constants.ts` - no `constants/` dir (rule overridden).
- G2.2: Comment only the "why" with single-line `//`; keep modules small and cohesive.

# METHODOLOGY - MINDSET

- Draft the strongest counter-position before finalizing a code or architecture decision.
- State assumptions explicitly; uncertain -> ask, never pick silently.
- Consider the adjacent cases (B/C/D), not just A - no partial scopes.
- Bias toward deletion - ask "can I delete instead?" before adding code or abstractions.
- For unclear bugs, propose targeted debug logs first - never a blind code fix.

# VERIFY IMPLEMENTATION

Execute steps 1-4 in strict order:

1. **QC**: Fix task-related errors first; report pre-existing errors separately.
   - 1.1: `pnpm prettier --write [changed-files]`.
   - 1.2: `tsc --noEmit` - typecheck the project.
   - 1.3: `dlint --format compact --files [changed-files]` - lint ONLY the changed files.
   - 1.4: Smoke-test over stdio against a real MCP client - index a project, run a query.
2. **STATUS**: Set plan status `COMPLETED`; commit only this task's files - and only when asked.
3. **CONFORMANCE**: Validate the plan's target files against the code - fully implemented, not partial.
4. **SUMMARY**: Close with a small PM-readable change table in German (Bereich, Aenderung, Nutzen).
