const WINDOWS_DRIVE = /^[A-Za-z]:/;

// Mirrors the server's manifest path rules so problems are reported before
// anything is uploaded.
export function relativePathError(value: string): string | null {
  if (value.length === 0) {
    return "empty path";
  }

  if (value.includes("\0")) {
    return "path contains a null byte";
  }

  if (value.startsWith("/") || value.startsWith("\\") || WINDOWS_DRIVE.test(value)) {
    return "absolute path";
  }

  if (value.includes("\\")) {
    return "name contains a backslash, which BrokenVault does not support";
  }

  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return `unsafe path segment "${segment}"`;
    }
  }

  return null;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}
