import { openStore, storeExists } from "../store/vector-store.js";
import { applyFiles, planReconcile } from "./sync.js";
import { filesFor, type ApplyResult } from "./sync-prompt.js";
import { activeJob, withJob, type JobProgress } from "./jobs.js";
import { listProjectFiles } from "../utils/file-scanner.js";
import {
  validateProjectPath,
  type CanonicalPath,
} from "../utils/path-guard.js";
import {
  errorMessage,
  textResult,
  type ToolContext,
} from "../utils/context.js";
import {
  DEFAULT_EXTENSIONS,
  type McpResponse,
  MS_PER_SECOND,
} from "../constants.js";

interface IndexArgs {
  readonly path: string;
  readonly extensions?: readonly string[];
  readonly force: boolean;
  readonly duplicates?: boolean;
}

// Progress across both phases: first chunks, then missing duplicate windows.
function phaseContext(
  ctx: ToolContext,
  progress: JobProgress,
  offset: number
): ToolContext {
  return {
    ...ctx,
    progress: async (done, _, message) => {
      progress.done = offset + done;
      await ctx.progress(progress.done, progress.total, message);
    },
  };
}

async function runIndex(
  projectPath: CanonicalPath,
  args: IndexArgs,
  ctx: ToolContext,
  progress: JobProgress
): Promise<McpResponse> {
  const startTime = Date.now();
  // A stored list outlives calls without extensions; opening an existing store creates nothing.
  const known = (await storeExists(projectPath))
    ? await openStore(projectPath)
    : null;
  const extensions =
    args.extensions ?? known?.getIndexedExtensions() ?? DEFAULT_EXTENSIONS;
  // List before creating a store: a git failure leaves none behind and purges nothing.
  const files = await listProjectFiles(projectPath, extensions);
  const store = known ?? (await openStore(projectPath));
  if (args.force) {
    store.clear();
    console.error("[dfine-semantic] force: store cleared, rebuilding");
  }
  if (args.duplicates !== undefined) store.windows.setEnabled(args.duplicates);
  const plan = await planReconcile(
    store,
    projectPath,
    files,
    store.windows.enabled()
  );
  store.deleteFiles(plan.purge);
  store.setIndexedExtensions(extensions);
  const todo = filesFor(plan, "all");
  progress.total = todo.length + plan.unwindowed.length;
  console.error(
    `[dfine-semantic] Indexing ${progress.total} of ${files.length} files in ${projectPath}`
  );
  await ctx.progress(0, progress.total, `Indexing ${progress.total} files`);
  const indexed = await applyFiles(store, projectPath, todo, {
    ctx: phaseContext(ctx, progress, 0),
    label: "Indexed",
    windows: plan.mode,
  });
  const windowed = indexed.cancelled
    ? ({ indexed: 0, cancelled: true } satisfies ApplyResult)
    : await applyFiles(store, projectPath, plan.unwindowed, {
        ctx: phaseContext(ctx, progress, todo.length),
        label: "Windowed",
        windows: "only",
      });
  const parts = [
    `Indexed ${indexed.indexed} files, ${plan.unchanged} unchanged`,
  ];
  if (windowed.indexed > 0)
    parts.push(`added duplicate windows to ${windowed.indexed}`);
  if (plan.purge.length > 0) parts.push(`removed ${plan.purge.length}`);
  if (windowed.cancelled)
    parts.push("cancelled with a consistent store, rerun to finish");
  const seconds = ((Date.now() - startTime) / MS_PER_SECOND).toFixed(1);
  parts.push(`in ${seconds}s. Total chunks: ${store.countChunks()}`);
  return textResult(parts.join(", "));
}

export async function handleIndexProject(
  args: IndexArgs,
  ctx: ToolContext
): Promise<McpResponse> {
  const projectPath = validateProjectPath(args.path);
  const running = activeJob(projectPath);
  // A search sync writes the same files: let it finish first.
  if (running?.kind === "sync") {
    console.error(
      `[dfine-semantic] index_project waits for a search sync of ${projectPath}`
    );
    await running.run;
  }
  const current = activeJob(projectPath);
  if (current?.kind === "index")
    return textResult(
      `index_project is already running for this project (${current.progress.done}/${current.progress.total} files). Wait for it to finish.`
    );
  const progress = { done: 0, total: 0 } satisfies JobProgress;
  try {
    return await withJob(projectPath, { kind: "index", progress }, () =>
      runIndex(projectPath, args, ctx, progress)
    );
  } catch (error) {
    throw new Error(
      `Indexing failed after ${progress.done} files: ${errorMessage(error)}`,
      {
        cause: error,
      }
    );
  }
}
