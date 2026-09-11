import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type CommandSuggestion = {
  label: string;
  command: string;
  port?: number;
  source: "npm" | "compose" | "procfile";
};

async function exists(path: string): Promise<boolean> {
  return !!(await stat(path).catch(() => undefined));
}

async function runner(dir: string): Promise<string> {
  if (await exists(join(dir, "bun.lock")) || await exists(join(dir, "bun.lockb"))) return "bun run";
  if (await exists(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(dir, "yarn.lock"))) return "yarn";
  return "npm run";
}

export function portFromCommand(command: string): number | undefined {
  const m = command.match(/--port[=\s]+(\d+)/i) || command.match(/\bPORT=(\d+)/) || command.match(/:(\d{2,5})\b/);
  if (!m) return undefined;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? port : undefined;
}

export function parsePackageScripts(json: string, run: string): CommandSuggestion[] {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(json) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }
  const preferred = ["dev", "start", "storybook", "preview"];
  const names = [
    ...preferred.filter((n) => scripts[n]),
    ...Object.keys(scripts).filter((n) => !preferred.includes(n) && /dev|start|story/i.test(n)),
  ];
  return names.map((name) => {
    const command = `${run} ${name}`;
    return { label: name, command, port: portFromCommand(scripts[name] ?? ""), source: "npm" as const };
  });
}

export function parseComposeServices(text: string): CommandSuggestion[] {
  const out: CommandSuggestion[] = [];
  let inServices = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices && /^\S/.test(line) && !line.startsWith("#")) break;
    if (!inServices) continue;
    const m = /^  ([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (m) out.push({ label: m[1], command: `docker compose up ${m[1]}`, source: "compose" });
  }
  return out;
}

export function parseProcfile(text: string): CommandSuggestion[] {
  const out: CommandSuggestion[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sp = line.indexOf(":");
    if (sp <= 0) continue;
    const label = line.slice(0, sp).trim();
    const command = line.slice(sp + 1).trim();
    if (!label || !command) continue;
    out.push({ label, command, port: portFromCommand(command), source: "procfile" });
  }
  return out;
}

export async function suggestCommands(dir: string): Promise<CommandSuggestion[]> {
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`folder does not exist: ${dir}`);
  const run = await runner(dir);
  const out: CommandSuggestion[] = [];
  const pkg = await readFile(join(dir, "package.json"), "utf8").catch(() => "");
  if (pkg) out.push(...parsePackageScripts(pkg, run));
  for (const name of ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"]) {
    const text = await readFile(join(dir, name), "utf8").catch(() => "");
    if (text) {
      out.push(...parseComposeServices(text));
      break;
    }
  }
  const proc = await readFile(join(dir, "Procfile"), "utf8").catch(() => "");
  if (proc) out.push(...parseProcfile(proc));
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.source}:${s.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
