import { createHash } from "node:crypto";
import { scanProject, type ScannedFile } from "../utils/file-scanner.js";
import { openStore, type VectorStore } from "../store/vector-store.js";
import { reindexFile } from "./sync.js";
import { validateProjectPath } from "../utils/path-guard.js";
import { type McpResponse, MS_PER_SECOND } from "../constants.js";

const PROGRESS_INTERVAL = 50;

interface IndexArgs {
  path: string;
  extensions: string[];
}

async function indexFiles(
  store: VectorStore,
  files: ScannedFile[],
  counts: { indexed: number; skipped: number }
): Promise<void> {
  for (const file of files) {
    const contentHash = createHash("sha256").update(file.content).digest("hex");
    if (store.getFileHash(file.relativePath) === contentHash) {
      counts.skipped++;
      continue;
    }
    await reindexFile(store, file.relativePath, file.content, contentHash);
    counts.indexed++;
    if (counts.indexed % PROGRESS_INTERVAL === 0)
      console.error(
        `[dfine-semantic] Indexed ${counts.indexed}/${files.length} files...`
      );
  }
}

function purgeStaleEntries(store: VectorStore, files: ScannedFile[]): number {
  const scannedPaths = new Set(files.map((f) => f.relativePath));
  let purged = 0;
  for (const stored of store.getAllFilePaths()) {
    if (!scannedPaths.has(stored)) {
      store.deleteFileChunks(stored);
      purged++;
    }
  }
  return purged;
}

export async function handleIndexProject(
  args: IndexArgs
): Promise<McpResponse> {
  const projectPath = validateProjectPath(args.path);
  const startTime = Date.now();
  const store = openStore(projectPath);
  const counts = { indexed: 0, skipped: 0 };

  try {
    const files = scanProject(projectPath, args.extensions);
    console.error(
      `[dfine-semantic] Scanning ${files.length} files in ${projectPath}`
    );

    await indexFiles(store, files, counts);
    const purged = purgeStaleEntries(store, files);

    const duration = Date.now() - startTime;
    const parts = [
      `Indexed ${counts.indexed} files, skipped ${counts.skipped} unchanged`,
    ];
    if (purged > 0) parts.push(`purged ${purged} stale`);
    parts.push(
      `in ${(duration / MS_PER_SECOND).toFixed(1)}s. Total chunks: ${store.getStats().totalChunks}`
    );
    return { content: [{ type: "text" as const, text: parts.join(", ") }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dfine-semantic] Indexing failed: ${message}`);
    return {
      content: [
        {
          type: "text" as const,
          text: `Indexing failed after ${counts.indexed} files: ${message}`,
        },
      ],
    };
  }
}
