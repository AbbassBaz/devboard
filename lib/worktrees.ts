import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Pinned, Service, StaleWorktree, WorktreeInfo } from "./types";
import { firstFreePort } from "./health";
import { mapUnder, underFolder } from "./projects";
import { rewriteCommandPort, rewriteUrlPort } from "./suggest";
import { TEMPLATE_FILE } from "./template";

export const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p);

/** Running or starting rows whose cwd is the folder or a descendant. Paths should already be resolved. */
export function blockingWorktreeServices(services: Service[], target: string): Service[] {
  return services.filter((s) =>
    (s.status === "running" || s.status === "starting") && underFolder(s.cwd, target),
  );
}

export type WorktreeRecord = {
  path: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
  locked?: string;
  prunable?: string;
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  ".cache",
  "target",
  ".turbo",
  ".output",
]);

/** Parse `git worktree list --porcelain` or `--porcelain -z`. */
export function parseWorktreeList(text: string): WorktreeRecord[] {
  const out: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  const flush = () => {
    if (current?.path) out.push(current);
    current = undefined;
  };
  const lines = text.includes("\0") ? text.split("\0") : text.split("\n");
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line) {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      flush();
      current = { path: value };
    } else if (!current) {
      continue;
    } else if (key === "HEAD") {
      current.head = value;
    } else if (key === "branch") {
      current.branch = value;
    } else if (key === "detached") {
      current.detached = true;
    } else if (key === "bare") {
      current.bare = true;
    } else if (key === "locked") {
      current.locked = value;
    } else if (key === "prunable") {
      current.prunable = value;
    }
  }
  flush();
  return out;
}

export function parseGitdirFile(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith("gitdir:"));
  if (!line) return undefined;
  const value = line.slice("gitdir:".length).trim();
  return value || undefined;
}

function branchName(ref?: string): string | undefined {
  if (!ref) return undefined;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function samePath(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return resolve(a) === resolve(b);
  }
}

async function git(args: string[], reject = false): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (reject && code !== 0) throw new Error(err.trim() || text.trim() || `git ${args.join(" ")} failed`);
  return text;
}

const DISK_TTL_MS = 10 * 60 * 1000;
const diskHits = new Map<string, { mtimeMs: number; at: number; mb: number }>();
let duRuns = 0;

export function resetDiskCache(): void {
  diskHits.clear();
  duRuns = 0;
}

export function countDiskDu(): number {
  return duRuns;
}

async function gitStamp(path: string): Promise<number> {
  const git = join(path, ".git");
  const info = await stat(git).catch(() => undefined);
  if (!info) return 0;
  if (info.isFile()) return info.mtimeMs;
  const head = await stat(join(git, "HEAD")).catch(() => undefined);
  return head?.mtimeMs ?? info.mtimeMs;
}

async function diskMb(path: string): Promise<number> {
  const mtimeMs = await gitStamp(path);
  const hit = diskHits.get(path);
  if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < DISK_TTL_MS) return hit.mb;
  duRuns++;
  const proc = Bun.spawn(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const kb = Number(text.trim().split(/\s+/)[0]);
  const mb = Number.isFinite(kb) ? Math.round(kb / 1024) : 0;
  diskHits.set(path, { mtimeMs, at: Date.now(), mb });
  return mb;
}

type Linked = { path: string; gitdir: string };

async function findGitCheckouts(root: string, maxDepth = 6): Promise<{ mains: string[]; linked: Linked[] }> {
  const mains: string[] = [];
  const linked: Linked[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const gitEntry = entries.find((e) => e.name === ".git");
    if (gitEntry) {
      const gitPath = join(dir, ".git");
      try {
        const info = await stat(gitPath);
        if (info.isDirectory()) {
          mains.push(dir);
          return;
        }
        if (info.isFile()) {
          const raw = parseGitdirFile(await readFile(gitPath, "utf8"));
          if (raw) {
            const gitdir = isAbsolute(raw) ? raw : resolve(dir, raw);
            linked.push({ path: dir, gitdir });
          }
          return;
        }
      } catch {
        return;
      }
    }
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
        .map((e) => walk(join(dir, e.name), depth + 1)),
    );
  }

  await walk(root, 0);
  return { mains, linked };
}

function inferRepo(gitdir: string): string {
  // .../repo/.git/worktrees/name → .../repo
  const idx = gitdir.lastIndexOf("/.git/worktrees/");
  if (idx >= 0) return gitdir.slice(0, idx);
  return dirname(dirname(gitdir));
}

export async function scanStaleWorktrees(dir: string): Promise<{ dir: string; stale: StaleWorktree[] }> {
  const expanded = expandHome(dir.trim());
  if (!expanded) throw new Error("folder required");
  const info = await stat(expanded).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`folder does not exist: ${expanded}`);
  const root = await realpath(expanded);

  const { mains, linked } = await findGitCheckouts(root);
  const stale: StaleWorktree[] = [];
  const seen = new Set<string>();

  for (const repo of mains) {
    const text = await git(["-C", repo, "worktree", "list", "--porcelain", "-z"]);
    for (const entry of parseWorktreeList(text)) {
      if (entry.bare || !entry.path) continue;
      if (await samePath(entry.path, repo)) continue;
      const missing = !(await exists(entry.path));
      if (entry.prunable != null || missing) {
        stale.push({
          path: entry.path,
          repo,
          branch: branchName(entry.branch),
          head: entry.head,
          reason: "prunable",
          detail: entry.prunable || "checkout directory is missing",
        });
        seen.add(resolve(entry.path));
      }
    }
  }

  for (const wt of linked) {
    if (seen.has(resolve(wt.path))) continue;
    if (await exists(wt.gitdir)) continue;
    stale.push({
      path: wt.path,
      repo: inferRepo(wt.gitdir),
      gitdir: wt.gitdir,
      reason: "orphaned",
      detail: "gitdir is missing",
    });
  }

  stale.sort((a, b) => a.path.localeCompare(b.path));
  return { dir: root, stale };
}

export async function pruneStaleWorktrees(dir: string): Promise<{ pruned: number; repos: string[] }> {
  const { stale } = await scanStaleWorktrees(dir);
  const repos = [...new Set(stale.filter((s) => s.reason === "prunable").map((s) => s.repo))];
  for (const repo of repos) {
    await git(["-C", repo, "worktree", "prune"]);
  }
  return { pruned: stale.filter((s) => s.reason === "prunable").length, repos };
}

/** Delete an orphaned checkout: `.git` must be a file whose gitdir is gone. Never deletes a real repository. */
export async function removeOrphanedWorktree(path: string): Promise<{ path: string }> {
  const expanded = expandHome(path.trim());
  const info = await stat(expanded).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`folder does not exist: ${expanded}`);
  const gitPath = join(expanded, ".git");
  const gitInfo = await stat(gitPath).catch(() => undefined);
  if (!gitInfo) throw new Error("not a git checkout");
  if (gitInfo.isDirectory()) throw new Error("refusing to delete a git repository");
  if (!gitInfo.isFile()) throw new Error("not a linked worktree");
  const raw = parseGitdirFile(await readFile(gitPath, "utf8"));
  if (!raw) throw new Error("not a linked worktree");
  const gitdir = isAbsolute(raw) ? raw : resolve(expanded, raw);
  if (await exists(gitdir)) throw new Error("worktree is still registered; prune it from the main repo instead");
  await rm(expanded, { recursive: true, force: true });
  return { path: expanded };
}

export async function scanWorktrees(dir: string, services: Service[] = [], opts: { disk?: boolean } = {}): Promise<{ dir: string; worktrees: WorktreeInfo[]; stale: StaleWorktree[] }> {
  const wantDisk = opts.disk !== false;
  const { dir: root, stale } = await scanStaleWorktrees(dir);
  const { mains } = await findGitCheckouts(root);
  const worktrees: WorktreeInfo[] = [];
  const seen = new Set<string>();

  for (const repo of mains) {
    const text = await git(["-C", repo, "worktree", "list", "--porcelain", "-z"]);
    for (const entry of parseWorktreeList(text)) {
      if (entry.bare || !entry.path || seen.has(resolve(entry.path))) continue;
      seen.add(resolve(entry.path));
      const missing = !(await exists(entry.path));
      const main = await samePath(entry.path, repo).catch(() => false);
      let dirty = false;
      if (!missing && !entry.prunable) {
        const status = await git(["-C", entry.path, "status", "--porcelain"]);
        dirty = status.trim().length > 0;
      }
      const resolved = missing ? resolve(entry.path) : await realpath(entry.path).catch(() => resolve(entry.path));
      const matched = [];
      for (const s of services) {
        if (s.kind !== "dev" || !s.cwd) continue;
        const cwd = await realpath(s.cwd).catch(() => s.cwd);
        if (underFolder(cwd, resolved) || underFolder(s.cwd, entry.path)) matched.push(s);
      }
      worktrees.push({
        path: resolved,
        repo,
        branch: branchName(entry.branch),
        head: entry.head,
        main,
        detached: entry.detached,
        locked: entry.locked,
        prunable: entry.prunable,
        dirty: missing ? false : dirty,
        ...(wantDisk && !missing ? { diskMb: await diskMb(entry.path) } : {}),
        serviceIds: matched.map((s) => s.id!).filter(Boolean),
        ports: [...new Set(matched.flatMap((s) => s.ports))],
        hasTemplate: !missing && await exists(join(entry.path, TEMPLATE_FILE)),
      });
    }
  }

  worktrees.sort((a, b) => Number(b.main) - Number(a.main) || a.path.localeCompare(b.path));
  return { dir: root, worktrees, stale };
}

export async function createWorktree(repo: string, branch: string, dest?: string): Promise<{ path: string; branch: string }> {
  const root = expandHome(repo.trim());
  const info = await stat(root).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`repo does not exist: ${root}`);
  const name = branch.trim().replace(/[^A-Za-z0-9._/-]+/g, "-");
  if (!name) throw new Error("branch required");
  const path = dest?.trim() ? expandHome(dest.trim()) : join(dirname(root), `${root.slice(root.lastIndexOf("/") + 1)}-${name.replace(/\//g, "-")}`);
  if (await exists(path)) throw new Error(`folder already exists: ${path}`);
  const hasBranch = (await git(["-C", root, "branch", "--list", name])).trim().length > 0;
  if (hasBranch) await git(["-C", root, "worktree", "add", path, name], true);
  else await git(["-C", root, "worktree", "add", "-b", name, path], true);
  return { path, branch: name };
}

export async function mainRepoOf(checkout: string): Promise<string> {
  const common = (await git(["-C", checkout, "rev-parse", "--git-common-dir"], true)).trim();
  const gitdir = isAbsolute(common) ? common : resolve(checkout, common);
  return dirname(gitdir);
}

export type LaunchCreate = Omit<Pinned, "id">;

export type LaunchPlan = {
  startIds: string[];
  create: LaunchCreate[];
};

/** Copy main-checkout pins into a sibling worktree on free ports, or just start pins already there. */
export function planWorktreeLaunch(worktree: string, repo: string, pinned: Pinned[], usedPorts: number[]): LaunchPlan {
  const wt = worktree.replace(/\/+$/, "");
  const root = repo.replace(/\/+$/, "");
  const same = wt === root;
  const used = [...usedPorts];
  const startIds: string[] = [];
  const create: LaunchCreate[] = [];

  for (const t of pinned.filter((p) => underFolder(p.cwd, root))) {
    const dest = same ? t.cwd : mapUnder(t.cwd, root, wt);
    if (!dest) continue;
    const existing = pinned.find((p) => p.cwd === dest && p.name === t.name);
    if (existing) {
      startIds.push(existing.id);
      continue;
    }
    const port = firstFreePort(used);
    used.push(port);
    create.push({
      name: t.name,
      cwd: dest,
      command: rewriteCommandPort(t.command, port),
      port,
      ...(t.healthUrl ? { healthUrl: rewriteUrlPort(t.healthUrl, port) } : {}),
      ...(t.env && Object.keys(t.env).length ? { env: t.env } : {}),
      ...(t.restartOnCrash ? { restartOnCrash: true } : {}),
    });
  }

  for (const p of pinned) {
    if (underFolder(p.cwd, wt) && !startIds.includes(p.id)) startIds.push(p.id);
  }
  return { startIds, create };
}

export async function retireWorktree(path: string, force = false): Promise<{ path: string }> {
  const expanded = expandHome(path.trim());
  const repo = await mainRepoOf(expanded);
  if (await samePath(expanded, repo)) throw new Error("refusing to remove the main worktree");
  const entry = parseWorktreeList(await git(["-C", repo, "worktree", "list", "--porcelain", "-z"])).find((e) => resolve(e.path) === resolve(expanded));
  if (entry?.locked && !force) throw new Error(`worktree is locked: ${entry.locked || "locked"}`);
  const dirty = (await git(["-C", expanded, "status", "--porcelain"])).trim().length > 0;
  if (dirty && !force) throw new Error("worktree has uncommitted changes");
  await git(["-C", repo, "worktree", "remove", ...(force ? ["--force"] : []), expanded], true);
  return { path: expanded };
}

/**
 * Where `POST /api/open` should look. A relative path — what a stack frame prints — hangs
 * off the service's own `cwd`; an absolute one is taken as it is. Home expands either way.
 */
export function resolveOpenPath(path: string, cwd?: string): string {
  const target = expandHome(String(path ?? "").trim());
  if (!target) throw new Error("path required");
  const base = cwd?.trim() ? expandHome(cwd.trim()) : "";
  return isAbsolute(target) || !base ? resolve(target) : resolve(base, target);
}

/** Open a path, at a line and column when the log line carried them. */
export async function openInEditor(path: string, line?: number, col?: number): Promise<{ cmd: string; path: string }> {
  const expanded = expandHome(path.trim());
  const info = await stat(expanded).catch(() => undefined);
  if (!info) throw new Error(`path does not exist: ${expanded}`);
  const at = line ? `${expanded}:${line}${col ? `:${col}` : ""}` : expanded;
  for (const cmd of ["cursor", "code", "subl"]) {
    // `cursor` and `code` need `-g` for a line; `subl` takes `file:line:col` on its own.
    const args = line ? (cmd === "subl" ? [at] : ["-g", at]) : [expanded];
    const proc = Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    if (code === 0) return { cmd, path: expanded };
  }
  const open = Bun.spawn(["open", expanded], { stdout: "ignore", stderr: "ignore" });
  await open.exited;
  return { cmd: "open", path: expanded };
}
