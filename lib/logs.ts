export type LogLevel = "error" | "warn" | "info" | "debug" | "other";

const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

const TS = /^(\s*(?:\[[^\]]{6,32}\]|\d{4}-\d{2}-\d{2}[T ][\d:.Z+-]+|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*)/;

export function splitLogLine(raw: string): { time: string; body: string } {
  const text = stripAnsi(raw);
  const m = TS.exec(text);
  if (!m) return { time: "", body: text };
  return { time: m[1].trim(), body: text.slice(m[0].length) };
}

const ERROR_RE = /\b(error|err!|fatal|panic|exception|uncaught|unhandled|econnrefused|enotfound|eaddrinuse|eacces|failed|failure|rejected|cannot |can't |exit(?:ed)? status|[✖×✗]|err_[a-z0-9_]+)\b|^\s*at\s+\S+/i;
const WARN_RE = /\b(warn(?:ing)?|deprecated|caution|slow|overrid)\b|[⚠]/i;
const INFO_RE = /\b(info|listening|ready|started|compiled|success|connected|http\/|GET |POST |PUT |PATCH |DELETE )\b/i;
const DEBUG_RE = /\b(debug|trace|verbose)\b/i;
const LEVEL_TOKEN = /\b(error|warn(?:ing)?|info|debug|fatal)\b/i;

export function classifyLine(raw: string): LogLevel {
  const text = stripAnsi(raw);
  const tagged = /^\s*(?:\[)?(error|err|fatal|warn(?:ing)?|info|debug|trace)(?:\])?\s*[:\-]/.exec(text.toLowerCase());
  if (tagged) {
    const t = tagged[1];
    if (t === "error" || t === "err" || t === "fatal") return "error";
    if (t.startsWith("warn")) return "warn";
    if (t === "info") return "info";
    return "debug";
  }
  if (ERROR_RE.test(text)) return "error";
  if (WARN_RE.test(text)) return "warn";
  if (INFO_RE.test(text)) return "info";
  if (DEBUG_RE.test(text)) return "debug";
  if (LEVEL_TOKEN.test(text)) {
    const hit = text.match(LEVEL_TOKEN)![1].toLowerCase();
    if (hit === "error" || hit === "fatal") return "error";
    if (hit.startsWith("warn")) return "warn";
    if (hit === "info") return "info";
    return "debug";
  }
  return "other";
}

export function looksLikeJson(s: string): boolean {
  const t = stripAnsi(s).trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}
