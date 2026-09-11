import { describe, expect, test } from "bun:test";
import {
  assignMember,
  mapUnder,
  parseLinks,
  projectViews,
  pruneProjectMembers,
  removeMember,
  renameMember,
  servicesInFolder,
  underFolder,
} from "../lib/projects";
import type { Project, Service } from "../lib/types";

const api: Service = {
  id: "core-api-3003", name: "core-api", kind: "dev", status: "running",
  ports: [3003], cwd: "/Users/dev/Projects/app/apps/api", pinned: true, hasLog: false, hidden: false,
  cpu: 0.4, memMb: 90,
};
const proxy: Service = {
  id: "core-proxy-3000", name: "core-proxy", kind: "dev", status: "stopped",
  ports: [3000], cwd: "/Users/dev/Projects/app/apps/proxy", pinned: true, hasLog: true, hidden: false,
};
const docs: Service = {
  id: "docs-3010", name: "docs", kind: "dev", status: "running",
  ports: [3010], cwd: "/Users/dev/Projects/docs-site", pinned: true, hasLog: false, hidden: false,
  cpu: 0.2, memMb: 40,
};

describe("underFolder", () => {
  test("matches the folder and its descendants, not a sibling prefix", () => {
    expect(underFolder("/Users/dev/Projects/app/apps/api", "/Users/dev/Projects/app")).toBe(true);
    expect(underFolder("/Users/dev/Projects/app", "/Users/dev/Projects/app")).toBe(true);
    expect(underFolder("/Users/dev/Projects/app-old/web", "/Users/dev/Projects/app")).toBe(false);
    expect(underFolder(undefined, "/Users/dev/Projects/app")).toBe(false);
  });
});

describe("mapUnder", () => {
  test("rewrites a cwd from the main checkout into a sibling worktree", () => {
    expect(mapUnder("/Users/dev/Projects/app/apps/api", "/Users/dev/Projects/app", "/Users/dev/Projects/app-feat")).toBe("/Users/dev/Projects/app-feat/apps/api");
    expect(mapUnder("/Users/dev/Projects/app", "/Users/dev/Projects/app", "/Users/dev/Projects/app-feat")).toBe("/Users/dev/Projects/app-feat");
    expect(mapUnder("/Users/dev/Projects/other", "/Users/dev/Projects/app", "/Users/dev/Projects/app-feat")).toBeUndefined();
  });
});

describe("servicesInFolder", () => {
  test("keeps only dev services under the folder", () => {
    const ids = servicesInFolder([api, proxy, docs], "/Users/dev/Projects/app").map((s) => s.id);
    expect(ids).toEqual(["core-api-3003", "core-proxy-3000"]);
  });
});

describe("membership", () => {
  const hub: Project = { id: "hub", name: "Hub", memberIds: ["core-api-3003"], links: [] };
  const other: Project = { id: "other", name: "Other", memberIds: ["docs-3010"], links: [] };

  test("assigning a member moves it out of every other project", () => {
    const next = assignMember([hub, other], "hub", "docs-3010");
    expect(next.find((p) => p.id === "hub")!.memberIds).toEqual(["core-api-3003", "docs-3010"]);
    expect(next.find((p) => p.id === "other")!.memberIds).toEqual([]);
  });

  test("rename keeps the service in the same project", () => {
    const next = renameMember([hub], "core-api-3003", "api-3003");
    expect(next[0].memberIds).toEqual(["api-3003"]);
  });

  test("remove and prune drop stale ids", () => {
    expect(removeMember([hub], "core-api-3003")[0].memberIds).toEqual([]);
    expect(pruneProjectMembers([hub], new Set(["nope"]))[0].memberIds).toEqual([]);
  });
});

describe("parseLinks", () => {
  test("reads label plus url, one per line", () => {
    expect(parseLinks("Docs https://docs.local\npostgres postgres://localhost/hub\n")).toEqual([
      { label: "Docs", url: "https://docs.local" },
      { label: "postgres", url: "postgres://localhost/hub" },
    ]);
  });
});

describe("projectViews", () => {
  test("sums running members and collects ports", () => {
    const view = projectViews(
      [{ id: "hub", name: "Hub", memberIds: ["core-api-3003", "core-proxy-3000", "gone"], links: [] }],
      [api, proxy, docs],
    )[0];
    expect(view).toMatchObject({ on: 1, off: 1, cpu: 0.4, memMb: 90, ports: [3000, 3003] });
  });
});
