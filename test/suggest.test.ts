import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isServerScript, parseComposeServices, parsePackageScripts, parseProcfile, portFromCommand, rewriteCommandPort, rewriteUrlPort, suggestCommands } from "../lib/suggest";

describe("portFromCommand", () => {
  test("reads --port, PORT=, and :port", () => {
    expect(portFromCommand("next dev --port 3010")).toBe(3010);
    expect(portFromCommand("PORT=8787 bun run src/index.ts")).toBe(8787);
  });
});

describe("rewriteCommandPort", () => {
  test("replaces --port, -p, or PORT=, and otherwise prefixes PORT=", () => {
    expect(rewriteCommandPort("next dev --port 3000", 3012)).toBe("next dev --port 3012");
    expect(rewriteCommandPort("next dev -p 3000", 3012)).toBe("next dev -p 3012");
    expect(rewriteCommandPort("PORT=3000 bun run --watch src/index.ts", 3012)).toBe("PORT=3012 bun run --watch src/index.ts");
    expect(rewriteCommandPort("bun run --watch src/index.ts", 3012)).toBe("PORT=3012 bun run --watch src/index.ts");
  });
});

describe("rewriteUrlPort", () => {
  test("rewrites the host port and keeps the path", () => {
    expect(rewriteUrlPort("http://127.0.0.1:3000/health", 3012)).toBe("http://127.0.0.1:3012/health");
  });
});

describe("parsers", () => {
  test("package scripts prefer dev/start/storybook and skip tools that only contain those letters", () => {
    const list = parsePackageScripts(JSON.stringify({
      scripts: {
        lint: "eslint",
        test: "bun test",
        devboard: "bun run bin/devboard.ts",
        docs: "vite --port 5173",
        "dev:api": "bun --watch src/index.ts --port 3003",
        dev: "next dev --port 3000",
        start: "node server",
        storybook: "storybook dev",
      },
    }), "pnpm");
    expect(list.map((s) => s.label)).toEqual(["dev", "start", "storybook", "dev:api", "docs"]);
    expect(list[0]).toMatchObject({ command: "pnpm dev", port: 3000, source: "npm" });
  });

  test("isServerScript is about how it runs, not the script name", () => {
    expect(isServerScript("devboard", "bun run bin/devboard.ts")).toBe(false);
    expect(isServerScript("docs", "vite --port 5173")).toBe(true);
    expect(isServerScript("dev:web", "anything")).toBe(true);
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
