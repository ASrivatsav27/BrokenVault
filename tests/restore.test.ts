import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { runBackup } from "../client/src/commands/backup.js";
import { runRestore } from "../client/src/commands/restore.js";
import { CliError } from "../client/src/errors.js";
import { assertSameTree, makeContext, removeDir, tempDir } from "../client/test/helpers/util.js";
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

async function backedUp(name: string) {
  const source = path.join(work, `${name}-source`);
  await mkdir(source);
  const dataset = await createDataset(source);
  const ctx = makeContext(server.url, path.join(work, `${name}-state.json`));
  const summary = await runBackup(ctx, source);
  return { source, dataset, ctx, snapshotId: summary.snapshotId };
}

test("restore recreates paths, empty items, file bytes and modification times exactly", LONG, async () => {
  const { source, ctx, snapshotId } = await backedUp("exact");
  const restored = path.join(work, "exact-restored");

  await runRestore(ctx, snapshotId, restored);

  await assertSameTree(source, restored, assert.equal);
});

test("restore refuses corrupted or missing stored chunks, never writes them, and works again once repaired", LONG, async (t) => {
  const { source, dataset, ctx, snapshotId } = await backedUp("damage");
  const chunkFile = chunkFilePath(dataset.helloChunk);

  try {
    await appendFile(chunkFile, "x");
    const corruptOut = path.join(work, "damage-corrupt");

    await assert.rejects(runRestore(ctx, snapshotId, corruptOut), (e: unknown) => {
      assert.ok(e instanceof CliError);
      assert.match(e.message, /corrupted/);
      assert.ok(e.message.includes(dataset.helloPath), "names the file");
      assert.ok(e.message.includes(dataset.helloChunk), "names the chunk");
      assert.match(e.message, /actual:\s+[0-9a-f]{64}/);
      return true;
    });
    await assert.rejects(readFile(path.join(corruptOut, "docs", "hello.txt")), "corrupted file was not written");

    await unlink(chunkFile);
    await assert.rejects(
      runRestore(ctx, snapshotId, path.join(work, "damage-missing")),
      (e: unknown) => e instanceof CliError && /missing/.test(e.message) && e.message.includes(dataset.helloPath)
    );
  } finally {
    await writeFile(chunkFile, dataset.helloBytes);
  }

  const repaired = path.join(work, "damage-repaired");
  await runRestore(ctx, snapshotId, repaired);
  await assertSameTree(source, repaired, assert.equal);
  t.diagnostic("chunk file repaired");
});
