import type Database from "better-sqlite3";
import type { CodeWindow, WindowKind } from "../chunking/windows.js";
import type { Embedded } from "../embedding/engine.js";
import { scored, toBlob, type Scored, type Statements } from "./schema.js";
import { WINDOWER_VERSION } from "../constants.js";

const ENABLED_KEY = "duplicates";
// Measured: below 0.95 a declaration unit's pairs added false pairs and found no extra copy.
const UNIT_MIN_SCORE = 0.95;

export interface StoredWindow {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  readonly kind: WindowKind;
}

interface NeighbourRow {
  readonly file: string;
  readonly from: number;
  readonly to: number;
  readonly kind: WindowKind;
  readonly distance: number;
}

export type WindowHit = Scored<NeighbourRow>;

export type EmbeddedWindows = readonly Embedded<CodeWindow>[];

function prepareWindowStatements(db: Database.Database) {
  return {
    insert: db.prepare<[string, number, number, WindowKind]>(
      "INSERT INTO windows (file_path, line_from, line_to, kind) VALUES (?, ?, ?, ?)"
    ),
    // last_insert_rowid() in SQL avoids the JS bigint-to-float binding issue.
    insertVector: db.prepare<[string, Buffer]>(
      "INSERT INTO vec_windows (window_id, file_path, embedding) VALUES (last_insert_rowid(), ?, ?)"
    ),
    deleteVectors: db.prepare<[string]>(
      "DELETE FROM vec_windows WHERE window_id IN (SELECT id FROM windows WHERE file_path = ?)"
    ),
    delete: db.prepare<[string]>("DELETE FROM windows WHERE file_path = ?"),
    mark: db.prepare<[number, string]>(
      "UPDATE file_hashes SET windows = ? WHERE file_path = ?"
    ),
    ofFile: db.prepare<[string, number, number], StoredWindow>(
      'SELECT id, line_from AS "from", line_to AS "to", kind FROM windows WHERE file_path = ? AND line_to >= ? AND line_from <= ? ORDER BY line_from'
    ),
    vector: db
      .prepare<[number], Buffer>(
        "SELECT embedding FROM vec_windows WHERE window_id = ?"
      )
      .pluck(),
    // != filters before k in vec0 0.1.9 (NOT IN only after it), so k neighbours from other files return.
    nearest: db.prepare<[Buffer, number, string], NeighbourRow>(`
      SELECT w.file_path AS file, w.line_from AS "from", w.line_to AS "to", w.kind, v.distance
      FROM vec_windows v JOIN windows w ON w.id = v.window_id
      WHERE v.embedding MATCH ? AND k = ? AND v.file_path != ?
    `),
  };
}

export class WindowIndex {
  private readonly sql: ReturnType<typeof prepareWindowStatements>;

  constructor(
    private readonly db: Database.Database,
    private readonly meta: Pick<Statements, "readMeta" | "writeMeta">
  ) {
    this.sql = prepareWindowStatements(db);
  }

  enabled(): boolean {
    return this.meta.readMeta.get(ENABLED_KEY) === "on";
  }

  // Off deletes every window (SQLite reuses the space later); on lets index_project build them.
  setEnabled(on: boolean) {
    const tx = this.db.transaction(() => {
      this.meta.writeMeta.run(ENABLED_KEY, on ? "on" : "off");
      if (on) return;
      this.clearAll();
      this.db.exec("UPDATE file_hashes SET windows = NULL");
    });
    tx();
    console.error(
      `[dfine-semantic] Duplicate search ${on ? "on" : "off, windows deleted"}`
    );
  }

  clearAll() {
    this.db.exec("DELETE FROM vec_windows; DELETE FROM windows;");
  }

  // Runs inside the caller's transaction, after the caller dropped the file's windows.
  insert(filePath: string, windows: EmbeddedWindows) {
    for (const { item, embedding } of windows) {
      this.sql.insert.run(filePath, item.from, item.to, item.kind);
      this.sql.insertVector.run(filePath, toBlob(embedding));
    }
  }

  // Windows for a file whose chunks are current, as the duplicate opt-in needs.
  rebuild(filePath: string, windows: EmbeddedWindows) {
    const tx = this.db.transaction(() => {
      this.drop(filePath);
      this.insert(filePath, windows);
      this.sql.mark.run(WINDOWER_VERSION, filePath);
    });
    tx();
  }

  drop(filePath: string) {
    this.sql.deleteVectors.run(filePath);
    this.sql.delete.run(filePath);
  }

  windowsOf(filePath: string, from: number, to: number): StoredWindow[] {
    return this.sql.ofFile.all(filePath, from, to);
  }

  // Empty when the window is gone: a sync or another process may replace it between two queries.
  nearest(
    window: StoredWindow,
    filePath: string,
    k: number,
    minScore: number
  ): WindowHit[] {
    const vector = this.sql.vector.get(window.id);
    if (!vector) return [];
    // A unit on either side pairs only with a near-verbatim copy.
    return scored(this.sql.nearest.all(vector, k, filePath), minScore).filter(
      (hit) =>
        (window.kind === "window" && hit.kind === "window") ||
        hit.score >= UNIT_MIN_SCORE
    );
  }
}
