import { describe, expect, test } from "bun:test";
import { classifyLine, looksLikeJson, splitLogLine, stripAnsi } from "../lib/logs";

describe("stripAnsi and splitLogLine", () => {
  test("drops SGR sequences and lifts an ISO timestamp", () => {
    expect(stripAnsi("\x1b[31merror\x1b[0m")).toBe("error");
    expect(splitLogLine("2026-09-11T01:21:30.154Z ready on :3010")).toEqual({
      time: "2026-09-11T01:21:30.154Z",
      body: "ready on :3010",
    });
  });
});

describe("classifyLine", () => {
  test("reads a leading level tag first", () => {
    expect(classifyLine("[error] something warning")).toBe("error");
    expect(classifyLine("WARN: slow query")).toBe("warn");
    expect(classifyLine("info: listening")).toBe("info");
  });

  test("catches crashes, warnings, and ready lines", () => {
    expect(classifyLine("Error: EADDRINUSE :3010")).toBe("error");
    expect(classifyLine("    at Module._compile (node:internal)")).toBe("error");
    expect(classifyLine("WARN The field pnpm.overrides was found")).toBe("warn");
    expect(classifyLine("✓ Ready in 307ms")).toBe("info");
    expect(classifyLine("debug fetching user")).toBe("debug");
    expect(classifyLine("===== 2026-09-11 start =====")).toBe("other");
  });
});

describe("looksLikeJson", () => {
  test("accepts a whole-line object", () => {
    expect(looksLikeJson('{"level":"error","msg":"boom"}')).toBe(true);
    expect(looksLikeJson("not json")).toBe(false);
  });
});
