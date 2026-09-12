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

export function countErrors(lines: string[]): number {
  return lines.reduce((n, line) => n + (classifyLine(line) === "error" ? 1 : 0), 0);
}

export function looksLikeJson(s: string): boolean {
  const t = stripAnsi(s).trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

export const JSON_TRACE_KEYS = ["requestId", "reqId", "traceId", "trace_id", "correlationId", "x-request-id"] as const;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TRACEPARENT_RE = /\b[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}\b/gi;
const REQ_RE = /\breq[-_][a-z0-9][-a-z0-9]*/gi;
const HEX_RE = /\b[0-9a-f]{16,}\b/gi;

function allMatches(re: RegExp, text: string): { value: string; start: number; end: number }[] {
  const out: { value: string; start: number; end: number }[] = [];
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(r)) {
    const start = m.index ?? 0;
    out.push({ value: m[0], start, end: start + m[0].length });
  }
  return out;
}

export function jsonTraceIds(raw: string): string[] {
  if (!looksLikeJson(raw)) return [];
  try {
    const v = JSON.parse(stripAnsi(raw).trim()) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return [];
    const rec = v as Record<string, unknown>;
    const out: string[] = [];
    for (const key of JSON_TRACE_KEYS) {
      const val = rec[key];
      if (typeof val === "string" && val.trim()) out.push(val.trim());
    }
    return out;
  } catch {
    return [];
  }
}

export function findIds(raw: string): string[] {
  const text = stripAnsi(raw);
  const out: string[] = [];
  const add = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  for (const id of jsonTraceIds(text)) add(id);
  const uuids = allMatches(UUID_RE, text);
  const tps = allMatches(TRACEPARENT_RE, text);
  const reqs = allMatches(REQ_RE, text);
  for (const m of uuids) add(m.value);
  for (const m of reqs) add(m.value);
  for (const m of tps) {
    add(m.value);
    add(m.value.split("-")[1] ?? "");
  }
  const covered = [...uuids, ...tps];
  for (const m of allMatches(HEX_RE, text)) {
    if (covered.some((c) => m.start >= c.start && m.end <= c.end)) continue;
    add(m.value);
  }
  return out;
}
