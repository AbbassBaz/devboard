export type Listener = { pid: number; command: string; port: number; address: string };

export type Process = {
  pid: number;
  ppid: number;
  pcpu: number;
  rss: number; // KB
  etime: string; // e.g. "23-01:48:34" or "16:09:12"
  args: string;
};

export type Kind = "dev" | "system";

export type RunningService = {
  rootPid: number;
  pids: number[];
  ports: number[];
  cwd?: string;
  command: string;
  commandLossy?: boolean;
  name: string;
  kind: Kind;
  uptime: string;
  cpu: number;
  memMb: number;
};

export type Readiness = "stopped" | "starting" | "ready" | "unhealthy";

export type Pinned = {
  id: string;
  name: string;
  cwd: string;
  command: string;
  port: number;
  healthUrl?: string;
  env?: Record<string, string>;
  restartOnCrash?: boolean;
};

export type StartSpec = { id: string; cwd: string; command: string; env?: Record<string, string> };

export type Tracked = {
  id: string;
  pid: number;
  startedAt: number;
  exitCode?: number;
  exitedAt?: number;
};

export type Service = {
  id?: string;
  name: string;
  kind: Kind;
  status: "running" | "stopped" | "starting";
  rootPid?: number;
  pids?: number[];
  ports: number[];
  cwd?: string;
  command?: string;
  commandLossy?: boolean;
  uptime?: string;
  cpu?: number;
  memMb?: number;
  pinned: boolean;
  hasLog: boolean;
  hidden: boolean;
  readiness: Readiness;
  healthUrl?: string;
  health?: { ok: boolean; status?: number; ms: number; error?: string };
  env?: Record<string, string>;
  restartOnCrash?: boolean;
  exitCode?: number;
  crash?: { tries: number; gaveUp: boolean };
  errorCount?: number;
};

export type ProjectLink = { label: string; url: string };

export type Project = {
  id: string;
  name: string;
  folder?: string;
  memberIds: string[];
  links: ProjectLink[];
};

export type ProjectView = Project & {
  on: number;
  off: number;
  cpu: number;
  memMb: number;
  ports: number[];
};

export type Preset = {
  id: string;
  name: string;
  projectId?: string;
  serviceIds: string[];
  urls: string[];
  worktree?: string;
  openEditor?: boolean;
};

export type AlertKind = "port-conflict" | "exited" | "dirty-worktree" | "log-size";

export type Alert = {
  id: string;
  kind: AlertKind;
  title: string;
  detail: string;
  serviceId?: string;
  path?: string;
};

export type WorktreeInfo = {
  path: string;
  repo: string;
  branch?: string;
  head?: string;
  main: boolean;
  detached?: boolean;
  locked?: string;
  prunable?: string;
  dirty: boolean;
  diskMb?: number;
  serviceIds: string[];
  ports: number[];
  hasTemplate?: boolean;
};

/** One row in a checked-in `devboard.json`. `cwd` is a relative subpath of the repo. */
export type PinTemplateEntry = {
  name: string;
  command: string;
  port: number;
  cwd?: string;
  healthUrl?: string;
  env?: Record<string, string>;
  restartOnCrash?: boolean;
};

export type TraceHit = {
  i: number;
  line: string;
  level: "error" | "warn" | "info" | "debug" | "other";
};

export type TraceGroup = {
  id: string;
  hits: TraceHit[];
};

export type TraceResult = {
  token: string;
  groups: TraceGroup[];
};

export type StaleReason = "prunable" | "orphaned";

export type StaleWorktree = {
  path: string;
  repo: string;
  branch?: string;
  head?: string;
  gitdir?: string;
  reason: StaleReason;
  detail: string;
};
