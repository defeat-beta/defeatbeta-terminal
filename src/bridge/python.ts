/**
 * Manages the persistent Python bridge subprocess.
 * Handles process lifecycle, request queuing, and JSON-RPC communication.
 */

import { join } from "path";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { tmpdir } from "os";

// The Python sidecar source is embedded at compile time. At runtime we
// materialize it to a temp file (see getBridgeScriptPath below) so the
// embedded source survives `bun build --compile`, where the original file
// path on disk is meaningless inside the bundled binary.
import bridgeSource from "../../scripts/bridge.py" with { type: "text" };

const HOME         = process.env.HOME ?? "";
const INSTALL_DIR  = join(HOME, ".defeatbeta-terminal"); // matches install.sh layout

/**
 * Find a Python executable that has `defeatbeta_api` importable.
 * Priority:
 *   1. DEFEATBETA_PYTHON env var (explicit override)
 *   2. ~/.defeatbeta-terminal/.venv/bin/python  (created by install.sh)
 *   3. <cwd>/.venv/bin/python                   (dev mode: `bun run dev` from repo root)
 *   4. System Python with defeatbeta-api installed (fallback)
 */
async function findPython(): Promise<string> {
  if (process.env.DEFEATBETA_PYTHON) return process.env.DEFEATBETA_PYTHON;

  // 2. Installed via install.sh
  const installedVenv = join(INSTALL_DIR, ".venv/bin/python");
  if (existsSync(installedVenv) && await canImportDefeatbeta(installedVenv)) {
    return installedVenv;
  }

  // 3. Dev mode: cwd-relative .venv (project repo)
  const cwdVenv = join(process.cwd(), ".venv/bin/python");
  if (existsSync(cwdVenv) && await canImportDefeatbeta(cwdVenv)) {
    return cwdVenv;
  }

  // 4. System Python fallback
  const pathDirs = (process.env.PATH ?? "").split(":");
  const extraDirs = [
    "/opt/homebrew/opt/python@3.11/bin",
    "/opt/homebrew/opt/python@3.12/bin",
    "/opt/homebrew/opt/python@3.13/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    `${HOME}/.pyenv/shims`,
    `${HOME}/.local/bin`,
  ];

  const names = ["python3.13", "python3.12", "python3.11", "python3", "python"];
  const seen = new Set<string>();

  for (const dir of [...pathDirs, ...extraDirs]) {
    for (const name of names) {
      const full = `${dir}/${name}`;
      if (seen.has(full)) continue;
      seen.add(full);
      if (await canImportDefeatbeta(full)) return full;
    }
  }

  throw new Error(
    "Could not find a Python with defeatbeta-api installed.\n" +
    "If you ran the installer, make sure ~/.defeatbeta-terminal/.venv exists.\n" +
    "If running from source, run: bun run setup\n" +
    "Or set DEFEATBETA_PYTHON=/path/to/python"
  );
}

async function canImportDefeatbeta(python: string): Promise<boolean> {
  try {
    const check = Bun.spawn(
      [python, "-c", "import defeatbeta_api"],
      { stdout: "ignore", stderr: "ignore" }
    );
    await check.exited;
    return check.exitCode === 0;
  } catch {
    return false;
  }
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

/**
 * Materialize the embedded bridge.py source to a real file path so Python can
 * spawn it. Necessary because `bun build --compile` bakes bridge.py into the
 * binary as a string — Python can't `spawn` source out of the bundled archive.
 *
 * Preferred location is `~/.defeatbeta-terminal/bridge.py`, matching the
 * install.sh layout (binary, venv, and bridge.py all live in one directory).
 * Each launch overwrites it so the file always matches the binary's embedded
 * source. If that directory isn't writable, we fall back to a per-pid file
 * under the OS tmp dir, deleted on exit.
 */
let bridgeScriptPath: string | null = null;
async function getBridgeScriptPath(): Promise<string> {
  if (bridgeScriptPath) return bridgeScriptPath;

  // Preferred: persist alongside the install dir.
  try {
    mkdirSync(INSTALL_DIR, { recursive: true });
    const preferred = join(INSTALL_DIR, "bridge.py");
    await Bun.write(preferred, bridgeSource);
    bridgeScriptPath = preferred;
    return preferred;
  } catch {
    // Fallback: ephemeral temp file (e.g. read-only HOME, sandboxed env).
    const tmp = join(tmpdir(), `defeatbeta-bridge-${process.pid}.py`);
    await Bun.write(tmp, bridgeSource);
    bridgeScriptPath = tmp;
    process.on("exit", () => {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    });
    return tmp;
  }
}

class PythonBridge {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private pending = new Map<string, PendingRequest>();
  private counter = 0;
  private buffer = "";
  private ready = false;
  private readyCallbacks: Array<() => void> = [];

  async start(): Promise<void> {
    const python = await findPython();
    const bridgeScript = await getBridgeScriptPath();
    this.proc = Bun.spawn(
      [python, bridgeScript],
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
