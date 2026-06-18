import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const MAX_FILE_SIZE = 100_000; // 100KB
const BYTES_PER_KB = 1_024;
export const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
export const MS_PER_SECOND = 1_000;
export const SEARCH_LIMIT_MAX = 500;
export const SEARCH_LIMIT_DEFAULT = 200;
export const SEARCH_THRESHOLD_DEFAULT = 0.3;
export const SEARCH_OVERFETCH_MULTIPLIER = 3;
export const SEARCH_OVERFETCH_CAP = 1_500;
export const QUERY_MAX_LENGTH = 2_000;
export const HIGH_SCORE_THRESHOLD = 0.8;
export const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_MB = 10;
export const GIT_MAX_BUFFER = BYTES_PER_MB * GIT_MAX_BUFFER_MB;
export const RENAME_MARKER_LENGTH = 4; // " -> ".length
export const GIT_STATUS_PREFIX_LENGTH = 3;
export const MIN_LINE_LENGTH = 4;

// Alias the SDK result type directly — its required string index signature is
// part of the callback contract, so we delegate instead of re-declaring it.
export type McpResponse = CallToolResult;
export const DEFAULT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".vue",
  ".php",
  ".md",
  ".css",
];
export const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".vue",
  ".php",
  ".md",
  ".css",
  ".py",
  ".go",
  ".rs",
  ".json",
]);
