import assert from "node:assert/strict";
import { appendFile, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { runBackup } from "../client/src/commands/backup.js";
import { runVerify } from "../client/src/commands/verify.js";
import { CliError } from "../client/src/errors.js";
import { makeContext, removeDir, tempDir } from "../client/test/helpers/util.js";
import { BackendServer } from "./helpers/backend.js";
import { chunkFilePath, createDataset } from "./helpers/data.js";

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

test("verify finds corrupted and missing chunks and names every affected snapshot and file, then clears after repair", LONG, async () => {
  const source = path.join(work, "source");
  await mkdir(source);
  const dataset = await createDataset(source);
  const ctx = makeContext(server.url, path.join(work, "state.json"));

  const first = await runBackup(ctx, source);
  const second = await runBackup(ctx, source);
  const chunkFile = chunkFilePath(dataset.helloChunk);

  const ours = async () => (await ctx.api.verify()).problems.find((p) => p.chunkId === dataset.helloChunk);

  assert.equal(await ours(), undefined, "healthy before any damage");

  try {
    await appendFile(chunkFile, "x");
    const corrupted = await ours();
    assert.equal(corrupted?.problem, "corrupted");

    for (const snapshotId of [first.snapshotId, second.snapshotId]) {
      const affected = corrupted?.affected.find((a) => a.versionId === snapshotId);
      assert.ok(affected, `snapshot ${snapshotId} is reported`);
      assert.ok(affected.paths.includes(dataset.helloPath), "file path is reported");
    }

    await assert.rejects(runVerify(ctx), (e: unknown) => e instanceof CliError && /damaged/.test(e.message));

    await unlink(chunkFile);
    const missing = await ours();
    assert.equal(missing?.problem, "missing");
    assert.ok(missing?.affected.some((a) => a.versionId === first.snapshotId));
  } finally {
    await writeFile(chunkFile, dataset.helloBytes);
  }

  assert.equal(await ours(), undefined, "clean again after the chunk is restored");
});

test("verify does not repair anything", LONG, async () => {
  const source = path.join(work, "no-repair");
  await mkdir(source);
  const dataset = await createDataset(source);
  const ctx = makeContext(server.url, path.join(work, "no-repair-state.json"));
  await runBackup(ctx, source);
  const chunkFile = chunkFilePath(dataset.helloChunk);

  try {
    await unlink(chunkFile);
    await ctx.api.verify();
    await ctx.api.verify();
    const stillMissing = (await ctx.api.verify()).problems.find((p) => p.chunkId === dataset.helloChunk);
    assert.equal(stillMissing?.problem, "missing", "still missing after verifying three times");
  } finally {
    await writeFile(chunkFile, dataset.helloBytes);
  }
});
