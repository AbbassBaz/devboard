import { describe, expect, test } from "bun:test";
import { cleanLine, classifyLine, countErrors, findIds, looksLikeJson, splitLogLine } from "../lib/logs";

const FIXTURE = `${import.meta.dir}/fixtures/logs/control-codes.log`;

async function fixtureLines(name: string): Promise<string[]> {
  const text = await Bun.file(`${import.meta.dir}/fixtures/logs/${name}`).text();
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

describe("cleanLine", () => {
  test("drops SGR, cursor, erase, and private-mode sequences", () => {
    expect(cleanLine("\x1b[31merror\x1b[0m")).toBe("error");
    expect(cleanLine("\x1b[?25l\x1b[32m✓\x1b[0m Ready\x1b[?25h")).toBe("✓ Ready");
    expect(cleanLine("\x1b[2K\x1b[1Gcompiling")).toBe("compiling");
  });

  test("drops OSC window titles and hyperlinks, BEL- or ST-terminated", () => {
    expect(cleanLine("\x1b]0;pnpm dev\x07ready")).toBe("ready");
    expect(cleanLine("\x1b]8;;http://localhost:3010\x1b\\open\x1b]8;;\x1b\\")).toBe("open");
  });

  test("keeps only the last frame of a carriage-return progress bar", () => {
    expect(cleanLine("\r 10%|# | 1/10\r100%|##| 10/10")).toBe("100%|##| 10/10");
    expect(cleanLine("done\r")).toBe("done");
  });

  test("leaves no byte below 0x20 except tab anywhere in the fixture", async () => {
    for (const raw of await fixtureLines("control-codes.log")) {
      const text = cleanLine(raw);
      expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
      expect(text.includes("[?25h")).toBe(false);
    }
  });

  test("the fixture progress-bar line equals its last frame", async () => {
    const lines = await fixtureLines("control-codes.log");
    const bar = lines.find((l) => l.includes("125M"))!;
    expect(cleanLine(bar)).toBe("100%|██████████| 125M/125M [00:08<00:00, 15.2MB/s]");
  });

  test("the fixture holds real control bytes, so the test is not vacuous", async () => {
    expect((await Bun.file(FIXTURE).text()).includes("\x1b[?25h")).toBe(true);
  });
});

describe("splitLogLine", () => {
  test("lifts an ISO timestamp", () => {
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
