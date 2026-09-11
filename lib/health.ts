import type { Pinned, Service } from "./types";

export async function probe(url: string, timeoutMs = 1500): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: ac.signal, redirect: "manual" });
    const ms = Date.now() - started;
    return { ok: res.status < 400, status: res.status, ms };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function healthUrlFor(s: Service, pinned: Pinned[]): string | undefined {
  if (s.healthUrl) return s.healthUrl;
  const p = pinned.find((x) => x.id === s.id);
  if (p?.healthUrl) return p.healthUrl;
  if (s.kind !== "dev" || s.status !== "running" || !s.ports[0]) return undefined;
  return `http://127.0.0.1:${s.ports[0]}/`;
}

export async function applyReadiness(services: Service[], pinned: Pinned[]): Promise<Service[]> {
  return Promise.all(
    services.map(async (s) => {
      if (s.kind !== "dev" || s.status !== "running") return { ...s, readiness: s.status === "stopped" ? "stopped" as const : s.readiness };
      const url = healthUrlFor(s, pinned);
      if (!url) return { ...s, readiness: "ready" as const };
      const health = await probe(url);
      return { ...s, healthUrl: url, health, readiness: health.ok ? "ready" as const : "unhealthy" as const };
    }),
  );
}

export function firstFreePort(used: number[], start = 3000): number {
  const taken = new Set(used);
  for (let p = start; p < 65535; p++) if (!taken.has(p)) return p;
  throw new Error("no free port");
}
