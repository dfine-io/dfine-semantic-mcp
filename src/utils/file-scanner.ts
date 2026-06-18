import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import ignore from "ignore";
import { isWithinRoot } from "./path-guard.js";
import {
  MAX_FILE_SIZE,
  GIT_TIMEOUT_MS,
  GIT_MAX_BUFFER,
  RENAME_MARKER_LENGTH,
  GIT_STATUS_PREFIX_LENGTH,
  MIN_LINE_LENGTH,
} from "../constants.js";

const ALWAYS_IGNORE = [
  "node_modules",
  ".next",
  "build",
  "dist",
  ".git",
  "data",
  ".playwright-mcp",
];

export function getFileExtension(filePath: string): string {
  return `.${filePath.split(".").pop() ?? ""}`;
}

function isIgnoredPath(filePath: string): boolean {
  return ALWAYS_IGNORE.some((dir) => filePath.startsWith(`${dir}/`));
}

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  content: string;
}

export function scanProject(
  projectPath: string,
  extensions: readonly string[]
): ScannedFile[] {
  const ig = loadGitignore(projectPath);
  const extSet = new Set(extensions);
  const files: ScannedFile[] = [];

  let filePaths: string[];
  try {
    const output = execSync(
      "git ls-files --cached --others --exclude-standard",
      {
        cwd: projectPath,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      }
    );
    filePaths = output.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    console.error("[dfine-semantic] git ls-files failed, skipping project");
    return [];
  }

  for (const relPath of filePaths) {
    const ext = getFileExtension(relPath);
    if (!extSet.has(ext)) continue;
    if (isIgnoredPath(relPath)) continue;
    if (ig.ignores(relPath)) continue;

    const absPath = join(projectPath, relPath);
    // Symlink guard: a tracked link must not read outside the project root.
    if (!isWithinRoot(projectPath, absPath)) continue;
    try {
      const stat = statSync(absPath);
      if (stat.size > MAX_FILE_SIZE) continue;
      const content = readFileSync(absPath, "utf-8");
      files.push({ absolutePath: absPath, relativePath: relPath, content });
    } catch {
      /* skip unreadable */
    }
  }

  return files;
}

function loadGitignore(projectPath: string): ReturnType<typeof ignore> {
  const ig = ignore();
  try {
    const content = readFileSync(join(projectPath, ".gitignore"), "utf-8");
    ig.add(content);
  } catch {
    /* no .gitignore */
  }
  return ig;
}

type ChangeStatus = "modified" | "added" | "deleted";

export interface ChangedFile {
  status: ChangeStatus;
  relativePath: string;
}

export function scanChangedFiles(
  projectPath: string,
  extensions: readonly string[]
): ChangedFile[] {
  const extSet = new Set(extensions);
  try {
    const output = execSync("git status --porcelain", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    if (!output.trim()) return [];

    const changes: ChangedFile[] = [];
    for (const line of output.trim().split(/\r?\n/)) {
      if (!line || line.length < MIN_LINE_LENGTH) continue;
      const xy = line.slice(0, 2);
      let filePath = line.slice(GIT_STATUS_PREFIX_LENGTH);
      const renameIdx = filePath.indexOf(" -> ");
      if (renameIdx !== -1)
        filePath = filePath.slice(renameIdx + RENAME_MARKER_LENGTH);

      const ext = getFileExtension(filePath);
      if (!extSet.has(ext)) continue;
      if (isIgnoredPath(filePath)) continue;

      if (xy.includes("D")) {
        changes.push({ status: "deleted", relativePath: filePath });
      } else {
        changes.push({
          status: xy.startsWith("??") ? "added" : "modified",
          relativePath: filePath,
        });
      }
    }
    return changes;
  } catch {
    return [];
  }
}
