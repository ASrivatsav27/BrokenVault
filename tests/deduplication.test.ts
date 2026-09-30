import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { runBackup } from "../client/src/commands/backup.js";
import { runRestore } from "../client/src/commands/restore.js";
import { CHUNK_SIZE } from "../client/src/config.js";
import { assertSameTree, makeContext, removeDir, tempDir } from "../client/test/helpers/util.js";
import { BackendServer, repoRoot, storageDir } from "./helpers/backend.js";
import { chunkFilePath, createDataset } from "./helpers/data.js";

const LONG = { timeout: 600_000 };

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

test("an unchanged second backup uploads nothing", LONG, async () => {
  const source = path.join(work, "unchanged");
  await mkdir(source);
  const dataset = await createDataset(source);
  const ctx = makeContext(server.url, path.join(work, "unchanged-state.json"));

  const first = await runBackup(ctx, source);
  const second = await runBackup(ctx, source);

  assert.equal(first.uploadedBytes, first.totalBytes);
  assert.equal(second.uploadedBytes, 0);
  assert.equal(second.missingChunks, 0);
  assert.equal(second.existingChunks, second.uniqueChunks);
  assert.equal(second.reusedBytes, second.totalBytes);
  assert.notEqual(second.snapshotId, first.snapshotId, "each backup is its own snapshot");

  if (existsSync(storageDir)) {
    const stored = await readFile(chunkFilePath(dataset.helloChunk));
    assert.ok(stored.equals(dataset.helloBytes), "the shared chunk is stored once, intact");
  }
});

test("a modified file and a new file upload only their new chunks", LONG, async () => {
  const source = path.join(work, "modified");
  await mkdir(source);
  await createDataset(source);
  const ctx = makeContext(server.url, path.join(work, "modified-state.json"));
  await runBackup(ctx, source);

  const large = path.join(source, "assets", "large.bin");
  const data = await readFile(large);
  data[10] = data[10]! ^ 0xff;
  await writeFile(large, data);
  const credits = `credits ${randomUUID()}`;
  await writeFile(path.join(source, "credits.txt"), credits);

  const second = await runBackup(ctx, source);

  assert.equal(second.missingChunks, 2, "one changed chunk plus the new file");
  assert.equal(second.uploadedBytes, CHUNK_SIZE + Buffer.byteLength(credits));
  assert.equal(second.reusedBytes, second.totalBytes - second.uploadedBytes);

  const restored = path.join(work, "modified-restored");
  await runRestore(ctx, second.snapshotId, restored);
  await assertSameTree(source, restored, assert.equal);
});

test("identical content inside one backup is uploaded once", LONG, async () => {
  const source = path.join(work, "dups");
  await mkdir(source);
  const content = randomBytes(CHUNK_SIZE * 2);
  await writeFile(path.join(source, "a.bin"), content);
  await writeFile(path.join(source, "b.bin"), content);

  const summary = await runBackup(makeContext(server.url, path.join(work, "dups-state.json")), source);

  assert.equal(summary.chunkOccurrences, 4);
  assert.equal(summary.uniqueChunks, 2);
  assert.equal(summary.uploadedBytes, CHUNK_SIZE * 2);
  assert.equal(summary.totalBytes, CHUNK_SIZE * 4);
  assert.equal(summary.reusedBytes, CHUNK_SIZE * 2);
});

test("challenge sample dataset v1 then v2 (skipped when the sample folders are absent)", LONG, async (t) => {
  const v1 = process.env.BROKENVAULT_SAMPLE_V1 ?? path.join(repoRoot, "brokenvault_sample_v1");
  const v2 = process.env.BROKENVAULT_SAMPLE_V2 ?? path.join(repoRoot, "brokenvault_sample_v2");

  if (!existsSync(v1) || !existsSync(v2) || !(await stat(v1)).isDirectory()) {
    t.skip("sample folders not found (set BROKENVAULT_SAMPLE_V1 and BROKENVAULT_SAMPLE_V2)");
    return;
  }

  const ctx = makeContext(server.url, path.join(work, "sample-state.json"));
  const first = await runBackup(ctx, v1);
  const second = await runBackup(ctx, v2);

  assert.ok(second.uploadedBytes < second.totalBytes, "v2 sends less than its total size");
  assert.ok(second.uploadedBytes < second.totalBytes * 0.1, "v2 sends only the changed and new parts");
  assert.equal(second.reusedBytes, second.totalBytes - second.uploadedBytes);

  for (const [name, source, snapshotId] of [
    ["sample-v1", v1, first.snapshotId],
    ["sample-v2", v2, second.snapshotId],
  ] as const) {
    const restored = path.join(work, `${name}-restored`);
    await runRestore(ctx, snapshotId, restored);
    await assertSameTree(source, restored, assert.equal);
  }
});
