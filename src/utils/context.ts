import type { CanonicalPath } from "./path-guard.js";
import type { JobProgress } from "../tools/jobs.js";
import type { McpResponse } from "../constants.js";

// What a handler needs from its request: cancel, progress, and the answers to a form it asked for.
export interface ToolContext {
  readonly signal: AbortSignal;
  readonly progress: (
    done: number,
    total: number,
    message: string
  ) => Promise<void>;
  // null when the client cannot show a form.
  readonly form: FormChannel | null;
}

// The answers a retried call carries, keyed like the form's requests; undefined on the first call.
interface FormChannel {
  readonly answers: Record<string, unknown> | undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function textResult(text: string): McpResponse {
  return { content: [{ type: "text", text }] };
}

// Text for the model, plus the same answer as data for clients that read the tool's outputSchema.
export function structuredResult(
  text: string,
  data: Record<string, unknown>
): McpResponse {
  return { content: [{ type: "text", text }], structuredContent: data };
}

// One answer for no store and for a store without chunks: index_project may still run, or matched no file.
export function notIndexed(
  projectPath: CanonicalPath,
  running: JobProgress | null
): string {
  if (running)
    return `index_project is running for ${projectPath} (${running.done}/${running.total} files). Search again when it finishes.`;
  return `No indexed code for ${projectPath} yet. Run index_project with this path; pass extensions when the project has none of the default file types.`;
}
