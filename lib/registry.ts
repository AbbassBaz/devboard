import { chmod, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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

function skip(path: string, field: string): void {
  console.log(`registry: ${basename(path)} skipped: ${field}`);
}

function asArray(raw: unknown, path: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw !== undefined) skip(path, "not an array");
  return [];
}

function isPinned(v: unknown): v is Pinned {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && o.id
    && typeof o.name === "string"
    && typeof o.cwd === "string"
    && typeof o.command === "string"
    && typeof o.port === "number" && Number.isInteger(o.port);
}

function pinnedField(v: unknown): string {
  if (!v || typeof v !== "object") return "entry";
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return "id";
  if (typeof o.name !== "string") return "name";
  if (typeof o.cwd !== "string") return "cwd";
  if (typeof o.command !== "string") return "command";
  return "port";
}

function isProject(v: unknown): v is Project {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && o.id && typeof o.name === "string" && Array.isArray(o.memberIds);
}

function projectField(v: unknown): string {
  if (!v || typeof v !== "object") return "entry";
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return "id";
  if (typeof o.name !== "string") return "name";
  return "memberIds";
}

function isPreset(v: unknown): v is Preset {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && o.id && typeof o.name === "string" && Array.isArray(o.serviceIds);
}

function presetField(v: unknown): string {
  if (!v || typeof v !== "object") return "entry";
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return "id";
  if (typeof o.name !== "string") return "name";
  return "serviceIds";
}

export class Registry {
  private tmpSeq = 0;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly home: string = DEVBOARD_HOME) {}

  private enqueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(path) ?? Promise.resolve();
    const current = prev.then(fn, fn);
    this.queues.set(path, current.then(() => undefined, () => undefined));
    return current;
  }

  private async readJson(path: string): Promise<unknown> {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    try {
      return await file.json();
    } catch {
      skip(path, "invalid JSON");
      return undefined;
    }
  }

  get path(): string {
    return join(this.home, "services.json");
  }

  async load(): Promise<Pinned[]> {
    const out: Pinned[] = [];
    for (const item of asArray(await this.readJson(this.path), this.path)) {
      if (isPinned(item)) out.push(item);
      else skip(this.path, pinnedField(item));
    }
    return out;
  }

  private async writeJson(path: string, data: unknown): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await chmod(this.home, 0o700);
    const tmp = `${path}.${process.pid}.${++this.tmpSeq}.tmp`;
    await Bun.write(tmp, JSON.stringify(data, null, 2) + "\n");
    await rename(tmp, path);
    await chmod(path, 0o600);
  }

  async save(list: Pinned[]): Promise<void> {
    await this.enqueue(this.path, () => this.writeJson(this.path, list));
  }

  async add(input: Omit<Pinned, "id">): Promise<Pinned> {
    return this.enqueue(this.path, async () => {
      const pinned: Pinned = { id: pinnedId(input.name, input.port), ...input };
      const list = (await this.load()).filter((p) => p.id !== pinned.id);
      list.push(pinned);
      await this.writeJson(this.path, list);
      return pinned;
    });
  }

  /** Replace `oldId` with new values; the id may change when name or port change. Returns undefined if `oldId` is unknown. */
  async replace(oldId: string, input: Omit<Pinned, "id">): Promise<Pinned | undefined> {
    const pinned = await this.enqueue(this.path, async () => {
      const list = await this.load();
      if (!list.some((p) => p.id === oldId)) return undefined;
      const nextPin: Pinned = { id: pinnedId(input.name, input.port), ...input };
      const next = list.filter((p) => p.id !== oldId && p.id !== nextPin.id);
      next.push(nextPin);
      await this.writeJson(this.path, next);
      return nextPin;
    });
    if (pinned && oldId !== pinned.id) await this.retargetMember(oldId, pinned.id);
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
    const out = new Set<string>();
    for (const item of asArray(await this.readJson(this.ignoredPath), this.ignoredPath)) {
      if (typeof item === "string") out.add(item);
      else skip(this.ignoredPath, "id");
    }
    return out;
  }

  async setIgnored(id: string, ignored: boolean): Promise<void> {
    await this.enqueue(this.ignoredPath, async () => {
      const set = await this.loadIgnored();
      if (ignored) set.add(id);
      else set.delete(id);
      await this.writeJson(this.ignoredPath, [...set].sort());
    });
  }

  async unpin(id: string): Promise<boolean> {
    const removed = await this.enqueue(this.path, async () => {
      const list = await this.load();
      const next = list.filter((p) => p.id !== id);
      if (next.length === list.length) return false;
      await this.writeJson(this.path, next);
      return true;
    });
    if (removed) await this.saveProjects(removeMember(await this.loadProjects(), id));
    return removed;
  }

  get projectsPath(): string {
    return join(this.home, "projects.json");
  }

  async loadProjects(): Promise<Project[]> {
    const out: Project[] = [];
    for (const item of asArray(await this.readJson(this.projectsPath), this.projectsPath)) {
      if (!isProject(item)) {
        skip(this.projectsPath, projectField(item));
        continue;
      }
      out.push({
        id: item.id,
        name: item.name,
        folder: item.folder || undefined,
        memberIds: [...new Set(item.memberIds.filter((id): id is string => typeof id === "string"))],
        links: Array.isArray(item.links) ? item.links : [],
      });
    }
    return out;
  }

  async saveProjects(list: Project[]): Promise<void> {
    await this.enqueue(this.projectsPath, () => this.writeJson(this.projectsPath, list));
  }

  async addProject(input: { name: string; folder?: string; memberIds?: string[]; links?: ProjectLink[] }): Promise<Project> {
    const name = input.name.trim();
    if (!name) throw new Error("name required");
    return this.enqueue(this.projectsPath, async () => {
      const project: Project = {
        id: slugify(name),
        name,
        folder: input.folder || undefined,
        memberIds: [...new Set(input.memberIds ?? [])],
        links: input.links ?? [],
      };
      const list = (await this.loadProjects()).filter((p) => p.id !== project.id);
      list.push(project);
      await this.writeJson(this.projectsPath, list);
      return project;
    });
  }

  async replaceProject(id: string, input: { name: string; folder?: string; memberIds?: string[]; links?: ProjectLink[] }): Promise<Project | undefined> {
    return this.enqueue(this.projectsPath, async () => {
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
      await this.writeJson(this.projectsPath, next);
      return project;
    });
  }

  async deleteProject(id: string): Promise<boolean> {
    return this.enqueue(this.projectsPath, async () => {
      const list = await this.loadProjects();
      const next = list.filter((p) => p.id !== id);
      if (next.length === list.length) return false;
      await this.writeJson(this.projectsPath, next);
      return true;
    });
  }

  async addProjectMember(projectId: string, serviceId: string): Promise<Project | undefined> {
    return this.enqueue(this.projectsPath, async () => {
      const list = await this.loadProjects();
      if (!list.some((p) => p.id === projectId)) return undefined;
      const next = assignMember(list, projectId, serviceId);
      await this.writeJson(this.projectsPath, next);
      return next.find((p) => p.id === projectId);
    });
  }

  async removeProjectMember(projectId: string, serviceId: string): Promise<Project | undefined> {
    return this.enqueue(this.projectsPath, async () => {
      const list = await this.loadProjects();
      const current = list.find((p) => p.id === projectId);
      if (!current) return undefined;
      const next = list.map((p) => (p.id === projectId ? { ...p, memberIds: p.memberIds.filter((mid) => mid !== serviceId) } : p));
      await this.writeJson(this.projectsPath, next);
      return next.find((p) => p.id === projectId);
    });
  }

  async syncProjectMembers(knownIds: ReadonlySet<string>): Promise<Project[]> {
    return this.enqueue(this.projectsPath, async () => {
      const list = pruneProjectMembers(await this.loadProjects(), knownIds);
      await this.writeJson(this.projectsPath, list);
      return list;
    });
  }

  async retargetMember(oldId: string, newId: string): Promise<void> {
    if (oldId === newId) return;
    await this.enqueue(this.projectsPath, async () => {
      await this.writeJson(this.projectsPath, renameMember(await this.loadProjects(), oldId, newId));
    });
  }

  get presetsPath(): string {
    return join(this.home, "presets.json");
  }

  async loadPresets(): Promise<Preset[]> {
    const out: Preset[] = [];
    for (const item of asArray(await this.readJson(this.presetsPath), this.presetsPath)) {
      if (!isPreset(item)) {
        skip(this.presetsPath, presetField(item));
        continue;
      }
      out.push({
        ...item,
        serviceIds: [...new Set(item.serviceIds.filter((id): id is string => typeof id === "string"))],
        urls: Array.isArray(item.urls) ? item.urls : [],
      });
    }
    return out;
  }

  async savePresets(list: Preset[]): Promise<void> {
    await this.enqueue(this.presetsPath, () => this.writeJson(this.presetsPath, list));
  }

  async addPreset(input: Omit<Preset, "id">): Promise<Preset> {
    const name = input.name.trim();
    if (!name) throw new Error("name required");
    return this.enqueue(this.presetsPath, async () => {
      const preset: Preset = { ...input, name, id: slugify(name), serviceIds: [...new Set(input.serviceIds)], urls: input.urls ?? [] };
      const list = (await this.loadPresets()).filter((p) => p.id !== preset.id);
      list.push(preset);
      await this.writeJson(this.presetsPath, list);
      return preset;
    });
  }

  get statePath(): string {
    return join(this.home, "state.json");
  }

  async loadTracked(): Promise<Tracked[]> {
    const raw = await this.readJson(this.statePath);
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { tracked?: unknown }).tracked)
      ? (raw as { tracked: unknown[] }).tracked
      : (raw === undefined ? [] : (skip(this.statePath, "not an array"), []));
    const out: Tracked[] = [];
    for (const item of list) {
      if (item && typeof item === "object" && typeof (item as Tracked).id === "string" && typeof (item as Tracked).pid === "number") {
        out.push(item as Tracked);
      } else skip(this.statePath, "id");
    }
    return out;
  }

  async saveTracked(list: Tracked[]): Promise<void> {
    await this.enqueue(this.statePath, () => this.writeJson(this.statePath, list));
  }

  async deletePreset(id: string): Promise<boolean> {
    return this.enqueue(this.presetsPath, async () => {
      const list = await this.loadPresets();
      const next = list.filter((p) => p.id !== id);
      if (next.length === list.length) return false;
      await this.writeJson(this.presetsPath, next);
      return true;
    });
  }
}
