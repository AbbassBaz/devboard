import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, writeSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mergeEnv } from "./env";
import { DEVBOARD_HOME } from "./registry";
import type { StartSpec } from "./types";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP_BYTES = 2 * 1024 * 1024;

export function isValidLogId(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone or not ours; either way there is nothing more to do
  }
}

export async function killTree(
  pids: number[],
  graceMs = 3000,
  protectedPids: number[] = [process.pid],
): Promise<{ killed: number[]; forced: number[] }> {
  const targets = [...new Set(pids)].filter((p) => p > 1 && !protectedPids.includes(p));
  for (const p of targets) signal(p, "SIGTERM");
  const deadline = Date.now() + graceMs;
  let alive = targets.filter(isAlive);
  while (alive.length && Date.now() < deadline) {
    await Bun.sleep(200);
    alive = alive.filter(isAlive);
  }
  for (const p of alive) signal(p, "SIGKILL");
  return { killed: targets.filter((p) => !alive.includes(p)), forced: alive };
}

export class Control {
  constructor(private readonly home: string = DEVBOARD_HOME) {}

  get logDir(): string {
    return join(this.home, "logs");
  }

  logPath(id: string): string {
    if (!isValidLogId(id)) throw new Error("invalid log id");
    const dir = resolve(this.logDir);
    const path = resolve(dir, `${id}.log`);
    if (!path.startsWith(dir + "/")) throw new Error("invalid log id");
    return path;
  }

  hasLog(id: string): boolean {
    return existsSync(this.logPath(id));
  }

  async rotateIfNeeded(id: string, maxBytes = LOG_MAX_BYTES, keepBytes = LOG_KEEP_BYTES): Promise<boolean> {
    const path = this.logPath(id);
    const info = await stat(path).catch(() => undefined);
    if (!info || info.size <= maxBytes) return false;
    const from = Math.max(0, info.size - keepBytes);
    let text = await Bun.file(path).slice(from, info.size).text();
    const nl = text.indexOf("\n");
    if (nl >= 0) text = text.slice(nl + 1);
    await Bun.write(path, `===== ${new Date().toISOString()} rotated, kept last ${(text.length / 1024).toFixed(0)} KB =====\n${text}`);
    return true;
  }

  async start(spec: StartSpec): Promise<number> {
    const cwdInfo = await stat(spec.cwd).catch(() => undefined);
    if (!cwdInfo?.isDirectory()) throw new Error(`working directory does not exist: ${spec.cwd}`);
    await mkdir(this.logDir, { recursive: true });
    await this.rotateIfNeeded(spec.id);
    const fd = openSync(this.logPath(spec.id), "a");
    try {
      const separator = fstatSync(fd).size > 0 ? "\n" : "";
      writeSync(fd, `${separator}===== ${new Date().toISOString()} start in ${spec.cwd}: ${spec.command} =====\n`);
      const child = spawn("/bin/sh", ["-c", spec.command], {
        cwd: spec.cwd,
        detached: true, // own session and process group: survives devboard exit and Ctrl-C
        stdio: ["ignore", fd, fd],
        env: mergeEnv(process.env, spec.env),
      });
      child.on("error", () => {});
      child.unref();
      if (child.pid === undefined) throw new Error(`failed to start: ${spec.command}`);
      return child.pid;
    } finally {
      closeSync(fd); // the child holds its own descriptor
    }
  }

  async logDirSize(): Promise<number> {
    const { readdir } = await import("node:fs/promises");
    try {
      const files = await readdir(this.logDir);
      let total = 0;
      for (const name of files) {
        try { total += (await stat(join(this.logDir, name))).size; } catch {}
      }
      return total;
    } catch {
      return 0;
    }
  }

  async clearLog(id: string): Promise<{ path: string; size: number }> {
    if (!this.hasLog(id)) throw new Error("no log for that id");
    const path = this.logPath(id);
    await Bun.write(path, `===== ${new Date().toISOString()} cleared =====\n`);
    const { size } = await stat(path);
    return { path, size };
  }

  async tailLog(id: string, lines = 200): Promise<{ lines: string[]; path: string; size: number }> {
    const path = this.logPath(id);
    const { size } = await stat(path);
    const from = Math.max(0, size - 256 * 1024);
    const text = await Bun.file(path).slice(from, size).text();
    const all = text.split("\n");
    if (all.at(-1) === "") all.pop();
    return { lines: all.slice(-lines), path, size };
  }
}
