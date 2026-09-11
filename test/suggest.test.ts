import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseComposeServices, parsePackageScripts, parseProcfile, portFromCommand, suggestCommands } from "../lib/suggest";

describe("portFromCommand", () => {
  test("reads --port, PORT=, and :port", () => {
    expect(portFromCommand("next dev --port 3010")).toBe(3010);
    expect(portFromCommand("PORT=8787 bun run src/index.ts")).toBe(8787);
  });
});

describe("parsers", () => {
  test("package scripts prefer dev/start/storybook", () => {
    const list = parsePackageScripts(JSON.stringify({
      scripts: { lint: "eslint", dev: "next dev --port 3000", start: "node server", storybook: "storybook dev" },
    }), "pnpm");
    expect(list.map((s) => s.label)).toEqual(["dev", "start", "storybook"]);
    expect(list[0]).toMatchObject({ command: "pnpm dev", port: 3000, source: "npm" });
  });

  test("compose services become docker compose up", () => {
    expect(parseComposeServices("services:\n  api:\n    image: x\n  web:\n    image: y\nvolumes:\n  data:\n").map((s) => s.command)).toEqual([
      "docker compose up api",
      "docker compose up web",
    ]);
  });

  test("Procfile keeps the command", () => {
    expect(parseProcfile("web: bun run --watch src/index.ts --port 3003\n# x\n")).toEqual([
      { label: "web", command: "bun run --watch src/index.ts --port 3003", port: 3003, source: "procfile" },
    ]);
  });
});

describe("suggestCommands", () => {
  test("reads a real folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devboard-sug-"));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite --port 5173" } }));
    mkdirSync(dir, { recursive: true });
    const list = await suggestCommands(dir);
    expect(list[0]).toMatchObject({ command: "pnpm dev", port: 5173 });
  });
});
