import type { VerifyReport } from "../api.js";
import type { CommandContext } from "../context.js";
import { ApiError, CliError } from "../errors.js";
import { formatCount } from "../output.js";

export async function runVerify(ctx: CommandContext): Promise<VerifyReport> {
  const { out, api, signal } = ctx;

  out.line(out.bold("BrokenVault"));
  out.line();
  out.line("Verifying stored data...");

  let report: VerifyReport;

  try {
    report = await api.verify(signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new CliError("This server does not provide a verify endpoint (expected POST /verify).", {
        hint: "Verification is not implemented on the server yet, so no result can be reported.",
      });
    }
    throw error;
  }

  out.line(
    `  checked ${formatCount(report.versionsChecked)} snapshot(s), ${formatCount(report.chunksChecked)} chunk(s)`
  );
  out.line();

  if (report.healthy && report.problems.length === 0) {
    out.line(out.green("Repository is healthy."));
    return report;
  }

  const byVersion = new Map<string, Map<string, string[]>>();

  for (const problem of report.problems) {
    const label = `chunk ${problem.chunkId.slice(0, 12)}... ${problem.problem}`;

    for (const affected of problem.affected) {
      const files = byVersion.get(affected.versionId) ?? new Map<string, string[]>();

      for (const filePath of affected.paths) {
        files.set(filePath, [...(files.get(filePath) ?? []), label]);
      }

      byVersion.set(affected.versionId, files);
    }
  }

  const missing = report.problems.filter((problem) => problem.problem === "missing").length;
  const corrupted = report.problems.length - missing;

  out.line(out.red(`DAMAGE FOUND: ${missing} missing chunk(s), ${corrupted} corrupted chunk(s)`));

  for (const [versionId, files] of byVersion) {
    out.line();
    out.line(`snapshot ${versionId}`);

    for (const [filePath, labels] of files) {
      out.line(`  ${filePath}  (${labels.join("; ")})`);
    }
  }

  out.line();
  throw new CliError("Verification found damaged data. Nothing was repaired.");
}

export async function verifyCommand(ctx: CommandContext, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError("Usage: brokenvault verify", { exitCode: 2 });
  }

  await runVerify(ctx);
}
