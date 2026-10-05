import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createHash } from "node:crypto";
import { basename, extname, join } from "node:path";
import { access, mkdir } from "node:fs/promises";
import type { Chunk } from "../chunking/chunker.js";
import type { Embedded } from "../embedding/engine.js";
import type { ProjectFile } from "../utils/file-scanner.js";
import type { CanonicalPath } from "../utils/path-guard.js";
import {
  migrate,
  parseExtensions,
  prepareStatements,
  scored,
  toBlob,
  type FileStateRow,
  type Scored,
  type SearchRow,
  type Statements,
} from "./schema.js";
import { WindowIndex, type EmbeddedWindows } from "./window-index.js";
import {
  CHUNKER_VERSION,
  DATA_DIR,
  EXTENSIONS_KEY,
  WINDOWER_VERSION,
} from "../constants.js";

const DB_HASH_PREFIX_LENGTH = 12;
// A large store migrates for seconds; other processes wait instead of failing with SQLITE_BUSY.
const BUSY_TIMEOUT_MS = 30_000;

// Singleton pool: one DB connection per project (process lifetime)
const storePool = new Map<CanonicalPath, VectorStore>();

// The stat comes from the listing, the hash from the content read for this write.
export interface FileRecord extends Pick<ProjectFile, "mtimeMs" | "size"> {
  readonly hash: string;
}

type FileState = Omit<FileStateRow, "path">;

export type SearchHit = Scored<SearchRow>;

interface SearchOptions {
  readonly limit: number;
  readonly threshold: number;
  readonly extensions: readonly string[];
  readonly withContent: boolean;
}

interface SearchPage {
  readonly results: readonly SearchHit[];
  readonly hasMore: boolean;
}

export function getDbPath(projectPath: CanonicalPath): string {
  const hash = createHash("sha256")
    .update(projectPath)
    .digest("hex")
    .slice(0, DB_HASH_PREFIX_LENGTH);
  return join(DATA_DIR, `${basename(projectPath)}-${hash}.db`);
}

// A pooled store stays usable after its file was deleted, so the pool counts as existing.
export async function storeExists(
  projectPath: CanonicalPath
): Promise<boolean> {
  if (storePool.has(projectPath)) return true;
  return access(getDbPath(projectPath)).then(
    () => true,
    () => false
  );
}

export async function openStore(
  projectPath: CanonicalPath
): Promise<VectorStore> {
  await mkdir(DATA_DIR, { recursive: true });
  // No await between this check and the pool write, so two callers share one connection.
  const existing = storePool.get(projectPath);
  if (existing) return existing;
  const db = new Database(getDbPath(projectPath), { timeout: BUSY_TIMEOUT_MS });
  try {
    sqliteVec.load(db);
    db.pragma("journal_mode = WAL"); // Non-blocking reads during writes
    db.pragma("synchronous = NORMAL"); // Faster writes, crash-safe with WAL
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const store = new VectorStore(db);
  storePool.set(projectPath, store);
  return store;
}

// Searches need chunks; opening a never-indexed path would create an empty store index_status lists.
export async function openIndexedStore(
  projectPath: CanonicalPath
): Promise<VectorStore | null> {
  if (!(await storeExists(projectPath))) return null;
  const store = await openStore(projectPath);
  return store.countChunks() > 0 ? store : null;
}

// Cleanup: close all DB connections on process exit
process.on("exit", () => {
  for (const store of storePool.values()) store.close();
});

class VectorStore {
  private readonly sql: Statements;
  readonly windows: WindowIndex;

  constructor(private readonly db: Database.Database) {
    this.sql = prepareStatements(db);
    this.windows = new WindowIndex(db, this.sql);
  }

  private dropChunks(filePath: string) {
    this.sql.deleteVectors.run(filePath);
    this.sql.deleteChunks.run(filePath);
    this.windows.drop(filePath);
  }

  // Delete, insert and file record in one transaction: a cancel leaves the file old or new.
  replaceFileChunks(
    filePath: string,
    file: FileRecord,
    chunks: readonly Embedded<Chunk>[],
    windows: EmbeddedWindows | null
  ) {
    const ext = extname(filePath);
    const tx = this.db.transaction(() => {
      this.dropChunks(filePath);
      for (const { item, embedding } of chunks) {
        this.sql.insertChunk.run(
          filePath,
          item.lineStart,
          item.lineEnd,
          item.part,
          item.content
        );
        this.sql.insertVector.run(ext, toBlob(embedding));
      }
      if (windows) this.windows.insert(filePath, windows);
      this.sql.writeFile.run(
        filePath,
        file.hash,
        file.mtimeMs,
        file.size,
        CHUNKER_VERSION,
        windows ? WINDOWER_VERSION : null
      );
    });
    tx();
  }

  // Same content, new stat (touch, checkout): store the stats so the next sync skips the reads.
  setFileStats(files: readonly ProjectFile[]) {
    const tx = this.db.transaction(() => {
      for (const file of files)
        this.sql.writeStat.run(file.mtimeMs, file.size, file.relativePath);
    });
    tx();
  }

  deleteFiles(filePaths: readonly string[]) {
    const tx = this.db.transaction(() => {
      for (const filePath of filePaths) {
        this.dropChunks(filePath);
        this.sql.deleteFile.run(filePath);
      }
    });
    tx();
  }

  getFileStates(): Map<string, FileState> {
    return new Map(
      this.sql.fileStates.all().map(({ path, ...state }) => [path, state])
    );
  }

  getIndexedExtensions(): readonly string[] {
    return parseExtensions(this.sql.readMeta.get(EXTENSIONS_KEY));
  }

  setIndexedExtensions(extensions: readonly string[]) {
    this.sql.writeMeta.run(EXTENSIONS_KEY, JSON.stringify(extensions));
  }

  // One row past the limit tells whether more matches exist.
  search(queryEmbedding: Float32Array, options: SearchOptions): SearchPage {
    const rows = this.sql.search.all(
      options.withContent ? 1 : 0,
      toBlob(queryEmbedding),
      options.limit + 1,
      JSON.stringify(options.extensions)
    );
    const hits = scored(rows, options.threshold);
    return {
      results: hits.slice(0, options.limit),
      hasMore: hits.length > options.limit,
    };
  }

  countChunks(): number {
    return this.sql.countChunks.get() ?? 0;
  }

  // Reset through the pooled connection: a deleted .db stays writable while the pool holds it.
  clear() {
    const tx = this.db.transaction(() => {
      // Unqualified, so orphaned vectors without a chunk row go too.
      this.db.exec(`
        DELETE FROM vec_chunks;
        DELETE FROM chunks;
        DELETE FROM file_hashes;
      `);
      this.windows.clearAll();
    });
    tx();
  }

  close() {
    this.db.close();
  }
}

// Narrow views: each flow sees only the store methods it uses.
export type PlanStore = Pick<VectorStore, "getFileStates" | "setFileStats">;
export type ApplyStore = Pick<VectorStore, "replaceFileChunks"> & {
  readonly windows: Pick<WindowIndex, "rebuild">;
};
export type SyncStore = PlanStore &
  ApplyStore &
  Pick<VectorStore, "deleteFiles" | "getIndexedExtensions"> & {
    readonly windows: Pick<WindowIndex, "enabled">;
  };
