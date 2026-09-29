import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { scanFolder } from "../src/scanner.js";
import { createDataset, removeDir, tempDir } from "./helpers/util.js";

let root: string;

before(async () => {
  root = await tempDir();
  await createDataset(root);
});

after(() => removeDir(root));

test("scans nested folders, empty files and empty directories", async () => {
  const scan = await scanFolder(root);
  const paths = scan.items.map((item) => item.path);

  assert.ok(paths.includes("docs/deep/er/note.txt"));
  assert.ok(paths.includes("empty-folder"));
  assert.ok(paths.includes("empty.txt"));
  assert.ok(paths.includes("unicode dir/résumé ✓.txt"));

  assert.equal(scan.emptyFileCount, 1);
  assert.equal(scan.emptyDirectoryCount, 1);
  assert.equal(scan.directoryCount, 6);
  assert.equal(scan.errors.length, 0);
  assert.equal(scan.items.find((i) => i.path === "empty-folder")?.type, "directory");
  assert.equal(scan.items.find((i) => i.path === "empty.txt")?.size, 0);
});

test("paths are relative, use forward slashes and are sorted deterministically", async () => {
  const scan = await scanFolder(root);
  const paths = scan.items.map((item) => item.path);

  for (const p of paths) {
    assert.ok(!path.isAbsolute(p) && !p.includes("\\") && !p.split("/").includes(".."));
  }
  assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

test("hidden files and node_modules are not excluded", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(dir, ".hidden"), "x");
    await writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "y");
    const paths = (await scanFolder(dir)).items.map((i) => i.path);
    assert.ok(paths.includes(".hidden"));
    assert.ok(paths.includes("node_modules/pkg/index.js"));
  } finally {
    await removeDir(dir);
  }
});

test("symbolic links are reported as skipped, never followed silently", async (t) => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "real.txt"), "x");
    try {
      await symlink(path.join(dir, "real.txt"), path.join(dir, "link.txt"));
    } catch {
      t.skip("symlinks not permitted here");
      return;
    }
    const scan = await scanFolder(dir);
    assert.deepEqual(scan.items.map((i) => i.path), ["real.txt"]);
    assert.deepEqual(scan.skipped.map((i) => i.path), ["link.txt"]);
  } finally {
    await removeDir(dir);
  }
});

test("names the server cannot accept are reported as errors", async (t) => {
  if (process.platform === "win32") {
    t.skip("backslashes cannot appear in Windows names");
    return;
  }
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "back\\slash.txt"), "x");
    const scan = await scanFolder(dir);
    assert.equal(scan.errors.length, 1);
    assert.match(scan.errors[0]!.message, /backslash/);
  } finally {
    await removeDir(dir);
  }
});
