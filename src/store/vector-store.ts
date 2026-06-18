import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { DIMENSIONS } from "../embedding/engine.js";
import { MS_PER_SECOND } from "../constants.js";

export const DATA_DIR =
  process.env["SEMANTIC_DATA_DIR"] ?? join(homedir(), ".dfine-semantic");

const SNIPPET_MAX_LENGTH = 500;
const DB_HASH_PREFIX_LENGTH = 12;

// Singleton pool: one DB connection per project (process lifetime)
const storePool = new Map<string, VectorStore>();

export interface ChunkRecord {
  id: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  contentHash: string;
  chunkType: string;
}

interface SearchResult {
  file: string;
  line: number;
  lineEnd: number;
  snippet: string;
  content: string;
  score: number;
  chunkType: string;
}

function getDbPath(projectPath: string): string {
  const hash = createHash("sha256")
    .update(projectPath)
    .digest("hex")
    .slice(0, DB_HASH_PREFIX_LENGTH);
  const name = projectPath.split("/").pop() ?? "unknown";
  return join(DATA_DIR, `${name}-${hash}.db`);
}

export function openStore(projectPath: string): VectorStore {
  const existing = storePool.get(projectPath);
  if (existing) return existing;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(getDbPath(projectPath));
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL"); // Non-blocking reads during writes
  db.pragma("synchronous = NORMAL"); // Faster writes, crash-safe with WAL
  const store = new VectorStore(db, projectPath);
  storePool.set(projectPath, store);
  return store;
}

// Cleanup: close all DB connections on process exit
process.on("exit", () => {
  for (const store of storePool.values()) store.close();
});

export class VectorStore {
  constructor(
    private db: Database.Database,
    public projectPath: string
  ) {
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        chunk_type TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
      CREATE TABLE IF NOT EXISTS file_hashes (
        file_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        last_indexed INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding float[${DIMENSIONS}] distance_metric=cosine
      );
    `);
  }

  // Batch inserts in a transaction for 10-50x faster bulk writes
  insertChunks(
    chunks: ReadonlyArray<{
      chunk: Omit<ChunkRecord, "id">;
      embedding: Float32Array;
    }>
  ) {
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (file_path, line_start, line_end, content, content_hash, chunk_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    // Use last_insert_rowid() in SQL to avoid JS bigint→float binding issue
    const insertVec = this.db.prepare(
      `INSERT INTO vec_chunks (chunk_id, embedding) VALUES (last_insert_rowid(), ?)`
    );
    const tx = this.db.transaction(() => {
      for (const { chunk, embedding } of chunks) {
        insertChunk.run(
          chunk.filePath,
          chunk.lineStart,
          chunk.lineEnd,
          chunk.content,
          chunk.contentHash,
          chunk.chunkType
        );
        insertVec.run(Buffer.from(embedding.buffer));
      }
    });
    tx();
  }

  search(
    queryEmbedding: Float32Array,
    limit: number,
    threshold: number
  ): SearchResult[] {
    // sqlite-vec cosine distance: 0 = identical, 2 = opposite
    // cosine_similarity = 1 - (cosine_distance / 2)
    const rows = this.db
      .prepare(
        `
      SELECT c.file_path, c.line_start, c.line_end, c.content, c.chunk_type, v.distance
      FROM vec_chunks v
      JOIN chunks c ON c.id = v.chunk_id
      WHERE v.embedding MATCH ?
        AND k = ?
    `
      )
      .all(Buffer.from(queryEmbedding.buffer), limit) as Array<{
      file_path: string;
      line_start: number;
      line_end: number;
      content: string;
      chunk_type: string;
      distance: number;
    }>;

    return rows
      .filter((r) => 1 - r.distance >= threshold)
      .map((r) => ({
        file: r.file_path,
        line: r.line_start,
        lineEnd: r.line_end,
        snippet: r.content.slice(0, SNIPPET_MAX_LENGTH),
        content: r.content,
        score: Math.round((1 - r.distance) * MS_PER_SECOND) / MS_PER_SECOND,
        chunkType: r.chunk_type,
      }));
  }

  getFileHash(filePath: string): string | null {
    const row = this.db
      .prepare("SELECT content_hash FROM file_hashes WHERE file_path = ?")
      .get(filePath) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  setFileHash(filePath: string, hash: string) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO file_hashes (file_path, content_hash, last_indexed) VALUES (?, ?, unixepoch())"
      )
      .run(filePath, hash);
  }

  deleteFileChunks(filePath: string) {
    this.db
      .prepare(
        "DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)"
      )
      .run(filePath);
    this.db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
    this.db
      .prepare("DELETE FROM file_hashes WHERE file_path = ?")
      .run(filePath);
  }

  getAllFilePaths(): string[] {
    const rows = this.db
      .prepare("SELECT file_path FROM file_hashes")
      .all() as Array<{ file_path: string }>;
    return rows.map((r) => r.file_path);
  }

  getStats() {
    const chunks = this.db
      .prepare("SELECT COUNT(*) as count FROM chunks")
      .get() as { count: number };
    const files = this.db
      .prepare("SELECT COUNT(*) as count FROM file_hashes")
      .get() as { count: number };
    return { totalChunks: chunks.count, totalFiles: files.count };
  }

  close() {
    this.db.close();
  }
}

// Narrow view for callers that only reconcile stored paths (purge flows).
export type FilePurgeStore = Pick<
  VectorStore,
  "getAllFilePaths" | "deleteFileChunks"
>;
