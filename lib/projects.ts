import type { Project, ProjectLink, ProjectView, Service } from "./types";

export function parseLinks(text: string): ProjectLink[] {
  const out: ProjectLink[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sp = line.search(/\s+/);
    const label = (sp < 0 ? line : line.slice(0, sp)).trim();
    const url = (sp < 0 ? line : line.slice(sp).trim()).trim();
    if (!label || !url) continue;
    const key = `${label}\0${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, url });
  }
  return out;
}

export function formatLinks(links: ProjectLink[]): string {
  return links.map((l) => (l.label === l.url ? l.url : `${l.label} ${l.url}`)).join("\n");
}

/** cwd is the folder or a descendant. Both sides should already have ~ expanded. */
export function underFolder(cwd: string | undefined, folder: string): boolean {
  if (!cwd || !folder) return false;
  const a = cwd.replace(/\/+$/, "");
  const b = folder.replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`);
}

export function servicesInFolder(services: Service[], folder: string): Service[] {
  return services.filter((s) => s.kind === "dev" && underFolder(s.cwd, folder));
}

/** Path of `cwd` relative to `folder`, or undefined if it is not underneath. "" means cwd is the folder. */
export function relUnder(cwd: string, folder: string): string | undefined {
  if (!underFolder(cwd, folder)) return undefined;
  const a = cwd.replace(/\/+$/, "");
  const b = folder.replace(/\/+$/, "");
  return a === b ? "" : a.slice(b.length + 1);
}

export function mapUnder(cwd: string, from: string, to: string): string | undefined {
  const rel = relUnder(cwd, from);
  if (rel === undefined) return undefined;
  const root = to.replace(/\/+$/, "");
  return rel ? `${root}/${rel}` : root;
}

/** A service belongs to at most one project. Adding it here drops it from every other. */
export function assignMember(projects: Project[], projectId: string, serviceId: string): Project[] {
  return projects.map((p) => {
    const members = p.memberIds.filter((id) => id !== serviceId);
    if (p.id === projectId && !members.includes(serviceId)) members.push(serviceId);
    return { ...p, memberIds: members };
  });
}

export function removeMember(projects: Project[], serviceId: string): Project[] {
  return projects.map((p) => ({ ...p, memberIds: p.memberIds.filter((id) => id !== serviceId) }));
}

export function renameMember(projects: Project[], oldId: string, newId: string): Project[] {
  if (oldId === newId) return projects;
  const owner = projects.find((p) => p.memberIds.includes(oldId))?.id;
  const next = removeMember(projects, oldId);
  if (!owner || !newId) return next;
  return assignMember(next, owner, newId);
}

export function pruneProjectMembers(projects: Project[], knownIds: ReadonlySet<string>): Project[] {
  return projects.map((p) => ({ ...p, memberIds: p.memberIds.filter((id) => knownIds.has(id)) }));
}

export function projectViews(projects: Project[], services: Service[]): ProjectView[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  return projects.map((p) => {
    const members = p.memberIds.map((id) => byId.get(id)).filter((s): s is Service => !!s);
    const running = members.filter((s) => s.status === "running");
    const ports = [...new Set(members.flatMap((s) => s.ports))].sort((a, b) => a - b);
    return {
      ...p,
      on: running.length,
      off: members.length - running.length,
      cpu: Math.round(running.reduce((sum, s) => sum + (s.cpu ?? 0), 0) * 10) / 10,
      memMb: running.reduce((sum, s) => sum + (s.memMb ?? 0), 0),
      ports,
    };
  });
}

export function groupedIds(projects: Project[]): Set<string> {
  return new Set(projects.flatMap((p) => p.memberIds));
}
