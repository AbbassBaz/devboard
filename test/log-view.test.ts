import { describe, expect, test } from "bun:test";
import { parseLine } from "../lib/logs";
// The page's pure half. It must import with no DOM, which is the whole point of the file.
import {
  collapseRepeats, contentParts, ctxTokens, entryBody, entryTid, errorIndexes, findLinks, foldEntries, formatLogTime,
  httpSpans, idSpans, isHidden, levelBadge, levelCounts, levelsLabel, LEVELS, lineKind, matches, matchesEntry,
  markerLabel, matchIndexes, matchSpans, mergeSpans, parseFilter, prettyCtx, relativeAge, runBoundaries,
  scopeStart, statusClass, unreadLabel, visibleEntries, visibleGroups,
} from "../public/log-view.js";

async function fixtureEntries(name: string) {
  const text = await Bun.file(`${import.meta.dir}/fixtures/logs/${name}`).text();
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((l, i) => parseLine(l, i));
}

describe("formatLogTime", () => {
  test("reduces an ISO stamp to a clock and keeps a bare clock", () => {
    expect(formatLogTime("2026-09-12T04:41:34.700Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatLogTime("2026-09-12 04:41:34,700")).toBe("04:41:34");
    expect(formatLogTime("[04:41:34]")).toBe("04:41:34");
    expect(formatLogTime("")).toBe("");
    expect(formatLogTime(undefined)).toBe("");
  });

  test("returns an unparseable stamp unchanged rather than inventing one", () => {
    expect(formatLogTime("later")).toBe("later");
  });
});

describe("lineKind, entryBody, entryTid", () => {
  test("a marker is a marker whatever else the line says", async () => {
    const [start] = await fixtureEntries("livekit.log");
    expect(lineKind(start)).toBe("mark");
  });

  test("level decides the rest", () => {
    expect(lineKind({ level: "error" })).toBe("err");
    expect(lineKind({ level: "warn" })).toBe("warn");
    expect(lineKind({ level: "info" })).toBe("ok");
    expect(lineKind({ level: "other" })).toBe("");
  });

  test("the body drops the time the process printed and nothing else", () => {
    const e = parseLine("2026-09-12 04:41:34,700 - INFO api - up", 0);
    expect(entryBody(e)).toBe("- INFO api - up");
    expect(entryBody({ text: "no time here" })).toBe("no time here");
  });

  test("only a JSON line gets the id label", async () => {
    const entries = await fixtureEntries("pino.log");
    expect(entryTid(entries[1])).toBe("req-9f2c");
    expect(entryTid({ text: "handled req-9f2c", ids: ["req-9f2c"] })).toBe("");
  });
});

describe("visibleEntries", () => {
  test("filters on text and on the level set, and keeps file order", async () => {
    const entries = await fixtureEntries("nextjs.log");
    expect(visibleEntries(entries, {})).toHaveLength(entries.length);
    expect(visibleEntries(entries, { filter: "  " })).toHaveLength(entries.length);
    expect(visibleEntries(entries, { filter: "get /api" }).map((e) => e.http?.status)).toEqual([500, 404]);
    expect(visibleEntries(entries, { levels: ["error"] }).every((e) => e.level === "error")).toBe(true);
    const both = visibleEntries(entries, { filter: "GET", levels: new Set(["error"]) });
    expect(both).toHaveLength(1);
    expect(both[0].http?.status).toBe(500);
    expect(visibleEntries(undefined, {})).toEqual([]);
  });

  test("matchesEntry is case-insensitive on the whole line", () => {
    const e = parseLine("Error: listen EADDRINUSE", 0);
    expect(matchesEntry(e, { filter: "eaddrinuse" })).toBe(true);
    expect(matchesEntry(e, { filter: "nope" })).toBe(false);
    expect(matchesEntry(e, { levels: ["error"] })).toBe(true);
    expect(matchesEntry(e, { levels: ["info"] })).toBe(false);
  });

  test("levels, this run, and a cleared view each hold on their own and together", async () => {
    const entries = await fixtureEntries("livekit.log");
    const all = entries.length;
    expect(visibleEntries(entries, { levels: LEVELS })).toHaveLength(all);
    expect(visibleEntries(entries, { levels: ["warn"] }).map((e) => e.level)).toEqual(["warn"]);

    // The livekit fixture opens with a start marker, so This run drops only the marker itself.
    expect(runBoundaries(entries)).toEqual([0]);
    expect(runBoundaries(entries, 500)).toEqual([500]);
    expect(visibleEntries(entries, { runOnly: true })).toHaveLength(all);
    expect(visibleEntries(entries, { runOnly: true }).map((e) => e.i)).toEqual(entries.map((e) => e.i));

    // A cleared view starts at an absolute key, so a trimmed buffer keeps its boundary.
    expect(visibleEntries(entries, { viewStart: 10 })).toHaveLength(all - 10);
    expect(visibleEntries(entries, { viewStart: 510, base: 500 })).toHaveLength(all - 10);
    expect(visibleEntries(entries, { viewStart: 10_000 })).toHaveLength(0);
    expect(scopeStart(entries, {})).toBe(0);

    const both = visibleEntries(entries, { viewStart: 12, levels: ["info"], filter: "process" });
    expect(both.map((e) => e.msg)).toEqual(["process exiting"]);
  });

  test("a hide rule drops the lines it catches and the chip off shows them again", async () => {
    const entries = await fixtureEntries("nextjs.log");
    const all = entries.length;
    const kept = visibleEntries(entries, { hide: ["/api"] });
    expect(kept).toHaveLength(all - 3);
    expect(kept.some((e) => e.text.includes("/api"))).toBe(false);
    // Same syntax as the search field, so a regex rule works too.
    expect(visibleEntries(entries, { hide: ["/ 50\\d/"] })).toHaveLength(all - 1);
    expect(visibleEntries(entries, { hide: ["/api", "Ready"] })).toHaveLength(all - 4);
    // Toggled off, nothing is dropped; the page dims them instead.
    expect(visibleEntries(entries, { hide: ["/api"], hideOn: false })).toHaveLength(all);
    expect(isHidden(entries[5], ["/api"])).toBe(true);
    expect(isHidden(entries[5], ["nothing"])).toBe(false);
    expect(isHidden(entries[5], [])).toBe(false);
    expect(isHidden(entries[5], ["  "])).toBe(false);
  });

  test("a hide rule on a static path is a term, not a broken regex", async () => {
    const entries = [
      parseLine(" GET /_next/static/chunks/main.js 200 in 3ms", 0),
      parseLine(" GET /api/orders 200 in 9ms", 1),
    ];
    expect(visibleEntries(entries, { hide: ["/_next/static"] }).map((e) => e.i)).toEqual([1]);
  });

  test("the level set the dropdown shows is named by what is in it", () => {
    expect(levelsLabel(new Set(LEVELS))).toBe("All levels");
    expect(levelsLabel(["error"])).toBe("Errors");
    expect(levelsLabel(["error", "warn"])).toBe("Errors · Warnings");
    expect(levelsLabel(["info", "debug"])).toBe("Custom");
    expect(levelsLabel([])).toBe("Custom");
  });
});

describe("levelCounts", () => {
  test("counts every level and reports zero for the missing ones", async () => {
    const counts = levelCounts(await fixtureEntries("nextjs.log"));
    expect(counts.error).toBe(1);
    expect(counts.warn).toBe(1);
    expect(counts.debug).toBe(0);
    expect(levelCounts([])).toEqual({ error: 0, warn: 0, info: 0, debug: 0, other: 0 });
  });
});

describe("errorIndexes", () => {
  test("returns absolute line keys so a trimmed buffer keeps its cursor", async () => {
    const entries = await fixtureEntries("node-crash.log");
    const plain = errorIndexes(entries);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((i) => entries[i].level === "error")).toBe(true);
    expect(errorIndexes(entries, 1000)).toEqual(plain.map((i) => i + 1000));
    expect(errorIndexes([])).toEqual([]);
  });
});

describe("foldEntries and collapseRepeats", () => {
  test("a node crash folds into one group with its nine frames", async () => {
    const entries = await fixtureEntries("node-crash.log");
    const groups = foldEntries(entries);
    expect(groups).toHaveLength(2);
    expect(groups[0].head.text).toBe("⨯ Failed to start server");
    expect(groups[0].tail).toHaveLength(0);
    expect(groups[1].head.text).toStartWith("Error: listen EADDRINUSE");
    expect(groups[1].tail).toHaveLength(9);
    expect(groups[1].start).toBe(1);
    expect(groups[1].end).toBe(10);
  });

  test("a python traceback folds under the error line that printed it", async () => {
    const entries = await fixtureEntries("python-traceback.log");
    const groups = foldEntries(entries);
    expect(groups[0].head.level).toBe("error");
    expect(groups[0].tail.length).toBeGreaterThan(4);
    expect(groups.at(-1).head.text).toBe("asyncio.exceptions.CancelledError");
  });

  test("a lone continuation with nothing above it is its own group", () => {
    const groups = foldEntries([parseLine("    at Module._compile (node:internal/modules:1)", 0)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].head.cont).toBe(true);
    expect(groups[0].tail).toHaveLength(0);
    expect(foldEntries(undefined)).toEqual([]);
  });

  test("nine plugin registered lines collapse into one with a count", async () => {
    const entries = await fixtureEntries("livekit.log");
    const groups = collapseRepeats(foldEntries(entries));
    const repeated = groups.find((g) => g.repeat > 1);
    expect(repeated.repeat).toBe(9);
    expect(repeated.head.msg).toBe("plugin registered");
    // The last one is the one that stays, so its time is the time on screen.
    expect(repeated.head.ctx).toContain("assemblyai");
    expect(groups.filter((g) => g.head.msg === "plugin registered")).toHaveLength(1);
  });

  test("a group survives when the filter hits a line folded under it", async () => {
    const entries = await fixtureEntries("node-crash.log");
    const groups = visibleGroups(entries, { filter: "syscall" });
    expect(groups).toHaveLength(1);
    expect(groups[0].head.text).toStartWith("Error: listen EADDRINUSE");
    expect(groups[0].tail).toHaveLength(9);
  });

  test("errorIndexes counts heads, not the frames under them", async () => {
    const entries = await fixtureEntries("node-crash.log");
    expect(errorIndexes(entries)).toEqual([0, 1]);
    const py = await fixtureEntries("python-traceback.log");
    // One stop for the whole traceback, and it is the line that printed it.
    expect(errorIndexes(py, 100)).toEqual([100]);
  });
});

describe("findLinks", () => {
  test("finds the URL and the file reference in a Next stack line", () => {
    const text = "ready on http://localhost:3010, error at src/app/page.tsx:12:5 while building";
    const spans = findLinks(text);
    expect(spans.map((s) => s.kind)).toEqual(["link", "path"]);
    expect(spans[0].value).toBe("http://localhost:3010");
    expect(spans[1].value).toBe("src/app/page.tsx");
    expect(spans[1].line).toBe(12);
    expect(spans[1].col).toBe(5);
    expect(text.slice(spans[1].start, spans[1].end)).toBe("src/app/page.tsx:12:5");
  });

  test("skips runtime internals and anything vendored", () => {
    expect(findLinks("    at Module._compile (node:internal/modules/cjs/loader:1234)")).toEqual([]);
    expect(findLinks("    at run (webpack-internal:///./src/app.tsx:3:1)")).toEqual([]);
    expect(findLinks("    at x (/app/node_modules/next/dist/server.js:9:2)")).toEqual([]);
    expect(findLinks("nothing here at all")).toEqual([]);
  });

  test("a line number is optional and trailing punctuation is not part of a URL", () => {
    const spans = findLinks("see http://127.0.0.1:3010/health. config is ./devboard.json");
    expect(spans[0].value).toBe("http://127.0.0.1:3010/health");
    expect(spans[1].value).toBe("./devboard.json");
    expect(spans[1].line).toBeUndefined();
  });
});

describe("runBoundaries, markerLabel, relativeAge", () => {
  test("finds every start marker in the buffer, in order, as absolute keys", async () => {
    const one = await fixtureEntries("livekit.log");
    const three = [...one, ...one, ...one].map((e, i) => ({ ...e, i }));
    expect(runBoundaries(three)).toEqual([0, one.length, one.length * 2]);
    expect(runBoundaries(three, 40)).toEqual([40, 40 + one.length, 40 + one.length * 2]);
    expect(runBoundaries([])).toEqual([]);
  });

  test("a divider reads its run, its own time, and the command that started it", () => {
    const start = parseLine("===== 2026-09-12T04:37:27.000Z start in /tmp/web: pnpm dev =====", 0);
    const at = Date.parse("2026-09-12T04:37:27.000Z");
    expect(markerLabel(start, 3, at + 2 * 60_000)).toBe(`run 3 · ${formatLogTime(start.marker!.at)} · pnpm dev · 2m ago`);
    // Older than a day: the time stays, the relative label goes.
    expect(markerLabel(start, 1, at + 3 * 24 * 3600_000)).toBe(`run 1 · ${formatLogTime(start.marker!.at)} · pnpm dev`);
    const rotated = parseLine("===== 2026-09-12T04:40:00.000Z rotated, kept last 2048 KB =====", 1);
    expect(markerLabel(rotated, 1, Date.parse("2026-09-12T04:40:00.000Z"))).toBe("rotated · 04:40:00 · 0s ago");
    expect(markerLabel(parseLine("plain line", 2))).toBe("");
  });

  test("relativeAge only labels a time devboard wrote, and only for a day", () => {
    const now = Date.parse("2026-09-12T12:00:00.000Z");
    expect(relativeAge("2026-09-12T11:59:30.000Z", now)).toBe("30s ago");
    expect(relativeAge("2026-09-12T09:30:00.000Z", now)).toBe("2h ago");
    expect(relativeAge("2026-09-10T12:00:00.000Z", now)).toBe("");
    expect(relativeAge("later", now)).toBe("");
    expect(relativeAge(undefined, now)).toBe("");
  });

  test("the unread divider names the first new line's own time, or nothing", () => {
    expect(unreadLabel(parseLine("2026-09-12 04:41:34,700 - INFO api - up", 0))).toBe("new since 04:41:34");
    expect(unreadLabel(parseLine("no time here", 1))).toBe("new");
  });
});

describe("parseFilter, matches, matchIndexes", () => {
  test("the syntax splits into terms, exclusions, phrases, and a regex", () => {
    const f = parseFilter('-static "not found" /^GET/');
    expect(f.not).toEqual(["static"]);
    expect(f.phrases).toEqual(["not found"]);
    expect(f.terms).toEqual([]);
    expect(f.regex.source).toBe("^GET");
    expect(parseFilter("  ").empty).toBe(true);
    expect(parseFilter("one two").terms).toEqual(["one", "two"]);
    // A path is not a regex: `/_next/static` has no valid flags, so it stays a term.
    expect(parseFilter("/_next/static").terms).toEqual(["/_next/static"]);
    expect(parseFilter("/_next/static").regex).toBeUndefined();
  });

  test("negation, phrase, and regex hold together on one line", () => {
    const hit = parseLine("GET /api/x 500 not found in 3ms", 0);
    const miss = parseLine("GET /static/app.js 200 not found in 3ms", 1);
    const f = parseFilter('-static "not found" /^GET/');
    expect(matches(hit, f)).toBe(true);
    expect(matches(miss, f)).toBe(false);
    expect(matches(parseLine("POST /api/x 500 not found", 2), f)).toBe(false);
    expect(matches(hit, parseFilter(""))).toBe(true);
  });

  test("an unparseable regex matches nothing and says so", () => {
    const f = parseFilter("/(/");
    expect(f.invalid).toBe(true);
    expect(matches(parseLine("anything at all", 0), f)).toBe(false);
    expect(matchSpans("anything at all", f)).toEqual([]);
  });

  test("matchIndexes returns absolute keys in order, folded frames included", async () => {
    const entries = await fixtureEntries("node-crash.log");
    // Line 1 is the head; lines 2 and 5 are frames folded under it.
    const keys = matchIndexes(entries, { filter: "EADDRINUSE" });
    expect(keys).toEqual([1, 2, 5]);
    expect(matchIndexes(entries, { filter: "EADDRINUSE", base: 900 })).toEqual([901, 902, 905]);
    // `⊘` mode keeps every line on screen, and the hits are the same lines.
    expect(matchIndexes(entries, { filter: "EADDRINUSE", filterHides: false })).toEqual([1, 2, 5]);
    expect(matchIndexes(entries, { filter: "" })).toEqual([]);
  });

  test("matchSpans marks every hit once, in text order", () => {
    const spans = matchSpans("GET /api/x 500 GET again", parseFilter("get /api/x"));
    expect(spans.map((s) => [s.start, s.end])).toEqual([[0, 3], [4, 10], [15, 18]]);
    expect(matchSpans("GET /a 200", parseFilter("/\\d{3}/")).map((s) => [s.start, s.end])).toEqual([[7, 10]]);
  });
});

describe("levelBadge and contentParts", () => {
  test("the badge is three characters, and nothing for a level with no name", () => {
    expect(levelBadge("error")).toBe("ERR");
    expect(levelBadge("warn")).toBe("WRN");
    expect(levelBadge("info")).toBe("INF");
    expect(levelBadge("debug")).toBe("DBG");
    expect(levelBadge("other")).toBe("");
  });

  test("a structured line splits into logger, message, and folded context", async () => {
    const entries = await fixtureEntries("livekit.log");
    const parts = contentParts(entries.at(-1));
    expect(parts.logger).toBe("livekit.agents");
    expect(parts.text).toBe("process exiting");
    expect(parts.ctx).toStartWith('{"reason"');
  });

  test("a plain line keeps its body and a marker keeps its own text", async () => {
    const entries = await fixtureEntries("nextjs.log");
    expect(contentParts(entries[5]).text).toBe(" GET /api/x 500 in 34ms");
    expect(contentParts(entries[0]).logger).toBeUndefined();
    expect(contentParts(undefined).text).toBe("");
  });
});

describe("prettyCtx and ctxTokens", () => {
  test("prints nested objects at two spaces and hands back anything that is not JSON", () => {
    expect(prettyCtx('{"a":{"b":[1,2]}}')).toBe('{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}');
    expect(prettyCtx("{not json")).toBe("{not json");
    expect(prettyCtx('"a string"')).toBe('"a string"');
    expect(prettyCtx(undefined)).toBe("");
  });

  test("tokens carry the key, string, and number runs and nothing else", () => {
    const pretty = prettyCtx('{"pid":72519,"reason":"job completed"}');
    const tokens = ctxTokens(pretty);
    expect(tokens.filter((t) => t.kind === "key").map((t) => t.text)).toEqual(['"pid"', '"reason"']);
    expect(tokens.filter((t) => t.kind === "num").map((t) => t.text)).toEqual(["72519"]);
    expect(tokens.filter((t) => t.kind === "str").map((t) => t.text)).toEqual(['"job completed"']);
    expect(tokens.map((t) => t.text).join("")).toBe(pretty);
  });
});

describe("httpSpans, idSpans, mergeSpans", () => {
  test("a request line marks its method, path, status, and duration", async () => {
    const entries = await fixtureEntries("nextjs.log");
    const e = entries[5];
    const text = contentParts(e).text;
    const spans = httpSpans(text, e.http);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["GET", "/api/x", "500", "34"]);
    expect(spans[2].cls).toBe("s5");
    expect(spans[3].cls).toBe("hd");
    expect(statusClass(201)).toBe("s2");
    expect(statusClass(302)).toBe("s3");
    expect(statusClass(404)).toBe("s4");
  });

  test("a slow request marks its duration as a warning", async () => {
    const entries = await fixtureEntries("nextjs.log");
    const e = entries.at(-1);
    const spans = httpSpans(contentParts(e).text, e.http);
    expect(spans.at(-1).cls).toBe("hs");
    expect(httpSpans("no request here", undefined)).toEqual([]);
  });

  test("an id wins the overlap and the spans come back in text order", () => {
    const text = "GET /req-9f2c 200 in 5ms";
    const spans = mergeSpans([
      ...idSpans(text, ["req-9f2c"]),
      ...httpSpans(text, { method: "GET", path: "/req-9f2c", status: 200, ms: 5 }),
    ]);
    expect(spans.map((s) => s.kind)).toEqual(["http", "id", "http", "http"]);
    expect(spans.map((s) => s.start)).toEqual([...spans.map((s) => s.start)].sort((a, b) => a - b));
    expect(mergeSpans([]).length).toBe(0);
  });
});
