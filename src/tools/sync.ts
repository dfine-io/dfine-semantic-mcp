import { createHash } from "node:crypto";
import { chunkCode, type Chunk } from "../chunking/chunker.js";
import {
  extractWindows,
  isWindowedPath,
  type CodeWindow,
} from "../chunking/windows.js";
import { embedTexts, type Embedded } from "../embedding/engine.js";
import type {
  ApplyStore,
  FileRecord,
  PlanStore,
  SyncStore,
} from "../store/vector-store.js";
import {
  listProjectFiles,
  readProjectFile,
  type ProjectFile,
} from "../utils/file-scanner.js";
import type { CanonicalPath } from "../utils/path-guard.js";
import { errorMessage, type ToolContext } from "../utils/context.js";
import { activeJob, withJob } from "./jobs.js";
import {
  chooseSync,
  filesFor,
  syncNote,
  type ApplyResult,
  type AskForm,
  type ReconcilePlan,
  type WindowMode,
} from "./sync-prompt.js";
import { CHUNKER_VERSION, WINDOWER_VERSION } from "../constants.js";

// Files per round: enough chunks to fill sorted batches, few enough to report progress often.
const FILES_PER_ROUND = 32;
// Parallel reads while sorting files: bounded, so a big checkout cannot exhaust file handles.
const HASH_CONCURRENCY = 32;

type ApplyLabel = "Indexed" | "Windowed" | "Synced";

interface ApplyOptions {
  readonly ctx: ToolContext;
  readonly label: ApplyLabel;
  readonly windows: WindowMode;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function hashAll(
  projectPath: CanonicalPath,
  files: readonly ProjectFile[]
): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>();
  for (let start = 0; start < files.length; start += HASH_CONCURRENCY) {
    const slice = files.slice(start, start + HASH_CONCURRENCY);
    const entries = await Promise.all(
      slice.map(async (file) => {
        const content = await readProjectFile(projectPath, file.relativePath);
        return [
          file.relativePath,
          content === null ? null : sha256(content),
        ] as const;
      })
    );
    for (const [path, hash] of entries) hashes.set(path, hash);
  }
  return hashes;
}

// Reads only files whose stat changed; touch or checkout without new content just updates the stat.
export async function planReconcile(
  store: PlanStore,
  projectPath: CanonicalPath,
  files: readonly ProjectFile[],
  windows: boolean
): Promise<ReconcilePlan> {
  const states = store.getFileStates();
  const statChanged = files.filter((file) => {
    const state = states.get(file.relativePath);
    return (
      state !== undefined &&
      (state.mtimeMs !== file.mtimeMs || state.size !== file.size)
    );
  });
  const hashes = await hashAll(projectPath, statChanged);
  const changed: ProjectFile[] = [];
  const stale: ProjectFile[] = [];
  const unwindowed: ProjectFile[] = [];
  const touched: ProjectFile[] = [];
  let unchanged = 0;
  for (const file of files) {
    const state = states.get(file.relativePath);
    if (!state) {
      changed.push(file);
      continue;
    }
    if (hashes.has(file.relativePath)) {
      if (hashes.get(file.relativePath) !== state.hash) {
        changed.push(file);
        continue;
      }
      touched.push(file);
    }
    if (state.chunker !== CHUNKER_VERSION) stale.push(file);
    // Only windowed types get windows: any other file would stay "missing" forever.
    else if (
      windows &&
      isWindowedPath(file.relativePath) &&
      state.windows !== WINDOWER_VERSION
    )
      unwindowed.push(file);
    else unchanged++;
  }
  store.setFileStats(touched);
  const listed = new Set(files.map((file) => file.relativePath));
  const purge = [...states.keys()].filter((path) => !listed.has(path));
  const mode = windows ? "with" : "none";
  return { changed, stale, unwindowed, purge, unchanged, mode };
}

interface PreparedFile {
  readonly file: ProjectFile;
  // null in "only" mode: the chunks and the file record stay as they are.
  readonly record: FileRecord | null;
  readonly chunks: readonly Chunk[];
  readonly windows: readonly CodeWindow[];
}

async function prepareFile(
  projectPath: CanonicalPath,
  file: ProjectFile,
  mode: WindowMode
): Promise<PreparedFile | null> {
  const content = await readProjectFile(projectPath, file.relativePath);
  if (content === null) return null;
  const only = mode === "only";
  // Files outside the windowed types get an empty set, so they count as current.
  const windowed = mode !== "none" && isWindowedPath(file.relativePath);
  return {
    file,
    record: only
      ? null
      : { hash: sha256(content), mtimeMs: file.mtimeMs, size: file.size },
    chunks: only ? [] : chunkCode(content),
    windows: windowed ? extractWindows(content) : [],
  };
}

function pairUp<T>(
  items: readonly T[],
  vectors: readonly Float32Array[],
  start: number,
  path: string
): Array<Embedded<T>> {
  return items.map((item, i) => {
    const embedding = vectors[start + i];
    if (!embedding) throw new Error(`No vector for ${path}`);
    return { item, embedding };
  });
}

// Reads each file right before embedding it; each file is written in its own transaction.
export async function applyFiles(
  store: ApplyStore,
  projectPath: CanonicalPath,
  files: readonly ProjectFile[],
  options: ApplyOptions
): Promise<ApplyResult> {
  const { ctx } = options;
  let indexed = 0;
  try {
    for (let start = 0; start < files.length; start += FILES_PER_ROUND) {
      const round = files.slice(start, start + FILES_PER_ROUND);
      const prepared = (
        await Promise.all(
          round.map((file) => prepareFile(projectPath, file, options.windows))
        )
      ).filter((entry): entry is PreparedFile => entry !== null);
      const texts = prepared.flatMap((entry) => [
        ...entry.chunks.map((chunk) => chunk.content),
        ...entry.windows.map((w) => w.text),
      ]);
      const vectors = await embedTexts(texts, ctx.signal);
      let next = 0;
      for (const entry of prepared) {
        const path = entry.file.relativePath;
        const chunks = pairUp(entry.chunks, vectors, next, path);
        next += entry.chunks.length;
        const windows = pairUp(entry.windows, vectors, next, path);
        next += entry.windows.length;
        if (entry.record)
          store.replaceFileChunks(
            path,
            entry.record,
            chunks,
            options.windows === "with" ? windows : null
          );
        else store.windows.rebuild(path, windows);
        indexed++;
      }
      const done = start + round.length;
      const message = `${options.label} ${done}/${files.length} files`;
      console.error(`[dfine-semantic] ${message}`);
      await ctx.progress(done, files.length, message);
    }
  } catch (error) {
    if (ctx.signal.aborted) return { indexed, cancelled: true };
    throw error;
  }
  return { indexed, cancelled: false };
}

// A search's sync ends in a note for its answer, or in a form the client shows before the retry.
export type SyncOutcome =
  { readonly kind: "note"; readonly note: string | null } | AskForm;

const note = (text: string | null): SyncOutcome => ({
  kind: "note",
  note: text,
});

async function runSync(
  store: SyncStore,
  projectPath: CanonicalPath,
  ctx: ToolContext
): Promise<SyncOutcome> {
  try {
    const files = await listProjectFiles(
      projectPath,
      store.getIndexedExtensions()
    );
    const plan = await planReconcile(
      store,
      projectPath,
      files,
      store.windows.enabled()
    );
    store.deleteFiles(plan.purge);
    const decision = chooseSync(projectPath, plan, ctx);
    if (decision.kind === "ask") return decision;
    const result = await applyFiles(
      store,
      projectPath,
      filesFor(plan, decision.choice),
      {
        ctx,
        label: "Synced",
        windows: plan.mode,
      }
    );
    return note(syncNote(plan, decision.choice, result));
  } catch (error) {
    // A failed sync never blocks the search: it answers from the current index.
    const message = errorMessage(error);
    console.error(`[dfine-semantic] Sync stopped: ${message}`);
    return note(`[sync] Stopped, searching the current index: ${message}`);
  }
}

// Search path: bring the index up to date first, or say why it is not.
export async function syncBeforeSearch(
  store: SyncStore,
  projectPath: CanonicalPath,
  ctx: ToolContext
): Promise<SyncOutcome> {
  const job = activeJob(projectPath);
  if (job?.kind === "index")
    return note(
      `[sync] index_project is running (${job.progress.done}/${job.progress.total} files); results may lag.`
    );
  if (job?.kind === "sync")
    return note(
      "[sync] Another search is syncing this project; results may lag."
    );
  const run = runSync(store, projectPath, ctx);
  return withJob(projectPath, { kind: "sync", run }, () => run);
}
