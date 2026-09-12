import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { PinTemplateEntry, Pinned } from "./types";

export const TEMPLATE_FILE = "devboard.json";

function asEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") env[k] = v;
  }
  return Object.keys(env).length ? env : undefined;
}

/** Parse a `devboard.json` body. Accepts an array or `{ pins: [...] }`. Skips bad rows. */
export function parsePinTemplate(text: string): PinTemplateEntry[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { pins?: unknown }).pins)
      ? (raw as { pins: unknown[] }).pins
      : [];
  const out: PinTemplateEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name.trim()) continue;
    if (typeof o.command !== "string" || !o.command.trim()) continue;
    const port = Number(o.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const cwd = typeof o.cwd === "string" && o.cwd.trim() ? o.cwd.trim() : undefined;
    const healthUrl = typeof o.healthUrl === "string" && o.healthUrl.trim() ? o.healthUrl.trim() : undefined;
    const env = asEnv(o.env);
    out.push({
      name: o.name.trim(),
      command: o.command.trim(),
      port,
      ...(cwd ? { cwd } : {}),
      ...(healthUrl ? { healthUrl } : {}),
      ...(env ? { env } : {}),
      ...(o.restartOnCrash === true ? { restartOnCrash: true } : {}),
    });
  }
  return out;
}

/** Resolve a template cwd against the repo root. Rejects absolute paths and `..` escapes. */
export function resolveTemplateCwd(root: string, sub?: string): string | undefined {
  const base = resolve(root);
  if (!sub || !sub.trim() || sub.trim() === ".") return base;
  if (isAbsolute(sub)) return undefined;
  const dest = resolve(base, sub);
  const rel = relative(base, dest);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return dest;
}

/** Rows to add: skip cwd+port already pinned. Never overwrites. */
export function planImport(root: string, entries: PinTemplateEntry[], existing: Pinned[]): Omit<Pinned, "id">[] {
  const taken = new Set(existing.map((p) => `${p.cwd}\0${p.port}`));
  const out: Omit<Pinned, "id">[] = [];
  for (const e of entries) {
    const cwd = resolveTemplateCwd(root, e.cwd);
    if (!cwd) continue;
    const key = `${cwd}\0${e.port}`;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({
      name: e.name,
      cwd,
      command: e.command,
      port: e.port,
      ...(e.healthUrl ? { healthUrl: e.healthUrl } : {}),
      ...(e.env ? { env: e.env } : {}),
      ...(e.restartOnCrash ? { restartOnCrash: true } : {}),
    });
  }
  return out;
}

export async function readTemplateFile(dir: string): Promise<string | undefined> {
  const text = await readFile(join(dir, TEMPLATE_FILE), "utf8").catch(() => undefined);
  return text;
}

export async function templateExists(dir: string): Promise<boolean> {
  const info = await stat(join(dir, TEMPLATE_FILE)).catch(() => undefined);
  return !!info?.isFile();
}
