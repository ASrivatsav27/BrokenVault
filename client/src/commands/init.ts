import type { CommandContext } from "../context.js";
import { saveConfig } from "../config.js";
import { CliError } from "../errors.js";

export async function initCommand(ctx: CommandContext, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError("Usage: brokenvault init", { exitCode: 2 });
  }

  const { out, api, repository, signal } = ctx;

  out.line(out.bold("BrokenVault"));
  out.line();
  out.line(`Contacting ${repository}...`);

  const versions = await api.listVersions(signal);
  const configFile = await saveConfig({ repository });

  out.line(`  server is reachable and speaks the BrokenVault API`);
  out.line(`  completed snapshots: ${versions.length}`);
  out.line();
  out.line(`Repository saved to ${configFile}`);
  out.line(out.green("Ready."));
}
