import { describe, expect, test } from "bun:test";
import { classifyLine, countErrors, findIds, looksLikeJson, splitLogLine, stripAnsi } from "../lib/logs";

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

  test("countErrors uses classifyLine", () => {
    expect(countErrors(["ok", "Error: boom", "ready", "Error: EADDRINUSE"])).toBe(2);
  });
});

describe("looksLikeJson", () => {
  test("accepts a whole-line object", () => {
    expect(looksLikeJson('{"level":"error","msg":"boom"}')).toBe(true);
    expect(looksLikeJson("not json")).toBe(false);
  });
});

describe("findIds", () => {
  test("reads a UUID", () => {
    expect(findIds("handled 550e8400-e29b-41d4-a716-446655440000 ok")).toEqual([
      "550e8400-e29b-41d4-a716-446655440000",
    ]);
  });

  test("reads a 32-hex trace id", () => {
    expect(findIds("trace 0af7651916cd43dd8448eb211c80319c")).toEqual([
      "0af7651916cd43dd8448eb211c80319c",
    ]);
  });

  test("reads a req- token", () => {
    expect(findIds("incoming req-abc123")).toEqual(["req-abc123"]);
  });

  test("reads a traceparent line", () => {
    const line = "traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    expect(findIds(line)).toContain("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(findIds(line)).toContain("0af7651916cd43dd8448eb211c80319c");
  });

  test("returns nothing for a plain access line", () => {
    expect(findIds("GET /api/x 200 in 34ms")).toEqual([]);
  });

  test("reads requestId from a JSON line", () => {
    expect(findIds('{"requestId":"req-from-json","msg":"ok"}')).toContain("req-from-json");
  });
});
