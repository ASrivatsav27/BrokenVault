import { chunkFile } from "./chunker.js";
import { sha256Hex } from "./hasher.js";
import { throwIfInterrupted } from "./errors.js";
import type { ScanResult } from "./scanner.js";

export interface ManifestFileEntry {
  path: string;
  type: "file";
  size: number;
  mtime: string;
  chunks: string[];
}

export interface ManifestDirectoryEntry {
  path: string;
  type: "directory";
  size: 0;
  mtime: string;
}

export type ManifestEntry = ManifestFileEntry | ManifestDirectoryEntry;

export interface ChunkLocation {
  absPath: string;
  offset: number;
  length: number;
}

export interface BuiltManifest {
  entries: ManifestEntry[];
  chunkIndex: Map<string, ChunkLocation>;
  chunkOccurrences: number;
  fingerprint: string;
}

export async function buildManifest(
  scan: ScanResult,
  options: {
    signal?: AbortSignal;
    onProgress?: (bytesProcessed: number) => void;
  } = {}
): Promise<BuiltManifest> {
  const entries: ManifestEntry[] = [];
  const chunkIndex = new Map<string, ChunkLocation>();
  let chunkOccurrences = 0;
  let processed = 0;

  for (const item of scan.items) {
    if (item.type === "directory") {
      entries.push({ path: item.path, type: "directory", size: 0, mtime: item.mtime });
      continue;
    }

    const chunks: string[] = [];

    for await (const chunk of chunkFile(item.absPath, item.size)) {
      throwIfInterrupted(options.signal);

      chunks.push(chunk.hash);
      chunkOccurrences++;
      processed += chunk.length;

      if (!chunkIndex.has(chunk.hash)) {
        chunkIndex.set(chunk.hash, {
          absPath: item.absPath,
          offset: chunk.offset,
          length: chunk.length,
        });
      }

      options.onProgress?.(processed);
    }

    entries.push({ path: item.path, type: "file", size: item.size, mtime: item.mtime, chunks });
  }

  const fingerprint = sha256Hex(Buffer.from(JSON.stringify(entries)));
  return { entries, chunkIndex, chunkOccurrences, fingerprint };
}
