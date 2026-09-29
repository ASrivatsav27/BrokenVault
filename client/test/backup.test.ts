import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { CHUNK_SIZE } from "../src/config.js";
import { runBackup } from "../src/commands/backup.js";
import { runRestore } from "../src/commands/restore.js";
import { CliError, InterruptedError } from "../src/errors.js";
import { stateKey } from "../src/state.js";
import { MockServer } from "./helpers/mockServer.js";
import { assertSameTree, createDataset, makeContext, removeDir, tempDir } from "./helpers/util.js";

let server: MockServer;
let work: string;
let source: string;
let stateFile: string;

beforeEach(async () => {
  server = await new MockServer().start();
  work = await tempDir();
  source = path.join(work, "source");
  stateFile = path.join(work, "state.json");
  await mkdir(source);
  await createDataset(source);
});

afterEach(async () => {
  await server.stop();
  await removeDir(work);
});

const storedBytes = () => [...server.chunks.values()].reduce((sum, chunk) => sum + chunk.length, 0);

test("first backup: counts are consistent and the snapshot restores exactly", async () => {
  const ctx = makeContext(server.url, stateFile);
  const summary = await runBackup(ctx, source);

  assert.equal(server.completedVersions().length, 1);
  assert.equal(summary.uploadedBytes, storedBytes());
  assert.equal(summary.reusedBytes, summary.totalBytes - summary.uploadedBytes);
  assert.equal(server.chunkPuts.length, summary.uniqueChunks, "each unique chunk sent once");

  const restored = path.join(work, "restored");
  await runRestore(ctx, summary.snapshotId, restored);
  await assertSameTree(source, restored, assert.equal);
});

test("duplicate content inside one backup is uploaded once", async () => {
  const dir = path.join(work, "dups");
  await mkdir(dir);
  const content = Buffer.alloc(CHUNK_SIZE * 2, 7);
  await writeFile(path.join(dir, "a.bin"), content);
  await writeFile(path.join(dir, "b.bin"), content);

  const summary = await runBackup(makeContext(server.url, stateFile), dir);

  assert.equal(summary.chunkOccurrences, 4);
  assert.equal(summary.uniqueChunks, 1);
  assert.equal(summary.uploadedBytes, CHUNK_SIZE);
  assert.equal(server.chunkPuts.length, 1);
});

test("an unchanged second backup uploads nothing", async () => {
  const ctx = makeContext(server.url, stateFile);
  const first = await runBackup(ctx, source);
  const putsAfterFirst = server.chunkPuts.length;

  const second = await runBackup(ctx, source);

  assert.equal(second.uploadedBytes, 0);
  assert.equal(second.uploadedChunks, 0);
  assert.equal(second.missingChunks, 0);
  assert.equal(second.existingChunks, second.uniqueChunks);
  assert.equal(second.reusedBytes, second.totalBytes);
  assert.equal(server.chunkPuts.length, putsAfterFirst);
  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.equal(server.completedVersions().length, 2);
});

test("a modified file and a new file upload only their new chunks", async () => {
  const ctx = makeContext(server.url, stateFile);
  await runBackup(ctx, source);

  const large = path.join(source, "assets", "large.bin");
  const data = await readFile(large);
  data[10] = data[10]! ^ 0xff;
  await writeFile(large, data);
  await writeFile(path.join(source, "docs", "new.txt"), "new file");

  const second = await runBackup(ctx, source);

  assert.equal(second.missingChunks, 2);
  assert.equal(second.uploadedChunks, 2);
  assert.equal(second.uploadedBytes, CHUNK_SIZE + "new file".length);
});

test("an interrupted upload stays hidden and resumes on the same upload without resending", async () => {
  const controller = new AbortController();
  server.onChunkStored = (count) => {
    if (count === 3) controller.abort();
  };

  const interrupted = makeContext(server.url, stateFile, controller.signal);
  await assert.rejects(runBackup(interrupted, source, { concurrency: 1 }), InterruptedError);

  assert.equal(server.completedVersions().length, 0);
  assert.deepEqual(await interrupted.api.listVersions(), [], "unfinished version is not listed");
  assert.equal(server.storedCount, 3);

  const saved = await interrupted.state.get(stateKey(server.url, await (await import("node:fs/promises")).realpath(source)));
  assert.ok(saved, "upload state was saved");
  assert.equal(saved.manifestUploaded, false);

  server.onChunkStored = undefined;
  const summary = await runBackup(makeContext(server.url, stateFile), source);

  assert.equal(summary.resumed, true);
  assert.equal(summary.uploadId, saved.uploadId);
  assert.equal(server.createUploadCount, 1, "no second upload was created");
  assert.equal(summary.existingChunks, 3);
  assert.equal(new Set(server.chunkPuts).size, server.chunkPuts.length, "no chunk was sent twice");
  assert.equal(server.completedVersions().length, 1);

  const restored = path.join(work, "restored");
  await runRestore(makeContext(server.url, stateFile), summary.snapshotId, restored);
  await assertSameTree(source, restored, assert.equal);
});

test("if the server lost the unfinished upload, the client starts a new one and still completes", async () => {
  const controller = new AbortController();
  server.onChunkStored = (count) => {
    if (count === 2) controller.abort();
  };
  await assert.rejects(
    runBackup(makeContext(server.url, stateFile, controller.signal), source, { concurrency: 1 }),
    InterruptedError
  );

  const port = Number(new URL(server.url).port);
  await server.stop();
  server = await new MockServer().start(port);

  const summary = await runBackup(makeContext(server.url, stateFile), source);

  assert.equal(summary.resumed, false);
  assert.equal(server.createUploadCount, 1);
  assert.equal(server.completedVersions().length, 1);
});

test("an empty folder can be backed up", async () => {
  const empty = path.join(work, "empty");
  await mkdir(empty);
  const summary = await runBackup(makeContext(server.url, stateFile), empty);
  assert.equal(summary.totalBytes, 0);
  assert.equal(server.completedVersions().length, 1);
});

test("invalid source paths are rejected with clear errors", async () => {
  const ctx = makeContext(server.url, stateFile);
  await assert.rejects(runBackup(ctx, path.join(work, "nope")), (e: unknown) => e instanceof CliError && /not found/.test(e.message));
  await assert.rejects(runBackup(ctx, path.join(source, "README.txt")), (e: unknown) => e instanceof CliError && /not a folder/.test(e.message));
  assert.equal(server.createUploadCount, 0, "nothing was created on the server");
});
