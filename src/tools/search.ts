import { join } from "node:path";
import { z } from "zod";
import { embed } from "../embedding/engine.js";
import { openIndexedStore, type SearchHit } from "../store/vector-store.js";
import { syncBeforeSearch } from "./sync.js";
import {
  validateProjectPath,
  type CanonicalPath,
} from "../utils/path-guard.js";
import {
  notIndexed,
  structuredResult,
  type ToolContext,
} from "../utils/context.js";
import {
  type McpResponse,
  DEFAULT_SEARCH_EXTENSIONS,
  HIGH_SCORE_THRESHOLD,
  SEARCH_LIMIT_MAX,
} from "../constants.js";

// The answer as data: clients read it from structuredContent, the model reads the text.
export const SearchOutputSchema = z.object({
  status: z
    .enum(["ok", "not_indexed"])
    .describe('"not_indexed": run index_project for this path first'),
  results: z.array(
    z.object({
      file: z.string().describe("Absolute path"),
      from: z.number().int(),
      to: z.number().int(),
      score: z.number(),
      content: z.string().nullable().describe("Set with returnFullContent"),
    })
  ),
  hasMore: z.boolean().describe("More matches pass the threshold"),
  notes: z.array(z.string()).describe("Sync and index notes"),
});
type SearchOutput = z.infer<typeof SearchOutputSchema>;

interface SearchArgs {
  readonly query: string;
  readonly path?: string;
  readonly limit: number;
  readonly threshold: number;
  readonly returnFullContent: boolean;
  readonly include?: readonly string[];
}

interface ResponseOptions {
  readonly projectPath: CanonicalPath;
  readonly returnFullContent: boolean;
  readonly hasMore: boolean;
}

function buildSearchResponse(
  results: ReadonlyArray<SearchHit>,
  opts: ResponseOptions
): string {
  const { projectPath, returnFullContent, hasMore } = opts;
  const tag = (score: number) => {
    if (score >= HIGH_SCORE_THRESHOLD) return " [HIGH MATCH]";
    return "";
  };
  if (returnFullContent) {
    return results
      .map((r, i) => {
        const absPath = join(projectPath, r.file);
        return `[${i + 1}]${tag(r.score)} ${absPath}:${r.line}-${r.lineEnd}\n${r.content ?? ""}`;
      })
      .join("\n\n---\n\n");
  }
  let text = results
    .map((r, i) => {
      const absPath = join(projectPath, r.file);
      return `[${i + 1}]${tag(r.score)} ${absPath}:${r.line}-${r.lineEnd}`;
    })
    .join("\n");
  text += `\n\n${results.length} results. Use Read tool to inspect files at the paths above.`;
  if (hasMore) {
    text += `\n\nNote: More matches pass the threshold. Raise limit (max ${SEARCH_LIMIT_MAX}) to see them.`;
  }
  return text;
}

export async function handleSearch(
  args: SearchArgs,
  ctx: ToolContext
): Promise<McpResponse> {
  const projectPath = validateProjectPath(args.path ?? process.cwd());
  const store = await openIndexedStore(projectPath);
  if (!store) {
    const text = notIndexed(projectPath);
    return structuredResult(text, {
      status: "not_indexed",
      results: [],
      hasMore: false,
      notes: [text],
    } satisfies SearchOutput);
  }
  // The query vector does not depend on the sync, so both run at once.
  const [sync, queryEmbedding] = await Promise.all([
    syncBeforeSearch(store, projectPath, ctx),
    embed(args.query),
  ]);
  if (sync.kind === "ask") return sync.form;
  const { results, hasMore } = store.search(queryEmbedding, {
    limit: args.limit,
    threshold: args.threshold,
    extensions: [...DEFAULT_SEARCH_EXTENSIONS, ...(args.include ?? [])],
    withContent: args.returnFullContent,
  });
  const body =
    results.length === 0
      ? "No results found above threshold."
      : buildSearchResponse(results, {
          projectPath,
          returnFullContent: args.returnFullContent,
          hasMore,
        });
  return structuredResult(sync.note ? `${sync.note}\n\n${body}` : body, {
    status: "ok",
    results: results.map((hit) => ({
      file: join(projectPath, hit.file),
      from: hit.line,
      to: hit.lineEnd,
      score: hit.score,
      content: hit.content,
    })),
    hasMore,
    notes: sync.note ? [sync.note] : [],
  } satisfies SearchOutput);
}
