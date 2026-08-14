import { createHash } from "node:crypto";
import { scanProject, type ScannedFile } from "../utils/file-scanner.js";
import {
  openStore,
  type VectorStore,
  type FilePurgeStore,
} from "../store/vector-store.js";
import { reindexFile } from "./sync.js";
import { validateProjectPath } from "../utils/path-guard.js";
import { type McpResponse, MS_PER_SECOND } from "../constants.js";

const PROGRESS_INTERVAL = 50;

// Nur das Abbruchsignal aus dem SDK-Extra — der Rest ist hier ohne Belang.
type CancellableRequest = { readonly signal: AbortSignal };

// Ein Lauf je Projektpfad: ein zweiter Aufruf mit denselben Vorgaben haengt
// sich an, statt dieselben Dateien ein zweites Mal zu embedden.
const indexInFlight = new Map<
  string,
  {
    readonly run: Promise<McpResponse>;
    readonly extKey: string;
    readonly force: boolean;
  }
>();

interface IndexArgs {
  path: string;
  extensions: string[];
  force: boolean;
}

async function indexFiles(
  store: VectorStore,
  files: readonly ScannedFile[],
  counts: { indexed: number; skipped: number },
  signal: AbortSignal
): Promise<boolean> {
  for (const file of files) {
    // Ohne diese Pruefung laeuft ein abgebrochener Aufruf als Zombie weiter.
    if (signal.aborted) return true;
    const contentHash = createHash("sha256").update(file.content).digest("hex");
    // reindexFile prueft den Hash selbst — ein zweiter SELECT je Datei entfaellt.
    const changed = await reindexFile(
      store,
      file.relativePath,
      file.content,
      contentHash
    );
    if (!changed) {
      counts.skipped++;
      continue;
    }
    counts.indexed++;
    if (counts.indexed % PROGRESS_INTERVAL === 0)
      console.error(
        `[dfine-semantic] Indexed ${counts.indexed}/${files.length} files...`
      );
  }
  return false;
}

function purgeStaleEntries(
  store: FilePurgeStore,
  files: readonly ScannedFile[]
): number {
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
  args: IndexArgs,
  extra: CancellableRequest
): Promise<McpResponse> {
  const projectPath = validateProjectPath(args.path);
  const extKey = [...args.extensions].sort().join(",");
  const active = indexInFlight.get(projectPath);
  if (active) {
    // Nur echte Wiederholungen duerfen sich anhaengen — in beide Richtungen:
    // auch ein normaler Aufruf darf keinen laufenden force-Neuaufbau erben.
    if (args.force || active.force || active.extKey !== extKey) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Index run already active with different settings — retry once it finishes.",
          },
        ],
      };
    }
    console.error(
      `[dfine-semantic] Index run already active for ${projectPath} — joining`
    );
    return active.run;
  }
  const run = runIndex(projectPath, args, extra);
  indexInFlight.set(projectPath, { run, extKey, force: args.force });
  try {
    return await run;
  } finally {
    indexInFlight.delete(projectPath);
  }
}

async function runIndex(
  projectPath: string,
  args: IndexArgs,
  extra: CancellableRequest
): Promise<McpResponse> {
  const startTime = Date.now();
  const store = openStore(projectPath);
  const counts = { indexed: 0, skipped: 0 };

  try {
    const files = scanProject(projectPath, args.extensions);
    console.error(
      `[dfine-semantic] Scanning ${files.length} files in ${projectPath}`
    );
    if (args.force) {
      store.clear();
      console.error("[dfine-semantic] force: store cleared, rebuilding");
    }

    const cancelled = await indexFiles(store, files, counts, extra.signal);
    // Nach einem Abbruch ist die Dateiliste unvollstaendig abgearbeitet.
    const purged = cancelled ? 0 : purgeStaleEntries(store, files);

    const duration = Date.now() - startTime;
    const parts = [
      `Indexed ${counts.indexed} files, skipped ${counts.skipped} unchanged`,
    ];
    if (purged > 0) parts.push(`purged ${purged} stale`);
    if (cancelled) parts.push("cancelled — store consistent, rerun to finish");
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
