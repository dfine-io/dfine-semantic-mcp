import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { getDbPath } from "../store/vector-store.js";
import { validateProjectPath } from "../utils/path-guard.js";
import { errorMessage, textResult } from "../utils/context.js";
import { BYTES_PER_MB, DATA_DIR, type McpResponse } from "../constants.js";

interface StatusArgs {
  readonly path?: string;
}

interface StatusRow {
  readonly chunks: number;
  readonly files: number;
}

// Plain counts need no sqlite-vec; a broken or foreign .db reports itself instead of failing the list.
async function describe(fileName: string): Promise<string> {
  const name = fileName.replace(/\.db$/, "");
  // Stores live only in DATA_DIR; joining here keeps stat off a raw caller value (dlint fs-path).
  const dbPath = join(DATA_DIR, fileName);
  let db: Database.Database | null = null;
  try {
    const sizeMb = ((await stat(dbPath)).size / BYTES_PER_MB).toFixed(2);
    db = new Database(dbPath, { fileMustExist: true });
    const row = db
      .prepare<[], StatusRow>(
        "SELECT (SELECT COUNT(*) FROM chunks) AS chunks, (SELECT COUNT(*) FROM file_hashes) AS files"
      )
      .get();
    if (!row) throw new Error("the store returned no counts");
    return `${name}: ${row.files} files, ${row.chunks} chunks, ${sizeMb}MB`;
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[dfine-semantic] Unreadable store ${name}: ${message}`);
    return `${name}: unreadable (${message})`;
  } finally {
    db?.close();
  }
}

// No data folder yet means nothing was indexed; every other read error surfaces.
async function storeFiles(): Promise<string[]> {
  try {
    return (await readdir(DATA_DIR)).filter((file) => file.endsWith(".db"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

export async function handleIndexStatus(
  args: StatusArgs
): Promise<McpResponse> {
  const dbFiles = await storeFiles();
  if (args.path) {
    const fileName = basename(getDbPath(validateProjectPath(args.path)));
    return textResult(
      dbFiles.includes(fileName)
        ? await describe(fileName)
        : `No index for ${args.path}.`
    );
  }
  if (dbFiles.length === 0) return textResult("No projects indexed yet.");
  return textResult((await Promise.all(dbFiles.map(describe))).join("\n"));
}
