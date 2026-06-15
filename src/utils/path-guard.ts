import { resolve, join, sep } from "node:path";
import { homedir } from "node:os";

function withTrailingSep(dir: string): string {
  return dir.endsWith(sep) ? dir : `${dir}${sep}`;
}

function parseAllowedRoots(): string[] {
  const defaults = [process.cwd(), join(homedir(), ".claude")];
  const extra = process.env["SEMANTIC_ALLOWED_ROOTS"];
  if (!extra) return defaults;
  const parsed = extra
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
  return [...defaults, ...parsed];
}

const ALLOWED_ROOTS = parseAllowedRoots();

export function validateProjectPath(inputPath: string): string {
  const resolved = resolve(inputPath);
  const isAllowed = ALLOWED_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(withTrailingSep(root))
  );
  if (!isAllowed) {
    throw new Error(`Path not in allowed roots: ${inputPath}`);
  }
  return resolved;
}
