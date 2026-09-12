import type { LogEntry, LogHttp, LogLevel, LogMarker } from "./types";

/** CSI: SGR colour, cursor moves, erases, and private `?` modes such as `ESC[?25h`. */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** OSC: window titles and hyperlinks, terminated by BEL or ST. */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** Single-character escapes (ESC c, ESC ], ESC \, …) left over after the two above. */
const ESC1 = /\x1b[@-Z\\-_]/g;
/** Anything still below 0x20 that is not a tab or a newline, plus DEL. */
const C0 = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * One printable line: every terminal control sequence removed and `\r` resolved so a
 * progress bar keeps only its final frame. Never returns a byte below 0x20 except tab.
 */
export function cleanLine(s: string): string {
  const stripped = String(s ?? "").replace(CSI, "").replace(OSC, "").replace(ESC1, "");
  return stripped.split("\n").map(lastFrame).join("\n").replace(C0, "");
}

/** Text after the last `\r` that is not the CRLF artefact at the end of the line. */
function lastFrame(line: string): string {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  const i = text.lastIndexOf("\r");
  return i < 0 ? text : text.slice(i + 1);
}

const TS = /^(\s*(?:\[[^\]]{6,32}\]|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*)/;

/** Split an already-cleaned line into the timestamp it printed and the rest. */
function splitClean(text: string): { time: string; body: string } {
  const m = TS.exec(text);
  if (!m) return { time: "", body: text };
  return { time: m[1].trim(), body: text.slice(m[0].length) };
}

export function splitLogLine(raw: string): { time: string; body: string } {
  return splitClean(cleanLine(raw));
}

const MARKER = /^=====\s(.+?)\s=====$/;

/** A devboard `=====` line: the start header, a rotation, or a clear. */
export function parseMarker(text: string): LogMarker | undefined {
  const m = MARKER.exec(text.trim());
  if (!m) return undefined;
  const rest = m[1];
  const start = /^(\S+) start in (.+?): (.+)$/.exec(rest);
  if (start) return { type: "start", at: start[1], cwd: start[2], command: start[3] };
  const rotated = /^(\S+) rotated(?:,.*)?$/.exec(rest);
  if (rotated) return { type: "rotated", at: rotated[1] };
  const cleared = /^(\S+) cleared$/.exec(rest);
  if (cleared) return { type: "cleared", at: cleared[1] };
  return undefined;
}

const LEVEL_WORD = "(error|err|fatal|critical|warning|warn|notice|info|debug|trace|verbose)";
/** `- INFO livekit.agents - msg` (Python `logging`, the leading dash left by the time split). */
const STRUCT_LOGGER = new RegExp(`^(?:-\\s+)?${LEVEL_WORD}\\s+([\\w.$-]{2,64})\\s+-\\s+(.*)$`, "i");
/** `INFO [logger] msg` */
const STRUCT_LEVEL_FIRST = new RegExp(`^${LEVEL_WORD}\\s+\\[([^\\]]{1,64})\\]\\s*[:-]?\\s*(.*)$`, "i");
/** `[logger] INFO msg` */
const STRUCT_LOGGER_FIRST = new RegExp(`^\\[([^\\]]{1,64})\\]\\s+${LEVEL_WORD}\\s*[:-]?\\s*(.*)$`, "i");

export type Structured = { level: LogLevel; logger?: string; msg: string; ctx?: string };

/** The `LEVEL logger - message {json}` family, as Python `logging`, pino-pretty, and nest print it. */
export function parseStructured(body: string): Structured | undefined {
  let level: string | undefined;
  let logger: string | undefined;
  let rest: string | undefined;
  const a = STRUCT_LOGGER.exec(body);
  if (a) [, level, logger, rest] = a;
  else {
    const b = STRUCT_LEVEL_FIRST.exec(body);
    if (b) [, level, logger, rest] = b;
    else {
      const c = STRUCT_LOGGER_FIRST.exec(body);
      if (c) [, logger, level, rest] = c;
    }
  }
  if (!level || rest == null) return undefined;
  const { msg, ctx } = splitTrailingCtx(rest);
  const out: Structured = { level: levelFromWord(level) ?? "other", msg };
  if (logger) out.logger = logger;
  if (ctx) out.ctx = ctx;
  return out;
}

/** Index of the `{` that opens a balanced object closing the string, or -1. */
function trailingObjectAt(text: string): number {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth < 0) return -1;
      if (depth === 0 && i === text.length - 1) return start;
    }
  }
  return -1;
}

/** Peel a trailing `{…}` context off a message when it is balanced and worth folding. */
export function splitTrailingCtx(rest: string): { msg: string; ctx?: string } {
  const text = rest.trimEnd();
  const at = text.endsWith("}") ? trailingObjectAt(text) : -1;
  if (at < 0 || text.length - at < 20) return { msg: text.trim() };
  return { msg: text.slice(0, at).trim(), ctx: text.slice(at) };
}

const JSON_LEVEL_NUM: Record<number, LogLevel> = { 10: "debug", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "error" };

function levelFromWord(word: string): LogLevel | undefined {
  const w = word.toLowerCase();
  if (w === "error" || w === "err" || w === "fatal" || w === "critical") return "error";
  if (w.startsWith("warn")) return "warn";
  if (w === "info" || w === "notice") return "info";
  if (w === "debug" || w === "trace" || w === "verbose") return "debug";
  return undefined;
}

function levelFromJson(value: unknown): LogLevel | undefined {
  if (typeof value === "number") return JSON_LEVEL_NUM[value] ?? (value >= 50 ? "error" : value >= 40 ? "warn" : value >= 30 ? "info" : "debug");
  if (typeof value === "string") return levelFromWord(value) ?? levelFromJson(Number(value));
  return undefined;
}

/** An epoch number is the time the process itself recorded, so rendering it as ISO is not a fabrication. */
function jsonTime(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const ms = value > 1e11 ? value : value * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export type JsonLine = { level?: LogLevel; msg?: string; time?: string; logger?: string; ctx?: string };

/** A whole-line JSON object: pino, bunyan, structlog. Known keys are lifted, the rest becomes `ctx`. */
export function parseJsonLine(body: string): JsonLine | undefined {
  if (!looksLikeJson(body)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(cleanLine(body).trim()); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const rec = { ...(parsed as Record<string, unknown>) };
  const take = (keys: string[]): unknown => {
    for (const k of keys) {
      if (k in rec) {
        const v = rec[k];
        delete rec[k];
        if (v != null && v !== "") return v;
      }
    }
    return undefined;
  };
  const out: JsonLine = {};
  const level = levelFromJson(take(["level", "severity", "lvl"]));
  if (level) out.level = level;
  const msg = take(["msg", "message", "event"]);
  if (typeof msg === "string") out.msg = msg;
  else if (msg != null) out.msg = JSON.stringify(msg);
  const time = jsonTime(take(["time", "timestamp", "ts"]));
  if (time) out.time = time;
  const logger = take(["name", "logger"]);
  if (typeof logger === "string") out.logger = logger;
  if (Object.keys(rec).length) out.ctx = JSON.stringify(rec);
  return out;
}

const HTTP = /(?:^|[\s>])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)\s+(\d{3})\b(?:\s+in\s+([\d.]+)\s*ms|\s+([\d.]+)\s*ms)?/;

/** `GET /api/x 200 in 34ms` (Next), `--> GET / 200 12ms` (Hono), `GET /api 200 12.3 ms - 123` (morgan). */
export function parseHttp(text: string): LogHttp | undefined {
  const m = HTTP.exec(text);
  if (!m) return undefined;
  const status = Number(m[3]);
  if (!Number.isFinite(status) || status < 100 || status > 599) return undefined;
  const msRaw = m[4] ?? m[5];
  const ms = msRaw == null ? undefined : Number(msRaw);
  const http: LogHttp = { method: m[1], path: m[2], status };
  if (ms != null && Number.isFinite(ms)) http.ms = ms;
  return http;
}

const CONT = [
  /^\s+at\s/,
  /^\s{2,}\S/,
  /^\s*[\]\})],?\s*$/,
  /^Traceback \(most recent call last\)/,
  /^ {2}File "/,
  /^\s*\^+\s*$/,
];

/** A stack frame, an indented object dump, or the closing brace of one. */
export function isContinuation(text: string): boolean {
  return CONT.some((re) => re.test(text));
}

const ERROR_RE = /\b(error|err!|fatal|panic|exception|uncaught|unhandled|econnrefused|enotfound|eaddrinuse|eacces|failed|failure|rejected|cannot |can't |exit(?:ed)? status|[✖×✗]|err_[a-z0-9_]+)\b|^\s*at\s+\S+/i;
const WARN_RE = /\b(warn(?:ing)?|deprecated|caution|slow|overrid)\b|[⚠]/i;
const INFO_RE = /\b(info|listening|ready|started|compiled|success|connected|http\/|GET |POST |PUT |PATCH |DELETE )\b/i;
const DEBUG_RE = /\b(debug|trace|verbose)\b/i;
const LEVEL_TOKEN = /\b(error|warn(?:ing)?|info|debug|fatal)\b/i;

type Parts = { json?: JsonLine; structured?: Structured; http?: LogHttp };

/** Everything the level decision and `parseLine` both need, computed once. */
function analyze(text: string, body: string): Parts {
  const json = parseJsonLine(body);
  return {
    json,
    structured: json ? undefined : parseStructured(body),
    http: parseHttp(text),
  };
}

/** The tagged level a line carries, from a structured prefix or a JSON field. */
function taggedLevel(text: string, parts: Parts): LogLevel | undefined {
  if (parts.json?.level) return parts.json.level;
  if (parts.structured && parts.structured.level !== "other") return parts.structured.level;
  const tagged = /^\s*(?:\[)?(error|err|fatal|warn(?:ing)?|info|debug|trace)(?:\])?\s*[:\-]/.exec(text.toLowerCase());
  return tagged ? levelFromWord(tagged[1]) : undefined;
}

function levelOf(text: string, parts: Parts): LogLevel {
  const tag = taggedLevel(text, parts);
  if (tag) return tag;
  const http = parts.http;
  if (http) {
    if (http.status >= 500) return "error";
    if (http.status >= 400) return "warn";
    return "info";
  }
  if (ERROR_RE.test(text)) return "error";
  if (WARN_RE.test(text)) return "warn";
  if (INFO_RE.test(text)) return "info";
  if (DEBUG_RE.test(text)) return "debug";
  if (LEVEL_TOKEN.test(text)) return levelFromWord(text.match(LEVEL_TOKEN)![1]) ?? "other";
  return "other";
}

/**
 * The one classifier. Reads a tagged level first (structured prefix or JSON field),
 * then the HTTP status (5xx error, 4xx warn), then the word heuristics.
 */
export function classifyLine(raw: string): LogLevel {
  const text = cleanLine(raw);
  if (parseMarker(text)) return "other";
  return levelOf(text, analyze(text, splitClean(text).body));
}

/** Parse one raw log line into the shape every reader of a log uses. */
export function parseLine(raw: string, i: number): LogEntry {
  const text = cleanLine(raw);
  const marker = parseMarker(text);
  if (marker) return { i, text, level: "other", marker };
  const { time, body } = splitClean(text);
  const parts = analyze(text, body);
  const entry: LogEntry = { i, text, level: levelOf(text, parts) };
  if (time) entry.time = time;
  const part = parts.json ?? parts.structured;
  if (part) {
    if (part.logger) entry.logger = part.logger;
    if (part.msg) entry.msg = part.msg;
    if (part.ctx) entry.ctx = part.ctx;
    if (parts.json?.time && !entry.time) entry.time = parts.json.time;
  }
  if (parts.http) entry.http = parts.http;
  if (isContinuation(text)) entry.cont = true;
  const ids = findIds(text);
  if (ids.length) entry.ids = ids;
  return entry;
}

export function countErrors(lines: string[]): number {
  return lines.reduce((n, line) => n + (classifyLine(line) === "error" ? 1 : 0), 0);
}

export function looksLikeJson(s: string): boolean {
  const t = cleanLine(s).trim();
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
    const v = JSON.parse(cleanLine(raw).trim()) as unknown;
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
  const text = cleanLine(raw);
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
