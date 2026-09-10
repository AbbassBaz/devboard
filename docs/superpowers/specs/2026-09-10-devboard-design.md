# devboard design

Date: 2026-09-10
Status: approved 2026-09-10

## Purpose

A personal dashboard for the local dev servers on this Mac. Open one page and see
every listening process, kill or restart it, pin the ones you care about into a saved
list, start a pinned service that is not running, and read the log of anything the
dashboard started.

## Non-goals for v1

- Auto-start of devboard at login (launchd)
- Authentication, remote access, or binding to anything but loopback
- Live log streaming over WebSocket or SSE
- CPU or memory graphs
- Docker containers
- Log rotation

## Constraints

- macOS only. Discovery relies on `lsof` and `ps` with macOS flags.
- Bun 1.2 or newer. TypeScript run directly, no build step, no UI framework,
  no runtime npm dependencies. `@types/bun` as the only dev dependency.
- Binds to 127.0.0.1:4242 only. The page can kill processes and run saved
  commands, so it must never be reachable from the network.
- Runs as the logged-in user and only sees or signals that user's processes.
- A tool can only show logs for processes it launched. Anything started from a
  terminal keeps its output in that terminal. This is a platform limit, not a bug.

## Concepts

**Listener.** One row from `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`: pid, command, port.

**Process.** One row from `ps -axo pid=,ppid=,pcpu=,rss=,etime=,args=`: pid, ppid,
CPU percent, resident KB, elapsed time, full command line. The executable name is
the basename of the first token of args. Command lines whose first token contains
spaces (some .app binaries) get a wrong basename. That is acceptable because such
processes never match the wrapper set below.

**Wrapper set.** Executable names that count as dev-server plumbing rather than the
user's shell: `node`, `bun`, `deno`, `npm`, `npx`, `pnpm`, `yarn`, `next`,
`next-server`, and `sh`/`bash`/`zsh` only when their second argument is `-c`.
Everything else (login shells, launchd, iTerm, Electron apps) stops the walk.

**Tree root.** Starting from a listener's pid, walk to the parent while the parent is
in the wrapper set and is not devboard's own pid or one of devboard's ancestors. The last
accepted pid is the root. Stopping there matters twice over: services devboard starts have
devboard as their parent until devboard exits, and services started from the same shell
wrapper as devboard are its siblings. Without the rule either would be folded into
devboard's own tree and hidden by the self-exclusion below. For a Next.js dev server
started with `pnpm dev`, the root is the `pnpm dev` process, and the tree is
`pnpm dev` → `next dev` → `next-server`. For a bun watch process whose shell has
exited, the root is the bun process itself.

**Running service.** One per tree root.

| Field | Source |
|---|---|
| rootPid | the root |
| pids | root plus every descendant |
| ports | all listener ports under the root |
| cwd | working directory of the root, from `lsof -a -d cwd -p <pids> -Fpn` |
| command | args of the root |
| name | `name` from `<cwd>/package.json` if present; else for `dev` the basename of cwd (falling back to the executable when cwd is `/`); for `system` always the executable name |
| kind | `dev` if the root executable is in the wrapper set or is a known runtime (`python`, `python3`, `uvicorn`, `ruby`, `java`, `go`, `cargo`), else `system` |
| uptime | etime of the root |
| cpu, memMb | summed over pids |

The devboard process and its own tree are excluded from results.

**Pinned service.** `{ id, name, cwd, command, port }` saved in
`~/.devboard/services.json`. `id` is a slug of the name plus the port, for
example `core-api-3003`. Pinning a running service copies its root command, cwd,
and first port. A pinned service matches a running service when the cwd is equal
and the pinned port is in the running service's ports. Matching by cwd alone is not
enough: OnCoreDocs runs three different servers from one folder.

**Merged view.** Every running service, flagged `pinned` when matched, plus every
pinned service with no match, shown as `stopped`.

## Modules

```
devboard/
  package.json            name, "type": "module", scripts: start, dev, test
  server.ts               Bun.serve on 127.0.0.1:4242, routes, static page
  lib/types.ts            Listener, Process, RunningService, Pinned, Service
  lib/discover.ts         scans, pure parsers, tree walk, grouping
  lib/registry.ts         load/save/pin/unpin for services.json
  lib/control.ts          killTree, start, restart, tailLog
  public/index.html       the page, plain HTML and JavaScript
  test/fixtures/          real lsof and ps output captured from this Mac
  test/discover.test.ts   parsers, root walk, grouping, classification
  test/control.test.ts    killTree against a real sh -c sleep tree
  README.md               how to run
  docs/superpowers/specs/ this file
```

### lib/discover.ts

Pure functions, each testable with fixture text:

- `parseListeners(lsofText): Listener[]`
- `parseProcesses(psText): Process[]`
- `parseCwds(lsofText): Map<number, string>`
- `isWrapper(proc): boolean`
- `selfAndAncestors(pid, byPid): Set<number>`
- `findRoot(pid, byPid, stop): number` (never climbs into the `stop` set)
- `descendants(rootPid, byPpid): number[]`
- `groupServices(listeners, processes, cwds, selfPid): RunningService[]`

Shell-calling functions:

- `scanListeners()`, `scanProcesses()`, `scanCwds(pids)` each run one command.
- `discover(): Promise<RunningService[]>` runs the first two, computes roots and
  trees, then runs one cwd lookup for all pids in one `lsof` call.

### lib/registry.ts

- `loadPinned(): Promise<Pinned[]>` returns `[]` when the file is missing.
- `savePinned(list)` writes the whole file atomically (write temp, rename).
- `pin(running, name?)` and `unpin(id)`.

### lib/control.ts

- `killTree(pids, graceMs = 3000)`. Send SIGTERM to every pid at once, root
  included, so a wrapper cannot respawn its child. Poll every 200 ms. After the
  grace period send SIGKILL to survivors. Return `{ killed, forced }`. A pid that
  is already gone counts as killed. Never signal pid 1 or the devboard tree.
- `start({ id, cwd, command })`. Ensure `~/.devboard/logs/` exists. Open
  `<id>.log` for append and write a header line with the ISO timestamp and the
  command. Spawn `/bin/sh -c <command>` in `cwd` with `detached: true` from
  `node:child_process`, stdin ignored, stdout and stderr pointed at the log file
  descriptor, environment inherited from devboard. Call `unref()` and return the
  pid. `detached` puts the child in its own session, so closing devboard or
  pressing Ctrl-C in its terminal does not take the service down. If Bun's
  `detached` turns out not to create a new session, fall back to
  `/bin/sh -c 'exec <command>'` under `nohup` and verify with the smoke test.
- `restart(service)` is `killTree` then `start`. For an unpinned running service it
  uses the root's command and cwd, with a log id derived the same way as a pin.
- `tailLog(id, lines = 200)` reads the last 256 KB of the file and returns the
  last N lines, plus the file path and size.

### server.ts

Routes, all JSON, errors as `{ error }` with 400, 404, or 500:

| Method and path | Body | Returns |
|---|---|---|
| GET /api/services | | `{ services, generatedAt }` |
| POST /api/kill | `{ rootPid }` | `{ killed, forced }` |
| POST /api/start | `{ id }` | `{ pid }` (pinned only) |
| POST /api/restart | `{ rootPid }` or `{ id }` | `{ killed, forced, pid }` |
| POST /api/pin | `{ rootPid, name? }` | `{ pinned }` |
| DELETE /api/pin/:id | | `{ ok: true }` |
| GET /api/logs/:id?lines=200 | | `{ lines, path, size }` |
| GET / | | `public/index.html` |

Service JSON shape:

```
{ id?, name, kind: "dev" | "system", status: "running" | "stopped",
  rootPid?, pids?, ports, cwd?, command?, uptime?, cpu?, memMb?,
  pinned, hasLog }
```

### public/index.html

- Polls `/api/services` every 3 seconds. A log panel, when open, polls its own
  endpoint every 2 seconds.
- Two sections. "Dev servers" lists `dev` services and stopped pinned ones.
  "System" is collapsed by default and lists `system` services with Kill only.
- Each row: status dot, name, ports as links to `http://localhost:<port>`, root pid,
  uptime, CPU, memory, shortened cwd, truncated command with the full text on hover.
- Buttons: Logs when `hasLog`, Restart, Kill, Pin or Unpin, and Start on stopped
  rows. Kill on a `system` row asks for confirmation first.
- Errors from the API appear as a toast. Light and dark follow the OS.

## Edge cases

- Two services in the same folder on different ports are separate roots and rows.
- A pinned service that came up on a different port (3000 was taken, Next picked
  3001) shows as stopped next to a new unpinned running row. Acceptable in v1.
- A service that exits right after Start: the call returns a pid, the next poll
  shows it stopped, and the log holds the error.
- Log files grow without bound. Deleting one is safe; the next start recreates it.
- If the two scans take more than a second on this machine, raise the poll
  interval to 5 seconds. Measure during the smoke test.

## Testing

- `bun test` covers the parsers, `findRoot` on the two real chains from this Mac
  (`next-server` → `next dev` → `pnpm dev` stopping at zsh, and
  `next-server` → `next dev` → `npm exec` stopping at launchd), one row per root,
  `system` classification for ControlCenter, and self exclusion.
- `killTree` test spawns `sh -c 'sleep 1000'` and asserts both processes are gone.
- Manual smoke run, recorded in the README: start devboard, start a throwaway bun
  server from a terminal, see it appear, pin it, kill it, start it from the page,
  read its log, press Ctrl-C on devboard and confirm the started service survives.
