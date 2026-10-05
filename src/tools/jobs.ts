import type { CanonicalPath } from "../utils/path-guard.js";
import type { SyncOutcome } from "./sync.js";

export interface JobProgress {
  done: number;
  total: number;
}

type Job =
  | { readonly kind: "index"; readonly progress: JobProgress }
  | { readonly kind: "sync"; readonly run: Promise<SyncOutcome> };

// One job per project: an index run and a search sync never embed the same files twice.
const jobs = new Map<CanonicalPath, Job>();

export function activeJob(projectPath: CanonicalPath): Job | undefined {
  return jobs.get(projectPath);
}

export async function withJob<T>(
  projectPath: CanonicalPath,
  job: Job,
  run: () => Promise<T>
): Promise<T> {
  jobs.set(projectPath, job);
  try {
    return await run();
  } finally {
    jobs.delete(projectPath);
  }
}
