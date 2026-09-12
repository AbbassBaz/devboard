import { describe, expect, test } from "bun:test";
import { parsePinTemplate, planImport, resolveTemplateCwd } from "../lib/template";
import type { Pinned } from "../lib/types";

const pin = (partial: Partial<Pinned> & Pick<Pinned, "id" | "cwd" | "port">): Pinned => ({
  name: "web", command: "bun run dev", ...partial,
});

describe("parsePinTemplate", () => {
  test("reads an array of pins and skips bad rows", () => {
    const entries = parsePinTemplate(JSON.stringify([
      { name: "web", command: "bun run dev", port: 3000, healthUrl: "http://127.0.0.1:3000/health", restartOnCrash: true },
      { name: "api", command: "bun run --watch src/index.ts", port: 3001, cwd: "apps/api", env: { DEBUG: "1" } },
      { name: "nope" },
      { name: "bad-port", command: "true", port: 0 },
      "ignore",
    ]));
    expect(entries).toEqual([
      { name: "web", command: "bun run dev", port: 3000, healthUrl: "http://127.0.0.1:3000/health", restartOnCrash: true },
      { name: "api", command: "bun run --watch src/index.ts", port: 3001, cwd: "apps/api", env: { DEBUG: "1" } },
    ]);
  });

  test("reads { pins: [...] } and returns [] for invalid JSON", () => {
    expect(parsePinTemplate('{ "pins": [{ "name": "web", "command": "vite", "port": 5173 }] }')).toEqual([
      { name: "web", command: "vite", port: 5173 },
    ]);
    expect(parsePinTemplate("not json")).toEqual([]);
    expect(parsePinTemplate("{ \"nope\": true }")).toEqual([]);
  });
});

describe("resolveTemplateCwd", () => {
  test("joins a relative subpath and rejects escapes", () => {
    expect(resolveTemplateCwd("/repo", undefined)).toBe("/repo");
    expect(resolveTemplateCwd("/repo", "apps/api")).toBe("/repo/apps/api");
    expect(resolveTemplateCwd("/repo", "../outside")).toBeUndefined();
    expect(resolveTemplateCwd("/repo", "/etc")).toBeUndefined();
  });
});

describe("planImport", () => {
  test("skips a cwd plus port that is already pinned", () => {
    const entries = parsePinTemplate(JSON.stringify([
      { name: "web", command: "bun run dev", port: 3000 },
      { name: "api", command: "bun run --watch src/index.ts", port: 3001 },
    ]));
    const existing: Pinned[] = [pin({ id: "web-3000", cwd: "/repo", port: 3000, command: "old" })];
    expect(planImport("/repo", entries, existing)).toEqual([
      { name: "api", cwd: "/repo", command: "bun run --watch src/index.ts", port: 3001 },
    ]);
  });
});
