const SHA256_HEX = /^[0-9a-f]{64}$/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;
const MAX_SIZE = 2_147_483_647;

export type ManifestEntryType = "file" | "directory";

export interface ValidatedManifestEntry {
  path: string;
  type: ManifestEntryType;
  size: number;
  mtime: Date;
  chunks: string[];
}

export interface ManifestIssue {
  index: number;
  path?: string;
  error: string;
}

export function getPathError(value: unknown): string | null {
  if (typeof value !== "string") {
    return "path must be a string";
  }

  if (value.length === 0) {
    return "path must not be empty";
  }

  if (value.includes("\0")) {
    return "path must not contain null bytes";
  }

  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    WINDOWS_DRIVE.test(value)
  ) {
    return "absolute paths are not allowed";
  }

  if (value.includes("\\")) {
    return "path must use '/' separators and must not contain backslashes";
  }

  for (const segment of value.split("/")) {
    if (segment === "") {
      return "path must not contain empty segments";
    }

    if (segment === "..") {
      return "path must not contain '..' segments";
    }

    if (segment === ".") {
      return "path must not contain '.' segments";
    }
  }

  return null;
}

function getEntryErrors(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["entry must be an object"];
  }

  const entry = raw as Record<string, unknown>;
  const errors: string[] = [];

  const pathError = getPathError(entry.path);
  if (pathError) {
    errors.push(pathError);
  }

  const type = entry.type;
  const isFile = type === "file";
  const isDirectory = type === "directory";

  if (!isFile && !isDirectory) {
    errors.push('type must be "file" or "directory"');
  }

  const size = entry.size;
  let validSize = false;

  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    errors.push("size must be a non-negative integer");
  } else if (size > MAX_SIZE) {
    errors.push(`size must not exceed ${MAX_SIZE} bytes`);
  } else {
    validSize = true;
  }

  if (typeof entry.mtime !== "string") {
    errors.push("mtime must be a date/time string");
  } else {
    const date = new Date(entry.mtime);
    const year = date.getUTCFullYear();

    if (Number.isNaN(date.getTime()) || year < 1 || year > 9999) {
      errors.push("mtime is not a valid date/time");
    }
  }

  const chunks = entry.chunks;

  if (isFile) {
    if (!Array.isArray(chunks)) {
      errors.push("file entries must have a chunks array");
    } else {
      const badIndex = chunks.findIndex(
        (id) => typeof id !== "string" || !SHA256_HEX.test(id)
      );

      if (badIndex !== -1) {
        errors.push(
          `chunks[${badIndex}] must be a lowercase 64-character SHA-256 hex string`
        );
      } else if (validSize) {
        if (size === 0 && chunks.length > 0) {
          errors.push("empty files must have zero chunks");
        } else if (size !== 0 && chunks.length === 0) {
          errors.push("non-empty files must have at least one chunk");
        }
      }
    }
  } else if (isDirectory) {
    if (
      chunks !== undefined &&
      !(Array.isArray(chunks) && chunks.length === 0)
    ) {
      errors.push("directory entries must not contain chunks");
    }
  }

  return errors;
}

export function validateManifestEntries(rawEntries: unknown[]): {
  entries: ValidatedManifestEntry[];
  issues: ManifestIssue[];
} {
  const issues: ManifestIssue[] = [];
  const entries: ValidatedManifestEntry[] = [];
  const firstSeen = new Map<string, number>();

  rawEntries.forEach((raw, index) => {
    const errors = getEntryErrors(raw);
    const rawPath =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>).path
        : undefined;
    const path = typeof rawPath === "string" ? rawPath : undefined;

    if (path !== undefined && !getPathError(path)) {
      const first = firstSeen.get(path);

      if (first === undefined) {
        firstSeen.set(path, index);
      } else {
        errors.push(`duplicate path (first seen at entry ${first})`);
      }
    }

    for (const error of errors) {
      issues.push(path === undefined ? { index, error } : { index, path, error });
    }

    if (errors.length === 0) {
      const entry = raw as Record<string, unknown>;

      entries.push({
        path: entry.path as string,
        type: entry.type as ManifestEntryType,
        size: entry.size as number,
        mtime: new Date(entry.mtime as string),
        chunks:
          entry.type === "file" ? [...(entry.chunks as string[])] : [],
      });
    }
  });

  return { entries, issues };
}

export function checkChunkReferences(
  entries: ValidatedManifestEntry[],
  knownChunkSizes: Map<string, number>
): ManifestIssue[] {
  const issues: ManifestIssue[] = [];

  entries.forEach((entry, index) => {
    const missing = entry.chunks.filter((id) => !knownChunkSizes.has(id));

    if (missing.length > 0) {
      const sample = [...new Set(missing)].slice(0, 3).join(", ");

      issues.push({
        index,
        path: entry.path,
        error: `references ${missing.length} chunk(s) that do not exist on the server (e.g. ${sample})`,
      });

      return;
    }

    let total = 0;

    for (const id of entry.chunks) {
      total += knownChunkSizes.get(id) ?? 0;
    }

    if (total !== entry.size) {
      issues.push({
        index,
        path: entry.path,
        error: `size ${entry.size} does not match total chunk size ${total}`,
      });
    }
  });

  return issues;
}
