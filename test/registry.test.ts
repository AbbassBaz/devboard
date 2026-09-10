import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry, pinnedId, slugify } from "../lib/registry";
import type { RunningService } from "../lib/types";

const running: RunningService = {
  rootPid: 41727, pids: [41727], ports: [3000],
  cwd: "/Users/abbassbaz/Desktop/Sadie/CoreAgentsHub/apps/core-proxy",
  command: "bun run --preload ./src/instrumentation.ts --watch src/index.ts",
  name: "@sadie/core-proxy", kind: "dev", uptime: "01:00", cpu: 0, memMb: 54,
};

let registry: Registry;
beforeEach(() => {
  registry = new Registry(mkdtempSync(join(tmpdir(), "devboard-")));
});

describe("ids", () => {
  test("slugify lowercases and collapses non-alphanumerics", () => {
    expect(slugify("@sadie/core-proxy")).toBe("sadie-core-proxy");
    expect(slugify("  OnCore Docs ")).toBe("oncore-docs");
    expect(slugify("///")).toBe("service");
  });
  test("pinnedId appends the port", () => {
    expect(pinnedId("@sadie/core-proxy", 3000)).toBe("sadie-core-proxy-3000");
  });
});

describe("Registry", () => {
  test("load returns [] when the file does not exist", async () => {
    expect(await registry.load()).toEqual([]);
  });

  test("pin saves name, cwd, command and first port; pinning again replaces", async () => {
    const pinned = await registry.pin(running);
    expect(pinned).toEqual({
      id: "sadie-core-proxy-3000", name: "@sadie/core-proxy",
      cwd: running.cwd, command: running.command, port: 3000,
    });
    await registry.pin(running, "Core Proxy");
    const list = await registry.load();
    expect(list).toHaveLength(2); // different name => different id
    expect(list.map((p) => p.id).sort()).toEqual(["core-proxy-3000", "sadie-core-proxy-3000"]);
    await registry.pin(running);
    expect(await registry.load()).toHaveLength(2); // same id replaced, not duplicated
  });

  test("add stores a hand-entered service and replaces one with the same id", async () => {
    const added = await registry.add({ name: "Docs", cwd: "/tmp", command: "pnpm dev", port: 3010 });
    expect(added).toEqual({ id: "docs-3010", name: "Docs", cwd: "/tmp", command: "pnpm dev", port: 3010 });
    await registry.add({ name: "Docs", cwd: "/tmp", command: "pnpm dev --turbo", port: 3010 });
    const list = await registry.load();
    expect(list).toHaveLength(1);
    expect(list[0].command).toBe("pnpm dev --turbo");
  });

  test("replace edits in place, renames the id when name or port change, and reports unknown ids", async () => {
    await registry.add({ name: "Docs", cwd: "/tmp", command: "pnpm dev", port: 3010 });
    const edited = await registry.replace("docs-3010", { name: "OnCore Docs", cwd: "/tmp", command: "pnpm dev --turbo", port: 3011 });
    expect(edited).toEqual({ id: "oncore-docs-3011", name: "OnCore Docs", cwd: "/tmp", command: "pnpm dev --turbo", port: 3011 });
    expect((await registry.load()).map((p) => p.id)).toEqual(["oncore-docs-3011"]);
    expect(await registry.replace("docs-3010", { name: "x", cwd: "/tmp", command: "true", port: 1 })).toBeUndefined();
  });

  test("pin rejects a service with no cwd", async () => {
    await expect(registry.pin({ ...running, cwd: undefined })).rejects.toThrow("working directory");
  });

  test("unpin removes and reports whether anything was removed", async () => {
    await registry.pin(running);
    expect(await registry.unpin("sadie-core-proxy-3000")).toBe(true);
    expect(await registry.unpin("sadie-core-proxy-3000")).toBe(false);
    expect(await registry.load()).toEqual([]);
  });

  test("save writes pretty JSON with a trailing newline", async () => {
    await registry.save([{ id: "a-1", name: "a", cwd: "/tmp", command: "true", port: 1 }]);
    const text = await Bun.file(registry.path).text();
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toHaveLength(1);
  });
});
