import { describe, expect, test } from "bun:test";
import { logIdFor, matchPinned, mergeServices } from "../lib/merge";
import type { Pinned, RunningService } from "../lib/types";

const docs: RunningService = {
  rootPid: 64672, pids: [64672, 64728, 64734], ports: [3010],
  cwd: "/Users/dev/Projects/docs-site", command: "node /x/pnpm dev",
  name: "docs-site", kind: "dev", uptime: "23-01:48:35", cpu: 0.2, memMb: 149,
};
const backend: RunningService = { ...docs, rootPid: 51272, pids: [51272], ports: [8787], command: "node server/dist/main.js" };
const cc: RunningService = {
  rootPid: 683, pids: [683], ports: [5000, 7000], command: "/System/.../ControlCenter",
  name: "ControlCenter", kind: "system", uptime: "49-00:13:40", cpu: 0.5, memMb: 44,
};
const pinnedDocs: Pinned = { id: "docs-3010", name: "Docs", cwd: docs.cwd!, command: docs.command, port: 3010 };
const pinnedApi: Pinned = { id: "core-api-3003", name: "core-api", cwd: "/Users/dev/Projects/app/apps/api", command: "bun run --watch src/index.ts", port: 3003 };

describe("matchPinned", () => {
  test("matches on cwd plus port, so two servers in one folder stay distinct", () => {
    expect(matchPinned(docs, [pinnedDocs, pinnedApi])).toBe(pinnedDocs);
    expect(matchPinned(backend, [pinnedDocs, pinnedApi])).toBeUndefined();
  });
});

describe("logIdFor", () => {
  test("derives the same id a pin would get", () => {
    expect(logIdFor(docs)).toBe("docs-site-3010");
  });
});

describe("mergeServices", () => {
  const out = mergeServices([docs, backend, cc], [pinnedDocs, pinnedApi], (id) => id === "core-api-3003");

  test("running services keep their data and get the pinned name and id when matched", () => {
    const row = out.find((s) => s.rootPid === 64672)!;
    expect(row).toMatchObject({ id: "docs-3010", name: "Docs", status: "running", pinned: true, hasLog: false, kind: "dev", ports: [3010] });
  });

  test("unmatched running services get a derived id and pinned false", () => {
    const row = out.find((s) => s.rootPid === 51272)!;
    expect(row).toMatchObject({ id: "docs-site-8787", pinned: false, status: "running" });
  });

  test("pinned services with no running match appear as stopped, with hasLog from the callback", () => {
    const row = out.find((s) => s.id === "core-api-3003")!;
    expect(row).toEqual({
      id: "core-api-3003", name: "core-api", kind: "dev", status: "stopped", ports: [3003],
      cwd: pinnedApi.cwd, command: pinnedApi.command, pinned: true, hasLog: true, hidden: false,
      readiness: "stopped",
    });
  });

  test("ignored ids are flagged hidden, running or stopped", () => {
    const rows = mergeServices([docs, cc], [pinnedApi], () => false, new Set(["docs-site-3010", "core-api-3003"]));
    expect(rows.find((s) => s.rootPid === 64672)!.hidden).toBe(true);
    expect(rows.find((s) => s.id === "core-api-3003")!.hidden).toBe(true);
    expect(rows.find((s) => s.rootPid === 683)!.hidden).toBe(false);
  });

  test("system services pass through", () => {
    expect(out.find((s) => s.rootPid === 683)).toMatchObject({ kind: "system", status: "running", pinned: false });
  });

  test("row count is running plus unmatched pinned", () => {
    expect(out).toHaveLength(4);
  });

  test("pinned env and restartOnCrash copy onto the row", () => {
    const pinned: Pinned = { ...pinnedApi, env: { FOO: "1" }, restartOnCrash: true };
    const row = mergeServices([], [pinned], () => false)[0];
    expect(row).toMatchObject({ env: { FOO: "1" }, restartOnCrash: true });
  });
});
