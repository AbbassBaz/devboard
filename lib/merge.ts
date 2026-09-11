import { pinnedId } from "./registry";
import type { Pinned, RunningService, Service } from "./types";

export function matchPinned(running: RunningService, pinned: Pinned[]): Pinned | undefined {
  if (!running.cwd) return undefined;
  return pinned.find((p) => p.cwd === running.cwd && running.ports.includes(p.port));
}

export function logIdFor(running: RunningService): string {
  return pinnedId(running.name, running.ports[0]);
}

export function mergeServices(
  running: RunningService[],
  pinned: Pinned[],
  hasLog: (id: string) => boolean,
  ignored: ReadonlySet<string> = new Set(),
): Service[] {
  const matched = new Set<string>();
  const rows: Service[] = running.map((r) => {
    const p = matchPinned(r, pinned);
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
  for (const p of pinned) {
    if (matched.has(p.id)) continue;
    rows.push({
      id: p.id,
      name: p.name,
      kind: "dev",
      status: "stopped",
      ports: [p.port],
      cwd: p.cwd,
      command: p.command,
      pinned: true,
      hasLog: hasLog(p.id),
      hidden: ignored.has(p.id),
      readiness: "stopped",
      ...(p.healthUrl ? { healthUrl: p.healthUrl } : {}),
      ...(p.env && Object.keys(p.env).length ? { env: p.env } : {}),
      ...(p.restartOnCrash ? { restartOnCrash: true } : {}),
    });
  }
  return rows;
}
