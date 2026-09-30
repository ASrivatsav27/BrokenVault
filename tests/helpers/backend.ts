import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const backendDir = path.join(repoRoot, "backend");
export const storageDir =
  process.env.BROKENVAULT_STORAGE_DIR ?? path.join(backendDir, "storage", "chunks");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// Starts the real backend (backend/server.ts) on a free port and can kill and
// restart it. Set BROKENVAULT_TEST_URL to use an already-running server instead;
// restart steps are then skipped.
export class BackendServer {
  readonly managed: boolean;
  readonly url: string;
  private readonly port: number;
  private child: ChildProcess | undefined;
  private output = "";

  private constructor(url: string, port: number, managed: boolean) {
    this.url = url;
    this.port = port;
    this.managed = managed;
  }

  static async start(): Promise<BackendServer> {
    const attach = process.env.BROKENVAULT_TEST_URL;

    if (attach) {
      const server = new BackendServer(attach.replace(/\/+$/, ""), 0, false);
      await server.waitUntilReady();
      return server;
    }

    if (!existsSync(path.join(backendDir, "node_modules"))) {
      throw new Error(
        "backend/node_modules not found. Run `npm install` in backend/ and make sure backend/.env has a working DATABASE_URL."
      );
    }

    const port = await freePort();
    const server = new BackendServer(`http://127.0.0.1:${port}`, port, true);
    await server.launch();
    return server;
  }

  private async launch(): Promise<void> {
    const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      cwd: backendDir,
      env: { ...process.env, PORT: String(this.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const collect = (chunk: Buffer) => {
      this.output = (this.output + chunk.toString()).slice(-4000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    this.child = child;

    await this.waitUntilReady();
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + 90_000;

    for (;;) {
      if (this.child && (this.child.exitCode !== null || this.child.signalCode !== null)) {
        throw new Error(`Backend exited before it was ready:\n${this.output}`);
      }

      try {
        const response = await fetch(`${this.url}/versions`);
        if (response.ok) return;
      } catch {
        // not listening yet
      }

      if (Date.now() > deadline) {
        throw new Error(`Backend did not become ready in 90s:\n${this.output}`);
      }

      await sleep(300);
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;

    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await Promise.race([exited, sleep(10_000)]);

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }

  async restart(): Promise<void> {
    if (!this.managed) {
      throw new Error("Cannot restart a server that was not started by the tests.");
    }
    await this.stop();
    await this.launch();
  }
}
