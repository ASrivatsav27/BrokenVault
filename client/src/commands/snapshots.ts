import type { CommandContext } from "../context.js";
import { CliError } from "../errors.js";
import { formatBytes, formatDate } from "../output.js";

export async function snapshotsCommand(ctx: CommandContext, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError("Usage: brokenvault snapshots", { exitCode: 2 });
  }

  const versions = await ctx.api.listVersions(ctx.signal);

  if (versions.length === 0) {
    ctx.out.line("No snapshots yet. Create one with: brokenvault backup <folder>");
    return;
  }

  const idWidth = Math.max("ID".length, ...versions.map((version) => version.id.length));
  const dateWidth = "2026-01-01 00:00".length;

  ctx.out.line(ctx.out.bold(`${"ID".padEnd(idWidth)}  ${"DATE".padEnd(dateWidth)}  SIZE`));

  for (const version of versions) {
    ctx.out.line(
      `${version.id.padEnd(idWidth)}  ${formatDate(version.createdAt).padEnd(dateWidth)}  ${formatBytes(version.totalBytes)}`
    );
  }

  ctx.out.line();
  ctx.out.line(`${versions.length} snapshot${versions.length === 1 ? "" : "s"}`);
}
