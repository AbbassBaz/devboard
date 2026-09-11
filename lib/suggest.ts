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

/** Strip `--port` / `-p` / `PORT=` so two invocations of the same server compare equal. */
export function commandWithoutPort(command: string): string {
  return command
    .replace(/--port[=\s]+\d+/gi, " ")
    .replace(/(?:^|\s)-p[=\s]+\d+(?=\s|$)/g, " ")
    .replace(/\bPORT=\d+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Rewrite a saved command so a worktree copy listens on `port`. */
export function rewriteCommandPort(command: string, port: number): string {
  if (/--port[=\s]+\d+/i.test(command)) return command.replace(/--port[=\s]+\d+/i, `--port ${port}`);
  if (/(?:^|\s)-p[=\s]+\d+(?=\s|$)/.test(command)) return command.replace(/(^|\s)-p[=\s]+\d+(?=\s|$)/, `$1-p ${port}`);
  if (/\bPORT=\d+/.test(command)) return command.replace(/\bPORT=\d+/, `PORT=${port}`);
  return `PORT=${port} ${command}`;
}

export function rewriteUrlPort(url: string, port: number): string {
  return url.replace(/^(https?:\/\/[^/:]+):\d+/i, `$1:${port}`);
}

const PREFERRED = ["dev", "start", "storybook", "preview"];
const PREFERRED_PREFIX = /^(dev|start|storybook|preview):/;
const SERVER_CMD = /\b(vite|next|nuxt|remix|astro|storybook|nodemon|webpack-dev-server|wrangler)\b|--watch\b|--hot\b|--port\b|\bPORT=|\btsx watch\b|\bbun --watch\b|\bbun --hot\b/i;

export function isServerScript(name: string, cmd: string): boolean {
  if (PREFERRED.includes(name) || PREFERRED_PREFIX.test(name)) return true;
  return SERVER_CMD.test(cmd);
}

export function parsePackageScripts(json: string, run: string): CommandSuggestion[] {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(json) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }
  const names = [
    ...PREFERRED.filter((n) => scripts[n]),
    ...Object.keys(scripts)
      .filter((n) => !PREFERRED.includes(n) && isServerScript(n, scripts[n] ?? ""))
      .sort(),
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
