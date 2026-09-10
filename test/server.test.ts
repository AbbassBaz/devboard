import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Control, isAlive } from "../lib/control";
import { scanProcesses } from "../lib/discover";
import { Registry } from "../lib/registry";
import type { Process, RunningService } from "../lib/types";
import { createHandler } from "../server";

const home = mkdtempSync(join(tmpdir(), "devboard-"));
const registry = new Registry(home);
const control = new Control(home);
let running: RunningService[] = [];
const handle = createHandler({ discover: async () => running, registry, control });

const docs: RunningService = {
  rootPid: 64672, pids: [64672, 64728, 64734], ports: [3010],
  cwd: home, command: "node /x/pnpm dev",
  name: "oncore-docs", kind: "dev", uptime: "23-01:48:35", cpu: 0.2, memMb: 149,
};

const spawned: number[] = [];
afterAll(() => {
  for (const pid of spawned) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
});

const call = (method: string, path: string, body?: unknown) =>
  handle(new Request(`http://devboard.test${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));

describe("GET /", () => {
  test("serves the page as HTML", async () => {
    const res = await call("GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("devboard");
  });
});

describe("GET /api/services", () => {
  test("merges running and pinned", async () => {
    running = [docs];
    await registry.pin({ ...docs, ports: [3003], name: "core-api", command: "bun run --watch src/index.ts" });
    const res = await call("GET", "/api/services");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generatedAt).toBeString();
    expect(body.services).toHaveLength(2);
    expect(body.services.find((s: any) => s.rootPid === 64672)).toMatchObject({ status: "running", pinned: false });
    expect(body.services.find((s: any) => s.id === "core-api-3003")).toMatchObject({ status: "stopped", pinned: true });
  });
});

describe("POST /api/pin and DELETE /api/pin/:id", () => {
  test("pins a running service and unpins by id", async () => {
    running = [docs];
    const res = await call("POST", "/api/pin", { rootPid: 64672 });
    expect(res.status).toBe(200);
    expect((await res.json()).pinned.id).toBe("oncore-docs-3010");
    expect((await registry.load()).some((p) => p.id === "oncore-docs-3010")).toBe(true);
    const del = await call("DELETE", "/api/pin/oncore-docs-3010");
    expect(del.status).toBe(200);
    expect((await call("DELETE", "/api/pin/oncore-docs-3010")).status).toBe(404);
  });

  test("404 when the rootPid is not running, 400 when missing", async () => {
    running = [];
    expect((await call("POST", "/api/pin", { rootPid: 1 })).status).toBe(404);
    expect((await call("POST", "/api/pin", {})).status).toBe(400);
  });
});

describe("POST /api/kill", () => {
  test("kills every pid of the matching service", async () => {
    const sh = Bun.spawn(["/bin/sh", "-c", "sleep 1000; exit 0"]); // a list, so sh does not exec sleep in place
    spawned.push(sh.pid);
    let child: Process | undefined;
    for (let i = 0; i < 30 && !child; i++) {
      child = (await scanProcesses()).find((p) => p.ppid === sh.pid);
      if (!child) await Bun.sleep(100);
    }
    spawned.push(child!.pid);
    running = [{ ...docs, rootPid: sh.pid, pids: [sh.pid, child!.pid], ports: [39990] }];
    const res = await call("POST", "/api/kill", { rootPid: sh.pid });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.killed.sort()).toEqual([sh.pid, child!.pid].sort());
    expect(isAlive(child!.pid)).toBe(false);
  });

  test("404 for an unknown rootPid", async () => {
    running = [];
    expect((await call("POST", "/api/kill", { rootPid: 424242 })).status).toBe(404);
  });
});

describe("POST /api/start, /api/restart and GET /api/logs/:id", () => {
  test("start runs a stopped pinned service and its log becomes readable", async () => {
    running = [];
    await registry.save([{ id: "echo-1", name: "echo", cwd: home, command: "echo started-by-devboard", port: 39991 }]);
    const res = await call("POST", "/api/start", { id: "echo-1" });
    expect(res.status).toBe(200);
    const { pid } = await res.json();
    spawned.push(pid);
    await Bun.sleep(300);
    const logs = await call("GET", "/api/logs/echo-1?lines=50");
    expect(logs.status).toBe(200);
    expect((await logs.json()).lines).toContain("started-by-devboard");
  });

  test("start refuses when the pinned service is already running", async () => {
    running = [{ ...docs, cwd: home, ports: [39991] }];
    expect((await call("POST", "/api/start", { id: "echo-1" })).status).toBe(409);
  });

  test("restart by id with nothing running just starts", async () => {
    running = [];
    const res = await call("POST", "/api/restart", { id: "echo-1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.killed).toEqual([]);
    expect(body.pid).toBeNumber();
    spawned.push(body.pid);
  });

  test("restart by rootPid requires a cwd", async () => {
    running = [{ ...docs, cwd: undefined }];
    expect((await call("POST", "/api/restart", { rootPid: 64672 })).status).toBe(400);
  });

  test("logs 404 for an unknown id and the unknown route 404s", async () => {
    expect((await call("GET", "/api/logs/nothing-here")).status).toBe(404);
    expect((await call("GET", "/api/whatever")).status).toBe(404);
  });
});
