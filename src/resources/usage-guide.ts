import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { DATA_DIR } from "../store/vector-store.js";

export async function handleUsageGuide(uri: URL) {
  // Build dynamic status of indexed projects
  let status = "No projects indexed yet.";
  if (existsSync(DATA_DIR)) {
    const dbs = readdirSync(DATA_DIR).filter((f) => f.endsWith(".db"));
    if (dbs.length > 0) {
      const lines = dbs.map((dbFile) => {
        const db = new Database(join(DATA_DIR, dbFile));
        sqliteVec.load(db);
        const chunks = db.prepare("SELECT COUNT(*) as c FROM chunks").get() as {
          c: number;
        };
        const files = db
          .prepare("SELECT COUNT(*) as c FROM file_hashes")
          .get() as { c: number };
        db.close();
        return `  - ${dbFile.replace(".db", "")}: ${files.c} files, ${chunks.c} chunks`;
      });
      status = `Indexed projects:\n${lines.join("\n")}`;
    }
  }

  const guide = `# dfine-semantic — Usage Guide

## Search Pipeline Priority
1. semantic_search — conceptual/cross-file discovery (FIRST choice)
2. LSP — symbol navigation (findReferences, goToDefinition)
3. Grep — exact string literals only

## Tools

### semantic_search
- path: MUST be absolute project root (e.g. /Users/user/project), NOT a subfolder
- Project MUST be indexed first via index_project
- Default (compact): returns file:line references — use Read tool to inspect
- returnFullContent=true: returns full code chunks inline — use for deep-dives with <20 results
- limit: 1-100 (default 10). Use 20-50 for broad discovery, 5-10 for focused queries
- threshold: 0-1 (default 0.3). Raise to 0.5+ for precision, lower for recall

### index_project
- Incremental: only re-indexes changed files (content-hash based)
- First run downloads ONNX model (~130MB) — cached in ~/.cache/huggingface/
- Typical: ~1000 files in 10-15 minutes

## Current Index Status
${status}`;

  return { contents: [{ uri: uri.href, text: guide }] };
}
