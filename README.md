# devboard

A localhost dashboard for the dev servers on this Mac. Lists every listening
process grouped by its dev-wrapper root, and lets you kill, restart, pin,
start, and read logs.

## Run

    bun install
    bun run start          # http://127.0.0.1:4242
    bun run dev            # same, restarts on file changes
    bun test

Start it from your normal zsh so that services launched from the page inherit
the same PATH (fnm's node, pnpm, bun).

`PORT` overrides the port. `DEVBOARD_HOME` overrides `~/.devboard`, where
`services.json` (pinned list), `projects.json`, `presets.json`, `ignored.json`,
and `logs/<id>.log` live.

## What it does

- **Discover.** `lsof` for listeners, `ps` for the process table. Each listener
  is walked up its parents while they are dev wrappers (node, bun, deno, npm,
  npx, pnpm, yarn, next, next-server, `sh -c`). The top wrapper is the root and
  one row. A `pnpm dev` → `next dev` → `next-server` chain is one row. The walk
  never climbs into devboard itself, so services devboard started keep their
  own row.
- **Kill.** SIGTERM to every pid in the tree at once, SIGKILL to survivors
  after 3 seconds.
- **Pin.** Saves name, folder, command and port so the service can be started
  later. Matched to running rows by folder plus port.
- **Start / Restart.** Runs the saved command in its folder via `/bin/sh -c`,
  detached in its own process group, output appended to
  `~/.devboard/logs/<id>.log`. Closing devboard does not stop what it started.
- **Logs.** Last 4000 lines, refreshed every 2 seconds, in a sidebar. Drag the left
  edge to resize. Search with `/`, jump matches with Enter, filter **ERR / WRN / INF**,
  wrap or unwrap long lines (click a row to expand one), Follow pauses when you scroll
  up. Copy or save the filtered view. **Clear** truncates the file. ANSI colors stay.
  A service that devboard did not start has no log yet; the pane says so and offers to
  restart it under devboard.
- **Readiness.** Running cards are probed on each refresh. 2xx/3xx on the optional
  health URL (or `http://127.0.0.1:<port>/`) is ready; anything else is unhealthy.
- **Hide.** Moves a card into the collapsed Hidden list below the board, for things like
  editor helpers that happen to listen on a port. Show brings it back. Stored in
  `~/.devboard/ignored.json`.
- **Start all / Stop all.** Header buttons. Start all switches on every saved server that
  is off. Stop all asks first, then switches off every running dev server, pinning the
  unsaved ones so they can be switched back on.
- **Add server.** The button in the header opens a form for name, folder, command and
  port. The folder must exist. The new card starts switched off; switch it on to run it.
- **Projects.** + Project groups servers you start together. Name it, optionally point
  at a folder and tick “Add everything from this folder” to pull in every card under
  that path. Start project / Stop project switch the whole group at once. Combined
  CPU, memory, ports, and extra links sit on the project bar. A server lives in one
  project; Ungroup puts it back with the other cards. Stored in
  `~/.devboard/projects.json`.
- **Worktrees.** The Worktrees tab inventories every checkout in a folder: branch,
  dirty, disk, and which servers are live there. Create a sibling worktree from a
  branch, open it in Cursor (then VS Code, Sublime, or Finder), launch the servers
  in that tree on a free port, or retire it. Retire refuses the main checkout, a
  locked tree, or uncommitted changes unless you force. Stale registrations still
  prune; orphaned folders whose gitdir is gone can be deleted. The last folder is
  remembered.
- **Resume presets.** Save a set of servers, URLs, and an optional worktree as
  “Frontend only”, “Full stack”, or whatever you name it. Resume starts them in
  parallel, opens the URLs, and can open the worktree in the editor. Stored in
  `~/.devboard/presets.json`.
- **Attention.** Port conflicts across different folders, stopped servers whose last
  log looks like a crash, dirty linked worktrees, and a log directory at or over
  500 MB.
- **Edit.** Pinned cards have an Edit action that opens the same form pre-filled. The
  saved list is `~/.devboard/services.json`; it is read on every request, so editing the
  file by hand works too, no restart needed.
- **npm exec.** A server launched with `npx` shows up as `npm exec <cmd> <args>`. devboard
  saves it as `npm exec -- <cmd> <args>`, because without the `--` npm eats flags meant
  for the command (`--port 3001` turned into `next dev 3001`).

## The page

Three views in the header: **Board**, **Worktrees**, **Attention**. One card per
dev server. The switch is the state: green and on means running, grey and off
means stopped. A readiness rail shows ready, starting, unhealthy, or stopped.
Switching off kills the process tree; if the card was not pinned yet it is pinned
first so it stays on the board and can be switched back on. Switching on runs the
saved command from devboard. Restart is kill then start. Remove drops a pinned
card. System processes (Postgres, Redis, macOS services) sit in a collapsed list
below the cards with only a Kill action.

## Limits

- Logs exist only for services devboard started. A process you launched from a
  terminal keeps its output in that terminal; macOS gives no way to attach.
- Killing a **System** row (Postgres, Redis, ControlCenter) usually just makes
  launchd or Homebrew services restart it. Use `brew services stop <name>`.
- If a pinned service comes up on a different port than the one saved, it
  shows as stopped next to a new unpinned running row.
- Log files are never rotated. Deleting one is safe.
- Binds to 127.0.0.1 only. Do not change that: the API kills processes and
  runs saved shell commands.

## Smoke checklist

1. `bun run start`, open http://127.0.0.1:4242.
2. In another terminal, from any folder with a package.json:
   `sh -c "bun -e 'Bun.serve({port:3999,fetch(){return new Response(\"hi\")}});setInterval(()=>{},1e6)'; exit 0"`.
   The trailing `; exit 0` matters: with a single command, `sh -c` execs it in
   place and there is no tree to discover.
3. Within 3 seconds a row appears on port 3999 with that folder's name.
4. Click **Pin**. A 📌 appears. `~/.devboard/services.json` has one entry.
5. Click **Kill**. The terminal command exits; the row turns to a stopped
   pinned row with **Start**.
6. Click **Start**. The row comes back running, now with **Logs**. Click it;
   the header line and any output show. The terminal from step 2 shows
   nothing, because devboard owns the process now.
7. Press Ctrl-C on devboard. `curl localhost:3999` still answers `hi`.
8. Start devboard again. The row is still there. Click **Restart**. The pid
   changes, the log gets a second header. Click **Kill**, then **Unpin**.

`bash scripts/smoke.sh` runs these eight steps against a real devboard through the API. Last run 2026-09-10: passed.
