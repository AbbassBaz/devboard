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
`services.json` (pinned list) and `logs/<id>.log` live.

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
- **Logs.** Last 200 lines of that file, refreshed every 2 seconds.

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
