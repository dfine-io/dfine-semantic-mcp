import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chunkCode } from "../chunking/chunker.js";
import { embedBatch } from "../embedding/engine.js";
import {
  type PendingChunk,
  type VectorStore,
  type FilePurgeStore,
  type FileIndexStore,
} from "../store/vector-store.js";
import { scanChangedFiles, type ChangedFile } from "../utils/file-scanner.js";
import { isWithinRoot } from "../utils/path-guard.js";
import { DEFAULT_EXTENSIONS, MAX_FILE_SIZE } from "../constants.js";

const SYNC_COOLDOWN_MS = 30_000;
const MAX_SYNC_FILES = 1_000;

const lastSyncTime = new Map<string, number>();
const syncInFlight = new Map<string, Promise<string | null>>();

export async function reindexFile(
  store: FileIndexStore,
  relativePath: string,
  content: string,
  precomputedHash?: string
): Promise<boolean> {
  const hash =
    precomputedHash ?? createHash("sha256").update(content).digest("hex");
  if (store.getFileHash(relativePath) === hash) return false;

  const codeChunks = chunkCode(content, relativePath);
  const embeddings = await embedBatch(codeChunks.map((c) => c.content));
  const batch: Array<{
    chunk: PendingChunk;
    embedding: Float32Array;
  }> = [];
  for (const chunk of codeChunks) {
    const embedding = embeddings.shift();
    if (!embedding) break;
    batch.push({
      chunk: {
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        content: chunk.content,
        chunkType: chunk.type,
      },
      embedding,
    });
  }
  // Ab hier kein await mehr: der Schreibblock ist eine einzige Transaktion.
  store.replaceFileChunks(relativePath, hash, batch);
  return true;
}

export async function lazySync(
  store: VectorStore,
  projectPath: string
): Promise<string | null> {
  const lastSync = lastSyncTime.get(projectPath) ?? 0;
  if (Date.now() - lastSync < SYNC_COOLDOWN_MS) return null;

  // Concurrency: deduplicate parallel searches triggering sync simultaneously
  const existing = syncInFlight.get(projectPath);
  if (existing) return existing;

  const syncPromise = executeLazySync(store, projectPath);
  syncInFlight.set(projectPath, syncPromise);
  try {
    return await syncPromise;
  } finally {
    syncInFlight.delete(projectPath);
  }
}

async function applyChanges(
  store: VectorStore,
  projectPath: string,
  changes: readonly ChangedFile[]
): Promise<{ synced: number; deleted: number }> {
  let synced = 0;
  let deleted = 0;
  for (const change of changes) {
    if (change.status === "deleted") {
      store.deleteFileChunks(change.relativePath);
      deleted++;
      continue;
    }
    const absPath = join(projectPath, change.relativePath);
    // Symlink guard: a tracked link must not read outside the project root.
    if (!isWithinRoot(projectPath, absPath)) continue;
    try {
      const stat = statSync(absPath);
      if (stat.size > MAX_FILE_SIZE) continue;
      const content = readFileSync(absPath, "utf-8");
      const changed = await reindexFile(store, change.relativePath, content);
      if (changed) synced++;
    } catch {
      /* skip unreadable */
    }
  }
  return { synced, deleted };
}

// Reconcile: purge stored paths that no longer exist on disk (committed deletes)
function purgeMissing(store: FilePurgeStore, projectPath: string): number {
  let deleted = 0;
  for (const filePath of store.getAllFilePaths()) {
    if (!existsSync(join(projectPath, filePath))) {
      store.deleteFileChunks(filePath);
      deleted++;
    }
  }
  return deleted;
}

async function executeLazySync(
  store: VectorStore,
  projectPath: string
): Promise<string | null> {
  const changes = scanChangedFiles(projectPath, DEFAULT_EXTENSIONS);
  lastSyncTime.set(projectPath, Date.now());
  if (changes.length === 0) return null;

  const capped = changes.length > MAX_SYNC_FILES;
  const toSync = capped ? changes.slice(0, MAX_SYNC_FILES) : changes;

  const { synced, deleted: deletedInSync } = await applyChanges(
    store,
    projectPath,
    toSync
  );
  const deleted = deletedInSync + purgeMissing(store, projectPath);

  if (synced === 0 && deleted === 0 && !capped) return null;
  const cappedNote = capped
    ? ` (capped at ${MAX_SYNC_FILES}/${changes.length} — remaining will sync on next search)`
    : "";
  const msg = `[sync] Auto-synced ${synced} modified, ${deleted} deleted files.${cappedNote}`;
  console.error(`[dfine-semantic] ${msg}`);
  return msg;
}
