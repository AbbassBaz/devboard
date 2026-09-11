#!/usr/bin/env bun
const base = (process.env.DEVBOARD_URL ?? "http://127.0.0.1:4242").replace(/\/$/, "");

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

function usage(): never {
  console.log(`devboard — talk to the local board at ${base}

  devboard                 list services
  devboard start <id>      start a pinned server
  devboard stop <id>       stop a running server
  devboard restart <id>    restart
  devboard logs <id> [-f]  print the log; -f follows
  devboard start-all       start every saved server that is off
  devboard stop-all        stop every running dev server
`);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const follow = rest.includes("-f");
const id = rest.find((a) => a !== "-f");

try {
  if (!cmd || cmd === "status" || cmd === "ls") {
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
