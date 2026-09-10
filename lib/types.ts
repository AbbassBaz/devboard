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
  name: string;
  kind: Kind;
  uptime: string;
  cpu: number;
  memMb: number;
};

export type Pinned = { id: string; name: string; cwd: string; command: string; port: number };

export type StartSpec = { id: string; cwd: string; command: string };

export type Service = {
  id?: string;
  name: string;
  kind: Kind;
  status: "running" | "stopped";
  rootPid?: number;
  pids?: number[];
  ports: number[];
  cwd?: string;
  command?: string;
  uptime?: string;
  cpu?: number;
  memMb?: number;
  pinned: boolean;
  hasLog: boolean;
  hidden: boolean;
};
