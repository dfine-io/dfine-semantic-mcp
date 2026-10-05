import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CallToolResult,
  InputRequiredResult,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export const MAX_FILE_SIZE = 100_000; // 100KB
const BYTES_PER_KB = 1_024;
export const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
export const MS_PER_SECOND = 1_000;
export const SEARCH_LIMIT_MAX = 500;
export const SEARCH_LIMIT_DEFAULT = 200;
export const SEARCH_THRESHOLD_DEFAULT = 0.3;
export const QUERY_MAX_LENGTH = 2_000;
export const HIGH_SCORE_THRESHOLD = 0.8;
export const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_MB = 10;
export const GIT_MAX_BUFFER = BYTES_PER_MB * GIT_MAX_BUFFER_MB;

export const DATA_DIR =
  process.env["SEMANTIC_DATA_DIR"] ?? join(homedir(), ".dfine-semantic");
// Bump when chunk boundaries change: files from an older chunker count as stale.
export const CHUNKER_VERSION = 2;
// Bump when window rules change: projects with duplicate search rebuild their windows.
export const WINDOWER_VERSION = 1;
// Hard cap near 550 tokens of code: bounds the memory of one embedding batch.
export const MAX_CHUNK_CHARS = 2_000;
// Measured on TypeScript: 10 code lines per window; hits closer than one window are one block.
export const WINDOW_LINES = 10;
// Measured or same syntax only: other languages need their own import rule and threshold first.
export const WINDOWED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
] as const;
export const EXTENSIONS_KEY = "extensions";

// A tool answer, or a form the client shows the user before it retries the call.
export type McpResponse = CallToolResult | InputRequiredResult;
// Every windowed type is indexed by default, so a default index can turn on duplicate search.
export const DEFAULT_EXTENSIONS = [
  ...WINDOWED_EXTENSIONS,
  ".vue",
  ".php",
  ".md",
  ".css",
] as const;
// semantic_search covers these unless its include widens them.
export const DEFAULT_SEARCH_EXTENSIONS: readonly string[] = [".ts", ".tsx"];
const ALLOWED = [...DEFAULT_EXTENSIONS, ".py", ".go", ".rs", ".json"] as const;
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(ALLOWED);
// One rule for every extension list, from a tool call or read back from the store; clients see the enum.
export const ExtensionListSchema = z.array(z.enum(ALLOWED)).min(1);
