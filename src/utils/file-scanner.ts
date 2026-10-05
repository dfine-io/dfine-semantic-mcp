import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { isWithinRoot, type CanonicalPath } from "./path-guard.js";
import { errorMessage } from "./context.js";
import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS, MAX_FILE_SIZE } from "../constants.js";

const execFileAsync = promisify(execFile);

const ALWAYS_IGNORE = [
  "node_modules",
  ".next",
  "build",
  "dist",
  "data",
  ".playwright-mcp",
];

// Fixed args: no index refresh, no repo-configured fsmonitor command, NUL-separated verbatim paths.
const LS_FILES = [
  "-c",
  "core.fsmonitor=false",
  "--no-optional-locks",
  "ls-files",
  "-z",
  "--exclude-standard",
];

function isIgnoredPath(filePath: string): boolean {
  return ALWAYS_IGNORE.some((dir) => filePath.startsWith(`${dir}/`));
}

export interface ProjectFile {
  readonly relativePath: string;
  readonly mtimeMs: number;
  readonly size: number;
}

async function gitList(
  projectPath: CanonicalPath,
  mode: readonly string[]
): Promise<string[]> {
  const { stdout } = await execFileAsync("git", [...LS_FILES, ...mode], {
    cwd: projectPath,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.split("\0").filter(Boolean);
}

// Root, file type and size: checked at listing and again right before every read.
async function checkReadable(
  projectPath: CanonicalPath,
  relativePath: string
): Promise<Stats> {
  const absolutePath = join(projectPath, relativePath);
  if (!(await isWithinRoot(projectPath, absolutePath)))
    throw new Error(`${relativePath} resolves outside the root`);
  const info = await stat(absolutePath);
  if (!info.isFile() || info.size > MAX_FILE_SIZE)
    throw new Error(`${relativePath} is no regular file within the size limit`);
  return info;
}

function skipped(relativePath: string, error: unknown): null {
  console.error(
    `[dfine-semantic] Skipped ${relativePath}: ${errorMessage(error)}`
  );
  return null;
}

async function statFile(
  projectPath: CanonicalPath,
  relativePath: string
): Promise<ProjectFile | null> {
  try {
    const info = await checkReadable(projectPath, relativePath);
    return { relativePath, mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    // Listed by git but unsafe, gone or too large: absent, so the plan purges it.
    return skipped(relativePath, error);
  }
}

// Throws when git fails: an empty list would purge the whole index.
export async function listProjectFiles(
  projectPath: CanonicalPath,
  extensions: readonly string[]
): Promise<ProjectFile[]> {
  const [listed, trackedIgnored] = await Promise.all([
    gitList(projectPath, ["--cached", "--others"]),
    gitList(projectPath, ["--cached", "--ignored"]),
  ]);
  const ignored = new Set(trackedIgnored);
  const wanted = new Set(extensions);
  const candidates = [...new Set(listed)].filter(
    (path) =>
      wanted.has(extname(path)) && !isIgnoredPath(path) && !ignored.has(path)
  );
  const stats = await Promise.all(
    candidates.map((path) => statFile(projectPath, path))
  );
  const files = stats.filter((file): file is ProjectFile => file !== null);
  console.error(
    `[dfine-semantic] Listed ${files.length} files in ${projectPath}`
  );
  return files;
}

// Checks again at read time: the file may have become a symlink, a pipe or too large since listing.
// null skips the file for this run; its index entry stays until a listing drops it.
export async function readProjectFile(
  projectPath: CanonicalPath,
  relativePath: string
): Promise<string | null> {
  try {
    await checkReadable(projectPath, relativePath);
    return await readFile(join(projectPath, relativePath), "utf-8");
  } catch (error) {
    return skipped(relativePath, error);
  }
}
