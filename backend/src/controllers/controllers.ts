import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import path from "node:path";

import { prisma } from "../config/db.js";

export async function createUpload(req: Request, res: Response) {
  try {
    const version = await prisma.version.create({
      data: {
        status: "unfinished",
      },
    });

    const upload = await prisma.upload.create({
      data: {
        versionId: version.id,
        status: "unfinished",
      },
    });

    return res.status(201).json({
      uploadId: upload.id,
      versionId: version.id,
      status: upload.status,
    });
  } catch (error) {
    console.error("Create upload error:", error);

    return res.status(500).json({
      error: "Failed to create upload",
    });
  }
}

export async function checkChunks(req: Request, res: Response) {
  try {
    const { hashes } = req.body;

    if (!Array.isArray(hashes)) {
      return res.status(400).json({
        error: "hashes must be an array",
      });
    }

    const chunks = await prisma.chunk.findMany({
      where: {
        id: {
          in: hashes,
        },
      },
      select: {
        id: true,
      },
    });

    const existing = chunks.map((chunk) => chunk.id);

    const missing = hashes.filter(
      (hash: string) => !existing.includes(hash)
    );

    return res.status(200).json({
      existing,
      missing,
    });
  } catch (error) {
    console.error("Check chunks error:", error);

    return res.status(500).json({
      error: "Failed to check chunks",
    });
  }
}

export async function uploadChunk(req: Request, res: Response) {
  try {
    const hash = req.params.hash;

    if (typeof hash !== "string") {
      return res.status(400).json({
        error: "Invalid chunk hash",
      });
    }

    const body = req.body;

    if (!Buffer.isBuffer(body)) {
      return res.status(400).json({
        error: "Request body must contain raw chunk bytes",
      });
    }

    const calculatedHash = createHash("sha256")
      .update(body)
      .digest("hex");

    if (calculatedHash !== hash) {
      return res.status(400).json({
        error: "Chunk hash mismatch",
        expected: hash,
        actual: calculatedHash,
      });
    }

    const existing = await prisma.chunk.findUnique({
      where: {
        id: hash,
      },
    });

    if (existing) {
      return res.status(200).json({
        status: "already_exists",
        hash,
      });
    }

    const chunkDir = path.resolve("storage/chunks");

    await mkdir(chunkDir, {
      recursive: true,
    });

    const chunkPath = path.join(chunkDir, hash);

    await writeFile(chunkPath, body);

    await prisma.chunk.create({
      data: {
        id: hash,
        size: body.length,
      },
    });

    return res.status(201).json({
      status: "stored",
      hash,
      size: body.length,
    });
  } catch (error) {
    console.error("Upload chunk error:", error);

    return res.status(500).json({
      error: "Failed to upload chunk",
    });
  }
}

export async function createManifest(req: Request, res: Response) {
  try {
    const uploadId = req.params.uploadId;

    if (typeof uploadId !== "string") {
      return res.status(400).json({
        error: "Invalid uploadId",
      });
    }

    const { entries } = req.body;

    if (!Array.isArray(entries)) {
      return res.status(400).json({
        error: "entries must be an array",
      });
    }

    const upload = await prisma.upload.findUnique({
      where: {
        id: uploadId,
      },
      include: {
        version: true,
      },
    });

    if (!upload) {
      return res.status(404).json({
        error: "Upload not found",
      });
    }

    if (upload.status !== "unfinished") {
      return res.status(400).json({
        error: "Upload is not unfinished",
      });
    }

    await prisma.$transaction(async (tx) => {
      for (const entry of entries) {
        if (
          typeof entry.path !== "string" ||
          typeof entry.type !== "string" ||
          typeof entry.size !== "number" ||
          typeof entry.mtime !== "string"
        ) {
          throw new Error("Invalid manifest entry");
        }

        const manifestEntry = await tx.manifestEntry.create({
          data: {
            versionId: upload.versionId,
            path: entry.path,
            type: entry.type,
            size: entry.size,
            mtime: new Date(entry.mtime),
          },
        });

        if (entry.type !== "file") {
          continue;
        }

        if (!Array.isArray(entry.chunks)) {
          throw new Error(
            `File entry "${entry.path}" must contain chunks`
          );
        }

        for (let i = 0; i < entry.chunks.length; i++) {
          const chunkId = entry.chunks[i];

          if (typeof chunkId !== "string") {
            throw new Error(
              `Invalid chunk ID in "${entry.path}"`
            );
          }

          await tx.manifestChunk.create({
            data: {
              entryId: manifestEntry.id,
              chunkId,
              position: i,
            },
          });
        }
      }
    });

    return res.status(201).json({
      message: "Manifest created",
      uploadId,
      versionId: upload.versionId,
      entries: entries.length,
    });
  } catch (error) {
    console.error("Create manifest error:", error);

    return res.status(500).json({
      error: "Failed to create manifest",
    });
  }
}


export async function commitUpload(req: Request, res: Response) {
  try {
    const uploadId = req.params.uploadId;

    if (typeof uploadId !== "string") {
      return res.status(400).json({
        error: "Invalid uploadId",
      });
    }

    const upload = await prisma.upload.findUnique({
      where: {
        id: uploadId,
      },
      include: {
        version: {
          include: {
            entries: {
              include: {
                chunks: true,
              },
            },
          },
        },
      },
    });

    if (!upload) {
      return res.status(404).json({
        error: "Upload not found",
      });
    }

    if (upload.status === "completed") {
      return res.status(200).json({
        status: "completed",
        uploadId,
        versionId: upload.versionId,
      });
    }

    const chunkIds = upload.version.entries
      .flatMap((entry) => entry.chunks)
      .map((chunk) => chunk.chunkId);

    const uniqueChunkIds = [...new Set(chunkIds)];

    const existingChunks = await prisma.chunk.findMany({
      where: {
        id: {
          in: uniqueChunkIds,
        },
      },
      select: {
        id: true,
      },
    });

    const existingIds = new Set(
      existingChunks.map((chunk) => chunk.id)
    );

    const missing = uniqueChunkIds.filter(
      (id) => !existingIds.has(id)
    );

    if (missing.length > 0) {
      return res.status(409).json({
        status: "unfinished",
        error: "Some chunks are missing",
        missing,
      });
    }

    await prisma.$transaction([
      prisma.upload.update({
        where: {
          id: uploadId,
        },
        data: {
          status: "completed",
        },
      }),

      prisma.version.update({
        where: {
          id: upload.versionId,
        },
        data: {
          status: "completed",
        },
      }),
    ]);

    return res.status(200).json({
      status: "completed",
      uploadId,
      versionId: upload.versionId,
    });
  } catch (error) {
    console.error("Commit upload error:", error);

    return res.status(500).json({
      error: "Failed to commit upload",
    });
  }
}

export async function listVersions(req: Request, res: Response) {
  try {
    const versions = await prisma.version.findMany({
      where: {
        status: "completed",
      },
      orderBy: {
        createdAt: "desc",
      },
      include: {
        entries: {
          include: {
            chunks: true,
          },
        },
      },
    });

    const result = versions.map((version) => {
      let totalBytes = 0;
      let uploadedBytes = 0;

      const uniqueChunks = new Set<string>();

      for (const entry of version.entries) {
        totalBytes += entry.size;

        for (const chunk of entry.chunks) {
          uniqueChunks.add(chunk.chunkId);
        }
      }

      return {
        id: version.id,
        status: version.status,
        createdAt: version.createdAt,
        totalBytes,
        chunkCount: uniqueChunks.size,
      };
    });

    return res.json(result);
  } catch (error) {
    console.error("List versions error:", error);

    return res.status(500).json({
      error: "Failed to list versions",
    });
  }
}

export async function restoreVersion(req: Request, res: Response) {
  try {
    const versionId = req.params.versionId;
    const outputPath = req.body.outputPath;

    if (typeof versionId !== "string") {
      return res.status(400).json({
        error: "Invalid versionId",
      });
    }

    if (typeof outputPath !== "string" || outputPath.length === 0) {
      return res.status(400).json({
        error: "outputPath is required",
      });
    }

    const version = await prisma.version.findUnique({
      where: {
        id: versionId,
      },
      include: {
        entries: {
          include: {
            chunks: {
              include: {
                chunk: true,
              },
              orderBy: {
                position: "asc",
              },
            },
          },
          orderBy: {
            path: "asc",
          },
        },
      },
    });

    if (!version) {
      return res.status(404).json({
        error: "Version not found",
      });
    }

    if (version.status !== "completed") {
      return res.status(400).json({
        error: "Only completed versions can be restored",
      });
    }

    const root = path.resolve(outputPath);

    for (const entry of version.entries) {
      const targetPath = path.resolve(root, entry.path);

      if (
        targetPath !== root &&
        !targetPath.startsWith(root + path.sep)
      ) {
        return res.status(400).json({
          error: `Unsafe path: ${entry.path}`,
        });
      }

      if (entry.type === "directory") {
        await mkdir(targetPath, {
          recursive: true,
        });

        const time = new Date(entry.mtime);

        await utimes(targetPath, time, time);

        continue;
      }

      if (entry.type !== "file") {
        return res.status(400).json({
          error: `Unsupported entry type: ${entry.type}`,
        });
      }

      await mkdir(path.dirname(targetPath), {
        recursive: true,
      });

      const buffers: Buffer[] = [];

      for (const manifestChunk of entry.chunks) {
        const chunkPath = path.resolve(
          "storage/chunks",
          manifestChunk.chunkId
        );

        const chunk = await readFile(chunkPath);

        buffers.push(chunk);
      }

      const fileData = Buffer.concat(buffers);

      if (fileData.length !== entry.size) {
        return res.status(409).json({
          error: `Restored size mismatch for ${entry.path}`,
          expected: entry.size,
          actual: fileData.length,
        });
      }

      await writeFile(targetPath, fileData);

      const time = new Date(entry.mtime);

      await utimes(targetPath, time, time);
    }

    return res.status(200).json({
      status: "restored",
      versionId,
      outputPath: root,
    });
  } catch (error) {
    console.error("Restore version error:", error);

    return res.status(500).json({
      error: "Failed to restore version",
    });
  }
}