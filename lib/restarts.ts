import { classifyLine } from "./logs";
import type { Control } from "./control";
import type { Pinned, Service } from "./types";

export const CRASH_MAX_TRIES = 5;

export function looksCrashed(lines: string[]): boolean {
  let lastStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("=====") && / start /.test(lines[i])) lastStart = i;
  }
  const slice = lastStart >= 0 ? lines.slice(lastStart + 1) : lines;
  return slice.some((l) => classifyLine(l) === "error");
}

export class CrashWatch {
  private armed = new Map<string, { tries: number; nextAt: number }>();

  constructor(private readonly control: Control) {}

  arm(id: string): void {
    if (!this.armed.has(id)) this.armed.set(id, { tries: 0, nextAt: 0 });
  }

  disarm(id: string): void {
    this.armed.delete(id);
  }

  async tick(services: Service[], pinned: Pinned[], now = Date.now()): Promise<string[]> {
    const restarted: string[] = [];
    for (const p of pinned) {
      if (!p.restartOnCrash) {
        this.armed.delete(p.id);
        continue;
      }
      const svc = services.find((s) => s.id === p.id);
      if (svc?.status === "running") {
        const st = this.armed.get(p.id);
        if (st) st.tries = 0;
        this.arm(p.id);
        continue;
      }
      const st = this.armed.get(p.id);
      if (!st || !this.control.hasLog(p.id) || now < st.nextAt || st.tries >= CRASH_MAX_TRIES) continue;
      const { lines } = await this.control.tailLog(p.id, 60);
      if (!looksCrashed(lines)) {
        this.disarm(p.id);
        continue;
      }
      try {
        await this.control.start(p);
        st.tries += 1;
        st.nextAt = now + Math.min(30_000, 1000 * 2 ** (st.tries - 1));
        restarted.push(p.id);
      } catch {
        st.tries += 1;
        st.nextAt = now + 5000;
      }
    }
    return restarted;
  }
}
