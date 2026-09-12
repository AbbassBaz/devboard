import { describe, expect, test } from "bun:test";
import {
  cleanLine,
  classifyLine,
  countErrors,
  findIds,
  isContinuation,
  looksLikeJson,
  parseHttp,
  parseJsonLine,
  parseLine,
  parseMarker,
  parseStructured,
  splitLogLine,
} from "../lib/logs";
import type { LogEntry } from "../lib/types";

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

describe("parseMarker", () => {
  test("reads the start header, a rotation, and a clear", () => {
    expect(parseMarker("===== 2026-09-12T04:00:00.000Z start in /tmp/app: pnpm dev =====")).toEqual({
      type: "start",
      at: "2026-09-12T04:00:00.000Z",
      cwd: "/tmp/app",
      command: "pnpm dev",
    });
    expect(parseMarker("===== 2026-09-12T04:40:00.000Z rotated =====")).toEqual({ type: "rotated", at: "2026-09-12T04:40:00.000Z" });
    expect(parseMarker("===== 2026-09-12T04:40:00.000Z rotated, kept last 2048 KB =====")?.type).toBe("rotated");
    expect(parseMarker("===== 2026-09-12T04:41:12.000Z cleared =====")).toEqual({ type: "cleared", at: "2026-09-12T04:41:12.000Z" });
    expect(parseMarker("===== not a marker")).toBeUndefined();
  });
});

describe("parseStructured", () => {
  test("splits LEVEL logger - message {json}", () => {
    expect(parseStructured('- INFO livekit.agents - process exiting {"reason": "job completed", "pid": 72519}')).toEqual({
      level: "info",
      logger: "livekit.agents",
      msg: "process exiting",
      ctx: '{"reason": "job completed", "pid": 72519}',
    });
  });

  test("reads LEVEL [logger] msg and [logger] LEVEL msg", () => {
    expect(parseStructured("WARN [next] compiled with warnings")).toMatchObject({ level: "warn", logger: "next", msg: "compiled with warnings" });
    expect(parseStructured("[worker] DEBUG polling the queue")).toMatchObject({ level: "debug", logger: "worker", msg: "polling the queue" });
  });

  test("leaves a trailing object under 20 characters in the message", () => {
    expect(parseStructured('- INFO api - done {"a":1}')).toEqual({ level: "info", logger: "api", msg: 'done {"a":1}' });
  });

  test("is undefined for a plain line", () => {
    expect(parseStructured("Ready in 164ms")).toBeUndefined();
  });
});

describe("parseJsonLine", () => {
  test("reads a pino error line", () => {
    const out = parseJsonLine('{"level":50,"time":1757556091456,"name":"api","msg":"request failed","status":500}');
    expect(out?.level).toBe("error");
    expect(out?.msg).toBe("request failed");
    expect(out?.logger).toBe("api");
    expect(out?.time).toBe(new Date(1757556091456).toISOString());
    expect(out?.ctx).toBe('{"status":500}');
  });

  test("maps every pino number and a string level", () => {
    const level = (n: number | string) => parseJsonLine(`{"level":${JSON.stringify(n)},"msg":"x"}`)?.level;
    expect([10, 20, 30, 40, 50, 60].map(level)).toEqual(["debug", "debug", "info", "warn", "error", "error"]);
    expect(level("warn")).toBe("warn");
  });

  test("is undefined for text and for an array", () => {
    expect(parseJsonLine("Ready in 164ms")).toBeUndefined();
    expect(parseJsonLine("[1,2,3]")).toBeUndefined();
  });
});

describe("parseHttp", () => {
  test("reads Next, Hono, and morgan request lines", () => {
    expect(parseHttp(" GET /api/x 500 in 34ms")).toEqual({ method: "GET", path: "/api/x", status: 500, ms: 34 });
    expect(parseHttp("--> GET / 200 12ms")).toEqual({ method: "GET", path: "/", status: 200, ms: 12 });
    expect(parseHttp("GET /api 200 12.3 ms - 123")).toEqual({ method: "GET", path: "/api", status: 200, ms: 12.3 });
    expect(parseHttp("POST /api/orders 201 in 1234ms")).toEqual({ method: "POST", path: "/api/orders", status: 201, ms: 1234 });
  });

  test("is undefined without a status", () => {
    expect(parseHttp("GET /api/x pending")).toBeUndefined();
    expect(parseHttp("Ready in 164ms")).toBeUndefined();
  });
});

describe("isContinuation", () => {
  test("catches stack frames, dumps, tracebacks, and closing braces", () => {
    expect(isContinuation("    at Module._compile (node:internal)")).toBe(true);
    expect(isContinuation("  code: 'EADDRINUSE',")).toBe(true);
    expect(isContinuation("}")).toBe(true);
    expect(isContinuation("Traceback (most recent call last):")).toBe(true);
    expect(isContinuation('  File "/tmp/a.py", line 1, in x')).toBe(true);
    expect(isContinuation("           ^^^^^^^^^")).toBe(true);
    expect(isContinuation("Error: listen EADDRINUSE: address already in use :::3010")).toBe(false);
    expect(isContinuation(" GET / 200 in 366ms")).toBe(false);
  });
});

describe("classifyLine reads a tagged level, then the HTTP status", () => {
  test("maps 5xx to error and 4xx to warn", () => {
    expect(classifyLine(" GET /api/x 500 in 34ms")).toBe("error");
    expect(classifyLine(" GET /api/missing 404 in 8ms")).toBe("warn");
    expect(classifyLine(" GET / 200 in 366ms")).toBe("info");
  });

  test("a devboard marker is never an error", () => {
    expect(classifyLine("===== 2026-09-12T04:00:00.000Z start in /tmp/app: pnpm dev =====")).toBe("other");
  });
});

describe("parseLine on fixtures", () => {
  const parseFixture = async (name: string): Promise<LogEntry[]> =>
    (await fixtureLines(name)).map((l, i) => parseLine(l, i));

  test("livekit: time, level, logger, msg, and folded ctx", async () => {
    const entries = await parseFixture("livekit.log");
    const exiting = entries.find((e) => e.msg === "process exiting")!;
    expect(exiting.time).toBe("2026-09-12 04:41:34,700");
    expect(exiting.level).toBe("info");
    expect(exiting.logger).toBe("livekit.agents");
    expect(exiting.ctx?.startsWith('{"reason"')).toBe(true);
    expect(exiting.text.includes("\x1b")).toBe(false);
    expect(entries.filter((e) => e.level === "warn")).toHaveLength(1);
    expect(entries.filter((e) => e.msg === "plugin registered")).toHaveLength(9);
  });

  test("livekit: the start marker carries its cwd and command", async () => {
    const [first] = await parseFixture("livekit.log");
    expect(first.marker).toEqual({ type: "start", at: "2026-09-12T04:37:54.477Z", cwd: "/tmp/agent", command: "python3 main.py dev" });
    expect(first.level).toBe("other");
  });

  test("pino: level 50 becomes error, with msg and time", async () => {
    const entries = await parseFixture("pino.log");
    expect(entries[1]).toMatchObject({
      level: "error",
      msg: "request failed",
      logger: "api",
      time: new Date(1757556091456).toISOString(),
    });
    expect(entries[1].ids).toContain("req-9f2c");
    expect(entries[0].level).toBe("info");
    expect(entries[2].level).toBe("warn");
  });

  test("nextjs: a 500 request line is an error with its status and duration", async () => {
    const entries = await parseFixture("nextjs.log");
    const five = entries.find((e) => e.http?.status === 500)!;
    expect(five.http).toEqual({ method: "GET", path: "/api/x", status: 500, ms: 34 });
    expect(five.level).toBe("error");
    expect(entries.find((e) => e.http?.status === 404)!.level).toBe("warn");
    expect(entries.find((e) => e.text.includes("Ready in"))!.text).toBe("✓ Ready in 164ms");
  });

  test("node-crash: the head is an error with a nine-line continuation tail", async () => {
    const entries = await parseFixture("node-crash.log");
    const head = entries.findIndex((e) => e.text.startsWith("Error: listen EADDRINUSE"));
    expect(entries[head].cont).toBeUndefined();
    expect(entries[head].level).toBe("error");
    expect(entries.slice(head + 1)).toHaveLength(9);
    expect(entries.slice(head + 1).every((e) => e.cont === true)).toBe(true);
    expect(parseLine("    at Module._compile (node:internal)", 0).cont).toBe(true);
  });

  test("python-traceback: the head is an error and the frames are continuations", async () => {
    const entries = await parseFixture("python-traceback.log");
    // `{"pid": 72519}` is under the 20-character fold threshold, so it stays in the message.
    expect(entries[0]).toMatchObject({ level: "error", logger: "livekit.agents", msg: 'error initializing process {"pid": 72519}' });
    expect(entries[0].ctx).toBeUndefined();
    expect(entries.slice(1, -1).every((e) => e.cont === true)).toBe(true);
  });

  test("pnpm: the progress bar is one line and every entry is printable", async () => {
    const entries = await parseFixture("pnpm.log");
    expect(entries.some((e) => e.text.startsWith("100%|"))).toBe(true);
    expect(entries.every((e) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(e.text))).toBe(true);
    expect(parseLine("===== 2026-09-12T04:40:00.000Z rotated =====", 0).marker?.type).toBe("rotated");
  });
});
