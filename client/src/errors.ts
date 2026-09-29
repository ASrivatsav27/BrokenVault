export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: { exitCode?: number; hint?: string } = {}
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? 1;
    this.hint = options.hint;
  }
}

export class InterruptedError extends CliError {
  constructor(message = "Interrupted.", hint?: string) {
    super(message, hint === undefined ? { exitCode: 130 } : { exitCode: 130, hint });
    this.name = "InterruptedError";
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export class NetworkError extends CliError {
  constructor(baseUrl: string, cause: unknown) {
    super(`Cannot reach BrokenVault server at ${baseUrl} (${describeNetworkCause(cause)})`, {
      hint: "Is the server running? Check the -r/--repository option.",
    });
    this.name = "NetworkError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function describeNetworkCause(error: unknown): string {
  if (typeof error === "object" && error !== null && "cause" in error) {
    const code = errorCode((error as { cause: unknown }).cause);
    if (code) return code;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function describeFsError(error: unknown): string {
  const code = errorCode(error);
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `permission denied (${code})`;
    case "ENOENT":
      return "no such file or directory (ENOENT)";
    case "ENOTDIR":
      return "not a directory (ENOTDIR)";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

export function isFsError(error: unknown, ...codes: string[]): boolean {
  const code = errorCode(error);
  return code !== undefined && codes.includes(code);
}

export function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new InterruptedError();
  }
}

export function formatApiError(error: ApiError): string {
  const lines = [`Server rejected the request (HTTP ${error.status}): ${error.message}`];
  const body = error.body;

  if (typeof body === "object" && body !== null && "issues" in body) {
    const issues = (body as { issues: unknown }).issues;

    if (Array.isArray(issues)) {
      for (const issue of issues.slice(0, 10)) {
        if (typeof issue === "object" && issue !== null) {
          const { path: issuePath, error: issueError } = issue as { path?: unknown; error?: unknown };
          lines.push(`  ${typeof issuePath === "string" ? issuePath : "(entry)"}: ${String(issueError)}`);
        }
      }
      if (issues.length > 10) {
        lines.push(`  ...and ${issues.length - 10} more`);
      }
    }
  }

  return lines.join("\n");
}
