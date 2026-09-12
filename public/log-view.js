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

/** Does this entry survive the current filter text and errors-only toggle? */
export function matchesEntry(entry, state = {}) {
  const q = (state.filter ?? "").trim().toLowerCase();
  if (q && !entry.text.toLowerCase().includes(q)) return false;
  if (state.errOnly && entry.level !== "error") return false;
  return true;
}

/** The entries the pane shows, in file order. */
export function visibleEntries(entries, state = {}) {
  return (entries ?? []).filter((e) => matchesEntry(e, state));
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

/** Absolute line keys (`base + position`) of the error lines, for the chip and `e`. */
export function errorIndexes(entries, base = 0) {
  const out = [];
  const list = entries ?? [];
  for (let i = 0; i < list.length; i++) {
    if (list[i]?.level === "error") out.push(base + i);
  }
  return out;
}
