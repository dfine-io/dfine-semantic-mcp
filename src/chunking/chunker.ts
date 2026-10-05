import { MAX_CHUNK_CHARS } from "../constants.js";

// Embedding cost grows with chunk length, so short chunks index faster and match more precisely.
const TARGET_CHUNK_CHARS = 1_000;
const DECLARATION =
  /^(export\s+)?(default\s+)?(async\s+)?(abstract\s+)?(function|class|interface|type|enum|const|let|var)\b/;
const CLOSING = /^[}\])]/;
const COMMENT_OR_DECORATOR = /^(\/\/|\/\*|\*|@)/;

export interface Chunk {
  readonly content: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  // Slice index when one line exceeds MAX_CHUNK_CHARS, else 0.
  readonly part: number;
}

// Cut where a reader would: after a blank line or at a declaration, never between it and its comment.
function isBoundary(line: string, previous: string): boolean {
  if (line === "" || /^\s/.test(line) || CLOSING.test(line)) return false;
  if (previous.trim() === "") return true;
  return (
    DECLARATION.test(line) && !COMMENT_OR_DECORATOR.test(previous.trimStart())
  );
}

function joinLines(lines: readonly string[], from: number, to: number): Chunk {
  const content = lines.slice(from, to).join("\n");
  return { content, lineStart: from + 1, lineEnd: to, part: 0 };
}

function sliceLine(line: string, lineNo: number): Chunk[] {
  const parts: Chunk[] = [];
  for (let at = 0; at < line.length; at += MAX_CHUNK_CHARS) {
    const content = line.slice(at, at + MAX_CHUNK_CHARS);
    parts.push({
      content,
      lineStart: lineNo,
      lineEnd: lineNo,
      part: parts.length,
    });
  }
  return parts;
}

function capRange(lines: readonly string[], from: number, to: number): Chunk[] {
  const out: Chunk[] = [];
  let start = from;
  let size = 0;
  for (let i = from; i < to; i++) {
    const line = lines[i] ?? "";
    if (line.length + 1 > MAX_CHUNK_CHARS) {
      if (i > start) out.push(joinLines(lines, start, i));
      out.push(...sliceLine(line, i + 1));
      start = i + 1;
      size = 0;
      continue;
    }
    if (size + line.length + 1 > MAX_CHUNK_CHARS) {
      out.push(joinLines(lines, start, i));
      start = i;
      size = 0;
    }
    size += line.length + 1;
  }
  if (to > start) out.push(joinLines(lines, start, to));
  return out;
}

// Every line lands in a chunk; cuts wait until a chunk is big enough to stand on its own.
export function chunkCode(content: string): Chunk[] {
  const lines = content.replace(/\n$/, "").split("\n");
  const chunks: Chunk[] = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (size >= TARGET_CHUNK_CHARS && isBoundary(line, lines[i - 1] ?? "")) {
      chunks.push(...capRange(lines, start, i));
      start = i;
      size = 0;
    }
    size += line.length + 1;
  }
  chunks.push(...capRange(lines, start, lines.length));
  return chunks.filter((chunk) => chunk.content.trim() !== "");
}
