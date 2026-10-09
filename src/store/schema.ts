import type Database from "better-sqlite3";
import { extname } from "node:path";
import { DIMENSIONS } from "../embedding/engine.js";
import { errorMessage } from "../utils/context.js";
import {
  DEFAULT_EXTENSIONS,
  EXTENSIONS_KEY,
  ExtensionListSchema,
} from "../constants.js";

// 2 = stat, chunker and window version per file, chunk parts, extensions on vectors, windows.
// 3 = each window carries its kind: a sliding window or a declaration unit.
const SCHEMA_VERSION = 3;
const KINDLESS_VERSION = 2;
const META_UPSERT = "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)";

// One file_hashes row under the names the reconcile reads.
export interface FileStateRow {
  readonly path: string;
  readonly hash: string;
  readonly mtimeMs: number | null;
  readonly size: number | null;
  readonly chunker: number | null;
  readonly windows: number | null;
}

export interface SearchRow {
  readonly file: string;
  readonly line: number;
  readonly lineEnd: number;
  readonly content: string | null;
  readonly distance: number;
}

// A KNN row with its distance turned into the similarity the tools report.
export type Scored<R extends { readonly distance: number }> = Omit<
  R,
  "distance"
> & { readonly score: number };

// A store without a usable list (empty pre-0.1.4 store, damaged row) syncs the defaults.
export function parseExtensions(value: string | undefined): readonly string[] {
  if (value === undefined) return DEFAULT_EXTENSIONS;
  try {
    const parsed = ExtensionListSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
    console.error(
      "[dfine-semantic] Stored extension list invalid, using defaults"
    );
  } catch (error) {
    console.error(
      `[dfine-semantic] Stored extension list unreadable: ${errorMessage(error)}`
    );
  }
  return DEFAULT_EXTENSIONS;
}

// vec0 cosine distance is 1 - cos, so a similarity score is 1 - distance; score and cut in one place.
export function scored<R extends { readonly distance: number }>(
  rows: readonly R[],
  minScore: number
): Array<Scored<R>> {
  return rows
    .map(({ distance, ...row }) => ({ ...row, score: 1 - distance }))
    .filter((hit) => hit.score >= minScore);
}

// Exactly this vector's bytes, even when it is a view into a larger buffer.
export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

const chunksTable = (name: string): string => `
  CREATE TABLE ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    part INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL
  );`;
// Same name as before 0.1.4: an older server still running sees a healed store and skips its repair.
const CHUNKS_INDEX =
  "CREATE UNIQUE INDEX idx_chunks_unique ON chunks(file_path, line_start, line_end, part);";
const META_TABLE =
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);";
const VEC_TABLE = `
  CREATE VIRTUAL TABLE vec_chunks USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    ext TEXT,
    embedding float[${DIMENSIONS}] distance_metric=cosine
  );`;
// Every window written without a kind, by an older store or an older server, is a sliding window.
const WINDOW_KIND = "kind TEXT NOT NULL DEFAULT 'window'";
// Duplicate-search windows: line ranges here, vectors with their file path in vec_windows.
const WINDOW_TABLES = `
  CREATE TABLE windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    line_from INTEGER NOT NULL,
    line_to INTEGER NOT NULL,
    ${WINDOW_KIND}
  );
  CREATE INDEX idx_windows_file ON windows(file_path);
  CREATE VIRTUAL TABLE vec_windows USING vec0(
    window_id INTEGER PRIMARY KEY,
    file_path TEXT,
    embedding float[${DIMENSIONS}] distance_metric=cosine
  );`;

const FRESH = `
  ${chunksTable("chunks")}
  ${CHUNKS_INDEX}
  CREATE TABLE file_hashes (
    file_path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    last_indexed INTEGER NOT NULL DEFAULT (unixepoch()),
    mtime_ms REAL,
    size INTEGER,
    chunker INTEGER,
    windows INTEGER
  );
  ${META_TABLE}
  ${VEC_TABLE}
  ${WINDOW_TABLES}
`;

// Rebuilds a pre-0.1.4 store once: latest row per range wins, every vector keeps its id and gains its extension.
const LEGACY = `
  ${chunksTable("chunks_v2")}
  INSERT INTO chunks_v2 (id, file_path, line_start, line_end, content)
    SELECT MAX(id), file_path, line_start, line_end, content FROM chunks
    WHERE file_path IN (SELECT file_path FROM file_hashes)
    GROUP BY file_path, line_start, line_end;
  DROP TABLE chunks;
  ALTER TABLE chunks_v2 RENAME TO chunks;
  ${CHUNKS_INDEX}
  ALTER TABLE file_hashes ADD COLUMN mtime_ms REAL;
  ALTER TABLE file_hashes ADD COLUMN size INTEGER;
  ALTER TABLE file_hashes ADD COLUMN chunker INTEGER;
  ALTER TABLE file_hashes ADD COLUMN windows INTEGER;
  ${META_TABLE}
  CREATE TEMP TABLE vec_backup AS SELECT chunk_id, embedding FROM vec_chunks;
  DROP TABLE vec_chunks;
  ${VEC_TABLE}
  INSERT INTO vec_chunks (chunk_id, ext, embedding)
    SELECT b.chunk_id, file_ext(c.file_path), b.embedding
    FROM vec_backup b JOIN chunks c ON c.id = b.chunk_id;
  DROP TABLE vec_backup;
  ${WINDOW_TABLES}
`;

function version(db: Database.Database): number {
  // pragma() is typed unknown; simple: true returns the bare user_version integer.
  return db.pragma("user_version", { simple: true }) as number;
}

// Stores before 0.1.4 kept no extension list: keep exactly the types the store already holds.
function inferExtensions(db: Database.Database): void {
  const extensions = db
    .prepare<[], string>("SELECT DISTINCT file_ext(file_path) FROM file_hashes")
    .pluck()
    .all();
  if (extensions.length === 0) return;
  db.prepare<[string, string]>(META_UPSERT).run(
    EXTENSIONS_KEY,
    JSON.stringify(extensions)
  );
}

// A store without a chunks table is new; one with chunks but no version predates 0.1.4.
function buildSchema(db: Database.Database): void {
  const legacy =
    db
      .prepare<[], number>("SELECT 1 FROM sqlite_master WHERE name = 'chunks'")
      .pluck()
      .get() !== undefined;
  db.exec(legacy ? LEGACY : FRESH);
  if (legacy) inferExtensions(db);
}

export function migrate(db: Database.Database): void {
  if (version(db) >= SCHEMA_VERSION) return;
  db.function("file_ext", { deterministic: true }, (path: unknown) =>
    typeof path === "string" ? extname(path) : null
  );
  const tx = db.transaction(() => {
    // Re-check inside the lock: another process may have migrated meanwhile.
    const current = version(db);
    if (current >= SCHEMA_VERSION) return;
    if (current === KINDLESS_VERSION)
      db.exec(`ALTER TABLE windows ADD COLUMN ${WINDOW_KIND};`);
    else buildSchema(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  // immediate() takes the write lock up front, so two starting processes cannot interleave.
  tx.immediate();
  // The rebuild leaves a WAL as large as the store behind.
  db.pragma("wal_checkpoint(TRUNCATE)");
}

// Prepared once per connection, after migrate(): every statement targets the v2 schema.
export function prepareStatements(db: Database.Database) {
  return {
    deleteVectors: db.prepare<[string]>(
      "DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)"
    ),
    deleteChunks: db.prepare<[string]>(
      "DELETE FROM chunks WHERE file_path = ?"
    ),
    deleteFile: db.prepare<[string]>(
      "DELETE FROM file_hashes WHERE file_path = ?"
    ),
    insertChunk: db.prepare<[string, number, number, number, string]>(
      "INSERT INTO chunks (file_path, line_start, line_end, part, content) VALUES (?, ?, ?, ?, ?)"
    ),
    // last_insert_rowid() in SQL avoids the JS bigint-to-float binding issue.
    insertVector: db.prepare<[string, Buffer]>(
      "INSERT INTO vec_chunks (chunk_id, ext, embedding) VALUES (last_insert_rowid(), ?, ?)"
    ),
    writeFile: db.prepare<
      [string, string, number, number, number, number | null]
    >(
      "INSERT OR REPLACE INTO file_hashes (file_path, content_hash, mtime_ms, size, chunker, windows) VALUES (?, ?, ?, ?, ?, ?)"
    ),
    writeStat: db.prepare<[number, number, string]>(
      "UPDATE file_hashes SET mtime_ms = ?, size = ? WHERE file_path = ?"
    ),
    fileStates: db.prepare<[], FileStateRow>(
      'SELECT file_path AS path, content_hash AS hash, mtime_ms AS "mtimeMs", size, chunker, windows FROM file_hashes'
    ),
    countChunks: db.prepare<[], number>("SELECT COUNT(*) FROM chunks").pluck(),
    readMeta: db
      .prepare<[string], string>("SELECT value FROM meta WHERE key = ?")
      .pluck(),
    writeMeta: db.prepare<[string, string]>(META_UPSERT),
    // ext filters inside the KNN, so k rows of the requested types come back.
    search: db.prepare<[number, Buffer, number, string], SearchRow>(`
      SELECT c.file_path AS file, c.line_start AS line, c.line_end AS "lineEnd",
        CASE WHEN ? THEN c.content END AS content, v.distance
      FROM vec_chunks v JOIN chunks c ON c.id = v.chunk_id
      WHERE v.embedding MATCH ? AND k = ? AND v.ext IN (SELECT value FROM json_each(?))
    `),
  };
}

export type Statements = ReturnType<typeof prepareStatements>;
