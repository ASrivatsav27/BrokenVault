import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { readChunkBytes } from "../chunker.js";
import { UPLOAD_CONCURRENCY } from "../config.js";
import type { CommandContext } from "../context.js";
import {
  ApiError,
  CliError,
  InterruptedError,
  describeFsError,
  formatApiError,
  isFsError,
  throwIfInterrupted,
} from "../errors.js";
import { sha256Hex } from "../hasher.js";
import { buildManifest } from "../manifest.js";
import { formatBytes, formatCount } from "../output.js";
import type { Output } from "../output.js";
import { scanFolder } from "../scanner.js";
import type { ScanResult } from "../scanner.js";
import { stateKey } from "../state.js";

export interface BackupSummary {
  snapshotId: string;
  uploadId: string;
  resumed: boolean;
  totalBytes: number;
  files: number;
  directories: number;
  chunkOccurrences: number;
  uniqueChunks: number;
  existingChunks: number;
  missingChunks: number;
  uploadedChunks: number;
  uploadedBytes: number;
  reusedBytes: number;
}

export interface BackupOptions {
  concurrency?: number;
  hooks?: { afterChunkUploaded?: (uploadedChunks: number) => void };
}

export async function validateSource(input: string): Promise<string> {
  const resolved = path.resolve(input);
  let info;

  try {
    info = await stat(resolved);
  } catch (error) {
    if (isFsError(error, "ENOENT")) {
      throw new CliError(`Source folder not found: ${input}`);
    }
    throw new CliError(`Cannot access source folder ${input}: ${describeFsError(error)}`);
  }

  if (!info.isDirectory()) {
    throw new CliError(`Source is not a folder: ${input}`, {
      hint: "Pass the folder you want to back up.",
    });
  }

  return realpath(resolved);
}

function reportScanProblems(out: Output, scan: ScanResult): void {
  if (scan.skipped.length > 0) {
    out.warn(`skipped ${scan.skipped.length} unsupported item(s):`);
    for (const item of scan.skipped.slice(0, 10)) {
      out.line(`  ${item.path} (${item.message})`);
    }
    if (scan.skipped.length > 10) {
      out.line(`  ...and ${scan.skipped.length - 10} more`);
    }
  }

  if (scan.errors.length > 0) {
    for (const item of scan.errors.slice(0, 20)) {
      out.error(`${item.path}: ${item.message}`);
    }
    if (scan.errors.length > 20) {
      out.line(`...and ${scan.errors.length - 20} more`);
    }
    throw new CliError(
      `Cannot back up: ${scan.errors.length} item(s) could not be read or have unsupported names.`,
      { hint: "Fix the items above (or remove them) and run the backup again." }
    );
  }
}

export async function runBackup(
  ctx: CommandContext,
  sourceInput: string,
  options: BackupOptions = {}
): Promise<BackupSummary> {
  const { out, api, state, signal, repository } = ctx;
  const concurrency = Math.max(1, options.concurrency ?? UPLOAD_CONCURRENCY);
  const source = await validateSource(sourceInput);

  let uploadedBytes = 0;
  let uploadedChunks = 0;

  out.line(out.bold("BrokenVault"));
  out.line();

  try {
    out.line(`Scanning ${sourceInput}...`);
    const scan = await scanFolder(source, (directories, files) => {
      throwIfInterrupted(signal);
      out.status(`  scanned ${formatCount(directories)} directories, ${formatCount(files)} files`);
    });
    out.clearStatus();
    reportScanProblems(out, scan);

    out.line(`  scanned ${formatCount(scan.directoryCount)} directories, ${formatCount(scan.fileCount)} files`);
    out.line(`  empty files: ${formatCount(scan.emptyFileCount)}`);
    out.line(`  empty directories: ${formatCount(scan.emptyDirectoryCount)}`);
    out.line(`  total size: ${formatBytes(scan.totalBytes)}`);
    out.line();

    out.line("Hashing...");
    const manifest = await buildManifest(scan, {
      signal,
      onProgress: (bytes) =>
        out.status(`  processed ${formatBytes(bytes)} of ${formatBytes(scan.totalBytes)}`),
    });
    out.clearStatus();
    out.line(`  processed ${formatBytes(scan.totalBytes)}`);
    out.line(`  chunks: ${formatCount(manifest.chunkOccurrences)} (${formatCount(manifest.chunkIndex.size)} unique)`);
    out.line();

    out.line("Checking server...");
    const { existing, missing: reportedMissing } = await api.checkChunks(
      [...manifest.chunkIndex.keys()],
      signal
    );
    const toUpload = reportedMissing.filter((hash) => manifest.chunkIndex.has(hash));
    const missingBytes = toUpload.reduce(
      (sum, hash) => sum + (manifest.chunkIndex.get(hash)?.length ?? 0),
      0
    );
    out.line(`  existing chunks: ${formatCount(existing.size)}`);
    out.line(`  missing chunks: ${formatCount(toUpload.length)}`);
    out.line();

    const key = stateKey(repository, source);
    const saved = await state.get(key);
    const reusable =
      saved !== undefined &&
      !(saved.manifestUploaded && saved.manifestFingerprint !== manifest.fingerprint);

    const createSession = async () => {
      const created = await api.createUpload(signal);
      await state.set(key, {
        uploadId: created.uploadId,
        versionId: created.versionId,
        manifestFingerprint: null,
        manifestUploaded: false,
      });
      return created;
    };

    let session;
    let resumed = false;
    let manifestUploaded = false;

    if (saved !== undefined && reusable) {
      session = { uploadId: saved.uploadId, versionId: saved.versionId };
      resumed = true;
      manifestUploaded = saved.manifestUploaded;
      out.line(`Resuming unfinished upload ${session.uploadId}`);
    } else {
      session = await createSession();
      out.line(`Upload session ${session.uploadId}`);
    }

    if (toUpload.length > 0) {
      out.line("Uploading...");
      const bar = out.progress(missingBytes);
      let handledBytes = 0;
      let next = 0;
      let failed = false;

      const worker = async () => {
        while (!failed) {
          try {
            throwIfInterrupted(signal);

            const index = next++;
            const hash = toUpload[index];
            if (hash === undefined) return;

            const location = manifest.chunkIndex.get(hash);
            if (location === undefined) return;

            const data = await readChunkBytes(location.absPath, location.offset, location.length);

            if (sha256Hex(data) !== hash) {
              throw new CliError(`File changed while it was being backed up: ${location.absPath}`, {
                hint: "Backups need files to stay unchanged. Run the backup again.",
              });
            }

            const result = await api.putChunk(hash, data, signal);

            if (result === "stored") {
              uploadedBytes += data.length;
              uploadedChunks++;
            }

            handledBytes += data.length;
            bar.update(handledBytes, `${formatBytes(uploadedBytes)} uploaded`);
            options.hooks?.afterChunkUploaded?.(uploadedChunks);
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, toUpload.length) }, worker));
      bar.finish(`${formatBytes(uploadedBytes)} uploaded`);
      out.line();
    } else {
      out.line("Nothing to upload: the server already has every chunk.");
      out.line();
    }

    out.line("Creating snapshot...");

    const finish = async (
      current: { uploadId: string; versionId: string },
      allowStale: boolean
    ): Promise<{ versionId: string } | "stale"> => {
      try {
        if (!manifestUploaded) {
          await api.putManifest(current.uploadId, manifest.entries, signal);
          manifestUploaded = true;
          await state.set(key, {
            uploadId: current.uploadId,
            versionId: current.versionId,
            manifestFingerprint: manifest.fingerprint,
            manifestUploaded: true,
          });
        }

        return await api.commit(current.uploadId, signal);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;

        if (error.status === 400) {
          const versions = await api.listVersions(signal);
          if (versions.some((version) => version.id === current.versionId)) {
            return { versionId: current.versionId };
          }
        }

        if (allowStale && [400, 404, 409, 500].includes(error.status)) {
          return "stale";
        }

        if (error.status === 409) {
          throw new CliError(`Cannot finish the snapshot: the server is missing chunks.\n${formatApiError(error)}`);
        }

        throw new CliError(formatApiError(error));
      }
    };

    let outcome = await finish(session, resumed);

    if (outcome === "stale") {
      out.warn("the earlier upload can no longer be continued; starting a new one (stored chunks are kept).");
      session = await createSession();
      resumed = false;
      manifestUploaded = false;
      outcome = await finish(session, false);
    }

    if (outcome === "stale") {
      throw new CliError("Could not complete the snapshot.");
    }

    await state.delete(key);

    const reusedBytes = scan.totalBytes - uploadedBytes;

    out.line(`  uploaded: ${formatBytes(uploadedBytes)}`);
    out.line(`  reused:   ${formatBytes(reusedBytes)}`);
    out.line();
    out.line(`snapshot ${out.bold(outcome.versionId)} saved`);
    out.line();
    out.line(out.green("Backup complete."));

    return {
      snapshotId: outcome.versionId,
      uploadId: session.uploadId,
      resumed,
      totalBytes: scan.totalBytes,
      files: scan.fileCount,
      directories: scan.directoryCount,
      chunkOccurrences: manifest.chunkOccurrences,
      uniqueChunks: manifest.chunkIndex.size,
      existingChunks: existing.size,
      missingChunks: toUpload.length,
      uploadedChunks,
      uploadedBytes,
      reusedBytes,
    };
  } catch (error) {
    if (error instanceof InterruptedError) {
      throw new InterruptedError(
        `Backup interrupted after uploading ${formatBytes(uploadedBytes)} (${formatCount(uploadedChunks)} chunks).`,
        "The snapshot stays unfinished and hidden. Run the same backup command again to resume."
      );
    }
    throw error;
  }
}

export async function backupCommand(ctx: CommandContext, args: string[]): Promise<void> {
  const [folder, ...extra] = args;

  if (folder === undefined || extra.length > 0) {
    throw new CliError("Usage: brokenvault backup <folder>", { exitCode: 2 });
  }

  await runBackup(ctx, folder);
}
