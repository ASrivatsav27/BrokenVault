import { createHash, randomUUID } from "node:crypto";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

interface MockEntry {
  path: string;
  type: string;
  size: number;
  mtime: string;
  chunks?: string[];
}

interface MockUpload {
  uploadId: string;
  versionId: string;
  status: "unfinished" | "completed";
  createdAt: Date;
  entries: MockEntry[] | null;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

// In-memory stand-in for the BrokenVault HTTP API, used to exercise the client
// without PostgreSQL. It mirrors the real backend's status codes and bodies.
export class MockServer {
  readonly chunks = new Map<string, Buffer>();
  readonly uploads = new Map<string, MockUpload>();
  readonly chunkPuts: string[] = [];
  createUploadCount = 0;
  storedCount = 0;
  supportsVerify = true;
  onChunkStored: ((storedCount: number) => void) | undefined;
  url = "";

  private readonly server = http.createServer((req, res) => {
    this.handle(req, res).catch((error) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    });
  });

  async start(port = 0): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(port, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  corruptChunk(hash: string): void {
    this.chunks.set(hash, Buffer.from("corrupted bytes"));
  }

  deleteChunk(hash: string): void {
    this.chunks.delete(hash);
  }

  completedVersions(): MockUpload[] {
    return [...this.uploads.values()].filter((upload) => upload.status === "completed");
  }

  private async body(req: http.IncomingMessage): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    return Buffer.concat(parts);
  }

  private send(res: http.ServerResponse, status: number, data: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const parts = (req.url ?? "/").split("?")[0]!.split("/").filter(Boolean);
    const raw = await this.body(req);
    const json = () => (raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {});

    if (method === "POST" && parts[0] === "uploads" && parts.length === 1) {
      this.createUploadCount++;
      const upload: MockUpload = {
        uploadId: randomUUID(),
        versionId: randomUUID(),
        status: "unfinished",
        createdAt: new Date(),
        entries: null,
      };
      this.uploads.set(upload.uploadId, upload);
      return this.send(res, 201, { uploadId: upload.uploadId, versionId: upload.versionId, status: "unfinished" });
    }

    if (method === "POST" && parts[0] === "chunks" && parts[1] === "check") {
      const hashes: string[] = json().hashes;
      return this.send(res, 200, {
        existing: hashes.filter((hash) => this.chunks.has(hash)),
        missing: hashes.filter((hash) => !this.chunks.has(hash)),
      });
    }

    if (method === "PUT" && parts[0] === "chunks" && parts[1]) {
      const hash = parts[1];
      this.chunkPuts.push(hash);
      const actual = sha256(raw);
      if (actual !== hash) return this.send(res, 400, { error: "Chunk hash mismatch", expected: hash, actual });
      if (this.chunks.has(hash)) return this.send(res, 200, { status: "already_exists", hash });
      this.chunks.set(hash, raw);
      this.storedCount++;
      this.send(res, 201, { status: "stored", hash, size: raw.length });
      this.onChunkStored?.(this.storedCount);
      return;
    }

    if (method === "PUT" && parts[0] === "uploads" && parts[2] === "manifest") {
      const upload = this.uploads.get(parts[1] ?? "");
      if (!upload) return this.send(res, 404, { error: "Upload not found" });
      if (upload.status !== "unfinished") return this.send(res, 400, { error: "Upload is not unfinished" });
      if (upload.entries !== null) return this.send(res, 500, { error: "Failed to create manifest" });
      const entries: MockEntry[] = json().entries;
      for (const entry of entries) {
        for (const chunk of entry.chunks ?? []) {
          if (!this.chunks.has(chunk)) {
            return this.send(res, 400, {
              error: "Invalid manifest",
              issues: [{ index: 0, path: entry.path, error: "references chunks that do not exist on the server" }],
            });
          }
        }
      }
      upload.entries = entries;
      return this.send(res, 201, { message: "Manifest created", entries: entries.length });
    }

    if (method === "POST" && parts[0] === "uploads" && parts[2] === "commit") {
      const upload = this.uploads.get(parts[1] ?? "");
      if (!upload) return this.send(res, 404, { error: "Upload not found" });
      if (upload.status === "completed") return this.send(res, 200, { status: "completed", versionId: upload.versionId });
      const missing = (upload.entries ?? []).flatMap((e) => e.chunks ?? []).filter((c) => !this.chunks.has(c));
      if (missing.length > 0) return this.send(res, 409, { status: "unfinished", error: "Some chunks are missing", missing });
      upload.status = "completed";
      return this.send(res, 200, { status: "completed", uploadId: upload.uploadId, versionId: upload.versionId });
    }

    if (method === "GET" && parts[0] === "versions" && parts.length === 1) {
      return this.send(
        res,
        200,
        this.completedVersions().map((upload) => ({
          id: upload.versionId,
          status: "completed",
          createdAt: upload.createdAt.toISOString(),
          totalBytes: (upload.entries ?? []).reduce((sum, e) => sum + e.size, 0),
          chunkCount: new Set((upload.entries ?? []).flatMap((e) => e.chunks ?? [])).size,
        }))
      );
    }

    if (method === "POST" && parts[0] === "versions" && parts[2] === "restore") {
      const version = this.completedVersions().find((upload) => upload.versionId === parts[1]);
      if (!version) return this.send(res, 404, { error: "Version not found" });
      const root = path.resolve(json().outputPath);
      const entries = [...(version.entries ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1));
      for (const entry of entries) {
        const target = path.resolve(root, entry.path);
        if (entry.type === "directory") {
          await mkdir(target, { recursive: true });
          continue;
        }
        const buffers: Buffer[] = [];
        for (const chunkId of entry.chunks ?? []) {
          const bytes = this.chunks.get(chunkId);
          if (!bytes) {
            return this.send(res, 409, { error: "Stored chunk is missing", code: "chunk_missing", versionId: version.versionId, path: entry.path, chunkId });
          }
          const actualHash = sha256(bytes);
          if (actualHash !== chunkId) {
            return this.send(res, 409, { error: "Stored chunk is corrupted", code: "chunk_corrupted", versionId: version.versionId, path: entry.path, chunkId, expectedHash: chunkId, actualHash });
          }
          buffers.push(bytes);
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.concat(buffers));
        const time = new Date(entry.mtime);
        await utimes(target, time, time);
      }
      return this.send(res, 200, { status: "restored", versionId: version.versionId, outputPath: root });
    }

    if (method === "POST" && parts[0] === "verify" && this.supportsVerify) {
      const problems = new Map<string, { problem: "missing" | "corrupted"; affected: Map<string, string[]> }>();
      let chunksChecked = 0;
      const seen = new Set<string>();
      for (const version of this.completedVersions()) {
        for (const entry of version.entries ?? []) {
          for (const chunkId of entry.chunks ?? []) {
            if (!seen.has(chunkId)) { seen.add(chunkId); chunksChecked++; }
            const bytes = this.chunks.get(chunkId);
            const problem = bytes === undefined ? "missing" : sha256(bytes) !== chunkId ? "corrupted" : null;
            if (problem === null) continue;
            const record = problems.get(chunkId) ?? { problem, affected: new Map() };
            const paths = record.affected.get(version.versionId) ?? [];
            paths.push(entry.path);
            record.affected.set(version.versionId, paths);
            problems.set(chunkId, record);
          }
        }
      }
      return this.send(res, 200, {
        healthy: problems.size === 0,
        versionsChecked: this.completedVersions().length,
        chunksChecked,
        problems: [...problems].map(([chunkId, r]) => ({
          chunkId,
          problem: r.problem,
          affected: [...r.affected].map(([versionId, paths]) => ({ versionId, paths })),
        })),
      });
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html");
    res.end(`Cannot ${method} ${req.url}`);
  }
}
