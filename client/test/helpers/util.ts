import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ApiClient } from "../../src/api.js";
import type { CommandContext } from "../../src/context.js";
import { Output } from "../../src/output.js";
import { StateStore } from "../../src/state.js";

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "bv-test-"));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function makeContext(
  repository: string,
  stateFile: string,
  signal: AbortSignal = new AbortController().signal
): CommandContext {
  return {
    repository,
    api: new ApiClient(repository, { retries: 1, retryDelayMs: 5 }),
    state: new StateStore(stateFile),
    out: new Output({ silent: true }),
    signal,
  };
}

// nested folders, unicode + spaces, binary, empty file, empty dir, duplicate content
export async function createDataset(root: string, largeBytes = 3 * 1024 * 1024): Promise<void> {
  await mkdir(path.join(root, "docs", "deep", "er"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "empty-folder"));
  await mkdir(path.join(root, "unicode dir"), { recursive: true });
  await writeFile(path.join(root, "docs", "hello.txt"), "hello brokenvault");
  await writeFile(path.join(root, "docs", "deep", "er", "note.txt"), "nested note");
  await writeFile(path.join(root, "unicode dir", "résumé ✓.txt"), "unicode content");
  await writeFile(path.join(root, "README.txt"), "test data");
  await writeFile(path.join(root, "empty.txt"), "");
  await writeFile(path.join(root, "assets", "binary.dat"), randomBytes(700 * 1024));
  await writeFile(path.join(root, "assets", "large.bin"), randomBytes(largeBytes));
}

export async function listTree(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(`${childRel}/`);
      out.push(...(await listTree(root, childRel)));
    } else {
      out.push(childRel);
    }
  }
  return out.sort();
}

export async function assertSameTree(
  expected: string,
  actual: string,
  assertEqual: (a: unknown, b: unknown, message?: string) => void
): Promise<void> {
  const expectedTree = await listTree(expected);
  assertEqual(JSON.stringify(await listTree(actual)), JSON.stringify(expectedTree), "same paths and empty items");

  for (const item of expectedTree) {
    if (item.endsWith("/")) continue;
    const a = await readFile(path.join(expected, item));
    const b = await readFile(path.join(actual, item));
    assertEqual(a.equals(b), true, `same bytes: ${item}`);
    const drift = Math.abs((await stat(path.join(expected, item))).mtimeMs - (await stat(path.join(actual, item))).mtimeMs);
    assertEqual(drift < 1000, true, `mtime within 1s: ${item} (drift ${drift}ms)`);
  }
}
