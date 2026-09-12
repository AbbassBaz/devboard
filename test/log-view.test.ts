import { describe, expect, test } from "bun:test";
import { parseLine } from "../lib/logs";
// The page's pure half. It must import with no DOM, which is the whole point of the file.
import { entryBody, entryTid, errorIndexes, formatLogTime, levelCounts, lineKind, matchesEntry, visibleEntries } from "../public/log-view.js";

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
  test("filters on text and on errors only, and keeps file order", async () => {
    const entries = await fixtureEntries("nextjs.log");
    expect(visibleEntries(entries, {})).toHaveLength(entries.length);
    expect(visibleEntries(entries, { filter: "  " })).toHaveLength(entries.length);
    expect(visibleEntries(entries, { filter: "get /api" }).map((e) => e.http?.status)).toEqual([500, 404]);
    expect(visibleEntries(entries, { errOnly: true }).every((e) => e.level === "error")).toBe(true);
    const both = visibleEntries(entries, { filter: "GET", errOnly: true });
    expect(both).toHaveLength(1);
    expect(both[0].http?.status).toBe(500);
    expect(visibleEntries(undefined, {})).toEqual([]);
  });

  test("matchesEntry is case-insensitive on the whole line", () => {
    const e = parseLine("Error: listen EADDRINUSE", 0);
    expect(matchesEntry(e, { filter: "eaddrinuse" })).toBe(true);
    expect(matchesEntry(e, { filter: "nope" })).toBe(false);
    expect(matchesEntry(e, { errOnly: true })).toBe(true);
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
