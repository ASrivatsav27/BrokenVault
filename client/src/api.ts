import { ApiError, CliError, InterruptedError, NetworkError } from "./errors.js";
import { CHECK_BATCH_SIZE } from "./config.js";
import type { ManifestEntry } from "./manifest.js";

export interface UploadSession {
  uploadId: string;
  versionId: string;
}

export interface VersionSummary {
  id: string;
  status: string;
  createdAt: string;
  totalBytes: number;
  chunkCount: number;
}

export type PutChunkResult = "stored" | "already_exists";

export interface VerifyProblem {
  chunkId: string;
  problem: "missing" | "corrupted";
  affected: Array<{ versionId: string; paths: string[] }>;
}

export interface VerifyReport {
  healthy: boolean;
  versionsChecked: number;
  chunksChecked: number;
  problems: VerifyProblem[];
}

export interface ApiOptions {
  retries?: number;
  retryDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function messageFrom(data: unknown, status: number): string {
  if (isRecord(data) && typeof data.error === "string") {
    return data.error;
  }
  if (typeof data === "string" && data.length > 0 && data.length < 200) {
    return data;
  }
  return `HTTP ${status}`;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new InterruptedError());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new InterruptedError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function unexpected(route: string): CliError {
  return new CliError(`Unexpected response from ${route}: this does not look like a BrokenVault server.`);
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(baseUrl: string, options: ApiOptions = {}) {
    this.baseUrl = baseUrl;
    this.retries = options.retries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 300;
  }

  private async request(
    method: string,
    route: string,
    init: {
      json?: unknown;
      body?: Buffer;
      signal?: AbortSignal | undefined;
      timeoutMs?: number;
    } = {}
  ): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = {};
    const requestInit: RequestInit = { method, headers };

    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      requestInit.body = JSON.stringify(init.json);
    } else if (init.body !== undefined) {
      headers["Content-Type"] = "application/octet-stream";
      requestInit.body = init.body as unknown as BodyInit;
    }

    const signals: AbortSignal[] = [];
    if (init.signal) signals.push(init.signal);
    if (init.timeoutMs !== undefined) signals.push(AbortSignal.timeout(init.timeoutMs));
    if (signals.length > 0) requestInit.signal = AbortSignal.any(signals);

    let status: number;
    let ok: boolean;
    let text: string;

    try {
      const response = await fetch(this.baseUrl + route, requestInit);
      status = response.status;
      ok = response.ok;
      text = await response.text();
    } catch (error) {
      if (init.signal?.aborted) {
        throw new InterruptedError();
      }
      throw new NetworkError(this.baseUrl, error);
    }

    let data: unknown = undefined;

    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!ok) {
      throw new ApiError(status, messageFrom(data, status), data);
    }

    return { status, data };
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    signal: AbortSignal | undefined
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const retryable =
          error instanceof NetworkError ||
          (error instanceof ApiError && error.status >= 500);

        if (!retryable || attempt >= this.retries) {
          throw error;
        }

        await sleep(this.retryDelayMs * 2 ** attempt, signal);
      }
    }
  }

  async createUpload(signal?: AbortSignal): Promise<UploadSession> {
    const { data } = await this.request("POST", "/uploads", { json: {}, signal, timeoutMs: 30_000 });

    if (!isRecord(data) || typeof data.uploadId !== "string" || typeof data.versionId !== "string") {
      throw unexpected("POST /uploads");
    }

    return { uploadId: data.uploadId, versionId: data.versionId };
  }

  async checkChunks(
    hashes: string[],
    signal?: AbortSignal
  ): Promise<{ existing: Set<string>; missing: string[] }> {
    const existing = new Set<string>();
    const missing: string[] = [];

    for (let i = 0; i < hashes.length; i += CHECK_BATCH_SIZE) {
      const batch = hashes.slice(i, i + CHECK_BATCH_SIZE);

      const { data } = await this.withRetry(
        () => this.request("POST", "/chunks/check", { json: { hashes: batch }, signal, timeoutMs: 60_000 }),
        signal
      );

      if (!isRecord(data) || !isStringArray(data.existing) || !isStringArray(data.missing)) {
        throw unexpected("POST /chunks/check");
      }

      for (const hash of data.existing) existing.add(hash);
      missing.push(...data.missing);
    }

    return { existing, missing };
  }

  async putChunk(hash: string, data: Buffer, signal?: AbortSignal): Promise<PutChunkResult> {
    const { data: body } = await this.withRetry(
      () => this.request("PUT", `/chunks/${encodeURIComponent(hash)}`, { body: data, signal, timeoutMs: 120_000 }),
      signal
    );

    if (isRecord(body) && (body.status === "stored" || body.status === "already_exists")) {
      return body.status;
    }

    throw unexpected("PUT /chunks/:hash");
  }

  async putManifest(uploadId: string, entries: ManifestEntry[], signal?: AbortSignal): Promise<void> {
    await this.request("PUT", `/uploads/${encodeURIComponent(uploadId)}/manifest`, {
      json: { entries },
      signal,
      timeoutMs: 300_000,
    });
  }

  async commit(uploadId: string, signal?: AbortSignal): Promise<{ versionId: string }> {
    const { data } = await this.withRetry(
      () => this.request("POST", `/uploads/${encodeURIComponent(uploadId)}/commit`, { json: {}, signal, timeoutMs: 300_000 }),
      signal
    );

    if (!isRecord(data) || data.status !== "completed" || typeof data.versionId !== "string") {
      throw unexpected("POST /uploads/:uploadId/commit");
    }

    return { versionId: data.versionId };
  }

  async listVersions(signal?: AbortSignal): Promise<VersionSummary[]> {
    const { data } = await this.withRetry(
      () => this.request("GET", "/versions", { signal, timeoutMs: 120_000 }),
      signal
    );

    if (!Array.isArray(data)) {
      throw unexpected("GET /versions");
    }

    return data.map((item): VersionSummary => {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        typeof item.createdAt !== "string" ||
        typeof item.totalBytes !== "number"
      ) {
        throw unexpected("GET /versions");
      }

      return {
        id: item.id,
        status: typeof item.status === "string" ? item.status : "completed",
        createdAt: item.createdAt,
        totalBytes: item.totalBytes,
        chunkCount: typeof item.chunkCount === "number" ? item.chunkCount : 0,
      };
    });
  }

  async restore(versionId: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/versions/${encodeURIComponent(versionId)}/restore`, {
      json: { outputPath },
      signal,
    });
  }

  async verify(signal?: AbortSignal): Promise<VerifyReport> {
    const { data } = await this.request("POST", "/verify", { json: {}, signal });

    if (
      !isRecord(data) ||
      typeof data.healthy !== "boolean" ||
      typeof data.versionsChecked !== "number" ||
      typeof data.chunksChecked !== "number" ||
      !Array.isArray(data.problems)
    ) {
      throw unexpected("POST /verify");
    }

    const problems = data.problems.map((raw): VerifyProblem => {
      if (
        !isRecord(raw) ||
        typeof raw.chunkId !== "string" ||
        (raw.problem !== "missing" && raw.problem !== "corrupted") ||
        !Array.isArray(raw.affected)
      ) {
        throw unexpected("POST /verify");
      }

      const affected = raw.affected.map((a) => {
        if (!isRecord(a) || typeof a.versionId !== "string" || !isStringArray(a.paths)) {
          throw unexpected("POST /verify");
        }
        return { versionId: a.versionId, paths: a.paths };
      });

      return { chunkId: raw.chunkId, problem: raw.problem, affected };
    });

    return {
      healthy: data.healthy,
      versionsChecked: data.versionsChecked,
      chunksChecked: data.chunksChecked,
      problems,
    };
  }
}
