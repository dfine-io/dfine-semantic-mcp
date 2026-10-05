import { resolve, join, sep, dirname, basename, relative } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";

// Only validateProjectPath creates this brand, so a branded root is already resolved.
declare const canonicalBrand: unique symbol;
export type CanonicalPath = string & { readonly [canonicalBrand]: true };

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

// A server started in / or the home folder would otherwise expose every file below it.
function workingRoot(): string[] {
  const cwd = canonical(process.cwd());
  if (dirname(cwd) !== cwd && cwd !== canonical(homedir())) return [cwd];
  console.error(
    `[dfine-semantic] Not using the working directory ${cwd} as a root`
  );
  return [];
}

function parseAllowedRoots(): string[] {
  const defaults = [...workingRoot(), join(homedir(), ".claude")];
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

export function validateProjectPath(inputPath: string): CanonicalPath {
  const resolved = canonical(inputPath);
  const isAllowed = ALLOWED_ROOTS.some((root) => isUnder(root, resolved));
  if (!isAllowed) {
    throw new Error(`Path not in allowed roots: ${inputPath}`);
  }
  return resolved as CanonicalPath;
}

// The resolved file path must stay inside the root: blocks tracked symlinks escaping it.
export async function isWithinRoot(
  root: CanonicalPath,
  absPath: string
): Promise<boolean> {
  const absolute = resolve(absPath);
  const resolved = await realpath(absolute).catch(() => absolute);
  return isUnder(root, resolved);
}

type RootRelative =
  | { readonly kind: "inside"; readonly path: string }
  | { readonly kind: "root" }
  | { readonly kind: "outside" };

// A caller's path in the root-relative form git lists. Lexical first, so a symlinked file keeps
// its own name; only a path through an alias of the root (/tmp for /private/tmp) gets its folder resolved.
export function relativeToRoot(
  root: CanonicalPath,
  input: string
): RootRelative {
  const lexical = resolve(root, input);
  const target = isUnder(root, lexical)
    ? lexical
    : join(canonical(dirname(lexical)), basename(lexical));
  if (target === root) return { kind: "root" };
  if (!isUnder(root, target)) return { kind: "outside" };
  return { kind: "inside", path: relative(root, target).split(sep).join("/") };
}
