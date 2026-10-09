import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { isWindowedPath } from "../chunking/windows.js";
import { openIndexedStore } from "../store/vector-store.js";
import type { StoredWindow, WindowIndex } from "../store/window-index.js";
import { merge, type Pair, type Range } from "./duplicate-pairs.js";
import { indexProgress } from "./jobs.js";
import { syncBeforeSearch } from "./sync.js";
import {
  relativeToRoot,
  validateProjectPath,
  type CanonicalPath,
} from "../utils/path-guard.js";
import {
  notIndexed,
  structuredResult,
  type ToolContext,
} from "../utils/context.js";
import type { McpResponse } from "../constants.js";

// Identical copies fill k first; four times the limit leaves room for the real twins.
const K_PER_LIMIT = 4;
const MIN_K = 20;
// About 30 s of neighbour queries: 50 average files fit, 50 huge files stop early.
const WINDOW_BUDGET = 1_000;
const SCORE_DIGITS = 3;
// Measured: from 0.88 nearly every pair was a real copy; below it a reader decides.
export const LIKELY_SCORE = 0.88;
const WHOLE_FILE_END = Number.MAX_SAFE_INTEGER;
// dotAll: a line break inside a path stays part of the path instead of failing the match.
const TARGET_SPEC = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/s;
// Why a caller's path names no project file.
const NOT_IN_PROJECT = {
  root: "the project root",
  outside: "outside the project",
} as const;
const DUPLICATES_OFF =
  "Duplicate search is off for this project. Ask the user, then run index_project with duplicates: true (the first build can take over an hour on large projects).";

const DuplicatePairSchema = z.object({
  file: z.string().describe("Root-relative path of the queried file"),
  from: z.number().int(),
  to: z.number().int(),
  otherFile: z.string().describe("Root-relative path of the similar file"),
  otherFrom: z.number().int(),
  otherTo: z.number().int(),
  score: z.number(),
  band: z
    .enum(["likely", "check"])
    .describe(
      `"likely" from ${LIKELY_SCORE}, "check" below: read the likely pairs first`
    ),
});
type DuplicatePair = z.infer<typeof DuplicatePairSchema>;

// The answer as data: clients read it from structuredContent, the model reads the text.
export const DuplicatesOutputSchema = z.object({
  status: z
    .enum(["ok", "off", "not_indexed"])
    .describe(
      '"off": duplicate search is not enabled for this project, which is not the same as no duplicates'
    ),
  pairs: z
    .array(DuplicatePairSchema)
    .describe("Candidates, best first per file"),
  notes: z
    .array(z.string())
    .describe(
      "Sync notes, why a file or exclude entry has no pairs, and how to read the pairs"
    ),
});
type DuplicatesOutput = z.infer<typeof DuplicatesOutputSchema>;

interface DuplicateArgs {
  readonly path?: string;
  readonly files: readonly string[];
  readonly threshold: number;
  readonly limit: number;
  readonly exclude: readonly string[];
}

interface Target extends Range {
  readonly kind: "target";
  readonly file: string;
}

interface Skip {
  readonly kind: "skip";
  readonly reason: string;
}

// One call's shared state: the window budget shrinks with every queried file.
interface Run {
  readonly root: CanonicalPath;
  readonly index: WindowIndex;
  readonly args: DuplicateArgs;
  readonly signal: AbortSignal;
  // Whole segments in git's form: "src/gen/" leaves out src/gen/ and keeps src/generated/.
  readonly prefixes: readonly string[];
  budget: number;
}

// One spec's outcome: its pairs, or why it has none.
type Answer =
  | { readonly kind: "pairs"; readonly pairs: readonly DuplicatePair[] }
  | { readonly kind: "note"; readonly text: string };

// "src/a.ts", "src/a.ts:40" or "src/a.ts:10-40", relative to the root or absolute inside it.
function parseTarget(spec: string, root: CanonicalPath): Target | Skip {
  const match = TARGET_SPEC.exec(spec);
  const location = relativeToRoot(root, match?.[1] ?? "");
  if (location.kind !== "inside") return skip(NOT_IN_PROJECT[location.kind]);
  const file = location.path;
  if (!isWindowedPath(file)) return skip("test path or unsupported file type");
  const from = Number(match?.[2] ?? 1);
  const last = match?.[3] ?? match?.[2];
  const to = last === undefined ? WHOLE_FILE_END : Number(last);
  return from <= to
    ? { kind: "target", file, from, to }
    : skip("empty line range");
}

const skip = (reason: string): Skip => ({
  kind: "skip",
  reason: `skipped (${reason})`,
});

// Yields before every query, so a cancel and other tool calls get through a long run.
async function pairsFor(
  run: Run,
  file: string,
  windows: readonly StoredWindow[]
): Promise<Pair[]> {
  const k = Math.max(MIN_K, run.args.limit * K_PER_LIMIT);
  const hits: Pair[] = [];
  for (const stored of windows) {
    run.signal.throwIfAborted();
    await setImmediate();
    for (const other of run.index.nearest(stored, file, k, run.args.threshold))
      if (!run.prefixes.some((p) => `${other.file}/`.startsWith(p)))
        hits.push({ from: stored.from, to: stored.to, other });
  }
  return merge(hits)
    .sort((a, b) => b.other.score - a.other.score)
    .slice(0, run.args.limit);
}

const note = (text: string): Answer => ({ kind: "note", text });

const pairLine = (pair: DuplicatePair): string =>
  `${pair.file}:${pair.from}-${pair.to} <-> ${pair.otherFile}:${pair.otherFrom}-${pair.otherTo} ${pair.score.toFixed(SCORE_DIGITS)} ${pair.band}`;

async function answerFor(run: Run, spec: string): Promise<Answer> {
  const target = parseTarget(spec, run.root);
  if (target.kind === "skip") return note(`${spec}: ${target.reason}`);
  const windows = run.index.windowsOf(target.file, target.from, target.to);
  if (windows.length === 0)
    return note(
      `${spec}: no duplicate windows (too short, not indexed, or run index_project)`
    );
  if (windows.length > run.budget)
    return note(
      `${spec}: ${skip("this call used its window budget - pass line ranges or fewer files").reason}`
    );
  run.budget -= windows.length;
  const pairs = await pairsFor(run, target.file, windows);
  if (pairs.length === 0)
    return note(`${spec}: no pair at or above ${run.args.threshold}`);
  return {
    kind: "pairs",
    pairs: pairs.map((pair) => {
      const score = Number(pair.other.score.toFixed(SCORE_DIGITS));
      return {
        file: target.file,
        from: pair.from,
        to: pair.to,
        otherFile: pair.other.file,
        otherFrom: pair.other.from,
        otherTo: pair.other.to,
        score,
        band: score >= LIKELY_SCORE ? "likely" : "check",
      };
    }),
  };
}

export async function handleFindDuplicates(
  args: DuplicateArgs,
  ctx: ToolContext
): Promise<McpResponse> {
  const projectPath = validateProjectPath(args.path ?? process.cwd());
  const store = await openIndexedStore(projectPath);
  if (!store)
    return unavailable(
      "not_indexed",
      notIndexed(projectPath, indexProgress(projectPath))
    );
  if (!store.windows.enabled()) return unavailable("off", DUPLICATES_OFF);
  // The queried files must match disk before their windows are compared.
  const sync = await syncBeforeSearch(store, projectPath, ctx);
  if (sync.kind === "ask") return sync.form;
  const notes = sync.note ? [sync.note] : [];
  const prefixes: string[] = [];
  for (const entry of args.exclude) {
    const location = relativeToRoot(projectPath, entry);
    if (location.kind === "inside") prefixes.push(`${location.path}/`);
    else
      notes.push(
        `${entry}: exclude ${skip(NOT_IN_PROJECT[location.kind]).reason}`
      );
  }
  const lines = [...notes];
  const run = {
    root: projectPath,
    index: store.windows,
    args,
    signal: ctx.signal,
    prefixes,
    budget: WINDOW_BUDGET,
  } satisfies Run;
  const pairs: DuplicatePair[] = [];
  let filesWithPairs = 0;
  for (const spec of args.files) {
    const answer = await answerFor(run, spec);
    if (answer.kind === "note") {
      notes.push(answer.text);
      lines.push(answer.text);
      continue;
    }
    pairs.push(...answer.pairs);
    lines.push(...answer.pairs.map(pairLine));
    filesWithPairs++;
  }
  console.error(
    `[dfine-semantic] find_duplicates: ${pairs.length} pairs for ${args.files.length} files in ${projectPath}`
  );
  // Text and notes end alike: some clients show the model only the structured answer.
  const summary = `${pairs.length} pairs in ${filesWithPairs} of ${args.files.length} files. Candidates only: read both ranges, likely pairs first, before merging anything.`;
  notes.push(summary);
  lines.push(summary);
  return structuredResult(lines.join("\n"), {
    status: "ok",
    pairs,
    notes,
  } satisfies DuplicatesOutput);
}

// No pairs to look for: the project has no index, or duplicate search is off for it.
function unavailable(
  status: Exclude<DuplicatesOutput["status"], "ok">,
  text: string
): McpResponse {
  return structuredResult(text, {
    status,
    pairs: [],
    notes: [text],
  } satisfies DuplicatesOutput);
}
