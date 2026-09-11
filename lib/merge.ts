import { pinnedId } from "./registry";
import { commandWithoutPort } from "./suggest";
import type { Pinned, RunningService, Service, Tracked } from "./types";

export function matchPinned(running: RunningService, pinned: Pinned[], peers: RunningService[] = []): Pinned | undefined {
  if (!running.cwd) return undefined;
  const exact = pinned.find((p) => p.cwd === running.cwd && running.ports.includes(p.port));
  if (exact) return exact;
  if (running.kind !== "dev") return undefined;
  const stripped = commandWithoutPort(running.command);
  const pinHits = pinned.filter((p) => p.cwd === running.cwd && commandWithoutPort(p.command) === stripped);
  if (pinHits.length !== 1) return undefined;
  const others = peers.length ? peers : [running];
  const peerHits = others.filter((r) => r.kind === "dev" && r.cwd === running.cwd && commandWithoutPort(r.command) === stripped);
  if (peerHits.length !== 1) return undefined;
  return pinHits[0];
}

export function logIdFor(running: RunningService): string {
  return pinnedId(running.name, running.ports[0]);
}

export function mergeServices(
  running: RunningService[],
  pinned: Pinned[],
  hasLog: (id: string) => boolean,
  ignored: ReadonlySet<string> = new Set(),
  tracked: Tracked[] = [],
): Service[] {
  const matched = new Set<string>();
  const rows: Service[] = running.map((r) => {
    const p = matchPinned(r, pinned, running);
    if (p) matched.add(p.id);
    const id = p?.id ?? logIdFor(r);
    return {
      id,
      name: p?.name ?? r.name,
      kind: r.kind,
      status: "running",
      rootPid: r.rootPid,
      pids: r.pids,
      ports: r.ports,
      cwd: r.cwd,
      command: r.command,
      uptime: r.uptime,
      cpu: r.cpu,
      memMb: r.memMb,
      pinned: !!p,
      hasLog: hasLog(id),
      hidden: ignored.has(id),
      readiness: "ready",
      ...(p?.healthUrl ? { healthUrl: p.healthUrl } : {}),
      ...(p?.env && Object.keys(p.env).length ? { env: p.env } : {}),
      ...(p?.restartOnCrash ? { restartOnCrash: true } : {}),
    };
  });
  const byId = new Map(tracked.map((t) => [t.id, t]));
  for (const p of pinned) {
    if (matched.has(p.id)) continue;
    const t = byId.get(p.id);
    const starting = t != null && t.exitedAt == null;
    rows.push({
      id: p.id,
      name: p.name,
      kind: "dev",
      status: starting ? "starting" : "stopped",
      ...(starting && t ? { rootPid: t.pid, pids: [t.pid] } : {}),
      ports: [p.port],
      cwd: p.cwd,
      command: p.command,
      pinned: true,
      hasLog: hasLog(p.id),
      hidden: ignored.has(p.id),
      readiness: starting ? "starting" : "stopped",
      ...(p.healthUrl ? { healthUrl: p.healthUrl } : {}),
      ...(p.env && Object.keys(p.env).length ? { env: p.env } : {}),
      ...(p.restartOnCrash ? { restartOnCrash: true } : {}),
      ...(!starting && t?.exitCode != null ? { exitCode: t.exitCode } : {}),
    });
  }
  return rows;
}
