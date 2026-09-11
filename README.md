# devboard

A localhost dashboard for the dev servers on this Mac. One screen: every listening
process on the left, grouped by project, and the selected server's log on the right.
Kill, start, restart, pin, group, and read logs without leaving the page or the terminal.

## Run

    bun install
    bun run start          # http://127.0.0.1:4242  (opens the menu bar extra too)
    bun run dev            # same, restarts on file changes
    bun test
    bun run bin/devboard.ts install   # once: put `devboard` on PATH, install the menu bar app

After install, any terminal:

    devboard               # list what's on
    devboard start api-3003
    devboard logs web -f
    devboard stop-all
    devboard up            # start the board if it is off
    devboard tray          # show the menu bar extra

`devboard install` drops a symlink in `~/.local/bin`, so the command works like `git`
or `ls`. Without installing, `bun run devboard -- <cmd>` does the same.

Start the board from your normal zsh so that services launched from the page inherit
the same PATH (fnm's node, pnpm, bun).

`PORT` overrides the port. `DEVBOARD_URL` is the board the CLI talks to (default
`http://127.0.0.1:4242`). `DEVBOARD_HOME` overrides `~/.devboard`, where
`services.json` (pinned list), `projects.json`, `presets.json`, `ignored.json`, and
`logs/<id>.log` live. `DEVBOARD_TRAY=0` starts the server without the menu bar extra.

## The page

Dark, dense, keyboard-first. Three fixed rows: a 44px top bar, the workspace, and a
28px status bar with the key map. The workspace is a sidebar and a log pane.

**Top bar.** Counts of servers up, down, and with errors in their log. A clock.
`+ Add` opens the add form. `···` holds Start all, Stop all, and the sheets:
Worktrees, New project, Presets, Attention.

**Sidebar.** One row per dev server, grouped under its project (or "Other"). Each row
has a state dot, the name, a port link, `pid · cpu · MB · uptime` when running, an
error count when the log has errors, a CPU bar, and a switch. The switch is the
state: green and on means running, grey and off means stopped, amber means starting
or stopping. Switching off kills the process tree; an unpinned server is pinned first
so it stays on the board and can be switched back on. Switching on runs the saved
command. Each group header has its own `start` and `stop` for the whole project.
The filter box at the top matches name or port; `/` focuses it. System processes
(Postgres, Redis, macOS services) sit in a collapsed **System** list with only a
Kill action. Hidden servers sit in a collapsed **Hidden** list with a Show action.

**Log pane.** The selected server: dot, name, `localhost:PORT ↗`, and state. One
primary button: **Start** when stopped, **Restart** when running. `···` holds Open in
browser, Open in editor, Copy run command, Show errors only, Follow, Clear log, then
Pin or Edit, Env, Add to or Remove from a project, Hide, and Remove. Under that,
click-to-copy `cwd` and `$ command`. The toolbar has a text filter, an error chip
that appears only when the log has errors (click jumps to the next one, shift-click
shows errors only), and a `↓ Resume follow` button that appears only when you have
scrolled away from the tail. Lines are coloured by content: errors red, warnings
amber, ready and listening green. Click a line to copy it. Timestamps show only when
the log has them.

**Keys.** `↑↓` or `j`/`k` select. `space` toggles the selected server. `r` restarts.
`e` jumps to the next error. `c` copies `cd <cwd> && <command>`. `o` opens the port
in the browser. `/` focuses the filter. `Esc` closes a menu or sheet. Keys are ignored
while an input has focus.

**Sheets.** Worktrees, projects, presets, attention, env, and the full server edit
open as overlays from the `···` menus. `Esc` or a click on the backdrop closes them.
Destructive actions (stop all, stop project, kill system, remove, clear log) ask
first.

`design.md` is the full spec: tokens, layout, states, and behaviour.

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
  later. Matched to running rows by folder plus port. A running server that
  devboard did not start has Pin in its log menu; switching it off pins it too.
- **Start / Restart.** Runs the saved command in its folder via `/bin/sh -c`,
  detached in its own process group, output appended to
  `~/.devboard/logs/<id>.log`. Closing devboard does not stop what it started.
  Saved env overrides are merged into the process environment. Optional
  **restart on crash** (5 tries, 1→2→4→8→16s, cap 30s) relaunches a stopped
  server whose last log looks like an error. Stop and Kill disarm it so a clean
  shutdown does not bounce back.
- **Logs.** Last 4000 lines, refreshed every 2 seconds. Filter by text or errors
  only, jump between errors, follow the tail or pause by scrolling up, copy a
  line, clear the file. ANSI codes are stripped and lines are coloured by
  content instead. A server that devboard did not start has no log yet; the
  pane says so; Restart brings it under devboard and starts capturing. Each file is capped at
  5 MB; on start (and on rotate) only the last 2 MB is kept.
- **Env.** The Env sheet shows saved overrides and the live `ps` environment of a
  running process. Edit the server to change overrides (`KEY=value` lines).
- **Readiness.** Running servers with an explicit health URL are probed on each
  refresh. 2xx/3xx is ready; anything else is unhealthy. No URL means ready. The
  board does not hit `/` just to guess, so noisy dev servers stay quiet.
- **CLI.** After `devboard install`, type `devboard` in any terminal. It lists the
  board and can `start`, `stop`, `restart`, `logs [-f]`, `start-all`, `stop-all`,
  `up`, and `tray`.
- **Menu bar.** A menu extra shows how many servers are on, turns red when one is
  unhealthy, and can start/stop, open a port, or open the board. Open at login is
  optional. Quitting the extra does not stop your servers.
- **Hide.** Moves a server into the collapsed Hidden list, for things like editor
  helpers that happen to listen on a port. Show brings it back. Stored in
  `~/.devboard/ignored.json`.
- **Start all / Stop all.** In the top-bar menu. Start all switches on every saved
  server that is off. Stop all asks first, then switches off every running dev
  server, pinning the unsaved ones so they can be switched back on.
- **Add server.** `+ Add` opens an inline form for name, folder, command and port.
  Leaving the folder field reads `package.json` scripts, Compose services, and a
  Procfile and offers them as commands. The folder must exist. The new server
  starts switched off. Health URL, env, and restart-on-crash live on the Edit
  sheet.
- **Projects.** New project groups servers you start together. Name it, optionally
  point at a folder and tick "Add everything from this folder" to pull in every
  server under that path. The group header in the sidebar starts or stops the
  whole set. A server lives in one project; Remove from project puts it back under
  "Other". Stored in `~/.devboard/projects.json`.
- **Worktrees.** The Worktrees sheet inventories every checkout in a folder:
  branch, dirty, disk, and which servers are live there. Create a sibling
  worktree from a branch, open it in Cursor (then VS Code, Sublime, or Finder),
  launch the servers in that tree on free ports (copies pins from the main
  checkout if that tree has none yet), or retire it. Retire refuses the
  main checkout, a locked tree, or uncommitted changes unless you force. Stale
  registrations still prune; orphaned folders whose gitdir is gone can be
  deleted. The last folder is remembered.
- **Presets.** Save a set of servers, URLs, and an optional worktree as "Frontend
  only", "Full stack", or whatever you name it. Resume starts them in parallel,
  opens the URLs, and can open the worktree in the editor. Stored in
  `~/.devboard/presets.json`.
- **Attention.** Port conflicts across different folders, stopped servers whose
  last log looks like a crash, dirty linked worktrees, and a log directory at or
  over 500 MB.
- **Edit.** Pinned servers have Edit in the log menu; it opens the full form
  pre-filled. The saved list is `~/.devboard/services.json`; it is read on every
  request, so editing the file by hand works too, no restart needed.
- **npm exec.** A server launched with `npx` shows up as `npm exec <cmd> <args>`.
  devboard saves it as `npm exec -- <cmd> <args>`, because without the `--` npm
  eats flags meant for the command (`--port 3001` turned into `next dev 3001`).

## Limits

- Logs exist only for services devboard started. A process you launched from a
  terminal keeps its output in that terminal; macOS gives no way to attach.
- Killing a **System** row (Postgres, Redis, ControlCenter) usually just makes
  launchd or Homebrew services restart it. Use `brew services stop <name>`.
- If a pinned service comes up on a different port than the one saved, it
  shows as stopped next to a new unpinned running row.
- Log files rotate at 5 MB (last 2 MB kept). Deleting one is still safe.
- Health probes run only when you set a health URL. A server that logs every
  request to `/` will not see board traffic unless you ask for it.
- Binds to 127.0.0.1 only. Do not change that: the API kills processes and
  runs saved shell commands. There is no remote or multi-machine mode.
  Requests whose Host or Origin is not loopback (or `localhost` / `::1`),
  or whose `Sec-Fetch-Site` is present and not `same-origin` or `none`,
  get 403. Non-GET requests must be `application/json` (415 otherwise).
  There are no CORS headers.

## Smoke checklist

1. `bun run start`, open http://127.0.0.1:4242.
2. In another terminal, from any folder with a package.json:
   `sh -c "bun -e 'Bun.serve({port:3999,fetch(){return new Response(\"hi\")}});setInterval(()=>{},1e6)'; exit 0"`.
   The trailing `; exit 0` matters: with a single command, `sh -c` execs it in
   place and there is no tree to discover.
3. Within 3 seconds a row appears under "Other" on port 3999 with that folder's name.
4. Select it and choose **Pin** from the log `···` menu. The row meta still shows
   it running. `~/.devboard/services.json` has one entry.
5. Switch it off. The terminal command exits; the row shows `stopped · saved`.
6. Switch it on. The row comes back running. The log pane shows the start header
   and any output. The terminal from step 2 shows nothing, because devboard owns
   the process now.
7. Press Ctrl-C on devboard. `curl localhost:3999` still answers `hi`.
8. Start devboard again. The row is still there. Press `r` to restart. The pid
   changes, the log gets a second header. Switch it off, then **Remove** from the
   log menu.

`bash scripts/smoke.sh` runs these eight steps against a real devboard through the
API. Last run 2026-09-10: passed.

## For agents and contributors

`AGENTS.md` is the instruction file for any coding agent. `agents/` holds scoped
rules and role prompts. `design.md` is the UI spec. `docs/superpowers/` is the
original design and plan, kept for history.

## License

devboard is MIT. See `LICENSE`. The only npm dependency is `@types/bun` (dev-only, MIT).

The UI fonts under `public/fonts/` are SIL Open Font License 1.1: IBM Plex Sans
(Copyright © 2017 IBM Corp.) and JetBrains Mono (Copyright 2020 The JetBrains
Mono Project Authors). License texts are `public/fonts/OFL-IBM-Plex.txt` and
`public/fonts/OFL-JetBrains-Mono.txt`.
