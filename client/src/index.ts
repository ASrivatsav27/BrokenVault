#!/usr/bin/env node
import { parseArgs } from "node:util";

import { ApiClient } from "./api.js";
import { backupCommand } from "./commands/backup.js";
import { initCommand } from "./commands/init.js";
import { restoreCommand } from "./commands/restore.js";
import { snapshotsCommand } from "./commands/snapshots.js";
import { verifyCommand } from "./commands/verify.js";
import { resolveRepository, DEFAULT_REPOSITORY } from "./config.js";
import type { CommandContext } from "./context.js";
import { ApiError, CliError, formatApiError } from "./errors.js";
import { Output } from "./output.js";
import { StateStore } from "./state.js";

const USAGE = `Usage: brokenvault [-r <server-url>] <command>

Commands:
  init                              check the server and remember it
  backup <folder>                   back up a folder (resumes an unfinished upload)
  snapshots                         list completed snapshots
  restore <snapshot-id> <folder>    restore a snapshot into an empty folder
  verify                            check stored data for missing or corrupted chunks

Options:
  -r, --repository <url>            BrokenVault server (default: ${DEFAULT_REPOSITORY},
                                    or BROKENVAULT_REPOSITORY, or the URL saved by init)
  -h, --help                        show this help`;

type Command = (ctx: CommandContext, args: string[]) => Promise<void>;

const COMMANDS: Record<string, Command> = {
  init: initCommand,
  backup: backupCommand,
  snapshots: snapshotsCommand,
  restore: restoreCommand,
  verify: verifyCommand,
};

async function main(argv: string[]): Promise<number> {
  const out = new Output();

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 3)) {
    out.error(`Node.js 20.3 or newer is required (found ${process.versions.node}).`);
    return 1;
  }

  let parsed;

  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repository: { type: "string", short: "r" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error));
    out.hint(USAGE);
    return 2;
  }

  const [name, ...args] = parsed.positionals;

  if (parsed.values.help || name === undefined) {
    out.line(USAGE);
    return name === undefined && !parsed.values.help ? 2 : 0;
  }

  const command = COMMANDS[name];

  if (command === undefined) {
    out.error(`Unknown command "${name}".`);
    out.hint(USAGE);
    return 2;
  }

  const controller = new AbortController();
  let interrupts = 0;

  process.on("SIGINT", () => {
    interrupts++;
    if (interrupts > 1) {
      process.exit(130);
    }
    out.line("\nInterrupting... (press Ctrl+C again to force quit)");
    controller.abort();
  });

  try {
    const repository = await resolveRepository(parsed.values.repository);

    await command(
      {
        repository,
        api: new ApiClient(repository),
        state: new StateStore(),
        out,
        signal: controller.signal,
      },
      args
    );

    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      out.error(error.message);
      if (error.hint) out.hint(error.hint);
      return error.exitCode;
    }

    if (error instanceof ApiError) {
      out.error(formatApiError(error));
      return 1;
    }

    out.error("Unexpected error. Details for debugging:");
    console.error(error);
    return 1;
  }
}

const code = await main(process.argv.slice(2));

await Promise.all([
  new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
  new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
]);

process.exit(code);
