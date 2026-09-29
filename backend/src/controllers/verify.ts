import type { Request, Response } from "express";
import { createHash } from "node:crypto";

import { prisma } from "../config/db.js";
import { readStoredChunk } from "./controllers.js";

export async function verifyRepository(req: Request, res: Response) {
  try {
    const versionsChecked = await prisma.version.count({
      where: {
        status: "completed",
      },
    });

    const rows = await prisma.manifestChunk.findMany({
      where: {
        entry: {
          version: {
            status: "completed",
          },
        },
      },
      select: {
        chunkId: true,
        entry: {
          select: {
            versionId: true,
            path: true,
          },
        },
      },
    });

    const usage = new Map<string, Map<string, Set<string>>>();

    for (const row of rows) {
      const versions = usage.get(row.chunkId) ?? new Map<string, Set<string>>();
      const paths = versions.get(row.entry.versionId) ?? new Set<string>();

      paths.add(row.entry.path);
      versions.set(row.entry.versionId, paths);
      usage.set(row.chunkId, versions);
    }

    const problems: Array<{
      chunkId: string;
      problem: "missing" | "corrupted";
      affected: Array<{ versionId: string; paths: string[] }>;
    }> = [];

    for (const [chunkId, versions] of usage) {
      const bytes = await readStoredChunk(chunkId);

      let problem: "missing" | "corrupted" | null = null;

      if (bytes === null) {
        problem = "missing";
      } else if (
        createHash("sha256").update(bytes).digest("hex") !== chunkId
      ) {
        problem = "corrupted";
      }

      if (problem === null) {
        continue;
      }

      problems.push({
        chunkId,
        problem,
        affected: [...versions].map(([versionId, paths]) => ({
          versionId,
          paths: [...paths].sort(),
        })),
      });
    }

    return res.status(200).json({
      healthy: problems.length === 0,
      versionsChecked,
      chunksChecked: usage.size,
      problems,
    });
  } catch (error) {
    console.error("Verify error:", error);

    return res.status(500).json({
      error: "Failed to verify repository",
    });
  }
}
