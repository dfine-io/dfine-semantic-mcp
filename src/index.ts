#!/usr/bin/env node
import { createRequire } from "node:module";
import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  type ServerContext,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { handleSearch, SearchOutputSchema } from "./tools/search.js";
import { handleIndexProject } from "./tools/index-project.js";
import { handleIndexStatus } from "./tools/index-status.js";
import {
  DuplicatesOutputSchema,
  handleFindDuplicates,
} from "./tools/duplicates.js";
import { errorMessage, type ToolContext } from "./utils/context.js";
import {
  ALLOWED_EXTENSIONS,
  ExtensionListSchema,
  DEFAULT_SEARCH_EXTENSIONS,
  SEARCH_LIMIT_MAX,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_THRESHOLD_DEFAULT,
  QUERY_MAX_LENGTH,
  WINDOWED_EXTENSIONS,
} from "./constants.js";

// Longest path most file systems allow; anything longer is no path.
const PATH_MAX_LENGTH = 4_096;
// 0.88 found about 40% of real duplicates in the measured TypeScript repo; below 0.8 it floods.
const DUPLICATE_THRESHOLD_DEFAULT = 0.88;
const DUPLICATE_THRESHOLD_MIN = 0.8;
const DUPLICATE_LIMIT_DEFAULT = 5;
const DUPLICATE_LIMIT_MAX = 20;
const DUPLICATE_FILES_MAX = 50;
const DUPLICATE_EXCLUDE_MAX = 20;

// package.json ships with every install, so the handshake version cannot drift from it.
const { version } = z
  .object({ version: z.string() })
  .parse(createRequire(import.meta.url)("../package.json"));

const INSTRUCTIONS = [
  "Semantic code search over a local index, one index per project root.",
  "- Use semantic_search to find code by concept, Grep for exact strings, LSP for symbol references.",
  "- Run index_project once per project root before its first search.",
  "- Expect every search to sync changed files first - a large sync asks the user before it runs.",
  "- Expect the first index or search to download the model (~640 MB) once.",
  "- Use find_duplicates in reviews and refactors - it is off until index_project duplicates: true.",
].join("\n");

// The SDK validates the request envelope but types it as {}: read the one member the form needs.
const EnvelopeSchema = z.object({
  [CLIENT_CAPABILITIES_META_KEY]: z.object({
    elicitation: z
      .object({ form: z.unknown(), url: z.unknown() })
      .partial()
      .optional(),
  }),
});

// Forms ride input_required, which needs the 2026-07-28 envelope; a 2025-era client gets the default.
// Same rule as the SDK's gate: a bare elicitation capability means forms.
function canShowForm(ctx: ServerContext): boolean {
  const parsed = EnvelopeSchema.safeParse(ctx.mcpReq.envelope);
  const elicitation = parsed.success
    ? parsed.data[CLIENT_CAPABILITIES_META_KEY].elicitation
    : undefined;
  return (
    elicitation !== undefined &&
    (elicitation.form !== undefined || elicitation.url === undefined)
  );
}

// Maps the SDK request onto what the handlers need, so they stay free of SDK types.
function toolContext(ctx: ServerContext): ToolContext {
  const token = ctx.mcpReq._meta?.progressToken;
  return {
    signal: ctx.mcpReq.signal,
    progress: async (done, total, message) => {
      if (token === undefined) return;
      // A closed client must not fail the run.
      await ctx.mcpReq
        .notify({
          method: "notifications/progress",
          params: { progressToken: token, progress: done, total, message },
        })
        .catch((error: unknown) => {
          console.error(
            `[dfine-semantic] Progress not sent: ${errorMessage(error)}`
          );
        });
    },
    form: canShowForm(ctx) ? { answers: ctx.mcpReq.inputResponses } : null,
  };
}

// Every failure reaches stderr once; the rethrow becomes an error result in the SDK.
function logged<A, R>(
  name: string,
  handler: (args: A, ctx: ToolContext) => Promise<R>
): (args: A, ctx: ServerContext) => Promise<R> {
  return async (args, ctx) => {
    try {
      return await handler(args, toolContext(ctx));
    } catch (error) {
      console.error(`[dfine-semantic] ${name} failed: ${errorMessage(error)}`);
      throw error;
    }
  };
}

// At least one extension, at most the allow-list itself.
const extensionList = ExtensionListSchema.max(ALLOWED_EXTENSIONS.size);

const pathString = z.string().max(PATH_MAX_LENGTH);
const optionalRoot = pathString
  .optional()
  .describe("Absolute project root - omit to use the working directory");
const pathEntry = pathString.min(1);

// The index is the server's own cache, so a sync before searching counts as read-only.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} satisfies ToolAnnotations;

const SearchInputSchema = z.object({
  query: z
    .string()
    .max(QUERY_MAX_LENGTH)
    .describe("One natural-language sentence"),
  path: optionalRoot,
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMIT_MAX)
    .default(SEARCH_LIMIT_DEFAULT)
    .describe("Max results"),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(SEARCH_THRESHOLD_DEFAULT)
    .describe("Min similarity - raise to 0.5 for precision, lower for recall"),
  returnFullContent: z
    .boolean()
    .default(false)
    .describe(
      "Return chunk code instead of file:line references - keep limit under 20"
    ),
  include: extensionList
    .optional()
    .describe('Extra indexed extensions to search, e.g. [".md", ".css"]'),
});

const DuplicatesInputSchema = z.object({
  files: z
    .array(pathEntry)
    .min(1)
    .max(DUPLICATE_FILES_MAX)
    .describe(
      'Root-relative or absolute paths, optionally with lines: "src/a.ts:10-40"'
    ),
  path: optionalRoot,
  threshold: z
    .number()
    .min(DUPLICATE_THRESHOLD_MIN)
    .max(1)
    .default(DUPLICATE_THRESHOLD_DEFAULT)
    .describe(
      "Min similarity - raise to 0.92 for fewer false pairs, lower for more recall"
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(DUPLICATE_LIMIT_MAX)
    .default(DUPLICATE_LIMIT_DEFAULT)
    .describe("Max pairs per file"),
  exclude: z
    .array(pathEntry)
    .max(DUPLICATE_EXCLUDE_MAX)
    .default([])
    .describe(
      'Root-relative or absolute folders or files to leave out, e.g. ["src/generated"]'
    ),
});

// serveStdio calls this once per connection and serves both protocol eras from it.
function createServer(): McpServer {
  const server = new McpServer(
    { name: "dfine-semantic", version },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool(
    "semantic_search",
    {
      title: "Semantic code search",
      description: [
        "Find code by meaning in an indexed project.",
        "Ask one full natural-language sentence, not keywords.",
        'Good: "How does the app validate share token permissions?" Bad: "shareToken auth validate".',
        "Returns file:line references by default - read the files you need.",
        `Searches ${DEFAULT_SEARCH_EXTENSIONS.join(" and ")} unless include adds other indexed extensions.`,
      ].join("\n"),
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged("semantic_search", handleSearch)
  );

  server.registerTool(
    "index_project",
    {
      title: "Index a project",
      description: [
        "Build or refresh the semantic index of a project root.",
        "Embeds only new, edited or outdated files and drops deleted ones.",
        "Pass duplicates: true once to enable find_duplicates for this project.",
      ].join("\n"),
      inputSchema: z.object({
        path: pathString.describe("Absolute path to project root"),
        extensions: extensionList
          .optional()
          .describe(
            "File extensions to index - omit to keep the project's list"
          ),
        force: z
          .boolean()
          .default(false)
          .describe("Discard the stored index and rebuild it from scratch"),
        duplicates: z
          .boolean()
          .optional()
          .describe(
            "true builds the duplicate index, false deletes it - omit to keep it as is"
          ),
      }),
      // force, duplicates: false and a narrower extension list delete indexed data.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    logged("index_project", handleIndexProject)
  );

  server.registerTool(
    "index_status",
    {
      title: "Index status",
      description:
        "List indexed projects with file, chunk and size counts - pass path for one project.",
      inputSchema: z.object({
        path: pathString.optional().describe("Optional project path to check"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged("index_status", handleIndexStatus)
  );

  server.registerTool(
    "find_duplicates",
    {
      title: "Find duplicate code",
      description: [
        "List code in other files that nearly matches the given files or line ranges.",
        'Use it in reviews and refactors - pass changed line ranges ("src/a.ts:10-40") for sharper pairs.',
        "Treat every pair as a candidate - read both ranges before you call it a duplicate.",
        "Expect it to be off per project - ask the user before you turn it on.",
        "Turn it on with index_project duplicates: true - the first build can take over an hour on large projects.",
        `Covers ${WINDOWED_EXTENSIONS.join(", ")} files; skips tests, specs and .d.ts files.`,
      ].join("\n"),
      inputSchema: DuplicatesInputSchema,
      outputSchema: DuplicatesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged("find_duplicates", handleFindDuplicates)
  );

  return server;
}

serveStdio(createServer, {
  onerror: (error) => {
    console.error(`[dfine-semantic] ${error.message}`);
  },
});
console.error("[dfine-semantic] MCP Server running on stdio");
