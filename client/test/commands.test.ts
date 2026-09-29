import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { ApiClient } from "../src/api.js";
import { runBackup } from "../src/commands/backup.js";
import { initCommand } from "../src/commands/init.js";
import { runRestore } from "../src/commands/restore.js";
import { snapshotsCommand } from "../src/commands/snapshots.js";
import { runVerify } from "../src/commands/verify.js";
import { CliError, NetworkError } from "../src/errors.js";
import { Output } from "../src/output.js";
import { MockServer } from "./helpers/mockServer.js";
import { createDataset, makeContext, removeDir, tempDir } from "./helpers/util.js";

const HELLO_CHUNK = "dd32ee6c6039bc5327ee5b829dea29e43456653b5dc9c68fa6ac873116ee91b8"; // "hello brokenvault"

let server: MockServer;
let work: string;
let source: string;
let stateFile: string;
let snapshotId: string;

function capture() {
  let text = "";
  const sink = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { out: new Output({ stdout: sink, stderr: sink, color: false, interactive: false }), text: () => text };
}

beforeEach(async () => {
  server = await new MockServer().start();
  work = await tempDir();
  source = path.join(work, "source");
  stateFile = path.join(work, "state.json");
  await mkdir(source);
  await createDataset(source, 512 * 1024);
  snapshotId = (await runBackup(makeContext(server.url, stateFile), source)).snapshotId;
});

afterEach(async () => {
  await server.stop();
  await removeDir(work);
});

test("snapshots lists completed versions with ID, date and size", async () => {
  const { out, text } = capture();
  await snapshotsCommand({ ...makeContext(server.url, stateFile), out }, []);
  assert.match(text(), /ID\s+DATE\s+SIZE/);
  assert.ok(text().includes(snapshotId));
  assert.match(text(), /1 snapshot\b/);
});

test("restore accepts a unique ID prefix and rejects unknown IDs", async () => {
  const ctx = makeContext(server.url, stateFile);
  await runRestore(ctx, snapshotId.slice(0, 8), path.join(work, "by-prefix"));
  assert.equal((await readFile(path.join(work, "by-prefix", "docs", "hello.txt"), "utf8")), "hello brokenvault");

  await assert.rejects(runRestore(ctx, "does-not-exist", path.join(work, "x")), (e: unknown) => e instanceof CliError && /No completed snapshot/.test(e.message));
});

test("restore refuses a non-empty output folder and a non-local server", async () => {
  const ctx = makeContext(server.url, stateFile);
  const full = path.join(work, "full");
  await mkdir(full);
  await writeFile(path.join(full, "keep.txt"), "x");
  await assert.rejects(runRestore(ctx, snapshotId, full), (e: unknown) => e instanceof CliError && /not empty/.test(e.message));

  const remote = makeContext("http://example.com:8000", stateFile);
  await assert.rejects(runRestore(remote, snapshotId, path.join(work, "y")), (e: unknown) => e instanceof CliError && /only works when the server runs on this machine/.test(e.message));
});

test("restore reports a corrupted chunk with file, chunk ID and both hashes, and does not write it", async () => {
  server.corruptChunk(HELLO_CHUNK);
  const output = path.join(work, "corrupt-out");

  await assert.rejects(runRestore(makeContext(server.url, stateFile), snapshotId, output), (e: unknown) => {
    assert.ok(e instanceof CliError);
    assert.match(e.message, /corrupted/);
    assert.ok(e.message.includes("docs/hello.txt"));
    assert.ok(e.message.includes(HELLO_CHUNK));
    assert.match(e.message, /actual:\s+[0-9a-f]{64}/);
    return true;
  });

  await assert.rejects(readFile(path.join(output, "docs", "hello.txt")), "corrupted file was not written");
});

test("restore reports a missing chunk", async () => {
  server.deleteChunk(HELLO_CHUNK);
  await assert.rejects(runRestore(makeContext(server.url, stateFile), snapshotId, path.join(work, "missing-out")), (e: unknown) => e instanceof CliError && /missing/.test(e.message) && e.message.includes("docs/hello.txt"));
});

test("verify reports a healthy repository", async () => {
  const { out, text } = capture();
  const report = await runVerify({ ...makeContext(server.url, stateFile), out });
  assert.equal(report.healthy, true);
  assert.match(text(), /Repository is healthy/);
});

test("verify names every affected snapshot and file when data is damaged", async () => {
  const second = await runBackup(makeContext(server.url, stateFile), source);
  server.corruptChunk(HELLO_CHUNK);

  const { out, text } = capture();
  await assert.rejects(runVerify({ ...makeContext(server.url, stateFile), out }), CliError);

  assert.match(text(), /DAMAGE FOUND: 0 missing chunk\(s\), 1 corrupted chunk\(s\)/);
  assert.ok(text().includes(snapshotId));
  assert.ok(text().includes(second.snapshotId));
  assert.ok(text().includes("docs/hello.txt"));
});

test("verify says so plainly when the server has no verify endpoint", async () => {
  server.supportsVerify = false;
  await assert.rejects(runVerify(makeContext(server.url, stateFile)), (e: unknown) => e instanceof CliError && /verify endpoint/.test(e.message));
});

test("init checks the server and saves the repository", async () => {
  const home = path.join(work, "home");
  process.env.BROKENVAULT_HOME = home;
  try {
    await initCommand(makeContext(server.url, stateFile), []);
    const saved = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    assert.equal(saved.repository, server.url);
  } finally {
    delete process.env.BROKENVAULT_HOME;
  }
});

test("an unreachable server gives a clean network error", async () => {
  const api = new ApiClient("http://127.0.0.1:1", { retries: 1, retryDelayMs: 5 });
  await assert.rejects(api.listVersions(), (e: unknown) => e instanceof NetworkError && /Cannot reach BrokenVault server/.test(e.message));
});
