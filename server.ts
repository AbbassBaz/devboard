import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { Control, killTree } from "./lib/control";
import { discover as realDiscover } from "./lib/discover";
import { logIdFor, matchPinned, mergeServices } from "./lib/merge";
import { Registry } from "./lib/registry";
import type { RunningService, StartSpec } from "./lib/types";

export type Deps = {
  discover: () => Promise<RunningService[]>;
  registry: Registry;
  control: Control;
};

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (message: string, status = 400) => json({ error: message }, status);
const page = Bun.file(new URL("./public/index.html", import.meta.url));
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p);

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const { registry, control } = deps;

  const findRunning = async (rootPid: number) => (await deps.discover()).find((s) => s.rootPid === rootPid);

  const readBody = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      const body = await req.json();
      return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  return async function handle(req: Request): Promise<Response> {
    const res = await route(req);
    const isMutation = req.method !== "GET";
    if (isMutation || res.status >= 400) {
      const path = new URL(req.url).pathname;
      if (path !== "/favicon.ico") console.log(`${new Date().toISOString()} ${req.method} ${path} -> ${res.status}${res.status >= 400 ? " " + (await res.clone().text()).slice(0, 200) : ""}`);
    }
    return res;
  };

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;
    try {
      if (method === "GET" && pathname === "/") {
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (method === "GET" && pathname === "/api/services") {
        const [running, pinned, ignored] = await Promise.all([deps.discover(), registry.load(), registry.loadIgnored()]);
        const services = mergeServices(running, pinned, (id) => control.hasLog(id), ignored);
        return json({ services, generatedAt: new Date().toISOString() });
      }

      if (method === "POST" && pathname === "/api/kill") {
        const { rootPid } = await readBody(req);
        if (typeof rootPid !== "number") return fail("rootPid required");
        const svc = await findRunning(rootPid);
        if (!svc) return fail("no running service with that rootPid", 404);
        return json(await killTree(svc.pids));
      }

      if (method === "POST" && pathname === "/api/start") {
        const { id } = await readBody(req);
        if (typeof id !== "string") return fail("id required");
        const pinned = (await registry.load()).find((p) => p.id === id);
        if (!pinned) return fail("no pinned service with that id", 404);
        const alreadyRunning = (await deps.discover()).some((s) => matchPinned(s, [pinned]));
        if (alreadyRunning) return fail("already running", 409);
        return json({ pid: await control.start(pinned) });
      }

      if (method === "POST" && pathname === "/api/restart") {
        const body = await readBody(req);
        const pinnedList = await registry.load();
        let spec: StartSpec;
        let pids: number[] = [];
        if (typeof body.rootPid === "number") {
          const svc = await findRunning(body.rootPid);
          if (!svc) return fail("no running service with that rootPid", 404);
          if (!svc.cwd) return fail("working directory unknown, cannot restart");
          spec = matchPinned(svc, pinnedList) ?? { id: logIdFor(svc), cwd: svc.cwd, command: svc.command };
          pids = svc.pids;
        } else if (typeof body.id === "string") {
          const pinned = pinnedList.find((p) => p.id === body.id);
          if (!pinned) return fail("no pinned service with that id", 404);
          const svc = (await deps.discover()).find((s) => matchPinned(s, [pinned]));
          spec = pinned;
          pids = svc?.pids ?? [];
        } else {
          return fail("rootPid or id required");
        }
        const result = pids.length ? await killTree(pids) : { killed: [], forced: [] };
        return json({ ...result, pid: await control.start(spec) });
      }

      const editPinned = /^\/api\/pinned\/([^/]+)$/.exec(pathname);
      if ((method === "POST" && pathname === "/api/pinned") || (method === "PUT" && editPinned)) {
        const { name, cwd, command, port } = await readBody(req);
        if (typeof name !== "string" || !name.trim()) return fail("name required");
        if (typeof cwd !== "string" || !cwd.trim()) return fail("folder required");
        if (typeof command !== "string" || !command.trim()) return fail("command required");
        const portNum = Number(port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return fail("port must be a whole number between 1 and 65535");
        const folder = expandHome(cwd.trim());
        const info = await stat(folder).catch(() => undefined);
        if (!info?.isDirectory()) return fail(`folder does not exist: ${folder}`);
        const input = { name: name.trim(), cwd: folder, command: command.trim(), port: portNum };
        if (editPinned) {
          const pinned = await registry.replace(decodeURIComponent(editPinned[1]), input);
          return pinned ? json({ pinned }) : fail("no pinned service with that id", 404);
        }
        return json({ pinned: await registry.add(input) }, 201);
      }

      if (method === "POST" && pathname === "/api/pin") {
        const { rootPid, name } = await readBody(req);
        if (typeof rootPid !== "number") return fail("rootPid required");
        const svc = await findRunning(rootPid);
        if (!svc) return fail("no running service with that rootPid", 404);
        return json({ pinned: await registry.pin(svc, typeof name === "string" && name ? name : undefined) });
      }

      if (method === "POST" && pathname === "/api/ignore") {
        const { id } = await readBody(req);
        if (typeof id !== "string" || !id) return fail("id required");
        await registry.setIgnored(id, true);
        return json({ ok: true });
      }
      const unignore = /^\/api\/ignore\/([^/]+)$/.exec(pathname);
      if (method === "DELETE" && unignore) {
        await registry.setIgnored(decodeURIComponent(unignore[1]), false);
        return json({ ok: true });
      }

      const unpin = /^\/api\/pin\/([^/]+)$/.exec(pathname);
      if (method === "DELETE" && unpin) {
        const removed = await registry.unpin(decodeURIComponent(unpin[1]));
        return removed ? json({ ok: true }) : fail("not pinned", 404);
      }

      const logs = /^\/api\/logs\/([^/]+)$/.exec(pathname);
      if (method === "GET" && logs) {
        const id = decodeURIComponent(logs[1]);
        if (!control.hasLog(id)) return fail("no log for that id", 404);
        const requested = Number(url.searchParams.get("lines") ?? 200);
        const lines = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 5000) : 200;
        return json(await control.tailLog(id, lines));
      }

      return fail("not found", 404);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), 500);
    }
  }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4242);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: createHandler({ discover: () => realDiscover(), registry: new Registry(), control: new Control() }),
  });
  console.log(`devboard → http://127.0.0.1:${server.port}`);
}
