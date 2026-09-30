import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { ApiError, InterruptedError } from "../client/src/errors.js";
import { runBackup } from "../client/src/commands/backup.js";
import { runRestore } from "../client/src/commands/restore.js";
import { stateKey } from "../client/src/state.js";
import { assertSameTree, makeContext, removeDir, tempDir } from "../client/test/helpers/util.js";
import { BackendServer, storageDir } from "./helpers/backend.js";
import { chunkFilePath, createDataset, sha256 } from "./helpers/data.js";

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

async function assertNothingRestored(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => []);
  assert.equal(entries.length, 0, "unfinished version wrote no files");
}

test("an interrupted upload stays hidden and unrestorable, and after both programs restart the same upload continues", LONG, async () => {
  const source = path.join(work, "source");
  const stateFile = path.join(work, "state.json");
  await mkdir(source);
  const dataset = await createDataset(source, 12 * 1024 * 1024);

  // 1. interrupt during upload (like Ctrl+C)
  const controller = new AbortController();
  const interrupted = makeContext(server.url, stateFile, controller.signal);

  await assert.rejects(
    runBackup(interrupted, source, {
      concurrency: 1,
      hooks: { afterChunkUploaded: (n) => { if (n === 10) controller.abort(); } },
    }),
    InterruptedError
  );

  // 2. the unfinished version is hidden and cannot be restored
  const saved = await interrupted.state.get(stateKey(server.url, await realpath(source)));
  assert.ok(saved, "upload state was saved for the client");
  assert.equal(saved.manifestUploaded, false);

  assert.ok(!(await interrupted.api.listVersions()).some((v) => v.id === saved.versionId), "not listed");

  const attempt = path.join(work, "unfinished-restore");
  await assert.rejects(
    interrupted.api.restore(saved.versionId, attempt),
    (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500
  );
  await assertNothingRestored(attempt);

  // 3. restart the server (and use brand-new client objects below)
  if (server.managed) {
    await server.restart();
  }

  // 4. resume: same upload, only what is missing
  const resumed = await runBackup(makeContext(server.url, stateFile), source);

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.uploadId, saved.uploadId, "the same upload was continued");
  assert.ok(resumed.existingChunks >= 10, "chunks uploaded before the stop were not asked for again");
  assert.equal(resumed.uploadedChunks, resumed.missingChunks);
  assert.ok(resumed.uploadedBytes < resumed.totalBytes, "did not re-send everything");

  const ctx = makeContext(server.url, stateFile);
  assert.ok((await ctx.api.listVersions()).some((v) => v.id === resumed.snapshotId), "completed and listed");

  const restored = path.join(work, "resumed-restored");
  await runRestore(ctx, resumed.snapshotId, restored);
  await assertSameTree(source, restored, assert.equal);

  // 5. sending a chunk again is harmless and does not create a second copy
  const onDisk = existsSync(storageDir);
  assert.equal(await ctx.api.putChunk(dataset.helloChunk, dataset.helloBytes), "already_exists");
  assert.equal(await ctx.api.putChunk(dataset.helloChunk, dataset.helloBytes), "already_exists");
  if (onDisk) {
    assert.equal((await stat(chunkFilePath(dataset.helloChunk))).size, dataset.helloBytes.length);
    assert.equal(sha256(await readFile(chunkFilePath(dataset.helloChunk))), dataset.helloChunk);
  }
});

test("a chunk sent twice to a fresh server is stored once", LONG, async () => {
  const ctx = makeContext(server.url, path.join(work, "dup-state.json"));
  const bytes = randomBytes(4096);
  const hash = sha256(bytes);

  assert.equal(await ctx.api.putChunk(hash, bytes), "stored");
  assert.equal(await ctx.api.putChunk(hash, bytes), "already_exists");

  const { existing, missing } = await ctx.api.checkChunks([hash]);
  assert.equal(existing.has(hash), true);
  assert.equal(missing.length, 0);
});
