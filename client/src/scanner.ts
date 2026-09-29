import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { MAX_FILE_SIZE } from "./config.js";
import { describeFsError } from "./errors.js";
import { relativePathError } from "./paths.js";

export interface ScannedItem {
  path: string;
  absPath: string;
  type: "file" | "directory";
  size: number;
  mtime: string;
}

export interface ScanIssue {
  path: string;
  message: string;
}

export interface ScanResult {
  root: string;
  items: ScannedItem[];
  directoryCount: number;
  fileCount: number;
  emptyFileCount: number;
  emptyDirectoryCount: number;
  totalBytes: number;
  skipped: ScanIssue[];
  errors: ScanIssue[];
}

function mtimeIso(mtime: Date): string | null {
  const year = mtime.getUTCFullYear();
  if (Number.isNaN(mtime.getTime()) || year < 1 || year > 9999) {
    return null;
  }
  return mtime.toISOString();
}

export async function scanFolder(
  root: string,
  onProgress?: (directories: number, files: number) => void
): Promise<ScanResult> {
  const result: ScanResult = {
    root,
    items: [],
    directoryCount: 0,
    fileCount: 0,
    emptyFileCount: 0,
    emptyDirectoryCount: 0,
    totalBytes: 0,
    skipped: [],
    errors: [],
  };

  const pending: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];

  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    let entries;

    try {
      entries = await readdir(current.abs, { withFileTypes: true });
    } catch (error) {
      result.errors.push({ path: current.rel || ".", message: describeFsError(error) });
      continue;
    }

    if (current.rel !== "" && entries.length === 0) {
      result.emptyDirectoryCount++;
    }

    for (const entry of entries) {
      const rel = current.rel === "" ? entry.name : `${current.rel}/${entry.name}`;
      const abs = path.join(current.abs, entry.name);

      const pathError = relativePathError(rel);
      if (pathError) {
        result.errors.push({ path: rel, message: pathError });
        continue;
      }

      if (entry.isSymbolicLink()) {
        result.skipped.push({ path: rel, message: "symbolic link" });
        continue;
      }

      if (!entry.isDirectory() && !entry.isFile()) {
        result.skipped.push({ path: rel, message: "not a regular file or directory" });
        continue;
      }

      let info;

      try {
        info = await lstat(abs);
      } catch (error) {
        result.errors.push({ path: rel, message: describeFsError(error) });
        continue;
      }

      const mtime = mtimeIso(info.mtime);
      if (mtime === null) {
        result.errors.push({ path: rel, message: "unsupported modification time" });
        continue;
      }

      if (entry.isDirectory()) {
        result.items.push({ path: rel, absPath: abs, type: "directory", size: 0, mtime });
        result.directoryCount++;
        pending.push({ abs, rel });
      } else {
        if (info.size > MAX_FILE_SIZE) {
          result.errors.push({
            path: rel,
            message: `file is larger than the ${MAX_FILE_SIZE}-byte limit the server supports`,
          });
          continue;
        }

        result.items.push({ path: rel, absPath: abs, type: "file", size: info.size, mtime });
        result.fileCount++;
        result.totalBytes += info.size;

        if (info.size === 0) {
          result.emptyFileCount++;
        }
      }

      onProgress?.(result.directoryCount, result.fileCount);
    }
  }

  result.items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}
