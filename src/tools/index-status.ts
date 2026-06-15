import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { DATA_DIR } from "../store/vector-store.js";
import { BYTES_PER_MB, type McpResponse } from "../constants.js";

interface StatusArgs {
  path?: string;
}

export async function handleIndexStatus(
  args: StatusArgs
): Promise<McpResponse> {
  if (!existsSync(DATA_DIR)) {
    return {
      content: [{ type: "text" as const, text: "No projects indexed yet." }],
    };
  }

  const projects: Array<{
    name: string;
    chunks: number;
    files: number;
    dbSizeMb: string;
  }> = [];
  const dbFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith(".db"));

  for (const dbFile of dbFiles) {
    const dbPath = join(DATA_DIR, dbFile);
    const size = statSync(dbPath).size;
    const db = new Database(dbPath);
    sqliteVec.load(db);
    const chunks = db.prepare("SELECT COUNT(*) as c FROM chunks").get() as {
      c: number;
    };
    const files = db.prepare("SELECT COUNT(*) as c FROM file_hashes").get() as {
      c: number;
    };
    db.close();
    projects.push({
      name: dbFile.replace(".db", ""),
      chunks: chunks.c,
      files: files.c,
      dbSizeMb: (size / BYTES_PER_MB).toFixed(2),
    });
  }

  // Filter by path if provided (match db filename pattern: name-hash.db)
  const pathSuffix = args.path?.split("/").pop() ?? "";
  const filtered = args.path
    ? projects.filter((p) => p.name.startsWith(pathSuffix))
    : projects;

  const text =
    filtered.length === 0
      ? "No projects indexed yet."
      : filtered
          .map(
            (p) =>
              `${p.name}: ${p.files} files, ${p.chunks} chunks, ${p.dbSizeMb}MB`
          )
          .join("\n");
  return { content: [{ type: "text" as const, text }] };
}
