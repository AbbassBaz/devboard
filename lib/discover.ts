import type { Listener } from "./types";

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
