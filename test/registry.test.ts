import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry, pinnedId, slugify, uniquePinnedId } from "../lib/registry";
import type { RunningService } from "../lib/types";

const running: RunningService = {
  rootPid: 41727, pids: [41727], ports: [3000],
  cwd: "/Users/dev/Projects/app/apps/proxy",
  command: "bun run --preload ./src/instrumentation.ts --watch src/index.ts",
  name: "@acme/proxy", kind: "dev", uptime: "01:00", cpu: 0, memMb: 54,
};

let registry: Registry;
beforeEach(() => {
  registry = new Registry(mkdtempSync(join(tmpdir(), "devboard-")));
});

describe("ids", () => {
  test("slugify lowercases and collapses non-alphanumerics", () => {
    expect(slugify("@acme/proxy")).toBe("acme-proxy");
    expect(slugify("  Docs Site ")).toBe("docs-site");
    expect(slugify("///")).toBe("service");
  });
  test("pinnedId appends the port", () => {
    expect(pinnedId("@acme/proxy", 3000)).toBe("acme-proxy-3000");
  });
  test("uniquePinnedId suffixes on collision", () => {
    expect(uniquePinnedId("web-3000", [])).toBe("web-3000");
    expect(uniquePinnedId("web-3000", ["web-3000"])).toBe("web-3000-2");
    expect(uniquePinnedId("web-3000", ["web-3000", "web-3000-2"])).toBe("web-3000-3");
  });
});

describe("Registry", () => {
  test("load returns [] when the file does not exist", async () => {
    expect(await registry.load()).toEqual([]);
  });

  test("pin saves name, cwd, command and first port; pinning the same row twice leaves one entry", async () => {
    const pinned = await registry.pin(running);
    expect(pinned).toEqual({
      id: "acme-proxy-3000", name: "@acme/proxy",
      cwd: running.cwd, command: running.command, port: 3000,
    });
    const renamed = await registry.pin(running, "Core Proxy");
    expect(renamed).toEqual({
      id: "acme-proxy-3000", name: "Core Proxy",
      cwd: running.cwd, command: running.command, port: 3000,
    });
    expect(await registry.load()).toHaveLength(1);
  });

  test("add stores a hand-entered service and replaces one with the same cwd and port", async () => {
    const added = await registry.add({ name: "Docs", cwd: "/tmp", command: "pnpm dev", port: 3010 });
    expect(added).toEqual({ id: "docs-3010", name: "Docs", cwd: "/tmp", command: "pnpm dev", port: 3010 });
    await registry.add({ name: "Docs", cwd: "/tmp", command: "pnpm dev --turbo", port: 3010 });
    const list = await registry.load();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "docs-3010", command: "pnpm dev --turbo" });
  });

  test("two web:3000 pins in different folders keep both ids", async () => {
    const a = await registry.add({ name: "web", cwd: "/repo/a", command: "npm run dev", port: 3000 });
    const b = await registry.add({ name: "web", cwd: "/repo/b", command: "npm run dev", port: 3000 });
    expect(a.id).toBe("web-3000");
    expect(b.id).toBe("web-3000-2");
    expect((await registry.load()).map((p) => p.id).sort()).toEqual(["web-3000", "web-3000-2"]);
  });

  test("replace edits in place, keeps the id, and reports unknown ids", async () => {
    await registry.add({ name: "Docs", cwd: "/tmp", command: "pnpm dev", port: 3010 });
    const edited = await registry.replace("docs-3010", { name: "Docs Site", cwd: "/tmp", command: "pnpm dev --turbo", port: 3011 });
    expect(edited).toEqual({ id: "docs-3010", name: "Docs Site", cwd: "/tmp", command: "pnpm dev --turbo", port: 3011 });
    expect((await registry.load()).map((p) => p.id)).toEqual(["docs-3010"]);
    expect(await registry.replace("missing", { name: "x", cwd: "/tmp", command: "true", port: 1 })).toBeUndefined();
  });

  test("an existing services.json loads unchanged", async () => {
    const raw = '[\n  {\n    "id": "custom-id",\n    "name": "web",\n    "cwd": "/old",\n    "command": "true",\n    "port": 3000\n  }\n]\n';
    writeFileSync(registry.path, raw);
    expect(await registry.load()).toEqual([{ id: "custom-id", name: "web", cwd: "/old", command: "true", port: 3000 }]);
    expect(await Bun.file(registry.path).text()).toBe(raw);
  });

  test("pin rejects a service with no cwd", async () => {
    await expect(registry.pin({ ...running, cwd: undefined })).rejects.toThrow("working directory");
  });

  test("unpin removes and reports whether anything was removed", async () => {
    await registry.pin(running);
    expect(await registry.unpin("acme-proxy-3000")).toBe(true);
    expect(await registry.unpin("acme-proxy-3000")).toBe(false);
    expect(await registry.load()).toEqual([]);
  });

  test("ignored ids round-trip and can be removed again", async () => {
    expect(await registry.loadIgnored()).toEqual(new Set());
    await registry.setIgnored("helper-17039", true);
    await registry.setIgnored("hidden-37777", true);
    expect([...(await registry.loadIgnored())]).toEqual(["helper-17039", "hidden-37777"]);
    await registry.setIgnored("helper-17039", false);
    expect([...(await registry.loadIgnored())]).toEqual(["hidden-37777"]);
  });

  test("save writes pretty JSON with a trailing newline", async () => {
    await registry.save([{ id: "a-1", name: "a", cwd: "/tmp", command: "true", port: 1 }]);
    const text = await Bun.file(registry.path).text();
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toHaveLength(1);
  });

  test("a fresh home is 0700 and registry files are 0600", async () => {
    await registry.save([{ id: "a-1", name: "a", cwd: "/tmp", command: "true", port: 1 }]);
    expect(statSync(registry.path.replace(/\/services\.json$/, "")).mode & 0o777).toBe(0o700);
    expect(statSync(registry.path).mode & 0o777).toBe(0o600);
  });

  test("projects persist, a member lives in one project, and unpin drops it", async () => {
    await registry.add({ name: "api", cwd: "/tmp/a", command: "true", port: 1 });
    await registry.add({ name: "web", cwd: "/tmp/b", command: "true", port: 2 });
    const hub = await registry.addProject({ name: "Hub", folder: "/tmp", memberIds: ["api-1"] });
    expect(hub.id).toBe("hub");
    await registry.addProject({ name: "Other", memberIds: ["web-2"] });
    await registry.addProjectMember("hub", "web-2");
    expect((await registry.loadProjects()).find((p) => p.id === "other")!.memberIds).toEqual([]);
    expect((await registry.loadProjects()).find((p) => p.id === "hub")!.memberIds.sort()).toEqual(["api-1", "web-2"]);
    await registry.unpin("web-2");
    expect((await registry.loadProjects()).find((p) => p.id === "hub")!.memberIds).toEqual(["api-1"]);
  });

  test("renaming a pinned service keeps its id, project, hide state, and preset", async () => {
    await registry.add({ name: "api", cwd: "/tmp/a", command: "true", port: 1 });
    await registry.addProject({ name: "Hub", memberIds: ["api-1"] });
    await registry.setIgnored("api-1", true);
    await registry.addPreset({ name: "Api", serviceIds: ["api-1"], urls: [] });
    await registry.replace("api-1", { name: "core-api", cwd: "/tmp/a", command: "true", port: 1 });
    expect((await registry.loadProjects())[0].memberIds).toEqual(["api-1"]);
    expect((await registry.load())[0]).toMatchObject({ id: "api-1", name: "core-api" });
    expect([...(await registry.loadIgnored())]).toEqual(["api-1"]);
    expect((await registry.loadPresets())[0].serviceIds).toEqual(["api-1"]);
  });

  test("presets persist and can be replaced by the same name", async () => {
    const preset = await registry.addPreset({
      name: "Frontend only",
      serviceIds: ["web-3000", "web-3000"],
      urls: ["http://127.0.0.1:3000"],
      openEditor: true,
    });
    expect(preset).toMatchObject({ id: "frontend-only", serviceIds: ["web-3000"], openEditor: true });
    await registry.addPreset({ name: "Frontend only", serviceIds: ["web-3001"], urls: [] });
    expect((await registry.loadPresets()).map((p) => p.serviceIds)).toEqual([["web-3001"]]);
    expect(await registry.deletePreset("frontend-only")).toBe(true);
    expect(await registry.deletePreset("frontend-only")).toBe(false);
  });

  test("a non-array services.json loads as [] and is left untouched", async () => {
    writeFileSync(registry.path, '{ "nope": true }\n');
    expect(await registry.load()).toEqual([]);
    expect(await Bun.file(registry.path).text()).toBe('{ "nope": true }\n');
  });

  test("twenty concurrent adds keep every entry and leave no tmp files", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      registry.add({ name: `n${i}`, cwd: "/tmp", command: "true", port: 5000 + i }),
    ));
    expect((await registry.load()).map((p) => p.id).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `n${i}-${5000 + i}`).sort(),
    );
    expect(readdirSync(registry.path.replace(/\/services\.json$/, "")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
