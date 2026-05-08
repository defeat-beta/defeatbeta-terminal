/**
 * Manages the persistent Python bridge subprocess.
 * Handles process lifecycle, request queuing, and JSON-RPC communication.
 */

import { join } from "path";
import { existsSync } from "fs";

// Project root is two levels up from src/bridge/
const PROJECT_ROOT = join(import.meta.dir, "../..");

// Find the Python executable. Priority:
//   1. DEFEATBETA_PYTHON env var (explicit override)
//   2. Project-local .venv (created by: uv venv && uv pip install -r requirements.txt)
//   3. System Python with defeatbeta-api installed (fallback)
async function findPython(): Promise<string> {
  if (process.env.DEFEATBETA_PYTHON) return process.env.DEFEATBETA_PYTHON;

  // Check project-local venv first
  const venvPython = join(PROJECT_ROOT, ".venv/bin/python");
  if (existsSync(venvPython)) {
    const check = Bun.spawn(
      [venvPython, "-c", "import defeatbeta_api"],
      { stdout: "ignore", stderr: "ignore" }
    );
    await check.exited;
    if (check.exitCode === 0) return venvPython;
  }

  // Fall back to any system Python that has defeatbeta-api
  const pathDirs = (process.env.PATH ?? "").split(":");
  const extraDirs = [
    "/opt/homebrew/opt/python@3.11/bin",
    "/opt/homebrew/opt/python@3.12/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    `${process.env.HOME}/.pyenv/shims`,
    `${process.env.HOME}/.local/bin`,
  ];

  const names = ["python3.11", "python3.12", "python3", "python"];
  const seen = new Set<string>();

  for (const dir of [...pathDirs, ...extraDirs]) {
    for (const name of names) {
      const full = `${dir}/${name}`;
      if (seen.has(full)) continue;
      seen.add(full);

      try {
        const check = Bun.spawn(
          [full, "-c", "import defeatbeta_api"],
          { stdout: "ignore", stderr: "ignore" }
        );
        await check.exited;
        if (check.exitCode === 0) return full;
      } catch {
        // executable not found or failed to spawn, try next candidate
      }
    }
  }

  throw new Error(
    "Could not find a Python with defeatbeta-api installed.\n" +
    "Run: bun run setup\n" +
    "Or set DEFEATBETA_PYTHON=/path/to/python"
  );
}

interface BridgeRequest {
  id: string;
  type: "ticker" | "market" | "meta" | "render" | "statement" | "valuation";
  symbol?: string;
  method: string;
  params?: Record<string, unknown>;
}

interface BridgeResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
  traceback?: string;
}

type PendingRequest = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  onProgress?: (msg: string) => void;
};

const BRIDGE_SCRIPT = join(import.meta.dir, "../../scripts/bridge.py");

class PythonBridge {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private pending = new Map<string, PendingRequest>();
  private counter = 0;
  private buffer = "";
  private ready = false;
  private readyCallbacks: Array<() => void> = [];

  async start(): Promise<void> {
    const python = await findPython();
    this.proc = Bun.spawn(
      [python, BRIDGE_SCRIPT],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          // Proxy support: inherits HTTP_PROXY/http_proxy from environment
          // Users can set: HTTP_PROXY=http://127.0.0.1:8118 defeatbeta
        },
      }
    );

    // Read stdout line by line
    this.readLoop();

    // Wait until bridge signals readiness
    await new Promise<void>((resolve) => {
      this.readyCallbacks.push(resolve);
    });
  }

  private async readLoop() {
    if (!this.proc?.stdout) return;
    const stdout = this.proc.stdout;
    if (typeof stdout === "number") return;

    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          this.handleLine(line.trim());
        }
      }
    } catch (e) {
      // Process exited unexpectedly
    } finally {
      // Flush any remaining buffered bytes
      const remaining = decoder.decode();
      if (remaining.trim()) this.handleLine(remaining.trim());
      // Reject all pending requests so callers don't hang forever
      this.rejectAllPending(new Error("Python bridge process exited"));
    }
  }

  private rejectAllPending(err: Error) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private handleLine(line: string) {
    let msg: BridgeResponse & { ready?: boolean; progress?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Handle readiness signal
    if ("ready" in msg && msg.ready) {
      this.ready = true;
      for (const cb of this.readyCallbacks) cb();
      this.readyCallbacks = [];
      return;
    }

    // Handle progress message — notify caller but keep request pending
    if ("progress" in msg && msg.progress != null) {
      this.pending.get(msg.id)?.onProgress?.(msg.progress);
      return;
    }

    const pending = this.pending.get(msg.id);
    if (!pending) return;

    this.pending.delete(msg.id);

    if (msg.success) {
      pending.resolve(msg.data);
    } else {
      pending.reject(new Error(msg.error ?? "Unknown bridge error"));
    }
  }

  async call(req: Omit<BridgeRequest, "id">, onProgress?: (msg: string) => void): Promise<unknown> {
    if (!this.proc || !this.ready) {
      throw new Error("Bridge not started");
    }

    const id = String(++this.counter);
    const fullReq: BridgeRequest = { ...req, id };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const line = JSON.stringify(fullReq) + "\n";
      const stdin = this.proc!.stdin!;
      if (typeof stdin !== "number") stdin.write(line);
    });
  }

  stop() {
    this.rejectAllPending(new Error("Bridge stopped"));
    this.proc?.kill();
    this.proc = null;
    this.ready = false;
  }
}

// Singleton instance
export const bridge = new PythonBridge();
