type ChunkType = "function" | "class" | "type" | "block" | "file";

interface Chunk {
  content: string;
  lineStart: number;
  lineEnd: number;
  type: ChunkType;
}

const EXPORT_KEYWORDS = new Set([
  "function",
  "class",
  "const",
  "let",
  "type",
  "interface",
  "enum",
]);
const MIN_CHUNK_LINES = 3;
const MAX_CHUNK_LINES = 100;
const SLIDING_WINDOW_LINES = 30;
const SLIDING_OVERLAP_LINES = 5;
const JS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs"]);

function isExportDeclaration(line: string): boolean {
  const words = line.split(/\s+/);
  return words.some((w) => EXPORT_KEYWORDS.has(w));
}

export function chunkCode(content: string, filePath: string): Chunk[] {
  const ext = filePath.split(".").pop() ?? ""; // raw ext without dot for JS_EXTENSIONS set
  if (JS_EXTENSIONS.has(ext)) {
    return chunkTypeScript(content);
  }
  return chunkGeneric(content);
}

interface BlockState {
  start: number;
  type: Chunk["type"];
  braceDepth: number;
}

function processBlockEnd(
  lines: readonly string[],
  chunks: Chunk[],
  block: BlockState,
  endIdx: number
): void {
  const blockLen = endIdx - block.start + 1;
  if (blockLen < MIN_CHUNK_LINES) return;

  if (blockLen > MAX_CHUNK_LINES) {
    chunks.push(...slidingWindow(lines, block.start, endIdx, block.type));
  } else {
    const content = lines.slice(block.start, endIdx + 1).join("\n");
    chunks.push({
      content,
      lineStart: block.start + 1,
      lineEnd: endIdx + 1,
      type: block.type,
    });
  }
}

function countBraces(line: string, depth: number): number {
  const opens = line.match(/[{(]/g)?.length ?? 0;
  const closes = line.match(/[})]/g)?.length ?? 0;
  return depth + opens - closes;
}

function isBlockEnded(
  block: BlockState,
  trimmed: string,
  idx: number
): boolean {
  if (block.braceDepth <= 0 && idx > block.start) return true;
  return block.type === "type" && trimmed.endsWith(";");
}

function chunkTypeScript(content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  let block: BlockState | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines.at(i) ?? "";
    const trimmed = line.trim();

    if (!block && isExportDeclaration(trimmed)) {
      block = { start: i, type: getChunkType(trimmed), braceDepth: 0 };
    }

    if (block) {
      block.braceDepth = countBraces(line, block.braceDepth);

      if (isBlockEnded(block, trimmed, i) || i === lines.length - 1) {
        processBlockEnd(lines, chunks, block, i);
        block = null;
      }
    }
  }

  if (chunks.length === 0) return chunkGeneric(content);
  return chunks;
}

function chunkGeneric(content: string): Chunk[] {
  const lines = content.split("\n");
  if (lines.length <= SLIDING_WINDOW_LINES) {
    return [{ content, lineStart: 1, lineEnd: lines.length, type: "file" }];
  }
  return slidingWindow(lines, 0, lines.length - 1, "block");
}

function slidingWindow(
  lines: readonly string[],
  start: number,
  end: number,
  type: Chunk["type"]
): Chunk[] {
  const chunks: Chunk[] = [];
  for (
    let i = start;
    i <= end;
    i += SLIDING_WINDOW_LINES - SLIDING_OVERLAP_LINES
  ) {
    const windowEnd = Math.min(i + SLIDING_WINDOW_LINES - 1, end);
    const content = lines.slice(i, windowEnd + 1).join("\n");
    chunks.push({ content, lineStart: i + 1, lineEnd: windowEnd + 1, type });
    if (windowEnd >= end) break;
  }
  return chunks;
}

function getChunkType(line: string): Chunk["type"] {
  if (line.includes("function")) return "function";
  if (line.includes("class")) return "class";
  if (
    line.includes("type ") ||
    line.includes("interface ") ||
    line.includes("enum ")
  )
    return "type";
  return "block";
}
