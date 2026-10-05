import { extname } from "node:path";
import {
  MAX_CHUNK_CHARS,
  WINDOW_LINES,
  WINDOWED_EXTENSIONS,
} from "../constants.js";

// Measured on TypeScript with WINDOW_LINES: stride 5, at least 6 code lines per window.
const WINDOW_STRIDE = 5;
const MIN_WINDOW_LINES = 6;
const WINDOWED = new Set<string>(WINDOWED_EXTENSIONS);
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.|\.d\.ts$/;
// IMPORT and LIST_LINE match the measured harness: the 0.88 recall rests on them.
const IMPORT =
  /^\s*(import\b|export\s+(\*|\{[^}]*\})\s+from\b|export\s+type\s+\{|\}\s*from\s+["']|from\s+["'])/;
// The inside of a multi-line import or export list: names only, nothing about behaviour.
const LIST_LINE = /^\s*(type\s+)?[\w$]+,?\s*$|^\s*\}\s*;?\s*$/;

export interface CodeWindow {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

export function isWindowedPath(path: string): boolean {
  return WINDOWED.has(extname(path)) && !TEST_PATH.test(path);
}

function isList(texts: readonly string[]): boolean {
  return (
    texts.filter((text) => LIST_LINE.test(text)).length * 2 >= texts.length
  );
}

// Blank and import lines say nothing about duplicated behaviour; minified text is no evidence either.
export function extractWindows(content: string): CodeWindow[] {
  const code: Array<{ readonly n: number; readonly t: string }> = [];
  content.split("\n").forEach((t, i) => {
    if (t.trim() && !IMPORT.test(t)) code.push({ n: i + 1, t });
  });
  const windows: CodeWindow[] = [];
  for (let i = 0; i + MIN_WINDOW_LINES <= code.length; i += WINDOW_STRIDE) {
    const slice = code.slice(i, i + WINDOW_LINES);
    const first = slice[0];
    const last = slice.at(-1);
    if (!first || !last) break;
    const texts = slice.map((line) => line.t);
    const text = texts.join("\n");
    if (!isList(texts) && text.length <= MAX_CHUNK_CHARS)
      windows.push({ from: first.n, to: last.n, text });
    if (i + WINDOW_LINES >= code.length) break;
  }
  return windows;
}
