const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    let value = line.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function formatEnv(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export function mergeEnv(base: NodeJS.ProcessEnv, extra?: Record<string, string>): NodeJS.ProcessEnv {
  if (!extra || !Object.keys(extra).length) return { ...base };
  return { ...base, ...extra };
}

/** Best-effort parse of `ps eww -p` on macOS. Values that contain spaces are truncated at the first space. */
export function parsePsEww(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = text.split("\n").slice(1).join(" ");
  const re = /([A-Za-z_][A-Za-z0-9_]*)=([^\s]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out[m[1]] = m[2];
  return out;
}

export async function readProcessEnv(pid: number): Promise<Record<string, string>> {
  const proc = Bun.spawn(["ps", "eww", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return parsePsEww(text);
}
