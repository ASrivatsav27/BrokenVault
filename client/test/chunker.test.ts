import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { chunkFile, readChunkBytes } from "../src/chunker.js";
import { CHUNK_SIZE } from "../src/config.js";
import { removeDir, tempDir } from "./helpers/util.js";

let dir: string;

before(async () => {
  dir = await tempDir();
});

after(() => removeDir(dir));

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("splits into fixed-size chunks with correct SHA-256 IDs and offsets", async () => {
  const data = randomBytes(CHUNK_SIZE * 2 + 1234);
  const file = path.join(dir, "a.bin");
  await writeFile(file, data);

  const chunks = [];
  for await (const chunk of chunkFile(file, data.length)) chunks.push(chunk);

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.length), [CHUNK_SIZE, CHUNK_SIZE, 1234]);
  assert.deepEqual(chunks.map((c) => c.offset), [0, CHUNK_SIZE, CHUNK_SIZE * 2]);
  for (const c of chunks) {
    assert.equal(c.hash, sha(data.subarray(c.offset, c.offset + c.length)));
    assert.ok((await readChunkBytes(file, c.offset, c.length)).equals(data.subarray(c.offset, c.offset + c.length)));
  }
});

test("chunking is deterministic and exact multiples produce no empty tail chunk", async () => {
  const data = randomBytes(CHUNK_SIZE * 2);
  const file = path.join(dir, "exact.bin");
  await writeFile(file, data);

  const run = async () => {
    const hashes: string[] = [];
    for await (const c of chunkFile(file, data.length)) hashes.push(c.hash);
    return hashes;
  };

  const first = await run();
  assert.equal(first.length, 2);
  assert.deepEqual(await run(), first);
});

test("empty files have no chunks", async () => {
  const file = path.join(dir, "empty");
  await writeFile(file, "");
  const chunks = [];
  for await (const c of chunkFile(file, 0)) chunks.push(c);
  assert.equal(chunks.length, 0);
});

test("a file that changed size is detected", async () => {
  const file = path.join(dir, "shrinks.bin");
  await writeFile(file, randomBytes(CHUNK_SIZE + 10));
  await assert.rejects(async () => {
    for await (const _ of chunkFile(file, CHUNK_SIZE + 10 + 5)) void _;
  }, /changed while it was being read/);
  await truncate(file, 5);
  await assert.rejects(readChunkBytes(file, 0, 100), /changed while it was being read/);
});
