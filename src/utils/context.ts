import {
  CLIENT_CAPABILITIES_META_KEY,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
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

// The SDK validates the request envelope but types it as {}: read the one member the form needs.
const EnvelopeSchema = z.object({
  [CLIENT_CAPABILITIES_META_KEY]: z.object({
    elicitation: z
      .object({ form: z.unknown(), url: z.unknown() })
      .partial()
      .optional(),
  }),
});

// Forms ride input_required, which needs the 2026-07-28 envelope; a 2025-era client gets the default.
// Same rule as the SDK's gate: a bare elicitation capability means forms.
function canShowForm(ctx: ServerContext): boolean {
  const parsed = EnvelopeSchema.safeParse(ctx.mcpReq.envelope);
  const elicitation = parsed.success
    ? parsed.data[CLIENT_CAPABILITIES_META_KEY].elicitation
    : undefined;
  return (
    elicitation !== undefined &&
    (elicitation.form !== undefined || elicitation.url === undefined)
  );
}

// Maps the SDK request onto what the handlers need, so they stay free of SDK types.
export function toolContext(ctx: ServerContext): ToolContext {
  const token = ctx.mcpReq._meta?.progressToken;
  return {
    signal: ctx.mcpReq.signal,
    progress: async (done, total, message) => {
      if (token === undefined) return;
      // A closed client must not fail the run.
      await ctx.mcpReq
        .notify({
          method: "notifications/progress",
          params: { progressToken: token, progress: done, total, message },
        })
        .catch((error: unknown) => {
          console.error(
            `[dfine-semantic] Progress not sent: ${errorMessage(error)}`
          );
        });
    },
    form: canShowForm(ctx) ? { answers: ctx.mcpReq.inputResponses } : null,
  };
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
