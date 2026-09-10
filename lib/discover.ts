import type { Listener, Process, RunningService } from "./types";

export function parseListeners(text: string): Listener[] {
  const out: Listener[] = [];
  const seen = new Set<string>();
  let pid = 0;
  let command = "";
  for (const line of text.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number(value);
      command = "";
    } else if (tag === "c") {
      command = value;
    } else if (tag === "n") {
      const idx = value.lastIndexOf(":");
      if (idx < 0) continue;
      const port = Number(value.slice(idx + 1));
      if (!Number.isInteger(port)) continue;
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pid, command, port, address: value.slice(0, idx) });
    }
  }
  return out;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/;

export function parseProcesses(text: string): Process[] {
  const out: Process[] = [];
  for (const line of text.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pcpu: Number(m[3]),
      rss: Number(m[4]),
      etime: m[5],
      args: (m[6] ?? "").trim(),
    });
  }
  return out;
}

export function parseCwds(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) out.set(pid, line.slice(1));
  }
  return out;
}

const WRAPPER_EXES = new Set(["node", "bun", "deno", "npm", "npx", "pnpm", "yarn", "next", "next-server"]);
const SHELL_EXES = new Set(["sh", "bash", "zsh"]);
const RUNTIME_EXES = new Set(["python", "python3", "uvicorn", "ruby", "java", "go", "cargo"]);

export function exeName(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
}

export function isWrapper(p: Process): boolean {
  const exe = exeName(p.args);
  if (WRAPPER_EXES.has(exe)) return true;
  if (SHELL_EXES.has(exe)) return p.args.trim().split(/\s+/)[1] === "-c";
  return false;
}

/**
 * The command to re-run a root with. `ps` flattens argv, so `sh -c '<script>'` shows as
 * `sh -c <script>` with the quoting gone; re-running that through another `sh -c` would only
 * execute the script's first word. The script itself is one argv element and is reproduced
 * verbatim, so strip the wrapper and keep the script.
 */
export function commandOf(args: string): string {
  const trimmed = args.trim();
  const tokens = trimmed.split(/\s+/);
  if (!SHELL_EXES.has(exeName(trimmed)) || tokens[1] !== "-c") return trimmed;
  const afterExe = trimmed.slice(tokens[0].length);
  return afterExe.slice(afterExe.indexOf("-c") + 2).trim();
}

export function isRuntime(p: Process): boolean {
  return RUNTIME_EXES.has(exeName(p.args));
}

export function indexProcesses(procs: Process[]) {
  const byPid = new Map<number, Process>();
  const byPpid = new Map<number, Process[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    const siblings = byPpid.get(p.ppid) ?? [];
    siblings.push(p);
    byPpid.set(p.ppid, siblings);
  }
  return { byPid, byPpid };
}

/** pid plus every ancestor of it that appears in the table, nearest first. */
export function selfAndAncestors(pid: number, byPid: Map<number, Process>): Set<number> {
  const out = new Set<number>([pid]);
  let current = byPid.get(pid);
  while (current && current.ppid > 1 && !out.has(current.ppid)) {
    out.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  return out;
}

/**
 * Climb from a listener to the top of its dev-wrapper chain. `stop` is devboard's own
 * pid and ancestors: services devboard starts are its children, and anything started from
 * the same shell wrapper as devboard is its sibling, so the walk must never enter that chain.
 */
export function findRoot(pid: number, byPid: Map<number, Process>, stop: ReadonlySet<number>): number {
  let current = pid;
  for (;;) {
    const proc = byPid.get(current);
    if (!proc) return current;
    const parent = byPid.get(proc.ppid);
    if (!parent || parent.pid <= 1 || stop.has(parent.pid) || !isWrapper(parent)) return current;
    current = parent.pid;
  }
}

export function treePids(rootPid: number, byPpid: Map<number, Process[]>): number[] {
  const out = [rootPid];
  for (let i = 0; i < out.length; i++) {
    for (const child of byPpid.get(out[i]) ?? []) out.push(child.pid);
  }
  return out;
}

export function groupServices(listeners: Listener[], processes: Process[], selfPid: number): RunningService[] {
  const { byPid, byPpid } = indexProcesses(processes);
  const stop = selfAndAncestors(selfPid, byPid);
  const portsByRoot = new Map<number, Set<number>>();
  for (const l of listeners) {
    const root = findRoot(l.pid, byPid, stop);
    const ports = portsByRoot.get(root) ?? new Set<number>();
    ports.add(l.port);
    portsByRoot.set(root, ports);
  }
  const out: RunningService[] = [];
  for (const [rootPid, ports] of portsByRoot) {
    const root = byPid.get(rootPid);
    if (!root) continue;
    const pids = treePids(rootPid, byPpid);
    if (pids.includes(selfPid)) continue;
    const tree = pids.map((pid) => byPid.get(pid)).filter((p): p is Process => !!p);
    out.push({
      rootPid,
      pids,
      ports: [...ports].sort((a, b) => a - b),
      command: commandOf(root.args),
      name: exeName(root.args),
      kind: isWrapper(root) || isRuntime(root) ? "dev" : "system",
      uptime: root.etime,
      cpu: Math.round(tree.reduce((sum, p) => sum + p.pcpu, 0) * 10) / 10,
      memMb: Math.round(tree.reduce((sum, p) => sum + p.rss, 0) / 1024),
    });
  }
  return out.sort((a, b) => a.ports[0] - b.ports[0]);
}

export function applyCwds(
  services: RunningService[],
  cwds: Map<number, string>,
  names: Map<number, string>,
): RunningService[] {
  return services.map((s) => {
    const cwd = cwds.get(s.rootPid);
    const folder = cwd ? cwd.slice(cwd.lastIndexOf("/") + 1) || undefined : undefined;
    const name = names.get(s.rootPid) ?? (s.kind === "dev" ? folder : undefined) ?? s.name;
    return { ...s, cwd, name };
  });
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited; // lsof exits 1 when it finds nothing; the output is still valid
  return text;
}

export const scanListeners = (): Promise<Listener[]> =>
  run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]).then(parseListeners);

export const scanProcesses = (): Promise<Process[]> =>
  run(["ps", "-axo", "pid=,ppid=,pcpu=,rss=,etime=,args="]).then(parseProcesses);

export const scanCwds = (pids: number[]): Promise<Map<number, string>> =>
  pids.length === 0
    ? Promise.resolve(new Map())
    : run(["lsof", "-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"]).then(parseCwds);

export async function readPackageName(cwd: string): Promise<string | undefined> {
  try {
    const pkg = await Bun.file(`${cwd}/package.json`).json();
    return typeof pkg?.name === "string" && pkg.name ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

export async function discover(selfPid = process.pid): Promise<RunningService[]> {
  const [listeners, processes] = await Promise.all([scanListeners(), scanProcesses()]);
  const services = groupServices(listeners, processes, selfPid);
  const cwds = await scanCwds(services.map((s) => s.rootPid));
  const names = new Map<number, string>();
  await Promise.all(
    services.map(async (s) => {
      const cwd = cwds.get(s.rootPid);
      if (!cwd) return;
      const name = await readPackageName(cwd);
      if (name) names.set(s.rootPid, name);
    }),
  );
  return applyCwds(services, cwds, names);
}
