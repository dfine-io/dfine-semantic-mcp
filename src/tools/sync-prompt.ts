import { z } from "zod";
import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { isWindowedPath } from "../chunking/windows.js";
import type { ProjectFile } from "../utils/file-scanner.js";
import type { CanonicalPath } from "../utils/path-guard.js";
import type { ToolContext } from "../utils/context.js";

// Pooled fp32: about 1.5 s per file for chunks; windows add 15.2 per file at 8.3/s (dfine-review).
const EST_SECONDS_PER_FILE = 1.5;
const EST_WINDOW_SECONDS_PER_FILE = 1.8;
const SYNC_PROMPT_SECONDS = 60;
const SECONDS_PER_MINUTE = 60;

// "with": chunks and windows; "none": chunks only; "only": windows for files whose chunks are current.
export type WindowMode = "with" | "none" | "only";

export interface ReconcilePlan {
  readonly changed: readonly ProjectFile[];
  readonly stale: readonly ProjectFile[];
  readonly unwindowed: readonly ProjectFile[];
  readonly purge: readonly string[];
  readonly unchanged: number;
  readonly mode: Exclude<WindowMode, "only">;
}

// What one applyFiles run did: the note and the index summary report it.
export interface ApplyResult {
  readonly indexed: number;
  readonly cancelled: boolean;
}

const SyncChoiceSchema = z.enum(["all", "changed", "none"]);
type SyncChoice = z.infer<typeof SyncChoiceSchema>;
// The form's key in inputRequests, and the answer a retried call brings back under it.
const SYNC_FORM = "sync";
const SyncAnswerSchema = z.object({ choice: SyncChoiceSchema });

// A form the client shows the user; the client then retries the call with the answer.
export interface AskForm {
  readonly kind: "ask";
  readonly form: InputRequiredResult;
}

type SyncDecision =
  { readonly kind: "choice"; readonly choice: SyncChoice } | AskForm;

// One entry of the form's titled single-select list.
interface ChoiceOption {
  readonly const: SyncChoice;
  readonly title: string;
}

// Per server process: a rebuild the user put off, and how many changed files the user chose to skip.
const rebuildDeferred = new Set<CanonicalPath>();
const skippedChanges = new Map<CanonicalPath, number>();

// Only windowed types pay for windows, so .md or .css files cost chunks alone.
function estSeconds(
  plan: ReconcilePlan,
  files: readonly ProjectFile[]
): number {
  const windowed =
    plan.mode === "with"
      ? files.filter((file) => isWindowedPath(file.relativePath)).length
      : 0;
  return (
    files.length * EST_SECONDS_PER_FILE + windowed * EST_WINDOW_SECONDS_PER_FILE
  );
}

function minutes(plan: ReconcilePlan, files: readonly ProjectFile[]): number {
  return Math.ceil(estSeconds(plan, files) / SECONDS_PER_MINUTE);
}

function syncForm(
  plan: ReconcilePlan,
  askRebuild: boolean
): InputRequiredResult {
  const changed = plan.changed.length;
  const all = filesFor(plan, "all");
  const options: ChoiceOption[] = [];
  const facts: string[] = [];
  if (askRebuild) {
    options.push({
      const: "all",
      title: `Re-index ${all.length} files now (~${minutes(plan, all)} min)`,
    });
    facts.push(`${plan.stale.length} files were indexed by an older version.`);
  }
  if (changed > 0) {
    options.push({
      const: "changed",
      title: `Re-index the ${changed} changed files (~${minutes(plan, plan.changed)} min)`,
    });
    facts.push(`${changed} files changed since the last sync.`);
  }
  options.push({ const: "none", title: "Search the current index" });
  return inputRequired({
    inputRequests: {
      [SYNC_FORM]: inputRequired.elicit({
        mode: "form",
        message: `${facts.join(" ")} How should this search proceed?`,
        requestedSchema: {
          type: "object",
          properties: {
            choice: {
              type: "string",
              title: "Index",
              oneOf: options,
              default: options[0]?.const,
            },
          },
          required: ["choice"],
        },
      }),
    },
  });
}

const choose = (choice: SyncChoice): SyncDecision => ({
  kind: "choice",
  choice,
});

// Small syncs run silently; a slow one or an older chunker asks first. No answer syncs changed files.
export function chooseSync(
  projectPath: CanonicalPath,
  plan: ReconcilePlan,
  ctx: ToolContext
): SyncDecision {
  const changed = plan.changed.length;
  const askRebuild = plan.stale.length > 0 && !rebuildDeferred.has(projectPath);
  const slow = estSeconds(plan, plan.changed) > SYNC_PROMPT_SECONDS;
  if (!askRebuild && !slow) {
    skippedChanges.delete(projectPath);
    return choose("changed");
  }
  if (!askRebuild && changed <= (skippedChanges.get(projectPath) ?? -1))
    return choose("none");
  // The first call returns the form; the retry carries the answer, a decline included.
  if (ctx.form && inputResponse(ctx.form.answers, SYNC_FORM).kind === "missing")
    return { kind: "ask", form: syncForm(plan, askRebuild) };
  const answer =
    acceptedContent(ctx.form?.answers, SYNC_FORM, SyncAnswerSchema)?.choice ??
    null;
  if (askRebuild && answer !== "all") rebuildDeferred.add(projectPath);
  if (answer === "none") skippedChanges.set(projectPath, changed);
  else skippedChanges.delete(projectPath);
  return choose(answer ?? "changed");
}

export function filesFor(
  plan: ReconcilePlan,
  choice: SyncChoice
): readonly ProjectFile[] {
  switch (choice) {
    case "all":
      return [...plan.changed, ...plan.stale];
    case "changed":
      return plan.changed;
    case "none":
      return [];
  }
}

export function syncNote(
  plan: ReconcilePlan,
  choice: SyncChoice,
  result: ApplyResult
): string | null {
  const notes: string[] = [];
  if (result.indexed > 0 || plan.purge.length > 0)
    notes.push(
      `[sync] Re-indexed ${result.indexed} files, removed ${plan.purge.length}.`
    );
  if (result.cancelled)
    notes.push("[sync] Cancelled before every file was re-indexed.");
  if (choice === "none" && plan.changed.length > 0)
    notes.push(
      `[sync] Skipped ${plan.changed.length} changed files on request; results may be stale.`
    );
  if (choice !== "all" && plan.stale.length > 0)
    notes.push(
      `[index] ${plan.stale.length} files come from an older version. Run index_project to rebuild (~${minutes(plan, plan.stale)} min).`
    );
  if (plan.unwindowed.length > 0)
    notes.push(
      `[duplicates] ${plan.unwindowed.length} files have no duplicate windows yet. Run index_project to add them.`
    );
  return notes.length > 0 ? notes.join("\n") : null;
}
