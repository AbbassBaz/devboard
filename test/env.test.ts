import { describe, expect, test } from "bun:test";
import { formatEnv, parseEnvText, parsePsEww } from "../lib/env";

describe("parseEnvText", () => {
  test("reads KEY=value, skips comments, and strips quotes", () => {
    expect(parseEnvText("# hi\nDATABASE_URL=postgres://x\nNAME=\"core api\"\nBAD\n")).toEqual({
      DATABASE_URL: "postgres://x",
      NAME: "core api",
    });
  });
});

describe("formatEnv", () => {
  test("sorts keys", () => {
    expect(formatEnv({ B: "2", A: "1" })).toBe("A=1\nB=2");
  });
});

describe("parsePsEww", () => {
  test("pulls KEY=value tokens after the header", () => {
    const text = "PID   COMMAND\n123 /bin/sh -c bun PATH=/usr/bin HOME=/Users/a";
    expect(parsePsEww(text)).toMatchObject({ PATH: "/usr/bin", HOME: "/Users/a" });
  });
});
