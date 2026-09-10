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
