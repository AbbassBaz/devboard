import { describe, expect, test } from "bun:test";
import { collectAlerts } from "../lib/attention";
import type { Service, WorktreeInfo } from "../lib/types";

const svc = (partial: Partial<Service> & Pick<Service, "id" | "name">): Service => ({
  kind: "dev", status: "running", ports: [], pinned: true, hasLog: false, hidden: false, readiness: "ready",
  ...partial,
});

const wt = (partial: Partial<WorktreeInfo> & Pick<WorktreeInfo, "path">): WorktreeInfo => ({
  repo: "/repo", dirty: false, diskMb: 1, serviceIds: [], ports: [], main: false, ...partial,
});

describe("collectAlerts", () => {
  test("flags the same port used from two folders", () => {
    const alerts = collectAlerts([
      svc({ id: "web-3000", name: "web", ports: [3000], cwd: "/repo/main" }),
      svc({ id: "web-wt-3000", name: "web-wt", ports: [3000], cwd: "/repo/feat" }),
    ], [], 0, new Map());
    expect(alerts).toEqual([expect.objectContaining({
      kind: "port-conflict",
      title: "Port 3000 is occupied by another checkout",
    })]);
  });

  test("ignores two listeners on the same port in the same folder", () => {
    expect(collectAlerts([
      svc({ id: "a", name: "a", ports: [3000], cwd: "/repo" }),
      svc({ id: "b", name: "b", ports: [3000], cwd: "/repo" }),
    ], [], 0, new Map())).toEqual([]);
  });

  test("surfaces an exited service whose log looks like a crash", () => {
    const alerts = collectAlerts([
      svc({ id: "api-1", name: "api", status: "stopped", hasLog: true, readiness: "stopped" }),
    ], [], 0, new Map([["api-1", ["listening", "Error: ECONNREFUSED 127.0.0.1:5432"]]]));
    expect(alerts[0]).toMatchObject({ kind: "exited", title: "api exited", serviceId: "api-1" });
    expect(alerts[0].detail).toContain("ECONNREFUSED");
  });

  test("lists dirty linked worktrees and a bloated log directory", () => {
    const alerts = collectAlerts([], [
      wt({ path: "/repo", main: true, dirty: true, branch: "main" }),
      wt({ path: "/repo-feat", dirty: true, branch: "feat" }),
    ], 600 * 1024 * 1024, new Map());
    expect(alerts.map((a) => a.kind)).toEqual(["dirty-worktree", "log-size"]);
    expect(alerts[0].detail).toContain("feat");
  });
});
