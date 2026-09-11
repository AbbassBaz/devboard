#!/usr/bin/env bun
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const base = (process.env.DEVBOARD_URL ?? "http://127.0.0.1:4242").replace(/\/$/, "");
const BIN = join(homedir(), ".local", "bin", "devboard");
const APP = join(homedir(), "Applications", "Devboard.app");

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
  return data as Record<string, unknown>;
}

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/services`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

function usage(code = 1): never {
  console.log(`devboard — local servers on this Mac

  Type these in any terminal (after once: devboard install):

  devboard                 list what's on / off
  devboard start <id>      start a saved server
  devboard stop <id>       stop a running server
  devboard restart <id>    restart
  devboard logs <id> [-f]  print the log; -f follows
  devboard start-all       start every saved server that is off
  devboard stop-all        stop every running dev server
  devboard up              start the board (and the menu bar) if needed
  devboard tray            show the menu bar extra
  devboard install         put \`devboard\` on your PATH and install the menu bar app
`);
  process.exit(code);
}

function launchTray() {
  if (!existsSync(APP)) {
    console.error("menu bar app is not installed yet — run: devboard install");
    process.exit(1);
  }
  Bun.spawn(["open", "-g", "-a", APP], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
}

async function up() {
  if (!(await isUp())) {
    const child = Bun.spawn([process.execPath, "run", "server.ts"], {
      cwd: ROOT,
      env: { ...process.env, DEVBOARD_TRAY: "0" },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    child.unref();
    const deadline = Date.now() + 8000;
    while (!(await isUp()) && Date.now() < deadline) await Bun.sleep(200);
    if (!(await isUp())) throw new Error("board did not come up on " + base);
  }
  if (existsSync(APP)) {
    Bun.spawn(["open", "-g", "-a", APP], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
  }
  console.log(`board ${base}`);
}

async function swiftReady(): Promise<boolean> {
  if (!Bun.which("swift")) return false;
  const check = Bun.spawn(["swift", "--version"], { stdout: "ignore", stderr: "ignore" });
  return (await check.exited) === 0;
}

async function install() {
  mkdirSync(join(homedir(), ".local", "bin"), { recursive: true });
  try { unlinkSync(BIN); } catch {}
  symlinkSync(join(ROOT, "bin/devboard.ts"), BIN);
  if (!(await swiftReady())) {
    console.log("menu bar app skipped: Swift 6 toolchain not found; install Xcode 16 or run bun run tray:build later");
    console.log(`command: ${BIN}`);
    return;
  }
  const build = Bun.spawn(["/bin/zsh", join(ROOT, "scripts/build-tray.sh")], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await build.exited;
  if (code !== 0) throw new Error("tray build failed");
  console.log(`command: ${BIN}`);
  console.log(`menu bar: ${APP}`);
  console.log("In any new terminal:  devboard");
  if (existsSync(APP)) {
    Bun.spawn(["open", "-g", "-a", APP], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const follow = rest.includes("-f");
const id = rest.find((a) => a !== "-f");

try {
  if (cmd === "help" || cmd === "-h" || cmd === "--help") usage(0);
  else if (cmd === "install") await install();
  else if (cmd === "up") await up();
  else if (cmd === "tray") launchTray();
  else if (!cmd || cmd === "status" || cmd === "ls") {
    if (!(await isUp())) {
      console.error(`board is off at ${base} — start it with:  devboard up`);
      process.exit(1);
    }
    const data = await api("GET", "/api/services") as { services: { id: string; name: string; status: string; ports: number[]; kind: string }[] };
    for (const s of data.services.filter((x) => x.kind === "dev")) {
      console.log(`${s.status === "running" ? "on " : "off"}  ${s.id}  ${s.name}  ${s.ports.map((p) => ":" + p).join(" ")}`);
    }
  } else if (cmd === "start" && id) {
    const out = await api("POST", "/api/start", { id });
    console.log(`started ${id} pid ${out.pid}`);
  } else if (cmd === "stop" && id) {
    const data = await api("GET", "/api/services") as { services: { id: string; rootPid?: number }[] };
    const svc = data.services.find((s) => s.id === id);
    if (!svc?.rootPid) throw new Error("not running");
    await api("POST", "/api/kill", { rootPid: svc.rootPid });
    console.log(`stopped ${id}`);
  } else if (cmd === "restart" && id) {
    const out = await api("POST", "/api/restart", { id });
    console.log(`restarted ${id} pid ${out.pid}`);
  } else if (cmd === "logs" && id) {
    let last = 0;
    const once = async () => {
      const data = await api("GET", `/api/logs/${encodeURIComponent(id)}?lines=200`) as { lines: string[] };
      const lines = data.lines.slice(last);
      last = data.lines.length;
      if (lines.length) console.log(lines.join("\n"));
    };
    await once();
    if (follow) {
      while (true) {
        await Bun.sleep(1000);
        await once();
      }
    }
  } else if (cmd === "start-all") {
    const data = await api("GET", "/api/services") as { services: { id: string; status: string; kind: string; pinned: boolean }[] };
    for (const s of data.services.filter((x) => x.kind === "dev" && x.pinned && x.status === "stopped")) {
      try { await api("POST", "/api/start", { id: s.id }); console.log(`started ${s.id}`); }
      catch (e) { console.error(`${s.id}: ${e instanceof Error ? e.message : e}`); }
    }
  } else if (cmd === "stop-all") {
    const data = await api("GET", "/api/services") as { services: { id: string; kind: string; status: string; rootPid?: number }[] };
    for (const s of data.services.filter((x) => x.kind === "dev" && x.status === "running" && x.rootPid)) {
      await api("POST", "/api/kill", { rootPid: s.rootPid });
      console.log(`stopped ${s.id}`);
    }
  } else {
    usage();
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
