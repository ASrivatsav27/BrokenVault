import type { Writable } from "node:stream";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }

  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatDate(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface OutputOptions {
  stdout?: Writable;
  stderr?: Writable;
  color?: boolean;
  interactive?: boolean;
  unicode?: boolean;
  silent?: boolean;
}

export interface Progress {
  update(done: number, detail?: string): void;
  finish(detail?: string): void;
}

const BAR_WIDTH = 28;

export class Output {
  private readonly stdout: Writable;
  private readonly stderr: Writable;
  private readonly color: boolean;
  private readonly interactive: boolean;
  private readonly unicode: boolean;
  private readonly silent: boolean;
  private statusActive = false;
  private lastStatusAt = 0;

  constructor(options: OutputOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;

    const tty = Boolean((this.stdout as { isTTY?: boolean }).isTTY);
    this.interactive = options.interactive ?? tty;
    this.color = options.color ?? (tty && !process.env.NO_COLOR);
    this.silent = options.silent ?? false;
    this.unicode =
      options.unicode ??
      (process.platform !== "win32" ||
        Boolean(process.env.WT_SESSION) ||
        process.env.TERM_PROGRAM === "vscode");
  }

  private paint(code: string, text: string): string {
    return this.color ? `\u001b[${code}m${text}\u001b[0m` : text;
  }

  bold(text: string): string {
    return this.paint("1", text);
  }

  dim(text: string): string {
    return this.paint("2", text);
  }

  green(text: string): string {
    return this.paint("32", text);
  }

  yellow(text: string): string {
    return this.paint("33", text);
  }

  red(text: string): string {
    return this.paint("31", text);
  }

  line(text = ""): void {
    if (this.silent) return;
    this.clearStatus();
    this.stdout.write(`${text}\n`);
  }

  warn(text: string): void {
    if (this.silent) return;
    this.clearStatus();
    this.stderr.write(`${this.yellow("warning:")} ${text}\n`);
  }

  error(text: string): void {
    if (this.silent) return;
    this.clearStatus();
    this.stderr.write(`${this.red("error:")} ${text}\n`);
  }

  hint(text: string): void {
    if (this.silent) return;
    this.stderr.write(`${this.dim(text)}\n`);
  }

  status(text: string, force = false): void {
    if (this.silent || !this.interactive) return;

    const now = Date.now();
    if (!force && now - this.lastStatusAt < 100) return;

    this.lastStatusAt = now;
    this.stdout.write(`\r\u001b[2K${text}`);
    this.statusActive = true;
  }

  clearStatus(): void {
    if (this.statusActive) {
      this.stdout.write("\r\u001b[2K");
      this.statusActive = false;
    }
  }

  progress(total: number): Progress {
    const filled = this.unicode ? "█" : "#";
    const empty = this.unicode ? "░" : "-";
    let lastMilestone = 0;

    const render = (done: number, detail: string): { text: string; percent: number } => {
      const fraction = total <= 0 ? 1 : Math.min(1, done / total);
      const cells = Math.round(fraction * BAR_WIDTH);
      const percent = Math.floor(fraction * 100);
      const bar = filled.repeat(cells) + empty.repeat(BAR_WIDTH - cells);
      const text = `[${bar}] ${String(percent).padStart(3)}%${detail ? `  ${detail}` : ""}`;
      return { text, percent };
    };

    return {
      update: (done, detail = "") => {
        const { text, percent } = render(done, detail);

        if (this.interactive) {
          this.status(text);
        } else if (percent >= lastMilestone + 25 && percent < 100) {
          lastMilestone = percent - (percent % 25);
          this.line(text);
        }
      },
      finish: (detail = "") => {
        this.line(render(total, detail).text);
      },
    };
  }
}
