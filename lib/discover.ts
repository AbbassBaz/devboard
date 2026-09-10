import type { Listener, Process } from "./types";

export function parseListeners(text: string): Listener[] {
  const out: Listener[] = [];
  const seen = new Set<string>();
  let pid = 0;
  let command = "";
  for (const line of text.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number(value);
      command = "";
    } else if (tag === "c") {
      command = value;
    } else if (tag === "n") {
      const idx = value.lastIndexOf(":");
      if (idx < 0) continue;
      const port = Number(value.slice(idx + 1));
      if (!Number.isInteger(port)) continue;
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pid, command, port, address: value.slice(0, idx) });
    }
  }
  return out;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/;

export function parseProcesses(text: string): Process[] {
  const out: Process[] = [];
  for (const line of text.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pcpu: Number(m[3]),
      rss: Number(m[4]),
      etime: m[5],
      args: (m[6] ?? "").trim(),
    });
  }
  return out;
}

export function parseCwds(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) out.set(pid, line.slice(1));
  }
  return out;
}

const WRAPPER_EXES = new Set(["node", "bun", "deno", "npm", "npx", "pnpm", "yarn", "next", "next-server"]);
const SHELL_EXES = new Set(["sh", "bash", "zsh"]);
const RUNTIME_EXES = new Set(["python", "python3", "uvicorn", "ruby", "java", "go", "cargo"]);

export function exeName(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
}

export function isWrapper(p: Process): boolean {
  const exe = exeName(p.args);
  if (WRAPPER_EXES.has(exe)) return true;
  if (SHELL_EXES.has(exe)) return p.args.trim().split(/\s+/)[1] === "-c";
  return false;
}

export function isRuntime(p: Process): boolean {
  return RUNTIME_EXES.has(exeName(p.args));
}

export function indexProcesses(procs: Process[]) {
  const byPid = new Map<number, Process>();
  const byPpid = new Map<number, Process[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    const siblings = byPpid.get(p.ppid) ?? [];
    siblings.push(p);
    byPpid.set(p.ppid, siblings);
  }
  return { byPid, byPpid };
}

export function findRoot(pid: number, byPid: Map<number, Process>, stopAt: number): number {
  let current = pid;
  for (;;) {
    const proc = byPid.get(current);
    if (!proc) return current;
    const parent = byPid.get(proc.ppid);
    if (!parent || parent.pid <= 1 || parent.pid === stopAt || !isWrapper(parent)) return current;
    current = parent.pid;
  }
}

export function treePids(rootPid: number, byPpid: Map<number, Process[]>): number[] {
  const out = [rootPid];
  for (let i = 0; i < out.length; i++) {
    for (const child of byPpid.get(out[i]) ?? []) out.push(child.pid);
  }
  return out;
}
