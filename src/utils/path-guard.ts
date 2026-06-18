import { resolve, join, sep } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";

function withTrailingSep(dir: string): string {
  return dir.endsWith(sep) ? dir : `${dir}${sep}`;
}

// Canonicalize: resolve symlinks too, so a link inside an allowed root cannot
// escape it. Falls back to the lexical path when the target does not exist yet.
function canonical(inputPath: string): string {
  const resolved = resolve(inputPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isUnder(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(withTrailingSep(root));
}

function parseAllowedRoots(): string[] {
  const defaults = [process.cwd(), join(homedir(), ".claude")];
  const extra = process.env["SEMANTIC_ALLOWED_ROOTS"];
  const raw = extra
    ? [
        ...defaults,
        ...extra
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      ]
    : defaults;
  return raw.map(canonical);
}

const ALLOWED_ROOTS = parseAllowedRoots();

export function validateProjectPath(inputPath: string): string {
  const resolved = canonical(inputPath);
  const isAllowed = ALLOWED_ROOTS.some((root) => isUnder(root, resolved));
  if (!isAllowed) {
    throw new Error(`Path not in allowed roots: ${inputPath}`);
  }
  return resolved;
}

// Guard individual file reads: the real (symlink-resolved) path must stay inside
// the already-validated project root — blocks tracked symlinks escaping the repo.
export function isWithinRoot(root: string, absPath: string): boolean {
  return isUnder(canonical(root), canonical(absPath));
}
