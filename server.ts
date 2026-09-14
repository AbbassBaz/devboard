import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { collectAlerts } from "./lib/attention";
import { Control, isValidLogId, killTree } from "./lib/control";
import { discover as realDiscover } from "./lib/discover";
import { maskEnv, parseEnvText, readProcessEnv as readLiveEnv } from "./lib/env";
import { applyReadiness, firstFreePort } from "./lib/health";
import { countErrors, parseLine } from "./lib/logs";
import { logIdFor, matchPinned, mergeServices } from "./lib/merge";
import { parseLinks, projectViews, servicesInFolder } from "./lib/projects";
import { Registry } from "./lib/registry";
import { CrashWatch } from "./lib/restarts";
import { suggestCommands } from "./lib/suggest";
import { parsePinTemplate, planImport, readTemplateFile } from "./lib/template";
import type { LogEntry, Pinned, ProjectLink, RunningService, Service, StartSpec, WorktreeInfo } from "./lib/types";
import { blockingWorktreeServices, createWorktree, mainRepoOf, openInEditor, planWorktreeLaunch, pruneStaleWorktrees, removeOrphanedWorktree, resolveOpenPath, retireWorktree, scanWorktrees } from "./lib/worktrees";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

export type BoardSnapshot = {
  running: RunningService[];
  pinned: Pinned[];
  services: Service[];
};

export type Deps = {
  discover: () => Promise<RunningService[]>;
  registry: Registry;
  control: Control;
  crashes?: CrashWatch;
  allowedHosts?: string[];
  snapshot?: () => Promise<BoardSnapshot>;
  cacheMs?: number;
  readProcessEnv?: (pid: number) => Promise<Record<string, string>>;
};

export type BoardHandler = ((req: Request) => Promise<Response>) & {
  refreshSnapshot: () => Promise<BoardSnapshot>;
};

function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

function isAllowedHost(host: string, extra: string[]): boolean {
  return LOOPBACK_HOSTS.includes(host) || extra.includes(host);
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (message: string, status = 400) => json({ error: message }, status);
const page = Bun.file(new URL("./public/index.html", import.meta.url));
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p);
const resolved = async (p: string) => realpath(p).catch(() => resolve(p));

function readEnvInput(body: Record<string, unknown>): Record<string, string> | undefined {
  if (body.env && typeof body.env === "object" && !Array.isArray(body.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v;
    }
    return Object.keys(env).length ? env : undefined;
  }
  if (typeof body.envText === "string" && body.envText.trim()) {
    const env = parseEnvText(body.envText);
    return Object.keys(env).length ? env : undefined;
  }
  return undefined;
}

export function createHandler(deps: Deps): BoardHandler {
  const { registry, control } = deps;
  const crashes = deps.crashes ?? new CrashWatch(control);
  const cacheMs = deps.cacheMs ?? 0;

  const findRunning = async (rootPid: number) => (await deps.discover()).find((s) => s.rootPid === rootPid);

  const buildSnapshot = deps.snapshot ?? (async (): Promise<BoardSnapshot> => {
    await control.hydrate();
    control.reconcile();
    const [running, pinned, ignored] = await Promise.all([deps.discover(), registry.load(), registry.loadIgnored()]);
    const services = mergeServices(running, pinned, (id) => control.hasLog(id), ignored, control.listTracked());
    return { running, pinned, services };
  });

  let cached: { at: number; data: BoardSnapshot } | null = null;
  let inflight: Promise<BoardSnapshot> | null = null;
  const refreshSnapshot = async () => {
    inflight = buildSnapshot().then((data) => {
      cached = { at: Date.now(), data };
      return data;
    }).finally(() => { inflight = null; });
    return inflight;
  };
  const snapshot = async () => {
    if (inflight) return inflight;
    if (cached && Date.now() - cached.at < cacheMs) return cached.data;
    return refreshSnapshot();
  };
  const invalidate = () => { cached = null; };

  const busyInWorktree = async (path: string) => {
    const target = await resolved(expandHome(path.trim()));
    const { services } = await snapshot();
    const checked = await Promise.all(services.map(async (s) => ({
      ...s,
      cwd: s.cwd ? await resolved(s.cwd) : s.cwd,
    })));
    return blockingWorktreeServices(checked, target);
  };

  const refuseBusyWorktree = async (path: string) => {
    const blockers = await busyInWorktree(path);
    if (!blockers.length) return null;
    return json({
      error: "Stop and retire",
      names: blockers.map((s) => s.name),
      rootPids: blockers.flatMap((s) => (s.rootPid != null ? [s.rootPid] : [])),
    }, 409);
  };

  const withCrash = (services: Service[]) =>
    services.map((s) => {
      const crash = s.id ? crashes.info(s.id) : undefined;
      return crash ? { ...s, crash } : s;
    });

  const errCache = new Map<string, { size: number; mtimeMs: number; count: number }>();
  const errorCountFor = async (id: string): Promise<number> => {
    if (!control.hasLog(id)) return 0;
    const info = await stat(control.logPath(id));
    const hit = errCache.get(id);
    if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.count;
    const count = countErrors((await control.tailLog(id, 4000)).lines);
    errCache.set(id, { size: info.size, mtimeMs: info.mtimeMs, count });
    return count;
  };
  const withErrorCounts = async (services: Service[]) =>
    Promise.all(services.map(async (s) => (s.id && s.hasLog ? { ...s, errorCount: await errorCountFor(s.id) } : s)));
  /** One parse per line on the server: the page, the CLI, Trace, and smoke all read `entries`. */
  const withEntries = <T extends { lines: string[] }>(tail: T) => {
    const { lines, ...rest } = tail;
    return { ...rest, entries: lines.map(parseLine) };
  };

  const folderMembers = async (folder: string): Promise<string[]> => {
    const { running, services } = await snapshot();
    const ids: string[] = [];
    for (const s of servicesInFolder(services, folder)) {
      if (s.hidden || !s.id) continue;
      if (s.pinned) {
        ids.push(s.id);
        continue;
      }
      const live = running.find((r) => r.rootPid === s.rootPid);
      if (!live?.cwd) continue;
      ids.push((await registry.pin(live, s.name)).id);
    }
    return [...new Set(ids)];
  };

  const importFromDir = async (dir: string) => {
    const text = await readTemplateFile(dir);
    if (text === undefined) return { exists: false as const, created: [] as Pinned[], skipped: 0, entries: [] };
    const entries = parsePinTemplate(text);
    const existing = await registry.load();
    const planned = planImport(dir, entries, existing);
    const created: Pinned[] = [];
    for (const input of planned) {
      const dest = await stat(input.cwd).catch(() => undefined);
      if (!dest?.isDirectory()) continue;
      created.push(await registry.add(input));
    }
    return { exists: true as const, created, skipped: entries.length - created.length, entries };
  };

  const readProjectInput = async (req: Request) => {
    const body = await readBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const folderRaw = typeof body.folder === "string" ? body.folder.trim() : "";
    const folder = folderRaw ? expandHome(folderRaw) : undefined;
    if (folder) {
      const info = await stat(folder).catch(() => undefined);
      if (!info?.isDirectory()) throw new Error(`folder does not exist: ${folder}`);
    }
    const links: ProjectLink[] = Array.isArray(body.links)
      ? (body.links as ProjectLink[])
      : typeof body.links === "string"
        ? parseLinks(body.links)
        : [];
    const addFromFolder = body.addFromFolder === true && !!folder;
    const memberIds = Array.isArray(body.memberIds) ? (body.memberIds as unknown[]).filter((id): id is string => typeof id === "string") : [];
    return { name, folder, links, addFromFolder, memberIds };
  };

  const readBody = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      const body = await req.json();
      return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const handle = async function handle(req: Request): Promise<Response> {
    const extra = deps.allowedHosts ?? [];
    const urlHost = new URL(req.url).hostname;
    if (!isAllowedHost(urlHost, extra)) return fail("forbidden", 403);

    const origin = req.headers.get("origin");
    if (origin !== null) {
      const originHost = origin === "null" ? null : hostnameOf(origin);
      if (!originHost || !isAllowedHost(originHost, extra)) return fail("forbidden", 403);
    }

    if (req.method !== "GET") {
      const ct = (req.headers.get("content-type") ?? "").toLowerCase();
      if (!ct.startsWith("application/json")) return fail("content-type must be application/json", 415);
    }

    const site = req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") return fail("forbidden", 403);

    const res = await route(req);
    const isMutation = req.method !== "GET";
    if (isMutation) invalidate();
    if (isMutation || res.status >= 400) {
      const path = new URL(req.url).pathname;
      if (path !== "/favicon.ico") console.log(`${new Date().toISOString()} ${req.method} ${path} -> ${res.status}${res.status >= 400 ? " " + (await res.clone().text()).slice(0, 200) : ""}`);
    }
    return res;
  } as BoardHandler;
  handle.refreshSnapshot = refreshSnapshot;
  return handle;

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;
    try {
      if (method === "GET" && pathname === "/") {
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (method === "GET" && (pathname === "/app.css" || pathname === "/app.js" || pathname === "/log-view.js")) {
        const file = Bun.file(new URL(`./public${pathname}`, import.meta.url));
        if (!(await file.exists())) return fail("not found", 404);
        return new Response(file, {
          headers: { "content-type": pathname.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" },
        });
      }
      const font = /^\/fonts\/([A-Za-z0-9-]+\.woff2)$/.exec(pathname);
      if (method === "GET" && font) {
        const file = Bun.file(new URL(`./public/fonts/${font[1]}`, import.meta.url));
        if (!(await file.exists())) return fail("not found", 404);
        return new Response(file, { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });
      }

      if (method === "GET" && pathname === "/api/services") {
        const { pinned, services: merged } = await snapshot();
        const services = (await withErrorCounts(withCrash(await applyReadiness(merged, pinned)))).map((s) =>
          s.env ? { ...s, env: maskEnv(s.env) } : s,
        );
        const projects = await registry.loadProjects();
        return json({
          services,
          projects: projectViews(projects, services),
          presets: await registry.loadPresets(),
          generatedAt: new Date().toISOString(),
        });
      }

      if (method === "POST" && pathname === "/api/kill") {
        const { rootPid } = await readBody(req);
        if (typeof rootPid !== "number") return fail("rootPid required");
        await control.hydrate();
        const svc = await findRunning(rootPid);
        const tracked = control.listTracked().find((t) => t.pid === rootPid && t.exitedAt == null);
        if (!svc && !tracked) return fail("no running service with that rootPid", 404);
        const pinned = svc ? matchPinned(svc, await registry.load()) : (await registry.load()).find((p) => p.id === tracked?.id);
        crashes.disarm(pinned?.id ?? (svc ? logIdFor(svc) : tracked!.id));
        const pids = svc?.pids ?? (tracked ? [tracked.pid] : []);
        return json(await killTree(pids, 3000, [process.pid], tracked?.pid));
      }

      if (method === "POST" && pathname === "/api/start") {
        const { id } = await readBody(req);
        if (typeof id !== "string") return fail("id required");
        const pinned = (await registry.load()).find((p) => p.id === id);
        if (!pinned) return fail("no pinned service with that id", 404);
        await control.hydrate();
        const alreadyRunning = (await deps.discover()).some((s) => matchPinned(s, [pinned]));
        if (alreadyRunning || control.isTrackedAlive(id)) return fail("already running", 409);
        crashes.reset(pinned.id);
        const pid = await control.start(pinned);
        return json({ pid });
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
          const pinned = matchPinned(svc, pinnedList);
          if (!pinned && svc.commandLossy && body.confirm !== true) return fail("command needs confirmation", 409);
          spec = pinned ?? { id: logIdFor(svc), cwd: svc.cwd, command: svc.command };
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
        await control.hydrate();
        control.reconcile();
        const groupPid = control.isTrackedAlive(spec.id) ? control.trackedOf(spec.id)?.pid : undefined;
        const killPids = pids.length ? pids : (groupPid ? [groupPid] : []);
        const result = killPids.length
          ? await killTree(killPids, 3000, [process.pid], groupPid)
          : { killed: [], forced: [] };
        crashes.reset(spec.id);
        const pid = await control.start(spec);
        return json({ ...result, pid });
      }

      const editPinned = /^\/api\/pinned\/([^/]+)$/.exec(pathname);
      if (method === "GET" && editPinned) {
        const pinned = (await registry.load()).find((p) => p.id === decodeURIComponent(editPinned[1]));
        return pinned ? json({ pinned }) : fail("no pinned service with that id", 404);
      }
      if ((method === "POST" && pathname === "/api/pinned") || (method === "PUT" && editPinned)) {
        const body = await readBody(req);
        const { name, cwd, command, port, healthUrl } = body;
        if (typeof name !== "string" || !name.trim()) return fail("name required");
        if (typeof cwd !== "string" || !cwd.trim()) return fail("folder required");
        if (typeof command !== "string" || !command.trim()) return fail("command required");
        const portNum = Number(port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return fail("port must be a whole number between 1 and 65535");
        const folder = expandHome(cwd.trim());
        const info = await stat(folder).catch(() => undefined);
        if (!info?.isDirectory()) return fail(`folder does not exist: ${folder}`);
        const env = readEnvInput(body);
        const input: Omit<Pinned, "id"> = {
          name: name.trim(), cwd: folder, command: command.trim(), port: portNum,
          healthUrl: typeof healthUrl === "string" && healthUrl.trim() ? healthUrl.trim() : undefined,
          ...(env ? { env } : {}),
          ...(body.restartOnCrash === true ? { restartOnCrash: true } : {}),
        };
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

      if (method === "POST" && pathname === "/api/projects") {
        let input;
        try { input = await readProjectInput(req); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
        if (!input.name) return fail("name required");
        if (input.addFromFolder && input.folder) await importFromDir(input.folder);
        const memberIds = input.addFromFolder && input.folder
          ? [...new Set([...input.memberIds, ...await folderMembers(input.folder)])]
          : input.memberIds;
        return json({ project: await registry.addProject({ ...input, memberIds }) }, 201);
      }

      const editProject = /^\/api\/projects\/([^/]+)$/.exec(pathname);
      if (method === "PUT" && editProject) {
        let input;
        try { input = await readProjectInput(req); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
        if (!input.name) return fail("name required");
        const current = (await registry.loadProjects()).find((p) => p.id === decodeURIComponent(editProject[1]));
        if (!current) return fail("no project with that id", 404);
        if (input.addFromFolder && input.folder) await importFromDir(input.folder);
        const memberIds = input.addFromFolder && input.folder
          ? [...new Set([...current.memberIds, ...input.memberIds, ...await folderMembers(input.folder)])]
          : (input.memberIds.length ? input.memberIds : current.memberIds);
        const project = await registry.replaceProject(current.id, { ...input, memberIds });
        return json({ project });
      }
      if (method === "DELETE" && editProject) {
        const removed = await registry.deleteProject(decodeURIComponent(editProject[1]));
        return removed ? json({ ok: true }) : fail("no project with that id", 404);
      }

      const projectMembers = /^\/api\/projects\/([^/]+)\/members$/.exec(pathname);
      if (method === "POST" && projectMembers) {
        const projectId = decodeURIComponent(projectMembers[1]);
        const body = await readBody(req);
        if (typeof body.folder === "string" && body.folder.trim()) {
          const folder = expandHome(body.folder.trim());
          const info = await stat(folder).catch(() => undefined);
          if (!info?.isDirectory()) return fail(`folder does not exist: ${folder}`);
          await importFromDir(folder);
          const ids = await folderMembers(folder);
          let project = (await registry.loadProjects()).find((p) => p.id === projectId);
          if (!project) return fail("no project with that id", 404);
          for (const id of ids) project = (await registry.addProjectMember(projectId, id)) ?? project;
          return json({ project });
        }
        if (typeof body.id !== "string" || !body.id) return fail("id or folder required");
        const { services, running } = await snapshot();
        const svc = services.find((s) => s.id === body.id);
        if (!svc || svc.kind !== "dev") return fail("no dev service with that id", 404);
        let serviceId = svc.id!;
        if (!svc.pinned) {
          const live = running.find((r) => r.rootPid === svc.rootPid);
          if (!live?.cwd) return fail("working directory unknown, pin it first");
          serviceId = (await registry.pin(live, svc.name)).id;
        }
        const project = await registry.addProjectMember(projectId, serviceId);
        return project ? json({ project }) : fail("no project with that id", 404);
      }

      const dropMember = /^\/api\/projects\/([^/]+)\/members\/([^/]+)$/.exec(pathname);
      if (method === "DELETE" && dropMember) {
        const project = await registry.removeProjectMember(decodeURIComponent(dropMember[1]), decodeURIComponent(dropMember[2]));
        return project ? json({ project }) : fail("no project with that id", 404);
      }

      const startProject = /^\/api\/projects\/([^/]+)\/start$/.exec(pathname);
      if (method === "POST" && startProject) {
        const project = (await registry.loadProjects()).find((p) => p.id === decodeURIComponent(startProject[1]));
        if (!project) return fail("no project with that id", 404);
        const { services, pinned } = await snapshot();
        const errors: { id: string; error: string }[] = [];
        const started: { id: string; pid: number }[] = [];
        await Promise.all(project.memberIds.map(async (id) => {
          const svc = services.find((s) => s.id === id);
          if (!svc || svc.status === "running" || svc.status === "starting") return;
          const spec = pinned.find((p) => p.id === id);
          if (!spec) { errors.push({ id, error: "not pinned" }); return; }
          try { crashes.reset(id); const pid = await control.start(spec); started.push({ id, pid }); }
          catch (e) { errors.push({ id, error: e instanceof Error ? e.message : String(e) }); }
        }));
        return json({ started, errors });
      }

      const stopProject = /^\/api\/projects\/([^/]+)\/stop$/.exec(pathname);
      if (method === "POST" && stopProject) {
        const project = (await registry.loadProjects()).find((p) => p.id === decodeURIComponent(stopProject[1]));
        if (!project) return fail("no project with that id", 404);
        const { services } = await snapshot();
        const errors: { id: string; error: string }[] = [];
        const stopped: string[] = [];
        await Promise.all(project.memberIds.map(async (id) => {
          const svc = services.find((s) => s.id === id);
          if (!svc || (svc.status !== "running" && svc.status !== "starting") || !svc.rootPid || !svc.pids) return;
          try {
            crashes.disarm(id);
            await killTree(svc.pids, 3000, [process.pid], control.trackedOf(id)?.pid);
            stopped.push(id);
          } catch (e) { errors.push({ id, error: e instanceof Error ? e.message : String(e) }); }
        }));
        return json({ stopped, errors });
      }

      if (method === "GET" && pathname === "/api/worktrees") {
        const dir = url.searchParams.get("dir") ?? "";
        if (!dir.trim()) return fail("dir required");
        const { services } = await snapshot();
        return json(await scanWorktrees(dir, services));
      }

      if (method === "POST" && pathname === "/api/worktrees/prune") {
        const { dir } = await readBody(req);
        if (typeof dir !== "string" || !dir.trim()) return fail("dir required");
        return json(await pruneStaleWorktrees(dir));
      }

      if (method === "POST" && pathname === "/api/worktrees/create") {
        const { repo, branch, path } = await readBody(req);
        if (typeof repo !== "string" || !repo.trim()) return fail("repo required");
        if (typeof branch !== "string" || !branch.trim()) return fail("branch required");
        return json(await createWorktree(repo, branch, typeof path === "string" ? path : undefined), 201);
      }

      if (method === "POST" && pathname === "/api/worktrees/retire") {
        const { path, force } = await readBody(req);
        if (typeof path !== "string" || !path.trim()) return fail("path required");
        const busy = await refuseBusyWorktree(path);
        if (busy) return busy;
        return json(await retireWorktree(path, force === true));
      }

      if (method === "POST" && pathname === "/api/worktrees/launch") {
        const { path } = await readBody(req);
        if (typeof path !== "string" || !path.trim()) return fail("path required");
        const folder = await resolved(expandHome(path.trim()));
        const info = await stat(folder).catch(() => undefined);
        if (!info?.isDirectory()) return fail(`folder does not exist: ${folder}`);
        await importFromDir(folder);
        const { services, pinned } = await snapshot();
        let repo = folder;
        try { repo = await resolved(await mainRepoOf(folder)); } catch { /* not a git checkout; start pins already in the folder */ }
        const pins = await Promise.all(pinned.map(async (p) => ({ ...p, cwd: await resolved(p.cwd) })));
        const plan = planWorktreeLaunch(folder, repo, pins, services.flatMap((s) => s.ports));
        const errors: { id: string; error: string }[] = [];
        const started: { id: string; pid: number }[] = [];
        const created: Pinned[] = [];
        for (const input of plan.create) {
          const dest = await stat(input.cwd).catch(() => undefined);
          if (!dest?.isDirectory()) {
            errors.push({ id: input.name, error: `folder does not exist: ${input.cwd}` });
            continue;
          }
          const pin = await registry.add(input);
          created.push(pin);
          plan.startIds.push(pin.id);
        }
        const pinnedNow = created.length ? await registry.load() : pinned;
        await Promise.all(plan.startIds.map(async (id) => {
          const svc = services.find((s) => s.id === id);
          if (svc?.status === "running" || svc?.status === "starting") return;
          const spec = pinnedNow.find((p) => p.id === id);
          if (!spec) { errors.push({ id, error: "not pinned" }); return; }
          try { crashes.reset(id); const pid = await control.start(spec); started.push({ id, pid }); }
          catch (e) { errors.push({ id, error: e instanceof Error ? e.message : String(e) }); }
        }));
        const used = [...services.flatMap((s) => s.ports), ...created.map((p) => p.port)];
        return json({ started, created, errors, port: firstFreePort(used) });
      }

      if (method === "POST" && pathname === "/api/worktrees/remove") {
        const { path } = await readBody(req);
        if (typeof path !== "string" || !path.trim()) return fail("path required");
        const busy = await refuseBusyWorktree(path);
        if (busy) return busy;
        return json(await removeOrphanedWorktree(path));
      }

      if (method === "POST" && pathname === "/api/open") {
        const { path, line, col, cwd } = await readBody(req);
        if (typeof path !== "string" || !path.trim()) return fail("path required");
        // A log line prints a path relative to the process that printed it.
        const target = resolveOpenPath(path, typeof cwd === "string" ? cwd : undefined);
        if (!existsSync(target)) return fail(`path does not exist: ${target}`);
        const at = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
        return json(await openInEditor(target, at(line), at(col)));
      }

      if (method === "GET" && pathname === "/api/attention") {
        const dir = url.searchParams.get("dir") ?? "";
        const { services } = await snapshot();
        let worktrees: WorktreeInfo[] = [];
        if (dir.trim()) {
          try { worktrees = (await scanWorktrees(dir, services, { disk: false })).worktrees; } catch { worktrees = []; }
        }
        const lastErrors = new Map<string, string[]>();
        await Promise.all(services.filter((s) => s.hasLog && s.id && s.status === "stopped").map(async (s) => {
          try { lastErrors.set(s.id!, (await control.tailLog(s.id!, 40)).lines); } catch {}
        }));
        return json({ alerts: collectAlerts(services, worktrees, await control.logDirSize(), lastErrors), worktreesDir: dir });
      }

      if (method === "POST" && pathname === "/api/presets") {
        const body = await readBody(req);
        if (typeof body.name !== "string" || !body.name.trim()) return fail("name required");
        const serviceIds = Array.isArray(body.serviceIds) ? body.serviceIds.filter((id): id is string => typeof id === "string") : [];
        const urls = Array.isArray(body.urls) ? body.urls.filter((u): u is string => typeof u === "string") : typeof body.urls === "string" ? body.urls.split("\n").map((u) => u.trim()).filter(Boolean) : [];
        return json({
          preset: await registry.addPreset({
            name: body.name,
            projectId: typeof body.projectId === "string" ? body.projectId : undefined,
            serviceIds,
            urls,
            worktree: typeof body.worktree === "string" ? body.worktree : undefined,
            openEditor: body.openEditor === true,
          }),
        }, 201);
      }

      const delPreset = /^\/api\/presets\/([^/]+)$/.exec(pathname);
      if (method === "PUT" && delPreset) {
        const body = await readBody(req);
        if (typeof body.name !== "string" || !body.name.trim()) return fail("name required");
        const serviceIds = Array.isArray(body.serviceIds) ? body.serviceIds.filter((id): id is string => typeof id === "string") : [];
        const urls = Array.isArray(body.urls) ? body.urls.filter((u): u is string => typeof u === "string") : typeof body.urls === "string" ? body.urls.split("\n").map((u) => u.trim()).filter(Boolean) : [];
        try {
          const preset = await registry.replacePreset(decodeURIComponent(delPreset[1]), {
            name: body.name,
            projectId: typeof body.projectId === "string" ? body.projectId : undefined,
            serviceIds,
            urls,
            worktree: typeof body.worktree === "string" ? body.worktree : undefined,
            openEditor: body.openEditor === true,
          });
          return preset ? json({ preset }) : fail("no preset with that id", 404);
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      }
      if (method === "DELETE" && delPreset) {
        const removed = await registry.deletePreset(decodeURIComponent(delPreset[1]));
        return removed ? json({ ok: true }) : fail("no preset with that id", 404);
      }

      const runPreset = /^\/api\/presets\/([^/]+)\/resume$/.exec(pathname);
      if (method === "POST" && runPreset) {
        const preset = (await registry.loadPresets()).find((p) => p.id === decodeURIComponent(runPreset[1]));
        if (!preset) return fail("no preset with that id", 404);
        const { services, pinned } = await snapshot();
        const errors: { id: string; error: string }[] = [];
        const started: { id: string; pid: number }[] = [];
        await Promise.all(preset.serviceIds.map(async (id) => {
          const svc = services.find((s) => s.id === id);
          if (svc?.status === "running" || svc?.status === "starting") return;
          const spec = pinned.find((p) => p.id === id);
          if (!spec) { errors.push({ id, error: "not pinned" }); return; }
          try { crashes.reset(id); const pid = await control.start(spec); started.push({ id, pid }); }
          catch (e) { errors.push({ id, error: e instanceof Error ? e.message : String(e) }); }
        }));
        if (preset.openEditor && preset.worktree) {
          try { await openInEditor(preset.worktree); } catch (e) { errors.push({ id: "editor", error: e instanceof Error ? e.message : String(e) }); }
        }
        return json({ started, errors, urls: preset.urls });
      }

      if (method === "GET" && pathname === "/api/suggest") {
        const dir = url.searchParams.get("dir") ?? "";
        if (!dir.trim()) return fail("dir required");
        return json({ suggestions: await suggestCommands(expandHome(dir.trim())) });
      }

      if (method === "GET" && pathname === "/api/import") {
        const dir = url.searchParams.get("dir") ?? "";
        if (!dir.trim()) return fail("dir required");
        const folder = expandHome(dir.trim());
        const info = await stat(folder).catch(() => undefined);
        if (!info?.isDirectory()) return fail(`folder does not exist: ${folder}`);
        const text = await readTemplateFile(folder);
        if (text === undefined) return json({ exists: false, entries: [], importable: 0 });
        const entries = parsePinTemplate(text);
        const importable = planImport(folder, entries, await registry.load()).length;
        return json({ exists: true, entries, importable });
      }
      if (method === "POST" && pathname === "/api/import") {
        const { dir } = await readBody(req);
        if (typeof dir !== "string" || !dir.trim()) return fail("dir required");
        const folder = expandHome(dir.trim());
        const info = await stat(folder).catch(() => undefined);
        if (!info?.isDirectory()) return fail(`folder does not exist: ${folder}`);
        const result = await importFromDir(folder);
        return json({ created: result.created, skipped: result.skipped, exists: result.exists });
      }

      if (method === "GET" && pathname === "/api/env") {
        const pid = Number(url.searchParams.get("pid"));
        if (!Number.isInteger(pid) || pid <= 1) return fail("pid required");
        await control.hydrate();
        const running = await deps.discover();
        const known = running.some((s) => s.rootPid === pid || s.pids.includes(pid))
          || control.listTracked().some((t) => t.pid === pid && t.exitedAt == null);
        if (!known) return fail("no service with that pid", 404);
        const env = await (deps.readProcessEnv ?? readLiveEnv)(pid);
        return json({ env: url.searchParams.get("reveal") === "1" ? env : maskEnv(env) });
      }

      if (method === "POST" && pathname === "/api/ports/next") {
        const { services } = await snapshot();
        const used = services.flatMap((s) => s.ports);
        return json({ port: firstFreePort(used) });
      }

      if (method === "GET" && pathname === "/api/trace") {
        const token = (url.searchParams.get("token") ?? "").trim();
        if (!token) return fail("token required");
        if (token.length > 200) return fail("token too long");
        const ids = (url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!ids.length) return fail("ids required");
        const groups = [];
        for (const id of ids.slice(0, 50)) {
          if (!isValidLogId(id) || !control.hasLog(id)) continue;
          const { lines } = await control.tailLog(id, 5000);
          const hits: LogEntry[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (!lines[i].includes(token)) continue;
            hits.push(parseLine(lines[i], i));
          }
          if (hits.length) groups.push({ id, hits });
        }
        return json({ token, groups });
      }

      const logs = /^\/api\/logs\/([^/]+)$/.exec(pathname);
      if (method === "GET" && logs) {
        const id = decodeURIComponent(logs[1]);
        if (!isValidLogId(id)) return fail("invalid log id", 400);
        if (!control.hasLog(id)) return fail("no log for that id", 404);
        const fromRaw = url.searchParams.get("from");
        if (fromRaw != null) {
          const from = Number(fromRaw);
          if (!Number.isFinite(from) || from < 0) return fail("from must be a byte offset");
          return json(withEntries(await control.tailLog(id, 200, from)));
        }
        const requested = Number(url.searchParams.get("lines") ?? 200);
        const lines = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 5000) : 200;
        return json(withEntries(await control.tailLog(id, lines)));
      }
      if (method === "DELETE" && logs) {
        const id = decodeURIComponent(logs[1]);
        if (!isValidLogId(id)) return fail("invalid log id", 400);
        if (!control.hasLog(id)) return fail("no log for that id", 404);
        return json(await control.clearLog(id));
      }

      return fail("not found", 404);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), 500);
    }
  }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4242);
  const registry = new Registry();
  const control = new Control();
  const crashes = new CrashWatch(control);
  const fetch = createHandler({ discover: () => realDiscover(), registry, control, crashes, cacheMs: 3000 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch,
  });
  setInterval(async () => {
    try {
      const { services, pinned } = await fetch.refreshSnapshot();
      const logIds = services.filter((s) => s.id && s.hasLog && (s.status === "running" || s.status === "starting")).map((s) => s.id!);
      await control.rotateRunning(logIds);
      const restarted = await crashes.tick(services, pinned);
      if (restarted.length) console.log(`${new Date().toISOString()} crash-restart ${restarted.join(",")}`);
    } catch {}
  }, 3000);
  console.log(`devboard → http://127.0.0.1:${server.port}`);
  if (process.env.DEVBOARD_TRAY !== "0") {
    const app = join(homedir(), "Applications", "Devboard.app");
    if (existsSync(app)) {
      Bun.spawn(["open", "-g", "-a", app], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
    }
  }
}
