import { join } from "node:path";
import { embed } from "../embedding/engine.js";
import { openStore } from "../store/vector-store.js";
import { lazySync } from "./sync.js";
import { validateProjectPath } from "../utils/path-guard.js";
import { getFileExtension } from "../utils/file-scanner.js";
import {
  type McpResponse,
  SEARCH_OVERFETCH_MULTIPLIER,
  SEARCH_OVERFETCH_CAP,
  HIGH_SCORE_THRESHOLD,
} from "../constants.js";

const DEFAULT_SEARCH_EXTENSIONS = new Set([".ts", ".tsx"]);

interface SearchArgs {
  query: string;
  path?: string;
  limit: number;
  threshold: number;
  returnFullContent: boolean;
  include?: string[];
}

interface ResponseOptions {
  projectPath: string;
  returnFullContent: boolean;
  limit: number;
  totalFiltered: number;
}

function buildSearchResponse(
  results: Array<{
    file: string;
    line: number;
    lineEnd: number;
    score: number;
    content: string;
  }>,
  opts: ResponseOptions
): string {
  const { projectPath, returnFullContent, limit, totalFiltered } = opts;
  const tag = (score: number) => {
    if (score >= HIGH_SCORE_THRESHOLD) return " [HIGH MATCH]";
    return "";
  };
  if (returnFullContent) {
    return results
      .map((r, i) => {
        const absPath = join(projectPath, r.file);
        return `[${i + 1}]${tag(r.score)} ${absPath}:${r.line}-${r.lineEnd}\n${r.content}`;
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
  if (totalFiltered > limit) {
    text += `\n\nNote: Results capped at limit=${limit}. ${totalFiltered - limit} more matches available — use limit=${totalFiltered} to fetch all.`;
  }
  return text;
}

export async function handleSearch(args: SearchArgs): Promise<McpResponse> {
  try {
    const projectPath = validateProjectPath(args.path ?? process.cwd());
    const store = openStore(projectPath);
    const stats = store.getStats();
    if (stats.totalChunks === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Project not indexed yet. Run index_project first with path: ${projectPath}`,
          },
        ],
      };
    }
    const syncMsg = await lazySync(store, projectPath);
    const queryEmbedding = await embed(args.query);

    const extFilter = new Set(DEFAULT_SEARCH_EXTENSIONS);
    if (args.include) {
      for (const ext of args.include) extFilter.add(ext);
    }
    const fetchLimit = Math.min(
      args.limit * SEARCH_OVERFETCH_MULTIPLIER,
      SEARCH_OVERFETCH_CAP
    );
    const raw = store.search(queryEmbedding, fetchLimit, args.threshold);
    const filtered = raw.filter((r) => extFilter.has(getFileExtension(r.file)));
    const results = filtered.slice(0, args.limit);

    if (results.length === 0) {
      return {
        content: [
          { type: "text" as const, text: "No results found above threshold." },
        ],
      };
    }

    let text = buildSearchResponse(results, {
      projectPath,
      returnFullContent: args.returnFullContent,
      limit: args.limit,
      totalFiltered: filtered.length,
    });
    if (syncMsg) text = `${syncMsg}\n\n${text}`;

    return { content: [{ type: "text" as const, text }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dfine-semantic] Search failed: ${message}`);
    return {
      content: [{ type: "text" as const, text: `Search failed: ${message}` }],
    };
  }
}
