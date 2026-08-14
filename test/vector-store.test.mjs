// Laeuft gegen den Build (tsconfig rootDir ist ./src, Tests bleiben aussen vor).
// Kein Embedding-Modell noetig: die Vektoren sind synthetisch, geprueft wird SQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { VectorStore } from "../build/store/vector-store.js";
import { DIMENSIONS } from "../build/embedding/engine.js";

const tmp = mkdtempSync(join(tmpdir(), "dfine-semantic-test-"));

// Schema vor dem Fix: einfacher Pfad-Index, kein Unique-Constraint.
const LEGACY_SCHEMA = `
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    chunk_type TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX idx_chunks_file ON chunks(file_path);
  CREATE TABLE file_hashes (
    file_path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    last_indexed INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE VIRTUAL TABLE vec_chunks USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    embedding float[${DIMENSIONS}] distance_metric=cosine
  );
`;

let dbCounter = 0;
function legacyDb() {
  const db = new Database(join(tmp, `store-${dbCounter++}.db`));
  sqliteVec.load(db);
  db.exec(LEGACY_SCHEMA);
  return db;
}

function vec(seed) {
  const v = new Float32Array(DIMENSIONS);
  v.fill(seed);
  return Buffer.from(v.buffer);
}

function batch(count) {
  return Array.from({ length: count }, (_, i) => ({
    chunk: {
      lineStart: i * 10 + 1,
      lineEnd: i * 10 + 9,
      content: `chunk ${i}`,
      chunkType: "block",
    },
    embedding: new Float32Array(DIMENSIONS).fill(i + 1),
  }));
}

const count = (db, sql) => db.prepare(sql).get().c;

test("repair() entfernt Duplikate und Chunks ohne Hash-Eintrag", () => {
  const db = legacyDb();
  const insert = db.prepare(
    "INSERT INTO chunks (file_path, line_start, line_end, content, content_hash, chunk_type) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertVec = db.prepare(
    "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (last_insert_rowid(), ?)"
  );
  db.prepare(
    "INSERT INTO file_hashes (file_path, content_hash) VALUES (?, ?)"
  ).run("a.ts", "hash-a");

  // a.ts doppelt geschrieben — der Schaden aus zwei ueberlappenden Laeufen.
  for (const pass of [1, 2]) {
    for (const [s, e] of [
      [1, 10],
      [11, 20],
    ]) {
      insert.run("a.ts", s, e, `a ${s}`, "hash-a", "block");
      insertVec.run(vec(pass));
    }
  }
  // b.ts hat Chunks, aber keine file_hashes-Zeile — Abbruch vor setFileHash.
  insert.run("b.ts", 1, 5, "b 1", "hash-b", "block");
  insertVec.run(vec(9));

  assert.equal(count(db, "SELECT COUNT(*) c FROM chunks"), 5);

  new VectorStore(db, "/fake/project");

  assert.equal(
    count(db, "SELECT COUNT(*) c FROM chunks WHERE file_path = 'a.ts'"),
    2,
    "a.ts muss auf einen Satz Chunks zusammenfallen"
  );
  assert.equal(
    count(db, "SELECT COUNT(*) c FROM chunks WHERE file_path = 'b.ts'"),
    0,
    "Chunks ohne Hash-Eintrag muessen verschwinden"
  );
  assert.equal(
    count(db, "SELECT COUNT(*) c FROM vec_chunks_rowids"),
    2,
    "die Vektoren der entfernten Chunks duerfen nicht liegen bleiben"
  );
  assert.equal(
    count(
      db,
      "SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_chunks_unique'"
    ),
    1
  );
  assert.equal(
    count(
      db,
      "SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_chunks_file'"
    ),
    0,
    "der vom Unique-Index gedeckte Pfad-Index muss weg sein"
  );
  db.close();
});

test("Unique-Index blockt eine zweite identische Chunk-Zeile", () => {
  const db = legacyDb();
  new VectorStore(db, "/fake/project");
  const insert = db.prepare(
    "INSERT INTO chunks (file_path, line_start, line_end, content, content_hash, chunk_type) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insert.run("a.ts", 1, 10, "x", "h", "block");
  assert.throws(
    () => insert.run("a.ts", 1, 10, "x", "h", "block"),
    /UNIQUE constraint failed/
  );
  db.close();
});

test("replaceFileChunks bleibt bei doppeltem Aufruf idempotent", () => {
  const db = legacyDb();
  const store = new VectorStore(db, "/fake/project");
  store.replaceFileChunks("a.ts", "hash-1", batch(3));
  store.replaceFileChunks("a.ts", "hash-1", batch(3));

  assert.equal(count(db, "SELECT COUNT(*) c FROM chunks"), 3);
  assert.equal(count(db, "SELECT COUNT(*) c FROM vec_chunks_rowids"), 3);
  assert.equal(store.getFileHash("a.ts"), "hash-1");
  db.close();
});

test("replaceFileChunks ersetzt bei geaendertem Inhalt vollstaendig", () => {
  const db = legacyDb();
  const store = new VectorStore(db, "/fake/project");
  store.replaceFileChunks("a.ts", "hash-1", batch(4));
  store.replaceFileChunks("a.ts", "hash-2", batch(2));

  assert.equal(count(db, "SELECT COUNT(*) c FROM chunks"), 2);
  assert.equal(count(db, "SELECT COUNT(*) c FROM vec_chunks_rowids"), 2);
  assert.equal(
    count(db, "SELECT COUNT(*) c FROM chunks WHERE content_hash = 'hash-1'"),
    0,
    "Chunks der Vorgaenger-Version duerfen nicht ueberleben"
  );
  assert.equal(store.getFileHash("a.ts"), "hash-2");
  db.close();
});

test("deleteFileChunks raeumt Chunks, Vektoren und Hash gemeinsam", () => {
  const db = legacyDb();
  const store = new VectorStore(db, "/fake/project");
  store.replaceFileChunks("a.ts", "hash-1", batch(2));
  store.replaceFileChunks("b.ts", "hash-2", batch(2));
  store.deleteFileChunks("a.ts");

  assert.equal(count(db, "SELECT COUNT(*) c FROM chunks"), 2);
  assert.equal(count(db, "SELECT COUNT(*) c FROM vec_chunks_rowids"), 2);
  assert.equal(store.getFileHash("a.ts"), null);
  assert.equal(store.getFileHash("b.ts"), "hash-2");
  db.close();
});

test("clear() entfernt auch Vektoren ohne zugehoerigen Chunk", () => {
  const db = legacyDb();
  const store = new VectorStore(db, "/fake/project");
  store.replaceFileChunks("a.ts", "hash-1", batch(2));
  // Verwaiste Vektorzeile: Chunk weg, Vektor bleibt — was ein gefiltertes
  // Delete nicht mehr erwischen wuerde.
  db.exec("DELETE FROM chunks WHERE line_start = 1");
  assert.equal(count(db, "SELECT COUNT(*) c FROM vec_chunks_rowids"), 2);

  store.clear();

  assert.equal(count(db, "SELECT COUNT(*) c FROM chunks"), 0);
  assert.equal(count(db, "SELECT COUNT(*) c FROM file_hashes"), 0);
  assert.equal(
    count(db, "SELECT COUNT(*) c FROM vec_chunks_rowids"),
    0,
    "clear() muss den Store restlos leeren"
  );
  db.close();
});

test("getStats zaehlt nach der Reparatur die bereinigten Mengen", () => {
  const db = legacyDb();
  const store = new VectorStore(db, "/fake/project");
  store.replaceFileChunks("a.ts", "hash-1", batch(3));
  store.replaceFileChunks("b.ts", "hash-2", batch(1));
  assert.deepEqual(store.getStats(), { totalChunks: 4, totalFiles: 2 });
  db.close();
});

process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
