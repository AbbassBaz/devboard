import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, writeSync } from "node:fs";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mergeEnv } from "./env";
import { DEVBOARD_HOME, Registry } from "./registry";
import type { StartSpec, Tracked } from "./types";

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
  groupPid?: number,
): Promise<{ killed: number[]; forced: number[] }> {
  if (groupPid && groupPid > 1 && !protectedPids.includes(groupPid)) {
    try { process.kill(-groupPid, "SIGTERM"); } catch {}
  }
  const targets = [...new Set(pids)].filter((p) => p > 1 && !protectedPids.includes(p));
  for (const p of targets) signal(p, "SIGTERM");
  const deadline = Date.now() + graceMs;
  let alive = targets.filter(isAlive);
  while (alive.length && Date.now() < deadline) {
    await Bun.sleep(200);
    alive = alive.filter(isAlive);
  }
  if (groupPid && groupPid > 1 && !protectedPids.includes(groupPid) && isAlive(groupPid)) {
    try { process.kill(-groupPid, "SIGKILL"); } catch {}
  }
  for (const p of alive) signal(p, "SIGKILL");
  return { killed: targets.filter((p) => !alive.includes(p)), forced: alive };
}

export class Control {
  private readonly registry: Registry;
  private readonly tracked = new Map<string, Tracked>();
  private loaded = false;

  constructor(private readonly home: string = DEVBOARD_HOME, registry?: Registry) {
    this.registry = registry ?? new Registry(home);
  }

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

  /** Copy the last keep-bytes to `<id>.log.1` and truncate the live file. Safe while a child holds an O_APPEND fd. */
  async rotateRunning(ids: string[], maxBytes = LOG_MAX_BYTES, keepBytes = LOG_KEEP_BYTES): Promise<string[]> {
    const rotated: string[] = [];
    for (const id of ids) {
      if (!isValidLogId(id) || !this.hasLog(id)) continue;
      const path = this.logPath(id);
      const info = await stat(path).catch(() => undefined);
      if (!info || info.size <= maxBytes) continue;
      const from = Math.max(0, info.size - keepBytes);
      let text = await Bun.file(path).slice(from, info.size).text();
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
      await Bun.write(`${path}.1`, text);
      const fd = openSync(path, "r+");
      try {
        ftruncateSync(fd, 0);
        writeSync(fd, `===== ${new Date().toISOString()} rotated =====\n`);
      } finally {
        closeSync(fd);
      }
      rotated.push(id);
    }
    return rotated;
  }

  async hydrate(): Promise<void> {
    if (this.loaded) return;
    for (const t of await this.registry.loadTracked()) this.tracked.set(t.id, t);
    this.loaded = true;
    this.reconcile();
  }

  reconcile(): void {
    let dirty = false;
    for (const t of this.tracked.values()) {
      if (t.exitedAt != null) continue;
      if (isAlive(t.pid)) continue;
      t.exitedAt = Date.now();
      dirty = true;
    }
    if (dirty) void this.persist();
  }

  listTracked(): Tracked[] {
    return [...this.tracked.values()];
  }

  trackedOf(id: string): Tracked | undefined {
    return this.tracked.get(id);
  }

  isTrackedAlive(id: string): boolean {
    const t = this.tracked.get(id);
    if (!t || t.exitedAt != null) return false;
    return isAlive(t.pid);
  }

  private async persist(): Promise<void> {
    await this.registry.saveTracked(this.listTracked());
  }

  private remember(id: string, pid: number): void {
    const rec: Tracked = { id, pid, startedAt: Date.now() };
    this.tracked.set(id, rec);
    void this.persist();
  }

  private markExit(id: string, pid: number, code: number | null): void {
    const cur = this.tracked.get(id);
    if (!cur || cur.pid !== pid) return;
    cur.exitCode = code ?? 0;
    cur.exitedAt = Date.now();
    void this.persist();
  }

  async start(spec: StartSpec): Promise<number> {
    await this.hydrate();
    const cwdInfo = await stat(spec.cwd).catch(() => undefined);
    if (!cwdInfo?.isDirectory()) throw new Error(`working directory does not exist: ${spec.cwd}`);
    await mkdir(this.logDir, { recursive: true, mode: 0o700 });
    await chmod(this.logDir, 0o700);
    await this.rotateIfNeeded(spec.id);
    const fd = openSync(this.logPath(spec.id), "a", 0o600);
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
      if (child.pid === undefined) throw new Error(`failed to start: ${spec.command}`);
      this.remember(spec.id, child.pid);
      child.on("exit", (code) => this.markExit(spec.id, child.pid!, code));
      child.unref();
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
    await chmod(path, 0o600);
    await unlink(`${path}.1`).catch(() => undefined);
    const { size } = await stat(path);
    return { path, size };
  }

  async tailLog(id: string, lines = 200, from?: number): Promise<{ lines: string[]; path: string; size: number; reset?: boolean; next: number }> {
    const path = this.logPath(id);
    const { size } = await stat(path);
    if (from != null) {
      if (size < from) {
        const text = await Bun.file(path).text();
        const all = splitLogLines(text);
        return { lines: all, path, size, reset: true, next: size };
      }
      const text = await Bun.file(path).slice(from, size).text();
      const lastNl = text.lastIndexOf("\n");
      const complete = lastNl >= 0 ? text.slice(0, lastNl) : "";
      const linesOut = complete.length ? complete.split("\n") : [];
      return { lines: linesOut, path, size, next: from + (lastNl >= 0 ? lastNl + 1 : 0) };
    }
    const start = Math.max(0, size - 256 * 1024);
    const live = splitLogLines(await Bun.file(path).slice(start, size).text());
    const prevPath = `${path}.1`;
    if (live.length >= lines || !existsSync(prevPath)) {
      return { lines: live.slice(-lines), path, size, next: size };
    }
    const prevSize = (await stat(prevPath)).size;
    const prev = splitLogLines(await Bun.file(prevPath).slice(Math.max(0, prevSize - 256 * 1024), prevSize).text());
    return { lines: [...prev.slice(-(lines - live.length)), ...live], path, size, next: size };
  }
}

function splitLogLines(text: string): string[] {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}
