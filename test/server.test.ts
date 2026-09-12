import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Control, isAlive, killTree } from "../lib/control";
import { discover, scanProcesses } from "../lib/discover";
import { Registry } from "../lib/registry";
import { CrashWatch } from "../lib/restarts";
import type { Process, RunningService, Service } from "../lib/types";
import { createHandler } from "../server";

const home = mkdtempSync(join(tmpdir(), "devboard-"));
const registry = new Registry(home);
const control = new Control(home);
let running: RunningService[] = [];
const handle = createHandler({ discover: async () => running, registry, control, allowedHosts: ["devboard.test"] });

const docs: RunningService = {
  rootPid: 64672, pids: [64672, 64728, 64734], ports: [3010],
  cwd: home, command: "node /x/pnpm dev",
  name: "docs-site", kind: "dev", uptime: "23-01:48:35", cpu: 0.2, memMb: 149,
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
    headers: method === "GET" ? undefined : { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));

describe("GET /", () => {
  test("serves the page as HTML", async () => {
    const res = await call("GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>devboard</title>");
    expect(html).toContain('id="dev"');
    expect(html).toContain('id="worktreesBtn"');
    expect(html).toContain('id="projectBtn"');
    expect(html).toContain("/app.js");
    expect(html).toContain("/app.css");
    expect(html).not.toContain("fonts.googleapis.com");
  });

  test("serves the split stylesheet and script", async () => {
    const css = await call("GET", "/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("--bg:");
    const js = await call("GET", "/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("/api/services");
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
    expect(body.services.find((s: Service) => s.rootPid === 64672)).toMatchObject({ status: "running", pinned: false });
    expect(body.services.find((s: Service) => s.id === "core-api-3003")).toMatchObject({ status: "stopped", pinned: true });
  });
});

describe("POST /api/ignore and DELETE /api/ignore/:id", () => {
  test("hides a service by id and shows it again", async () => {
    running = [docs];
    expect((await call("POST", "/api/ignore", { id: "docs-site-3010" })).status).toBe(200);
    let list = (await (await call("GET", "/api/services")).json()).services;
    expect(list.find((s: Service) => s.id === "docs-site-3010")).toMatchObject({ hidden: true, status: "running" });
    expect((await call("DELETE", "/api/ignore/docs-site-3010")).status).toBe(200);
    list = (await (await call("GET", "/api/services")).json()).services;
    expect(list.find((s: Service) => s.id === "docs-site-3010")!.hidden).toBe(false);
    expect((await call("POST", "/api/ignore", {})).status).toBe(400);
  });
});

describe("POST /api/pinned (hand-entered server)", () => {
  test("creates a stopped pinned service, expanding ~ in the folder", async () => {
    running = [];
    const res = await call("POST", "/api/pinned", { name: "Home Thing", cwd: "~", command: "true", port: 39992 });
    expect(res.status).toBe(201);
    const { pinned } = await res.json();
    expect(pinned).toMatchObject({ id: "home-thing-39992", cwd: process.env.HOME, command: "true", port: 39992 });
    const list = (await (await call("GET", "/api/services")).json()).services;
    expect(list.find((s: Service) => s.id === "home-thing-39992")).toMatchObject({ status: "stopped", pinned: true });
    await registry.unpin("home-thing-39992");
  });

  test("PUT /api/pinned/:id edits a saved service and 404s for unknown ids", async () => {
    running = [];
    await registry.save([{ id: "dash-3001", name: "dash", cwd: home, command: "npm exec next dev --port 3001", port: 3001 }]);
    const res = await call("PUT", "/api/pinned/dash-3001", { name: "dashboard", cwd: home, command: "npm exec -- next dev --port 3001", port: 3001 });
    expect(res.status).toBe(200);
    expect((await res.json()).pinned).toEqual({ id: "dashboard-3001", name: "dashboard", cwd: home, command: "npm exec -- next dev --port 3001", port: 3001 });
    expect((await registry.load()).map((p) => p.id)).toEqual(["dashboard-3001"]);
    expect((await call("PUT", "/api/pinned/dash-3001", { name: "x", cwd: home, command: "true", port: 1 })).status).toBe(404);
    expect((await call("PUT", "/api/pinned/dashboard-3001", { name: "x", cwd: home, command: "true", port: 0 })).status).toBe(400);
    await registry.save([]);
  });

  test("rejects missing fields, bad ports and folders that do not exist", async () => {
    expect((await call("POST", "/api/pinned", { cwd: home, command: "true", port: 1 })).status).toBe(400);
    expect((await call("POST", "/api/pinned", { name: "x", cwd: home, command: "true", port: "abc" })).status).toBe(400);
    expect((await call("POST", "/api/pinned", { name: "x", cwd: home, command: "true", port: 70000 })).status).toBe(400);
    const missing = await call("POST", "/api/pinned", { name: "x", cwd: join(home, "nope"), command: "true", port: 1 });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("folder does not exist");
  });
});

describe("POST /api/pin and DELETE /api/pin/:id", () => {
  test("pins a running service and unpins by id", async () => {
    running = [docs];
    const res = await call("POST", "/api/pin", { rootPid: 64672 });
    expect(res.status).toBe(200);
    expect((await res.json()).pinned.id).toBe("docs-site-3010");
    expect((await registry.load()).some((p) => p.id === "docs-site-3010")).toBe(true);
    const del = await call("DELETE", "/api/pin/docs-site-3010");
    expect(del.status).toBe(200);
    expect((await call("DELETE", "/api/pin/docs-site-3010")).status).toBe(404);
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

  test("DELETE /api/logs/:id clears a captured log", async () => {
    const cleared = await call("DELETE", "/api/logs/echo-1");
    expect(cleared.status).toBe(200);
    expect((await (await call("GET", "/api/logs/echo-1")).json()).lines.some((l: string) => l.includes("cleared"))).toBe(true);
    expect((await call("DELETE", "/api/logs/nothing-here")).status).toBe(404);
  });

  test("GET /api/logs/:id?from= follows by byte offset and resets after clear", async () => {
    mkdirSync(control.logDir, { recursive: true });
    const path = control.logPath("follow-1");
    writeFileSync(path, Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const first = await (await call("GET", "/api/logs/follow-1?from=0")).json();
    expect(first.lines).toHaveLength(150);
    writeFileSync(path, Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n") + "\nsame\nsame\n");
    const second = await (await call("GET", `/api/logs/follow-1?from=${first.next}`)).json();
    expect(second.lines[0]).toBe("line 151");
    expect(second.lines.slice(-2)).toEqual(["same", "same"]);
    expect((await call("DELETE", "/api/logs/follow-1")).status).toBe(200);
    const after = await (await call("GET", `/api/logs/follow-1?from=${second.next}`)).json();
    expect(after.reset).toBe(true);
    expect(after.lines.some((l: string) => l.includes("cleared"))).toBe(true);
  });

  test("GET /api/services counts classifyLine errors from the log", async () => {
    running = [];
    await registry.add({ name: "errs", cwd: home, command: "true", port: 39890 });
    mkdirSync(control.logDir, { recursive: true });
    writeFileSync(control.logPath("errs-39890"), "ok\nError: boom\nready\nError: EADDRINUSE\n");
    const body = await (await call("GET", "/api/services")).json();
    expect(body.services.find((s: Service) => s.id === "errs-39890")).toMatchObject({ errorCount: 2 });
    const log = await (await call("GET", "/api/logs/errs-39890?lines=50")).json();
    expect(log.levels.filter((l: string) => l === "error")).toHaveLength(2);
  });

  test("log ids cannot escape the log directory", async () => {
    const outside = join(home, "..", "outside.log");
    writeFileSync(outside, "leave me alone\n");
    const get = await call("GET", "/api/logs/..%2F..%2Foutside");
    const del = await call("DELETE", "/api/logs/..%2F..%2Foutside");
    expect(get.status).toBe(400);
    expect(del.status).toBe(400);
    expect(await Bun.file(outside).text()).toBe("leave me alone\n");
  });
});

describe("GET /api/worktrees and prune/remove", () => {
  test("scans a folder, prunes a deleted worktree, and removes an orphan", async () => {
    const root = mkdtempSync(join(tmpdir(), "devboard-wt-api-"));
    const repo = join(root, "app");
    const linked = join(root, "app-agent");
    const orphan = join(root, "orphan");
    const git = async (cwd: string, args: string[]) => {
      const proc = Bun.spawn(["git", "-c", "user.name=devboard", "-c", "user.email=devboard@test", ...args], {
        cwd, stdout: "ignore", stderr: "pipe",
      });
      const err = await new Response(proc.stderr).text();
      if ((await proc.exited) !== 0) throw new Error(err);
    };
    await git(root, ["init", "-q", "app"]);
    await git(repo, ["commit", "--allow-empty", "-qm", "init"]);
    await git(repo, ["worktree", "add", "-q", "-b", "agent", linked]);
    rmSync(linked, { recursive: true, force: true });
    mkdirSync(orphan);
    writeFileSync(join(orphan, ".git"), "gitdir: /no/such/repo/.git/worktrees/orphan\n");

    expect((await call("GET", "/api/worktrees")).status).toBe(400);
    const scanned = await call("GET", `/api/worktrees?dir=${encodeURIComponent(root)}`);
    expect(scanned.status).toBe(200);
    const body = await scanned.json();
    expect(body.stale.map((w: { reason: string }) => w.reason).sort()).toEqual(["orphaned", "prunable"]);

    const pruned = await call("POST", "/api/worktrees/prune", { dir: root });
    expect(pruned.status).toBe(200);
    expect((await pruned.json()).pruned).toBe(1);

    const removed = await call("POST", "/api/worktrees/remove", { path: orphan });
    expect(removed.status).toBe(200);
    const again = await (await call("GET", `/api/worktrees?dir=${encodeURIComponent(root)}`)).json();
    expect(again.stale).toEqual([]);
  });

  test("launch copies main-checkout pins into a worktree on free ports", async () => {
    const root = mkdtempSync(join(tmpdir(), "devboard-launch-"));
    const repo = join(root, "app");
    const linked = join(root, "app-feat");
    const git = async (cwd: string, args: string[]) => {
      const proc = Bun.spawn(["git", "-c", "user.name=devboard", "-c", "user.email=devboard@test", ...args], {
        cwd, stdout: "ignore", stderr: "pipe",
      });
      const err = await new Response(proc.stderr).text();
      if ((await proc.exited) !== 0) throw new Error(err);
    };
    await git(root, ["init", "-q", "app"]);
    mkdirSync(join(repo, "apps", "api"), { recursive: true });
    writeFileSync(join(repo, "apps", "api", "ok.txt"), "1");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-qm", "api"]);
    await git(repo, ["worktree", "add", "-q", "-b", "feat", linked]);

    running = [];
    await registry.save([]);
    await registry.add({
      name: "api", cwd: join(repo, "apps", "api"),
      command: "echo launched --port 3003", port: 3003,
    });
    const res = await call("POST", "/api/worktrees/launch", { path: linked });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toHaveLength(1);
    expect(body.created[0].name).toBe("api");
    expect(body.created[0].cwd.endsWith("/app-feat/apps/api")).toBe(true);
    expect(body.created[0].port).not.toBe(3003);
    expect(body.created[0].command).toBe(`echo launched --port ${body.created[0].port}`);
    expect(body.started[0].id).toBe(body.created[0].id);
    spawned.push(body.started[0].pid);
  });

  test("retire and remove 409 while a server runs in the checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "devboard-wt-busy-"));
    const repo = join(root, "app");
    const linked = join(root, "app-agent");
    const orphan = join(root, "orphan");
    const git = async (cwd: string, args: string[]) => {
      const proc = Bun.spawn(["git", "-c", "user.name=devboard", "-c", "user.email=devboard@test", ...args], {
        cwd, stdout: "ignore", stderr: "pipe",
      });
      const err = await new Response(proc.stderr).text();
      if ((await proc.exited) !== 0) throw new Error(err);
    };
    await git(root, ["init", "-q", "app"]);
    await git(repo, ["commit", "--allow-empty", "-qm", "init"]);
    await git(repo, ["worktree", "add", "-q", "-b", "agent", linked]);

    running = [{ ...docs, name: "api", cwd: linked, ports: [39980] }];
    const busy = await call("POST", "/api/worktrees/retire", { path: linked });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "Stop and retire", names: ["api"] });
    expect(existsSync(linked)).toBe(true);

    running = [];
    expect((await call("POST", "/api/worktrees/retire", { path: linked })).status).toBe(200);
    expect(existsSync(linked)).toBe(false);

    const main = await call("POST", "/api/worktrees/retire", { path: repo });
    expect(main.status).toBe(500);
    expect((await main.json()).error).toMatch(/main worktree/);
    expect(existsSync(repo)).toBe(true);

    mkdirSync(orphan);
    writeFileSync(join(orphan, ".git"), "gitdir: /no/such/repo/.git/worktrees/orphan\n");
    running = [{ ...docs, name: "ghost", cwd: orphan, ports: [39981] }];
    const blocked = await call("POST", "/api/worktrees/remove", { path: orphan });
    expect(blocked.status).toBe(409);
    expect(existsSync(orphan)).toBe(true);
    running = [];
    expect((await call("POST", "/api/worktrees/remove", { path: orphan })).status).toBe(200);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("projects", () => {
  test("create from a folder, start members together, and keep a service in one project", async () => {
    running = [];
    await registry.save([]);
    await registry.saveProjects([]);
    const app = join(home, "hub", "api");
    mkdirSync(app, { recursive: true });
    await registry.add({ name: "api", cwd: app, command: "echo project-start", port: 39993 });
    await registry.add({ name: "other", cwd: home, command: "true", port: 39994 });

    expect((await call("POST", "/api/projects", { folder: join(home, "hub") })).status).toBe(400);
    const created = await call("POST", "/api/projects", { name: "Hub", folder: join(home, "hub"), addFromFolder: true });
    expect(created.status).toBe(201);
    expect((await created.json()).project.memberIds).toEqual(["api-39993"]);

    const listed = await (await call("GET", "/api/services")).json();
    expect(listed.projects[0]).toMatchObject({ id: "hub", on: 0, off: 1, ports: [39993] });

    const started = await call("POST", "/api/projects/hub/start");
    expect(started.status).toBe(200);
    const startBody = await started.json();
    expect(startBody.started[0].id).toBe("api-39993");
    spawned.push(startBody.started[0].pid);

    await registry.addProject({ name: "Other" });
    expect((await call("POST", "/api/projects/other/members", { id: "api-39993" })).status).toBe(200);
    expect((await registry.loadProjects()).find((p) => p.id === "hub")!.memberIds).toEqual([]);

    expect((await call("DELETE", "/api/projects/hub")).status).toBe(200);
    expect((await call("DELETE", "/api/projects/hub")).status).toBe(404);
  });
});

describe("healthUrl, ports, presets and attention", () => {
  test("POST /api/pinned keeps an optional health URL", async () => {
    running = [];
    const res = await call("POST", "/api/pinned", {
      name: "Ready", cwd: home, command: "true", port: 39995, healthUrl: "http://127.0.0.1:39995/ready",
    });
    expect(res.status).toBe(201);
    expect((await res.json()).pinned.healthUrl).toBe("http://127.0.0.1:39995/ready");
    await registry.unpin("ready-39995");
  });

  test("POST /api/ports/next skips used ports", async () => {
    running = [{ ...docs, ports: [3000, 3001] }];
    const res = await call("POST", "/api/ports/next");
    expect(res.status).toBe(200);
    expect((await res.json()).port).toBe(3002);
  });

  test("presets save and resume starts pinned members", async () => {
    running = [];
    await registry.save([{ id: "echo-2", name: "echo", cwd: home, command: "echo resumed", port: 39996 }]);
    const created = await call("POST", "/api/presets", {
      name: "Frontend only", serviceIds: ["echo-2"], urls: ["http://127.0.0.1:39996"],
    });
    expect(created.status).toBe(201);
    const { preset } = await created.json();
    expect(preset.id).toBe("frontend-only");
    const listed = await (await call("GET", "/api/services")).json();
    expect(listed.presets.map((p: { id: string }) => p.id)).toContain("frontend-only");
    const resumed = await call("POST", "/api/presets/frontend-only/resume");
    expect(resumed.status).toBe(200);
    const body = await resumed.json();
    expect(body.started[0].id).toBe("echo-2");
    expect(body.urls).toEqual(["http://127.0.0.1:39996"]);
    spawned.push(body.started[0].pid);
    expect((await call("DELETE", "/api/presets/frontend-only")).status).toBe(200);
  });

  test("POST /api/pinned keeps env overrides and restart-on-crash", async () => {
    running = [];
    const res = await call("POST", "/api/pinned", {
      name: "Envful", cwd: home, command: "true", port: 39997,
      envText: "DATABASE_URL=postgres://x\n# skip\nNAME=\"core api\"",
      restartOnCrash: true,
    });
    expect(res.status).toBe(201);
    expect((await res.json()).pinned).toMatchObject({
      env: { DATABASE_URL: "postgres://x", NAME: "core api" },
      restartOnCrash: true,
    });
    await registry.unpin("envful-39997");
  });

  test("GET /api/suggest reads package scripts from a folder", async () => {
    const dir = join(home, "sug");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite --port 5173" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    const res = await call("GET", `/api/suggest?dir=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).suggestions[0]).toMatchObject({ command: "pnpm dev", port: 5173 });
    expect((await call("GET", "/api/suggest")).status).toBe(400);
  });

  test("serves a self-hosted font", async () => {
    const res = await call("GET", "/fonts/IBMPlexSans-Regular.woff2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("font/woff2");
  });

  test("GET /api/env masks secrets, gates pids, and reveal returns the value", async () => {
    running = [{ ...docs, rootPid: 4242, pids: [4242, 4243] }];
    const liveEnv = { API_KEY: "secret-value", PORT: "3000" };
    const envHandle = createHandler({
      discover: async () => running,
      registry,
      control,
      allowedHosts: ["devboard.test"],
      readProcessEnv: async () => liveEnv,
    });
    const envCall = (path: string) => envHandle(new Request(`http://devboard.test${path}`));
    const masked = await (await envCall("/api/env?pid=4242")).json();
    expect(masked.env).toEqual({ API_KEY: "••••", PORT: "3000" });
    const revealed = await (await envCall("/api/env?pid=4243&reveal=1")).json();
    expect(revealed.env.API_KEY).toBe("secret-value");
    expect((await envCall("/api/env?pid=424242")).status).toBe(404);
    expect((await envCall("/api/env")).status).toBe(400);

    running = [];
    await registry.add({
      name: "envy", cwd: home, command: `printf 'API_KEY=%s\\n' "$API_KEY"; exit 0`, port: 39894,
      env: { API_KEY: "secret-value" },
    });
    const started = await call("POST", "/api/start", { id: "envy-39894" });
    expect(started.status).toBe(200);
    spawned.push((await started.json()).pid);
    await Bun.sleep(300);
    const log = await (await call("GET", "/api/logs/envy-39894?lines=50")).json();
    expect(log.lines).toContain("API_KEY=secret-value");
    await registry.unpin("envy-39894");
  });

  test("GET /api/services masks env and GET /api/pinned/:id returns the real copy", async () => {
    running = [];
    await registry.add({
      name: "secret", cwd: home, command: "true", port: 39893,
      env: { API_KEY: "abc", PORT: "3000" },
    });
    const list = await (await call("GET", "/api/services")).json();
    expect(list.services.find((s: Service) => s.id === "secret-39893").env).toEqual({ API_KEY: "••••", PORT: "3000" });
    const raw = await (await call("GET", "/api/pinned/secret-39893")).json();
    expect(raw.pinned.env).toEqual({ API_KEY: "abc", PORT: "3000" });
    await registry.unpin("secret-39893");
  });

  test("GET /api/attention reports a port conflict", async () => {
    running = [
      { ...docs, name: "web", ports: [3010], cwd: join(home, "a") },
      { ...docs, rootPid: 9, pids: [9], name: "web-b", ports: [3010], cwd: join(home, "b") },
    ];
    const res = await call("GET", `/api/attention?dir=${encodeURIComponent(home)}`);
    expect(res.status).toBe(200);
    const { alerts } = await res.json();
    expect(alerts.some((a: { kind: string }) => a.kind === "port-conflict")).toBe(true);
  });
});

describe("request gate", () => {
  test("Host: evil.example gets 403", async () => {
    const res = await handle(new Request("http://evil.example/api/services"));
    expect(res.status).toBe(403);
  });

  test("POST with content-type: text/plain gets 415", async () => {
    const res = await handle(new Request("http://devboard.test/api/ignore", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ id: "x" }),
    }));
    expect(res.status).toBe(415);
  });

  test("POST with Origin: http://evil.example gets 403", async () => {
    const res = await handle(new Request("http://devboard.test/api/ignore", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ id: "x" }),
    }));
    expect(res.status).toBe(403);
  });

  test("Origin: null gets 403", async () => {
    const res = await handle(new Request("http://devboard.test/api/services", {
      headers: { origin: "null" },
    }));
    expect(res.status).toBe(403);
  });

  test("POST with Origin: http://127.0.0.1:4242 and JSON passes", async () => {
    const res = await handle(new Request("http://devboard.test/api/ignore", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:4242" },
      body: JSON.stringify({ id: "gate-ok" }),
    }));
    expect(res.status).toBe(200);
  });

  test("POST with no Origin and JSON passes", async () => {
    const res = await call("POST", "/api/ignore", { id: "gate-cli" });
    expect(res.status).toBe(200);
  });
});

describe("tracked process status", () => {
  const trackHome = realpathSync(mkdtempSync(join(tmpdir(), "devboard-track-")));
  const trackRegistry = new Registry(trackHome);
  const trackControl = new Control(trackHome);
  const trackCrashes = new CrashWatch(trackControl);
  const trackHandle = createHandler({
    discover,
    registry: trackRegistry,
    control: trackControl,
    crashes: trackCrashes,
    allowedHosts: ["devboard.test"],
  });
  const trackCall = (method: string, path: string, body?: unknown) =>
    trackHandle(new Request(`http://devboard.test${path}`, {
      method,
      headers: method === "GET" ? undefined : { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }));

  const TRACK_PORT = 39880;
  const serveCmd = `sleep 5; bun -e 'Bun.serve({hostname:"127.0.0.1",port:${TRACK_PORT},fetch(){return new Response("ok")}});setInterval(()=>{},1e6)'; exit 0`;

  afterAll(async () => {
    const t = trackControl.trackedOf("boot-39880");
    if (t) await killTree([t.pid], 500, [process.pid], t.pid);
    rmSync(trackHome, { recursive: true, force: true });
  });

  test("start shows starting then running, refuses a second start, and records exit codes", async () => {
    await trackRegistry.save([{
      id: "boot-39880", name: "boot", cwd: trackHome, command: serveCmd, port: TRACK_PORT,
    }]);
    const started = await trackCall("POST", "/api/start", { id: "boot-39880" });
    expect(started.status).toBe(200);
    const { pid } = await started.json();
    spawned.push(pid);

    const early = await (await trackCall("GET", "/api/services")).json();
    expect(early.services.find((s: Service) => s.id === "boot-39880")).toMatchObject({
      status: "starting", readiness: "starting", rootPid: pid,
    });
    expect((await trackCall("POST", "/api/start", { id: "boot-39880" })).status).toBe(409);

    const deadline = Date.now() + 12000;
    let row: Service | undefined;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${TRACK_PORT}/`)).ok) break;
      } catch {}
      await Bun.sleep(100);
    }
    while (Date.now() < deadline) {
      row = (await (await trackCall("GET", "/api/services")).json()).services.find((s: Service) => s.id === "boot-39880");
      if (row?.status === "running") break;
      await Bun.sleep(100);
    }
    expect(row).toMatchObject({ status: "running", pinned: true, ports: [TRACK_PORT] });

    await trackRegistry.add({ name: "die", cwd: trackHome, command: "exit 3", port: 39881 });
    const died = await trackCall("POST", "/api/start", { id: "die-39881" });
    expect(died.status).toBe(200);
    const { pid: diePid } = await died.json();
    spawned.push(diePid);
    const dieDeadline = Date.now() + 3000;
    let dieRow: Service | undefined;
    while (Date.now() < dieDeadline) {
      dieRow = (await (await trackCall("GET", "/api/services")).json()).services.find((s: Service) => s.id === "die-39881");
      if (dieRow?.status === "stopped" && dieRow.exitCode === 3) break;
      await Bun.sleep(40);
    }
    expect(dieRow).toMatchObject({ status: "stopped", exitCode: 3 });
  }, 20000);

  test("six crash ticks against exit 1 set crash.gaveUp on the row", async () => {
    await trackRegistry.add({
      name: "boom", cwd: trackHome, command: "exit 1", port: 39882, restartOnCrash: true,
    });
    const start = await trackCall("POST", "/api/start", { id: "boom-39882" });
    expect(start.status).toBe(200);
    spawned.push((await start.json()).pid);
    const pinned = (await trackRegistry.load()).find((p) => p.id === "boom-39882")!;
    let now = 0;
    for (let i = 0; i < 6; i++) {
      const wait = Date.now() + 2000;
      let row: Service | undefined;
      while (Date.now() < wait) {
        row = (await (await trackCall("GET", "/api/services")).json()).services.find((s: Service) => s.id === "boom-39882");
        if (row?.status === "stopped" && row.exitCode === 1) break;
        await Bun.sleep(30);
      }
      expect(row).toMatchObject({ status: "stopped", exitCode: 1 });
      await trackCrashes.tick([row!], [pinned], now);
      now += 60_000;
    }
    const body = await (await trackCall("GET", "/api/services")).json();
    expect(body.services.find((s: Service) => s.id === "boom-39882")?.crash).toEqual({ tries: 5, gaveUp: true });
  });

  test("GET /api/services reuses a cached scan until a mutation", async () => {
    let scans = 0;
    const cacheHome = realpathSync(mkdtempSync(join(tmpdir(), "devboard-cache-")));
    let live: RunningService[] = [docs];
    const cacheHandle = createHandler({
      discover: async () => { scans += 1; return live; },
      registry: new Registry(cacheHome),
      control: new Control(cacheHome),
      allowedHosts: ["devboard.test"],
      cacheMs: 30_000,
    });
    const get = () => cacheHandle(new Request("http://devboard.test/api/services"));
    expect((await (await get()).json()).services.some((s: Service) => s.rootPid === 64672)).toBe(true);
    live = [];
    expect((await (await get()).json()).services.some((s: Service) => s.rootPid === 64672)).toBe(true);
    expect(scans).toBe(1);
    await cacheHandle(new Request("http://devboard.test/api/ignore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "docs-site-3010" }),
    }));
    expect((await (await get()).json()).services.some((s: Service) => s.rootPid === 64672)).toBe(false);
    expect(scans).toBe(2);
    rmSync(cacheHome, { recursive: true, force: true });
  });

  test("repeated GET /api/services writes no registry file", async () => {
    const quietHome = realpathSync(mkdtempSync(join(tmpdir(), "devboard-quiet-")));
    const quietRegistry = new Registry(quietHome);
    const quietControl = new Control(quietHome);
    const quietHandle = createHandler({
      discover: async () => [],
      registry: quietRegistry,
      control: quietControl,
      allowedHosts: ["devboard.test"],
    });
    await quietRegistry.save([{ id: "quiet-1", name: "quiet", cwd: quietHome, command: "true", port: 1 }]);
    const names = ["services.json", "projects.json", "ignored.json", "presets.json", "state.json"];
    const before = Object.fromEntries(names.map((n) => {
      try { return [n, statSync(join(quietHome, n)).mtimeMs]; } catch { return [n, null]; }
    }));
    const listed = new Set(readdirSync(quietHome));
    const get = (path: string) => quietHandle(new Request(`http://devboard.test${path}`));
    expect((await get("/api/services")).status).toBe(200);
    expect((await get("/api/services")).status).toBe(200);
    for (const n of names) {
      let after: number | null = null;
      try { after = statSync(join(quietHome, n)).mtimeMs; } catch { after = null; }
      expect(after).toBe(before[n]);
    }
    expect(readdirSync(quietHome).filter((n) => !listed.has(n))).toEqual([]);
    rmSync(quietHome, { recursive: true, force: true });
  });

  test("GET /api/services stays 200 when services.json is not an array", async () => {
    const badHome = realpathSync(mkdtempSync(join(tmpdir(), "devboard-badjson-")));
    writeFileSync(join(badHome, "services.json"), '{ "nope": true }\n');
    const badHandle = createHandler({
      discover: async () => [docs],
      registry: new Registry(badHome),
      control: new Control(badHome),
      allowedHosts: ["devboard.test"],
    });
    const res = await badHandle(new Request("http://devboard.test/api/services"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.services.some((s: Service) => s.rootPid === 64672)).toBe(true);
    expect(await Bun.file(join(badHome, "services.json")).text()).toBe('{ "nope": true }\n');
    rmSync(badHome, { recursive: true, force: true });
  });
});
