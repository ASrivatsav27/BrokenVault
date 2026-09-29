import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliError, isFsError } from "./errors.js";

export const DEFAULT_REPOSITORY = "http://localhost:8000";

// Fixed-size chunking. Changing this value makes new backups stop matching
// chunks stored by older ones, so treat it as part of the storage format.
export const CHUNK_SIZE = 256 * 1024;

// The server stores sizes in a 32-bit integer column.
export const MAX_FILE_SIZE = 2_147_483_647;

export const UPLOAD_CONCURRENCY = 6;
export const CHECK_BATCH_SIZE = 1000;

export function homeDir(): string {
  return process.env.BROKENVAULT_HOME ?? path.join(os.homedir(), ".brokenvault");
}

export function normalizeRepositoryUrl(input: string): string {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new CliError(`Invalid repository URL: ${input}`, {
      hint: "Use the server address, for example http://localhost:8000",
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(`Unsupported repository protocol "${url.protocol}"`, {
      hint: "The repository must be an http:// or https:// server URL.",
    });
  }

  return url.toString().replace(/\/+$/, "");
}

export async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isFsError(error, "ENOENT") || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), "utf8");
  await rename(temp, file);
}

interface ConfigFile {
  repository?: string;
}

function configPath(): string {
  return path.join(homeDir(), "config.json");
}

export async function loadConfig(): Promise<ConfigFile> {
  const data = await readJsonFile(configPath());
  if (typeof data === "object" && data !== null && "repository" in data) {
    const repository = (data as { repository: unknown }).repository;
    if (typeof repository === "string") {
      return { repository };
    }
  }
  return {};
}

export async function saveConfig(config: { repository: string }): Promise<string> {
  await writeJsonAtomic(configPath(), config);
  return configPath();
}

export async function resolveRepository(option: string | undefined): Promise<string> {
  if (option !== undefined) {
    return normalizeRepositoryUrl(option);
  }

  const fromEnv = process.env.BROKENVAULT_REPOSITORY;
  if (fromEnv) {
    return normalizeRepositoryUrl(fromEnv);
  }

  const saved = (await loadConfig()).repository;
  return normalizeRepositoryUrl(saved ?? DEFAULT_REPOSITORY);
}
