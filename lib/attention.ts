import type { Alert, Service, WorktreeInfo } from "./types";

const ERROR_LINE = /\b(error|fatal|panic|exception|econnrefused|enotfound|failed)\b/i;

export function collectAlerts(
  services: Service[],
  worktrees: WorktreeInfo[],
  logBytes: number,
  lastErrors: Map<string, string[]>,
): Alert[] {
  const alerts: Alert[] = [];

  const byPort = new Map<number, Service[]>();
  for (const s of services) {
    if (s.kind !== "dev" || s.hidden) continue;
    for (const port of s.ports) {
      const list = byPort.get(port) ?? [];
      list.push(s);
      byPort.set(port, list);
    }
  }
  for (const [port, list] of byPort) {
    const cwds = new Set(list.map((s) => s.cwd).filter(Boolean));
    if (list.length < 2 || cwds.size < 2) continue;
    const names = list.map((s) => s.name).join(", ");
    alerts.push({
      id: `port-${port}`,
      kind: "port-conflict",
      title: `Port ${port} is occupied by another checkout`,
      detail: `${names} are using :${port} from different folders.`,
      serviceId: list.find((s) => s.status === "running")?.id,
    });
  }

  for (const s of services) {
    if (s.kind !== "dev" || s.status !== "stopped" || !s.hasLog || !s.id) continue;
    const lines = lastErrors.get(s.id) ?? [];
    if (!lines.some((l) => ERROR_LINE.test(l))) continue;
    const excerpt = lines.filter((l) => ERROR_LINE.test(l)).slice(-3).join(" · ");
    alerts.push({
      id: `exit-${s.id}`,
      kind: "exited",
      title: `${s.name} exited`,
      detail: excerpt || "The last log lines look like a crash.",
      serviceId: s.id,
    });
  }

  for (const wt of worktrees) {
    if (!wt.dirty || wt.main) continue;
    alerts.push({
      id: `dirty-${wt.path}`,
      kind: "dirty-worktree",
      title: "This worktree has uncommitted changes",
      detail: `${wt.branch ?? "detached"} · ${wt.path}`,
      path: wt.path,
    });
  }

  if (logBytes >= 500 * 1024 * 1024) {
    alerts.push({
      id: "logs-size",
      kind: "log-size",
      title: `Your devboard logs occupy ${(logBytes / 1024 / 1024 / 1024).toFixed(1)} GB`,
      detail: "Deleting a log file is safe. The next start recreates it.",
    });
  }

  return alerts;
}
