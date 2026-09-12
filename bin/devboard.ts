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
    headers: method === "GET" ? undefined : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
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
  devboard ls [--json]     same list; --json prints the services array
  devboard add <name> <folder> <command> <port>
  devboard rm <id>         unpin a saved server
  devboard pin <port>      pin the running row on that port
  devboard open <id>       open the saved folder in the editor
  devboard start <id>      start a saved server
  devboard stop <id>       stop a running server
  devboard restart <id>    restart
  devboard logs <id> [-f]  print the log; -f follows
  devboard start-all       start every saved server that is off
  devboard stop-all        stop every running dev server
  devboard doctor          check bun, PATH tools, :4242, and the tray
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

type Svc = {
  id?: string;
  name: string;
  status: string;
  ports: number[];
  kind: string;
  rootPid?: number;
  pinned?: boolean;
  cwd?: string;
};

function bunMeets(engine: string, version: string): boolean {
  const want = /(\d+)\.(\d+)/.exec(engine);
  const have = /(\d+)\.(\d+)/.exec(version);
  if (!want || !have) return true;
  const [wMaj, wMin] = [Number(want[1]), Number(want[2])];
  const [hMaj, hMin] = [Number(have[1]), Number(have[2])];
  return hMaj > wMaj || (hMaj === wMaj && hMin >= wMin);
}

async function doctor(): Promise<number> {
  const pkg = await Bun.file(join(ROOT, "package.json")).json() as { engines?: { bun?: string } };
  const need = pkg.engines?.bun ?? ">=1.2";
  const bunOk = bunMeets(need, Bun.version);
  const lsof = Bun.which("lsof");
  const ps = Bun.which("ps");
  const localBin = join(homedir(), ".local", "bin");
  const onPath = (process.env.PATH ?? "").split(":").includes(localBin);
  let portLine = `4242 free`;
  let portHeld = false;
  if (lsof) {
    const proc = Bun.spawn(["lsof", "-nP", "-iTCP:4242", "-sTCP:LISTEN"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const line = text.trim().split("\n").find((l) => /\bLISTEN\b/.test(l));
    if (line) {
      portHeld = true;
      const pid = line.split(/\s+/)[1] ?? "?";
      portLine = `4242 held by pid ${pid}`;
    }
  }
  const tray = existsSync(APP);
  const rows: { hard: boolean; ok: boolean; text: string }[] = [
    { hard: true, ok: bunOk, text: bunOk ? `bun ${Bun.version} meets ${need}` : `bun ${Bun.version} does not meet engines ${need} — install a newer Bun` },
    { hard: true, ok: !!lsof, text: lsof ? `lsof on PATH (${lsof})` : "lsof not on PATH — install it (macOS ships it in /usr/sbin)" },
    { hard: true, ok: !!ps, text: ps ? `ps on PATH (${ps})` : "ps not on PATH" },
    { hard: false, ok: !portHeld, text: portHeld ? `${portLine} — the board is already up` : portLine },
    { hard: false, ok: onPath, text: onPath ? `~/.local/bin is on PATH` : `~/.local/bin is not on PATH — add it or run: bun run devboard -- <cmd>` },
    { hard: false, ok: tray, text: tray ? `tray app at ${APP}` : `tray app missing — run: bun run tray:build` },
  ];
  for (const r of rows) console.log(`${r.ok ? "ok" : "fix"}  ${r.text}`);
  return rows.some((r) => r.hard && !r.ok) ? 1 : 0;
}

const raw = process.argv.slice(2);
const jsonOut = raw.includes("--json");
const follow = raw.includes("-f");
const positional = raw.filter((a) => a !== "--json" && a !== "-f" && a !== "-h" && a !== "--help");
const cmd = positional[0];
const id = positional[1];

try {
  if (cmd === "help" || raw.includes("-h") || raw.includes("--help")) usage(0);
  else if (cmd === "install") await install();
  else if (cmd === "up") await up();
  else if (cmd === "tray") launchTray();
  else if (cmd === "doctor") process.exit(await doctor());
  else if (!cmd || cmd === "status" || cmd === "ls") {
    if (!(await isUp())) {
      console.error(`board is off at ${base} — start it with:  devboard up`);
      process.exit(1);
    }
    const data = await api("GET", "/api/services") as { services: Svc[] };
    if (jsonOut) {
      console.log(JSON.stringify(data.services, null, 2));
    } else {
      for (const s of data.services.filter((x) => x.kind === "dev")) {
        console.log(`${s.status === "running" ? "on " : "off"}  ${s.id}  ${s.name}  ${s.ports.map((p) => ":" + p).join(" ")}`);
      }
    }
  } else if (cmd === "add" && positional.length >= 5) {
    const [, name, folder, command, portRaw] = positional;
    const out = await api("POST", "/api/pinned", { name, cwd: folder, command, port: Number(portRaw) }) as { pinned: { id: string } };
    console.log(`added ${out.pinned.id}`);
  } else if (cmd === "rm" && id) {
    await api("DELETE", `/api/pin/${encodeURIComponent(id)}`);
    console.log(`removed ${id}`);
  } else if (cmd === "pin" && id) {
    const port = Number(id);
    if (!Number.isInteger(port) || port < 1) throw new Error("pin needs a port");
    const data = await api("GET", "/api/services") as { services: Svc[] };
    const svc = data.services.find((s) => s.status === "running" && s.rootPid && s.ports.includes(port));
    if (!svc?.rootPid) throw new Error(`no running server on :${port}`);
    const out = await api("POST", "/api/pin", { rootPid: svc.rootPid }) as { pinned: { id: string } };
    console.log(`pinned ${out.pinned.id}`);
  } else if (cmd === "open" && id) {
    const data = await api("GET", "/api/services") as { services: Svc[] };
    const svc = data.services.find((s) => s.id === id);
    if (!svc?.cwd) throw new Error("no saved folder for that id");
    const out = await api("POST", "/api/open", { path: svc.cwd }) as { cmd?: string };
    console.log(`opened ${svc.cwd}${out.cmd ? ` with ${out.cmd}` : ""}`);
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
    let from = 0;
    let first = true;
    const once = async () => {
      const q = first ? "lines=200" : `from=${from}`;
      const data = await api("GET", `/api/logs/${encodeURIComponent(id)}?${q}`) as { lines: string[]; size: number; next?: number; reset?: boolean };
      if (data.reset) console.log("--- log reset ---");
      if (data.lines.length) console.log(data.lines.join("\n"));
      from = data.next ?? data.size;
      first = false;
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
    const data = await api("GET", "/api/services") as { services: { id: string; kind: string; status: string; rootPid?: number; pinned?: boolean }[] };
    for (const s of data.services.filter((x) => x.kind === "dev" && x.status === "running" && x.rootPid)) {
      try {
        if (!s.pinned) await api("POST", "/api/pin", { rootPid: s.rootPid });
        await api("POST", "/api/kill", { rootPid: s.rootPid });
        console.log(`stopped ${s.id}`);
      } catch (e) {
        console.error(`${s.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  } else {
    usage();
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
