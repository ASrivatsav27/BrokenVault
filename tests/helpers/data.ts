import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { storageDir } from "./backend.js";

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export const chunkFilePath = (hash: string) => path.join(storageDir, hash);

export interface Dataset {
  root: string;
  helloPath: string;
  helloBytes: Buffer;
  helloChunk: string;
}

// Every run gets unique content, so "uploaded bytes" is predictable no matter
// what an earlier run already stored on the server.
export async function createDataset(root: string, largeBytes = 2 * 1024 * 1024): Promise<Dataset> {
  const token = randomUUID();
  const helloBytes = Buffer.from(`hello brokenvault ${token}`);

  await mkdir(path.join(root, "docs", "deep", "er"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "empty-folder"));
  await mkdir(path.join(root, "unicode dir"));

  await writeFile(path.join(root, "docs", "hello.txt"), helloBytes);
  await writeFile(path.join(root, "docs", "deep", "er", "note.txt"), `nested ${token}`);
  await writeFile(path.join(root, "unicode dir", "résumé ✓.txt"), `unicode ${token}`);
  await writeFile(path.join(root, "README.txt"), `readme ${token}`);
  await writeFile(path.join(root, "empty.txt"), "");
  await writeFile(path.join(root, "assets", "binary.dat"), randomBytes(700 * 1024));
  await writeFile(path.join(root, "assets", "large.bin"), randomBytes(largeBytes));

  return { root, helloPath: "docs/hello.txt", helloBytes, helloChunk: sha256(helloBytes) };
}
