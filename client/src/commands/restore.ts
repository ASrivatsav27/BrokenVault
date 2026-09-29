import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { VersionSummary } from "../api.js";
import type { CommandContext } from "../context.js";
import {
  ApiError,
  CliError,
  describeFsError,
  formatApiError,
  isFsError,
} from "../errors.js";
import { formatBytes } from "../output.js";
import { isLoopbackHost } from "../paths.js";

export function resolveSnapshot(versions: VersionSummary[], input: string): VersionSummary {
  const exact = versions.find((version) => version.id === input);
  if (exact) return exact;

  const matches = versions.filter((version) => version.id.startsWith(input));

  if (matches.length === 1 && input.length >= 4) {
    return matches[0] as VersionSummary;
  }

  if (matches.length > 1) {
    throw new CliError(`Snapshot ID "${input}" matches ${matches.length} snapshots.`, {
      hint: "Use more characters of the ID.",
    });
  }

  throw new CliError(`No completed snapshot matches "${input}".`, {
    hint: "Run 'brokenvault snapshots' to list snapshot IDs.",
  });
}

export async function prepareOutputFolder(input: string): Promise<string> {
  const resolved = path.resolve(input);
  let info;

  try {
    info = await stat(resolved);
  } catch (error) {
    if (isFsError(error, "ENOENT")) {
      return resolved;
    }
    throw new CliError(`Cannot access output folder ${input}: ${describeFsError(error)}`);
  }

  if (!info.isDirectory()) {
    throw new CliError(`Output path exists and is not a folder: ${input}`);
  }

  let entries: string[];

  try {
    entries = await readdir(resolved);
  } catch (error) {
    throw new CliError(`Cannot read output folder ${input}: ${describeFsError(error)}`);
  }

  if (entries.length > 0) {
    throw new CliError(`Output folder is not empty: ${input}`, {
      hint: "Restore into an empty or new folder.",
    });
  }

  return resolved;
}

function explainRestoreError(error: unknown, snapshotId: string): unknown {
  if (!(error instanceof ApiError)) return error;

  const body = typeof error.body === "object" && error.body !== null ? (error.body as Record<string, unknown>) : {};

  if (error.status === 409 && (body.code === "chunk_missing" || body.code === "chunk_corrupted")) {
    const lines = [
      body.code === "chunk_missing"
        ? "Restore stopped: stored data is missing."
        : "Restore stopped: stored data is corrupted.",
      `  snapshot: ${snapshotId}`,
      `  file:     ${String(body.path)}`,
      `  chunk:    ${String(body.chunkId)}`,
    ];

    if (body.code === "chunk_corrupted") {
      lines.push(`  expected: ${String(body.expectedHash)}`);
      lines.push(`  actual:   ${String(body.actualHash)}`);
    }

    return new CliError(lines.join("\n"), {
      hint: "Corrupted data is never restored and nothing is repaired automatically.",
    });
  }

  if (error.status === 404) {
    return new CliError(`Snapshot not found on the server: ${snapshotId}`);
  }

  return new CliError(formatApiError(error));
}

export async function runRestore(
  ctx: CommandContext,
  snapshotInput: string,
  outputInput: string
): Promise<void> {
  const { out, api, signal } = ctx;

  if (!isLoopbackHost(new URL(ctx.repository).hostname)) {
    throw new CliError("Restore currently only works when the server runs on this machine.", {
      hint: "The server writes the restored files itself, so a remote server would write to its own disk.",
    });
  }

  const versions = await api.listVersions(signal);
  const snapshot = resolveSnapshot(versions, snapshotInput);
  const outputPath = await prepareOutputFolder(outputInput);

  out.line(out.bold("BrokenVault"));
  out.line();
  out.line(`Restoring snapshot ${snapshot.id} (${formatBytes(snapshot.totalBytes)})`);
  out.line(`  to ${outputPath}`);

  const started = Date.now();
  const timer = setInterval(() => {
    out.status(`  restoring and verifying chunk hashes... ${Math.round((Date.now() - started) / 1000)}s`, true);
  }, 500);

  try {
    await api.restore(snapshot.id, outputPath, signal);
  } catch (error) {
    throw explainRestoreError(error, snapshot.id);
  } finally {
    clearInterval(timer);
    out.clearStatus();
  }

  out.line();
  out.line(`snapshot ${out.bold(snapshot.id)} restored to ${outputPath}`);
  out.line(out.green("Restore complete."));
}

export async function restoreCommand(ctx: CommandContext, args: string[]): Promise<void> {
  const [snapshot, output, ...extra] = args;

  if (snapshot === undefined || output === undefined || extra.length > 0) {
    throw new CliError("Usage: brokenvault restore <snapshot-id> <output-folder>", { exitCode: 2 });
  }

  await runRestore(ctx, snapshot, output);
}
