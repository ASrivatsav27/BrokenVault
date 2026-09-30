import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { runBackup } from "../client/src/commands/backup.js";
import { makeContext, removeDir, tempDir } from "../client/test/helpers/util.js";
import { BackendServer } from "./helpers/backend.js";
import { createDataset } from "./helpers/data.js";

const LONG = { timeout: 300_000 };

let server: BackendServer;
let work: string;

before(async () => {
  server = await BackendServer.start();
  work = await tempDir();
}, { timeout: 120_000 });

after(async () => {
  await server.stop();
  await removeDir(work);
});

test("backup stores nested folders, an empty file and an empty folder as one completed snapshot", LONG, async () => {
  const source = path.join(work, "source");
  await mkdir(source);
  await createDataset(source);

  const ctx = makeContext(server.url, path.join(work, "state.json"));
  const summary = await runBackup(ctx, source);

  assert.equal(summary.files, 7);
  assert.equal(summary.directories, 6);
  assert.equal(summary.uploadedBytes, summary.totalBytes, "all content was new to the server");
  assert.equal(summary.reusedBytes, 0);

  const listed = (await ctx.api.listVersions()).find((v) => v.id === summary.snapshotId);
  assert.ok(listed, "completed snapshot is listed");
  assert.equal(listed.status, "completed");
  assert.equal(listed.totalBytes, summary.totalBytes);
});

test("the server rejects unsafe or malformed manifests and accepts empty files and folders", LONG, async () => {
  const ctx = makeContext(server.url, path.join(work, "state-manifest.json"));
  const session = await ctx.api.createUpload();
  const put = (entries: unknown[]) =>
    fetch(`${server.url}/uploads/${session.uploadId}/manifest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });

  const mtime = "2026-01-15T10:30:00.000Z";
  const entry = (over: Record<string, unknown> = {}) => ({ path: "a.txt", type: "file", size: 0, mtime, chunks: [], ...over });
  const ghost = "0".repeat(64);

  const bad: Array<[string, unknown[]]> = [
    ["absolute Windows path", [entry({ path: "C:\\Users\\test.txt" })]],
    ["absolute Unix path", [entry({ path: "/etc/passwd" })]],
    ["../ escape", [entry({ path: "../secret.txt" })]],
    ["nested .. escape", [entry({ path: "folder/../../secret.txt" })]],
    ["duplicate path", [entry(), entry()]],
    ["invalid type", [entry({ type: "symlink" })]],
    ["invalid mtime", [entry({ mtime: "not-a-date" })]],
    ["negative size", [entry({ size: -1 })]],
    ["chunk that does not exist", [entry({ size: 5, chunks: [ghost] })]],
    ["malformed chunk ID", [entry({ size: 5, chunks: ["ABC"] })]],
    ["empty path", [entry({ path: "" })]],
  ];

  for (const [name, entries] of bad) {
    assert.equal((await put(entries)).status, 400, name);
  }

  const good = await put([
    { path: "empty-dir", type: "directory", size: 0, mtime },
    { path: "empty.txt", type: "file", size: 0, mtime, chunks: [] },
  ]);
  assert.equal(good.status, 201);

  const { versionId } = await ctx.api.commit(session.uploadId);
  assert.ok((await ctx.api.listVersions()).some((v) => v.id === versionId));
});
