import { extname } from "node:path";
import { DECLARATION } from "./chunker.js";
import {
  MAX_CHUNK_CHARS,
  WINDOW_LINES,
  WINDOWED_EXTENSIONS,
} from "../constants.js";

// Measured on TypeScript with WINDOW_LINES: stride 5, at least 6 code lines per window.
const WINDOW_STRIDE = 5;
const MIN_WINDOW_LINES = 6;
// A shorter declaration drowns in every 10-line window; from 5 code lines it gets a unit of its own.
const MIN_UNIT_LINES = 5;
const WINDOWED = new Set<string>(WINDOWED_EXTENSIONS);
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.|\.d\.ts$/;
// IMPORT, LIST_LINE and COMMENT match the measured harness: the recall rests on them.
const IMPORT =
  /^\s*(import\b|export\s+(\*|\{[^}]*\})\s+from\b|export\s+type\s+\{|\}\s*from\s+["']|from\s+["'])/;
// The inside of a multi-line import or export list: names only, nothing about behaviour.
const LIST_LINE = /^\s*(type\s+)?[\w$]+,?\s*$|^\s*\}\s*;?\s*$/;
// A copied declaration rarely keeps its comment, so units leave comment lines out.
const COMMENT = /^\s*(\/\/|\/\*|\*)/;

// "window": WINDOW_LINES code lines at a stride; "unit": one short top-level declaration.
export type WindowKind = "window" | "unit";

export interface CodeWindow {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly kind: WindowKind;
}

interface CodeLine {
  readonly n: number;
  readonly t: string;
}

export function isWindowedPath(path: string): boolean {
  return WINDOWED.has(extname(path)) && !TEST_PATH.test(path);
}

function isList(texts: readonly string[]): boolean {
  return (
    texts.filter((text) => LIST_LINE.test(text)).length * 2 >= texts.length
  );
}

// A list of names or minified text is no duplicate evidence, so it yields no window.
function toWindow(
  lines: readonly CodeLine[],
  kind: WindowKind
): CodeWindow | null {
  const first = lines[0];
  const last = lines.at(-1);
  if (!first || !last) return null;
  const texts = lines.map((line) => line.t);
  const text = texts.join("\n");
  if (isList(texts) || text.length > MAX_CHUNK_CHARS) return null;
  return { from: first.n, to: last.n, text, kind };
}

function slidingWindows(code: readonly CodeLine[]): CodeWindow[] {
  const windows: CodeWindow[] = [];
  for (let i = 0; i + MIN_WINDOW_LINES <= code.length; i += WINDOW_STRIDE) {
    const window = toWindow(code.slice(i, i + WINDOW_LINES), "window");
    if (window) windows.push(window);
    if (i + WINDOW_LINES >= code.length) break;
  }
  return windows;
}

// One unit per top-level declaration of MIN_UNIT_LINES to WINDOW_LINES code lines, unless a window has its range.
function declarationUnits(
  code: readonly CodeLine[],
  taken: ReadonlySet<string>
): CodeWindow[] {
  const declarations: CodeLine[][] = [];
  for (const line of code) {
    if (COMMENT.test(line.t)) continue;
    const current = declarations.at(-1);
    if (current && !DECLARATION.test(line.t)) current.push(line);
    else declarations.push([line]);
  }
  return declarations.flatMap((lines) => {
    if (lines.length < MIN_UNIT_LINES || lines.length > WINDOW_LINES) return [];
    const unit = toWindow(lines, "unit");
    return unit && !taken.has(`${unit.from}-${unit.to}`) ? [unit] : [];
  });
}

// Blank and import lines say nothing about duplicated behaviour.
export function extractWindows(content: string): CodeWindow[] {
  const code: CodeLine[] = [];
  content.split("\n").forEach((t, i) => {
    if (t.trim() && !IMPORT.test(t)) code.push({ n: i + 1, t });
  });
  const windows = slidingWindows(code);
  const taken = new Set(windows.map((window) => `${window.from}-${window.to}`));
  return [...windows, ...declarationUnits(code, taken)];
}
