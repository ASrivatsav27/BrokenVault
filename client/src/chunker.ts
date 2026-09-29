import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import { CHUNK_SIZE } from "./config.js";
import { CliError } from "./errors.js";
import { sha256Hex } from "./hasher.js";

export interface ChunkRef {
  hash: string;
  offset: number;
  length: number;
}

async function fillBuffer(
  handle: FileHandle,
  buffer: Buffer,
  position: number
): Promise<number> {
  let filled = 0;

  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      buffer.length - filled,
      position + filled
    );

    if (bytesRead === 0) {
      break;
    }

    filled += bytesRead;
  }

  return filled;
}

function changedError(absPath: string): CliError {
  return new CliError(`File changed while it was being read: ${absPath}`, {
    hint: "Backups need files to stay unchanged. Run the backup again.",
  });
}

// Reads one bounded buffer at a time; only hashes and offsets are kept.
export async function* chunkFile(
  absPath: string,
  expectedSize: number,
  chunkSize: number = CHUNK_SIZE
): AsyncGenerator<ChunkRef> {
  if (expectedSize === 0) {
    return;
  }

  const handle = await open(absPath, "r");

  try {
    const buffer = Buffer.allocUnsafe(chunkSize);
    let offset = 0;

    for (;;) {
      const filled = await fillBuffer(handle, buffer, offset);

      if (filled === 0) {
        break;
      }

      yield { hash: sha256Hex(buffer.subarray(0, filled)), offset, length: filled };
      offset += filled;

      if (filled < buffer.length) {
        break;
      }
    }

    if (offset !== expectedSize) {
      throw changedError(absPath);
    }
  } finally {
    await handle.close();
  }
}

export async function readChunkBytes(
  absPath: string,
  offset: number,
  length: number
): Promise<Buffer> {
  const handle = await open(absPath, "r");

  try {
    const buffer = Buffer.allocUnsafe(length);
    const filled = await fillBuffer(handle, buffer, offset);

    if (filled !== length) {
      throw changedError(absPath);
    }

    return buffer;
  } finally {
    await handle.close();
  }
}
