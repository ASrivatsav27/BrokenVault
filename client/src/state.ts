import path from "node:path";

import { homeDir, readJsonFile, writeJsonAtomic } from "./config.js";

export interface UploadState {
  uploadId: string;
  versionId: string;
  manifestFingerprint: string | null;
  manifestUploaded: boolean;
  updatedAt: string;
}

interface StateFile {
  uploads: Record<string, UploadState>;
}

export function stateKey(repository: string, source: string): string {
  return `${repository}\n${source}`;
}

function isUploadState(value: unknown): value is UploadState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.uploadId === "string" &&
    typeof v.versionId === "string" &&
    typeof v.manifestUploaded === "boolean" &&
    (v.manifestFingerprint === null || typeof v.manifestFingerprint === "string")
  );
}

export class StateStore {
  private readonly file: string;

  constructor(file: string = path.join(homeDir(), "uploads.json")) {
    this.file = file;
  }

  private async read(): Promise<StateFile> {
    const data = await readJsonFile(this.file);
    const uploads: Record<string, UploadState> = {};

    if (typeof data === "object" && data !== null && "uploads" in data) {
      const raw = (data as { uploads: unknown }).uploads;

      if (typeof raw === "object" && raw !== null) {
        for (const [key, value] of Object.entries(raw)) {
          if (isUploadState(value)) {
            uploads[key] = value;
          }
        }
      }
    }

    return { uploads };
  }

  async get(key: string): Promise<UploadState | undefined> {
    return (await this.read()).uploads[key];
  }

  async set(key: string, value: Omit<UploadState, "updatedAt">): Promise<void> {
    const state = await this.read();
    state.uploads[key] = { ...value, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.file, state);
  }

  async delete(key: string): Promise<void> {
    const state = await this.read();

    if (key in state.uploads) {
      delete state.uploads[key];
      await writeJsonAtomic(this.file, state);
    }
  }
}
