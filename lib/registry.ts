import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Pinned, RunningService } from "./types";

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

  async pin(running: RunningService, name?: string): Promise<Pinned> {
    if (!running.cwd) throw new Error("cannot pin a service whose working directory is unknown");
    const finalName = name ?? running.name;
    const pinned: Pinned = {
      id: pinnedId(finalName, running.ports[0]),
      name: finalName,
      cwd: running.cwd,
      command: running.command,
      port: running.ports[0],
    };
    const list = (await this.load()).filter((p) => p.id !== pinned.id);
    list.push(pinned);
    await this.save(list);
    return pinned;
  }

  async unpin(id: string): Promise<boolean> {
    const list = await this.load();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return false;
    await this.save(next);
    return true;
  }
}
