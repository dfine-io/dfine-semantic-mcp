#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleSearch } from "./tools/search.js";
import { handleIndexProject } from "./tools/index-project.js";
import { handleIndexStatus } from "./tools/index-status.js";
import { handleUsageGuide } from "./resources/usage-guide.js";
import {
  ALLOWED_EXTENSIONS,
  DEFAULT_EXTENSIONS,
  SEARCH_LIMIT_MAX,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_THRESHOLD_DEFAULT,
  QUERY_MAX_LENGTH,
} from "./constants.js";

const server = new McpServer({
  name: "dfine-semantic",
  version: "0.1.0",
});

server.registerResource("usage-guide", "semantic://usage-guide", {}, (uri) =>
  handleUsageGuide(uri)
);

server.registerTool(
  "semantic_search",
  {
    description:
      'Search codebase semantically — finds conceptual matches beyond exact keywords.\n\nIMPORTANT: Query with natural language SENTENCES, not keywords. Good: "How does the app validate share token permissions?" Bad: "shareToken auth validate". The embedding model encodes full sentences as vectors.\n\nDo NOT pass `path` — it defaults to the project root from process.cwd(). Only pass `path` if you need a different indexed project.\n\nDefault mode returns compact file:line references for navigation (use Read tool to inspect). Set returnFullContent=true only for deep-dives with few results (<20) where you need the code inline.\n\nBy default only .ts and .tsx files are returned. To include other file types (e.g. .md, .css, .js), pass them via the `include` parameter. Example: include=[".md"] to also search documentation files.',
    inputSchema: {
      query: z
        .string()
        .max(QUERY_MAX_LENGTH)
        .describe(
          "Natural language search query — use full sentences, not keywords"
        ),
      path: z
        .string()
        .optional()
        .describe(
          "Project root path. Omit to use current working directory. MUST be project root, not a subdirectory."
        ),
      limit: z
        .number()
        .min(1)
        .max(SEARCH_LIMIT_MAX)
        .default(SEARCH_LIMIT_DEFAULT)
        .describe("Max results"),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .default(SEARCH_THRESHOLD_DEFAULT)
        .describe("Min similarity score"),
      returnFullContent: z
        .boolean()
        .default(false)
        .describe(
          "Return full chunk content instead of compact references. Use only for deep-dives with few results."
        ),
      include: z
        .array(z.string().regex(/^\.[a-z0-9]+$/i))
        .refine(
          (exts) => exts.every((e) => ALLOWED_EXTENSIONS.has(e)),
          "Extension not in allowlist"
        )
        .optional()
        .describe(
          'Additional file extensions to include beyond the default .ts/.tsx filter. Example: [".md", ".css"]'
        ),
    },
  },
  handleSearch
);

server.registerTool(
  "index_project",
  {
    description:
      "Index a project directory for semantic search — scans, chunks, and embeds code files. Only changed files are re-embedded. Set force=true to discard the stored index and rebuild it from scratch.",
    inputSchema: {
      path: z.string().describe("Absolute path to project root"),
      extensions: z
        .array(z.string().regex(/^\.[a-z0-9]+$/i))
        .default([...DEFAULT_EXTENSIONS])
        .refine(
          (exts) => exts.every((e) => ALLOWED_EXTENSIONS.has(e)),
          "Extension not in allowlist"
        )
        .describe("File extensions to index"),
      force: z
        .boolean()
        .default(false)
        .describe(
          "Discard the stored index and rebuild from scratch. Use after a corrupted or interrupted run."
        ),
    },
  },
  handleIndexProject
);

server.registerTool(
  "index_status",
  {
    description: "Show indexing status for all or a specific project",
    inputSchema: {
      path: z.string().optional().describe("Optional project path to check"),
    },
  },
  handleIndexStatus
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[dfine-semantic] MCP Server running on stdio");
}

main().catch((error) => {
  console.error("[dfine-semantic] Fatal:", error);
  process.exit(1);
});
