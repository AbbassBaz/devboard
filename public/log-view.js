/**
 * Pure log-pane logic: `LogEntry[]` and view state in, arrays and strings out.
 *
 * Nothing here touches `document`, `window`, `fetch`, or `localStorage`, so `bun test`
 * imports this file directly (`test/log-view.test.ts`) with no DOM. Page logic that
 * meets that bar belongs here, not in `app.js`.
 *
 * An entry is what `GET /api/logs/:id` returns; `LogEntry` in `lib/types.ts`.
 */

/** The clock part of a time the process printed. Never invents one. */
export function formatLogTime(t) {
  if (!t) return "";
  const iso = Date.parse(t);
  if (!Number.isNaN(iso) && /^\d{4}-\d{2}-\d{2}/.test(t)) {
    return new Date(iso).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  const m = t.match(/(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : t;
}

/** The CSS class for a line: a devboard marker first, then its level. */
export function lineKind(entry) {
  if (!entry) return "";
  if (entry.marker) return "mark";
  if (entry.level === "error") return "err";
  if (entry.level === "warn") return "warn";
  if (entry.level === "info") return "ok";
  return "";
}

/** The line without the time it printed. `entry.time` is a prefix of `entry.text`. */
export function entryBody(entry) {
  const text = entry?.text ?? "";
  if (!entry?.time) return text;
  const i = text.indexOf(entry.time);
  return i < 0 ? text : text.slice(i + entry.time.length).trimStart();
}

/** The JSON request id the server lifted, shown as a small label on a JSON line. */
export function entryTid(entry) {
  return entry?.text?.startsWith("{") ? (entry.ids ?? [])[0] ?? "" : "";
}

export const LEVELS = ["error", "warn", "info", "debug", "other"];

/** Is this entry's level one of the ones the Levels dropdown has checked? */
export function inLevels(entry, levels) {
  if (!levels) return true;
  const has = typeof levels.has === "function" ? (l) => levels.has(l) : (l) => levels.includes(l);
  return has(entry?.level ?? "other");
}

/** The scope filters: level, and nothing else that reads one line at a time. */
function inScope(entry, state) {
  return !!entry && inLevels(entry, state.levels);
}

/** The text filter. Plain substring until F-37 gives it a syntax. */
function matchesSearch(entry, state) {
  const q = (state.filter ?? "").trim().toLowerCase();
  if (!q) return true;
  return (entry?.text ?? "").toLowerCase().includes(q);
}

/** Does this entry survive the level set and the search text? */
export function matchesEntry(entry, state = {}) {
  return inScope(entry, state) && matchesSearch(entry, state);
}

/** Absolute line keys of the `start` markers: where each run of the process begins. */
export function runBoundaries(entries, base = 0) {
  const out = [];
  for (const e of entries ?? []) {
    if (e?.marker?.type === "start") out.push(base + e.i);
  }
  return out;
}

/**
 * The first position the view shows: after a Clear (`viewStart`, an absolute key so a
 * buffer trim cannot move it) and after the last `start` marker when This run is on.
 */
export function scopeStart(entries, state = {}) {
  const list = entries ?? [];
  const base = state.base ?? 0;
  let from = 0;
  if (state.viewStart != null) from = Math.max(from, state.viewStart - base);
  if (state.runOnly) {
    const runs = runBoundaries(list, base);
    if (runs.length) from = Math.max(from, runs[runs.length - 1] - base);
  }
  return Math.max(0, Math.min(from, list.length));
}

/** The entries the pane shows, in file order. */
export function visibleEntries(entries, state = {}) {
  const list = entries ?? [];
  return list.slice(scopeStart(list, state)).filter((e) => matchesEntry(e, state));
}

/**
 * Continuation lines folded under the line they belong to. A stack frame, an indented
 * dump, or a closing brace attaches to the nearest line above that is not one itself;
 * a `cont` with nothing above it is its own group. `start` and `end` are the positions
 * the group covers, which is how an append finds the group it has to re-render.
 */
export function foldEntries(entries) {
  const groups = [];
  for (const e of entries ?? []) {
    if (!e) continue;
    const last = groups[groups.length - 1];
    if (e.cont && last && !last.head.marker) {
      last.tail.push(e);
      last.end = e.i;
      continue;
    }
    groups.push({ head: e, tail: [], repeat: 1, start: e.i, end: e.i });
  }
  return groups;
}

/** What makes two lines the same line again: the level, the logger, and the message. */
export function repeatKey(entry) {
  if (!entry) return "";
  if (entry.marker) return `marker|${entry.i}`;
  // The folded context is left out on purpose: nine `plugin registered` lines differ
  // only inside their JSON, and the pane shows one of them with `×9`.
  if (entry.msg != null) return `${entry.level}|${entry.logger ?? ""}|${entry.msg}`;
  return `${entry.level}|${entryBody(entry)}`;
}

/** Runs of the same line collapse into the last one, which keeps its time and counts the rest. */
export function collapseRepeats(groups) {
  const out = [];
  for (const g of groups ?? []) {
    const last = out[out.length - 1];
    // Only lines with nothing folded under them collapse, so a repeated crash dump
    // never loses the frames of the copy it replaces.
    if (last && !last.tail.length && !g.tail.length && !g.head.marker && repeatKey(last.head) === repeatKey(g.head)) {
      out[out.length - 1] = { head: g.head, tail: [], repeat: last.repeat + 1, start: last.start, end: g.end };
      continue;
    }
    out.push({ ...g });
  }
  return out;
}

/**
 * A group is in scope when its head is; the search then hits the head or any line folded
 * under it, so a search for `EADDRINUSE` shows the whole dump.
 */
export function groupMatches(group, state = {}) {
  if (!group || !inScope(group.head, state)) return false;
  if (matchesSearch(group.head, state)) return true;
  return (group.tail ?? []).some((e) => matchesSearch(e, state));
}

/** The groups the pane renders: folded, collapsed, and filtered, in file order. */
export function visibleGroups(entries, state = {}) {
  const list = entries ?? [];
  return collapseRepeats(foldEntries(list.slice(scopeStart(list, state)))).filter((g) => groupMatches(g, state));
}

/** How many lines of each level are in the buffer. Levels with no lines read 0. */
export function levelCounts(entries) {
  const counts = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
  for (const e of entries ?? []) {
    const level = e?.level ?? "other";
    counts[level] = (counts[level] ?? 0) + 1;
  }
  return counts;
}

/**
 * Absolute line keys (`base + position`) of the error lines, for the chip and `e`.
 * Heads only: the ten frames of one crash are one stop, not eleven.
 */
export function errorIndexes(entries, base = 0, state = {}) {
  const out = [];
  for (const g of visibleGroups(entries, { ...state, base })) {
    if (g.head.level === "error") out.push(base + g.head.i);
  }
  return out;
}

/** What the Levels button reads, from the set it has checked. */
export function levelsLabel(levels) {
  const on = LEVELS.filter((l) => inLevels({ level: l }, levels));
  if (on.length === LEVELS.length) return "All levels";
  if (on.length === 1 && on[0] === "error") return "Errors";
  if (on.length === 2 && on.includes("error") && on.includes("warn")) return "Errors · Warnings";
  return "Custom";
}

/** The 3-character gutter badge. `other` has none, so a marker line stays quiet. */
export function levelBadge(level) {
  if (level === "error") return "ERR";
  if (level === "warn") return "WRN";
  if (level === "info") return "INF";
  if (level === "debug") return "DBG";
  return "";
}

/**
 * What the content column shows once the badge carries the level: the logger, the
 * message, and the JSON context that folds behind a chevron.
 */
export function contentParts(entry) {
  if (!entry) return { text: "" };
  if (entry.marker) return { text: entryBody(entry) };
  const out = { text: entry.msg ?? entryBody(entry) };
  if (entry.logger) out.logger = entry.logger;
  if (entry.ctx) out.ctx = entry.ctx;
  return out;
}

/** A folded context, pretty-printed at 2-space indent. Text that is not JSON comes back as it is. */
export function prettyCtx(ctx) {
  const text = String(ctx ?? "");
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object") return text;
    return JSON.stringify(value, null, 2);
  } catch {
    return text;
  }
}

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/g;

/** Pretty-printed context split into `key`, `str`, `num`, and plain runs for colouring. */
export function ctxTokens(pretty) {
  const text = String(pretty ?? "");
  const out = [];
  let last = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), kind: "" });
    const kind = m[1] ? "key" : m[2] ? "str" : "num";
    const value = m[1] ?? m[2] ?? m[3];
    out.push({ text: value, kind });
    last = at + value.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: "" });
  return out;
}

/** The class for an HTTP status: 2xx reads ok, 3xx dim, 4xx warn, 5xx error. */
export function statusClass(status) {
  if (status >= 500) return "s5";
  if (status >= 400) return "s4";
  if (status >= 300) return "s3";
  return "s2";
}

/** Spans for the method, path, status, and duration of a request line, located in the rendered text. */
export function httpSpans(text, http) {
  if (!http || !text) return [];
  const m = text.indexOf(http.method);
  if (m < 0) return [];
  const p = text.indexOf(http.path, m + http.method.length);
  if (p < 0) return [];
  const code = String(http.status);
  const st = text.indexOf(code, p + http.path.length);
  if (st < 0) return [];
  const spans = [
    { start: m, end: m + http.method.length, kind: "http", cls: "hm" },
    { start: p, end: p + http.path.length, kind: "http", cls: "hp" },
    { start: st, end: st + code.length, kind: "http", cls: statusClass(http.status) },
  ];
  if (http.ms != null) {
    const ms = String(http.ms);
    const at = text.indexOf(ms, st + code.length);
    if (at >= 0) spans.push({ start: at, end: at + ms.length, kind: "http", cls: http.ms >= 1000 ? "hs" : "hd" });
  }
  return spans;
}

/** Spans for the id tokens the server found. A composite id yields to the part worth tracing. */
export function idSpans(text, ids) {
  const own = ids ?? [];
  const wanted = own.filter((id) => !own.some((other) => other !== id && id.includes(other))).sort((a, b) => b.length - a.length);
  const spans = [];
  for (const id of wanted) {
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(id, from);
      if (at < 0) break;
      spans.push({ start: at, end: at + id.length, kind: "id", value: id });
      from = at + id.length;
    }
  }
  return spans;
}

const SPAN_RANK = { id: 3, link: 2, path: 2, http: 1 };

/** One set of non-overlapping spans in text order. A higher-ranked span wins the overlap. */
export function mergeSpans(spans) {
  const list = (spans ?? []).filter((s) => s && s.end > s.start);
  const byRank = [...list].sort((a, b) => (SPAN_RANK[b.kind] ?? 0) - (SPAN_RANK[a.kind] ?? 0) || a.start - b.start || b.end - a.end);
  const kept = [];
  for (const s of byRank) {
    if (kept.some((k) => s.start < k.end && k.start < s.end)) continue;
    kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}
