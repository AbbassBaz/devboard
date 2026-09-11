import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { assignMember, pruneProjectMembers, removeMember, renameMember } from "./projects";
import type { Pinned, Preset, Project, ProjectLink, RunningService, Tracked } from "./types";

export const DEVBOARD_HOME = process.env.DEVBOARD_HOME ?? join(homedir(), ".devboard");

export function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "service";
}

export function pinnedId(name: string, port: number): string {
  return `${slugify(name)}-${port}`;
}

export class Registry {
  constructor(private readonly home: string = DEVBOARD_HOME) {}

  get path(): string {
    return join(this.home, "services.json");
  }

  async load(): Promise<Pinned[]> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return [];
    return (await file.json()) as Pinned[];
  }

  async save(list: Pinned[]): Promise<void> {
    await mkdir(this.home, { recursive: true });
    const tmp = `${this.path}.tmp`;
    await Bun.write(tmp, JSON.stringify(list, null, 2) + "\n");
    await rename(tmp, this.path);
  }

  async add(input: Omit<Pinned, "id">): Promise<Pinned> {
    const pinned: Pinned = { id: pinnedId(input.name, input.port), ...input };
    const list = (await this.load()).filter((p) => p.id !== pinned.id);
    list.push(pinned);
    await this.save(list);
    return pinned;
  }

  /** Replace `oldId` with new values; the id may change when name or port change. Returns undefined if `oldId` is unknown. */
  async replace(oldId: string, input: Omit<Pinned, "id">): Promise<Pinned | undefined> {
    const list = await this.load();
    if (!list.some((p) => p.id === oldId)) return undefined;
    const pinned: Pinned = { id: pinnedId(input.name, input.port), ...input };
    const next = list.filter((p) => p.id !== oldId && p.id !== pinned.id);
    next.push(pinned);
    await this.save(next);
    if (oldId !== pinned.id) await this.retargetMember(oldId, pinned.id);
    return pinned;
  }

  async pin(running: RunningService, name?: string): Promise<Pinned> {
    if (!running.cwd) throw new Error("cannot pin a service whose working directory is unknown");
    return this.add({ name: name ?? running.name, cwd: running.cwd, command: running.command, port: running.ports[0] });
  }

  get ignoredPath(): string {
    return join(this.home, "ignored.json");
  }

  async loadIgnored(): Promise<Set<string>> {
    const file = Bun.file(this.ignoredPath);
    if (!(await file.exists())) return new Set();
    return new Set((await file.json()) as string[]);
  }

  async setIgnored(id: string, ignored: boolean): Promise<void> {
    const set = await this.loadIgnored();
    if (ignored) set.add(id);
    else set.delete(id);
    await mkdir(this.home, { recursive: true });
    const tmp = `${this.ignoredPath}.tmp`;
    await Bun.write(tmp, JSON.stringify([...set].sort(), null, 2) + "\n");
    await rename(tmp, this.ignoredPath);
  }

  async unpin(id: string): Promise<boolean> {
    const list = await this.load();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return false;
    await this.save(next);
    await this.saveProjects(removeMember(await this.loadProjects(), id));
    return true;
  }

  get projectsPath(): string {
    return join(this.home, "projects.json");
  }

  async loadProjects(): Promise<Project[]> {
    const file = Bun.file(this.projectsPath);
    if (!(await file.exists())) return [];
    const raw = (await file.json()) as Project[];
    return raw.map((p) => ({
      id: p.id,
      name: p.name,
      folder: p.folder || undefined,
      memberIds: [...new Set(p.memberIds ?? [])],
      links: Array.isArray(p.links) ? p.links : [],
    }));
  }

  async saveProjects(list: Project[]): Promise<void> {
    await mkdir(this.home, { recursive: true });
    const tmp = `${this.projectsPath}.tmp`;
    await Bun.write(tmp, JSON.stringify(list, null, 2) + "\n");
    await rename(tmp, this.projectsPath);
  }

  async addProject(input: { name: string; folder?: string; memberIds?: string[]; links?: ProjectLink[] }): Promise<Project> {
    const name = input.name.trim();
    if (!name) throw new Error("name required");
    const project: Project = {
      id: slugify(name),
      name,
      folder: input.folder || undefined,
      memberIds: [...new Set(input.memberIds ?? [])],
      links: input.links ?? [],
    };
    const list = (await this.loadProjects()).filter((p) => p.id !== project.id);
    list.push(project);
    await this.saveProjects(list);
    return project;
  }

  async replaceProject(id: string, input: { name: string; folder?: string; memberIds?: string[]; links?: ProjectLink[] }): Promise<Project | undefined> {
    const list = await this.loadProjects();
    const current = list.find((p) => p.id === id);
    if (!current) return undefined;
    const name = input.name.trim();
    if (!name) throw new Error("name required");
    const project: Project = {
      id: slugify(name),
      name,
      folder: input.folder || undefined,
      memberIds: [...new Set(input.memberIds ?? current.memberIds)],
      links: input.links ?? current.links,
    };
    const next = list.filter((p) => p.id !== id && p.id !== project.id);
    next.push(project);
    await this.saveProjects(next);
    return project;
  }

  async deleteProject(id: string): Promise<boolean> {
    const list = await this.loadProjects();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return false;
    await this.saveProjects(next);
    return true;
  }

  async addProjectMember(projectId: string, serviceId: string): Promise<Project | undefined> {
    const list = await this.loadProjects();
    if (!list.some((p) => p.id === projectId)) return undefined;
    const next = assignMember(list, projectId, serviceId);
    await this.saveProjects(next);
    return next.find((p) => p.id === projectId);
  }

  async removeProjectMember(projectId: string, serviceId: string): Promise<Project | undefined> {
    const list = await this.loadProjects();
    const current = list.find((p) => p.id === projectId);
    if (!current) return undefined;
    const next = list.map((p) => (p.id === projectId ? { ...p, memberIds: p.memberIds.filter((id) => id !== serviceId) } : p));
    await this.saveProjects(next);
    return next.find((p) => p.id === projectId);
  }

  async syncProjectMembers(knownIds: ReadonlySet<string>): Promise<Project[]> {
    const list = pruneProjectMembers(await this.loadProjects(), knownIds);
    await this.saveProjects(list);
    return list;
  }

  async retargetMember(oldId: string, newId: string): Promise<void> {
    if (oldId === newId) return;
    await this.saveProjects(renameMember(await this.loadProjects(), oldId, newId));
  }

  get presetsPath(): string {
    return join(this.home, "presets.json");
  }

  async loadPresets(): Promise<Preset[]> {
    const file = Bun.file(this.presetsPath);
    if (!(await file.exists())) return [];
    return (await file.json()) as Preset[];
  }

  async savePresets(list: Preset[]): Promise<void> {
    await mkdir(this.home, { recursive: true });
    const tmp = `${this.presetsPath}.tmp`;
    await Bun.write(tmp, JSON.stringify(list, null, 2) + "\n");
    await rename(tmp, this.presetsPath);
  }

  async addPreset(input: Omit<Preset, "id">): Promise<Preset> {
    const name = input.name.trim();
    if (!name) throw new Error("name required");
    const preset: Preset = { ...input, name, id: slugify(name), serviceIds: [...new Set(input.serviceIds)], urls: input.urls ?? [] };
    const list = (await this.loadPresets()).filter((p) => p.id !== preset.id);
    list.push(preset);
    await this.savePresets(list);
    return preset;
  }

  get statePath(): string {
    return join(this.home, "state.json");
  }

  async loadTracked(): Promise<Tracked[]> {
    const file = Bun.file(this.statePath);
    if (!(await file.exists())) return [];
    const raw = (await file.json()) as { tracked?: Tracked[] } | Tracked[];
    return Array.isArray(raw) ? raw : raw.tracked ?? [];
  }

  async saveTracked(list: Tracked[]): Promise<void> {
    await mkdir(this.home, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await Bun.write(tmp, JSON.stringify(list, null, 2) + "\n");
    await rename(tmp, this.statePath);
  }

  async deletePreset(id: string): Promise<boolean> {
    const list = await this.loadPresets();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return false;
    await this.savePresets(next);
    return true;
  }
}
