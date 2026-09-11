import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import type { Service } from "../lib/types";
import {
  createWorktree,
  parseGitdirFile,
  parseWorktreeList,
  pruneStaleWorktrees,
  removeOrphanedWorktree,
  retireWorktree,
  scanStaleWorktrees,
  scanWorktrees,
} from "../lib/worktrees";

const porcelain = `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-wt
HEAD def456
branch refs/heads/agent
prunable gitdir file points to non-existent location

worktree /repo-bare
bare
`;

describe("parseWorktreeList", () => {
  test("reads porcelain records and the prunable reason", () => {
    const list = parseWorktreeList(porcelain);
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({ path: "/repo", head: "abc123", branch: "refs/heads/main" });
    expect(list[1]).toMatchObject({
      path: "/repo-wt",
      branch: "refs/heads/agent",
      prunable: "gitdir file points to non-existent location",
    });
    expect(list[2].bare).toBe(true);
  });

  test("reads NUL-separated porcelain the same way", () => {
    const z = "worktree /a\0HEAD aaa\0branch refs/heads/main\0\0worktree /b\0detached\0prunable gone\0\0";
    const list = parseWorktreeList(z);
    expect(list).toEqual([
      { path: "/a", head: "aaa", branch: "refs/heads/main" },
      { path: "/b", detached: true, prunable: "gone" },
    ]);
  });
});

describe("parseGitdirFile", () => {
  test("reads the gitdir line", () => {
    expect(parseGitdirFile("gitdir: /repo/.git/worktrees/foo\n")).toBe("/repo/.git/worktrees/foo");
    expect(parseGitdirFile("# comment\n")).toBeUndefined();
  });
});

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  temps.length = 0;
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "devboard-wt-"));
  temps.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "user.name=devboard", "-c", "user.email=devboard@test", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
}

describe("scanStaleWorktrees", () => {
  test("finds a worktree whose checkout was deleted", async () => {
    const root = tmp();
    const repo = join(root, "app");
    const linked = join(root, "app-agent");
    await git(root, ["init", "-q", "app"]);
    await git(repo, ["commit", "--allow-empty", "-qm", "init"]);
    await git(repo, ["worktree", "add", "-q", "-b", "agent", linked]);
    rmSync(linked, { recursive: true, force: true });

    const { stale } = await scanStaleWorktrees(root);
    expect(stale).toHaveLength(1);
    expect(stale[0].path.endsWith("/app-agent")).toBe(true);
    expect(stale[0].repo.endsWith("/app")).toBe(true);
    expect(stale[0]).toMatchObject({
      branch: "agent",
      reason: "prunable",
    });
    expect(stale[0].detail).toContain("non-existent");
  });

  test("returns [] when every worktree is healthy", async () => {
    const root = tmp();
    const repo = join(root, "app");
    await git(root, ["init", "-q", "app"]);
    await git(repo, ["commit", "--allow-empty", "-qm", "init"]);
    expect((await scanStaleWorktrees(root)).stale).toEqual([]);
    expect((await scanStaleWorktrees(repo)).stale).toEqual([]);
  });

  test("finds an orphaned checkout whose gitdir is gone", async () => {
    const root = tmp();
    const orphan = join(root, "leftover");
    mkdirSync(orphan);
    writeFileSync(join(orphan, ".git"), "gitdir: /no/such/repo/.git/worktrees/leftover\n");

    const { stale } = await scanStaleWorktrees(root);
    expect(stale).toHaveLength(1);
    expect(stale[0].path.endsWith("/leftover")).toBe(true);
    expect(stale[0]).toMatchObject({
      reason: "orphaned",
      detail: "gitdir is missing",
    });
  });

  test("rejects a missing folder", async () => {
    await expect(scanStaleWorktrees(join(tmp(), "missing"))).rejects.toThrow("folder does not exist");
  });
});

describe("prune and remove", () => {
  test("prune drops the stale registration", async () => {
    const root = tmp();
    const repo = join(root, "app");
    const linked = join(root, "app-agent");
    await git(root, ["init", "-q", "app"]);
    await git(repo, ["commit", "--allow-empty", "-qm", "init"]);
    await git(repo, ["worktree", "add", "-q", "-b", "agent", linked]);
    rmSync(linked, { recursive: true, force: true });

    const result = await pruneStaleWorktrees(root);
    expect(result.pruned).toBe(1);
    expect((await scanStaleWorktrees(root)).stale).toEqual([]);
  });

  test("remove deletes an orphaned checkout and refuses a real repo", async () => {
    const root = tmp();
    const orphan = join(root, "leftover");
    mkdirSync(orphan);
    writeFileSync(join(orphan, ".git"), "gitdir: /no/such/repo/.git/worktrees/leftover\n");
    await git(root, ["init", "-q", "app"]);
    await git(join(root, "app"), ["commit", "--allow-empty", "-qm", "init"]);

    await expect(removeOrphanedWorktree(join(root, "app"))).rejects.toThrow("refusing to delete a git repository");
    expect((await removeOrphanedWorktree(orphan)).path).toBe(orphan);
    expect(await Bun.file(orphan).exists()).toBe(false);
  });
});

describe("scan, create and retire worktrees", () => {
  test("inventory includes branch, dirty flag, disk and matching services", async () => {
    const root = tmp();
    const repo = join(root, "app");
    const linked = join(root, "app-agent");
    await git(root, ["init", "-q", "-b", "main", "app"]);
    await git(repo, ["commit", "--allow-empty", "-qm", "init"]);
    await git(repo, ["worktree", "add", "-q", "-b", "agent", linked]);
    writeFileSync(join(linked, "note.txt"), "dirty");
    const services: Service[] = [{
      id: "api-1", name: "api", kind: "dev", status: "running", ports: [3001],
      cwd: linked, pinned: true, hasLog: false, hidden: false, readiness: "ready",
    }];
    const { worktrees, stale } = await scanWorktrees(root, services);
    expect(stale).toEqual([]);
    const main = worktrees.find((w) => w.path === realpathSync(repo));
    const wt = worktrees.find((w) => w.path === realpathSync(linked));
    expect(main).toMatchObject({ main: true, dirty: false, branch: "main" });
    expect(wt).toMatchObject({ main: false, dirty: true, branch: "agent", serviceIds: ["api-1"], ports: [3001] });
    expect(wt!.diskMb).toBeGreaterThanOrEqual(0);
  });

  test("create adds a sibling checkout and retire refuses main, dirty, then force-removes", async () => {
    const root = tmp();
    const repo = join(root, "app");
    await git(root, ["init", "-q", "app"]);
    await git(repo, ["commit", "--allow-empty", "-qm", "init"]);
    const created = await createWorktree(repo, "feature/x");
    expect(created.branch).toBe("feature/x");
    expect(created.path).toBe(join(root, "app-feature-x"));
    expect(existsSync(created.path)).toBe(true);

    await expect(retireWorktree(repo)).rejects.toThrow("main worktree");
    writeFileSync(join(created.path, "wip.txt"), "no");
    await expect(retireWorktree(created.path)).rejects.toThrow("uncommitted");
    expect((await retireWorktree(created.path, true)).path).toBe(created.path);
    expect(existsSync(created.path)).toBe(false);
  });
});
