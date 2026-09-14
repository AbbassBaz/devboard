# devboard: agent guide

Instructions for any coding agent working in this repo, whatever tool or model runs it. This is the only instruction file. Scoped rules and role prompts live in `agents/`.

## What this is

A localhost dashboard for the dev servers on one Mac. Bun server on `127.0.0.1:4242`, vanilla JS page, a `devboard` CLI, and a Swift menu bar extra. It discovers listening processes with `lsof` and `ps`, collapses each dev-wrapper chain into one row, and can kill, start, restart, pin, group, and tail logs for them.

Loopback only by design; no remote mode or auth.

## Commands

```
bun install
bun run start                 # server + menu bar extra
bun run dev                   # restarts on file change
bun test                      # 260 tests, ~10s, one live test spawns a real process on :39999
bash scripts/smoke.sh         # end-to-end against a real board; needs :4242 and :3999 free
bun run devboard -- <cmd>     # CLI without installing
bun run setup                 # symlink `devboard` into ~/.local/bin, build + install the tray app
DEVBOARD_TRAY=0 bun run start # server only, no menu bar extra
```

## Layout

| Path | Owns |
|---|---|
| `server.ts` | `createHandler(deps)` with every `/api/*` route in one `route()` function, the 3s crash-restart tick, and the `Bun.serve` bootstrap under `import.meta.main` |
| `lib/types.ts` | Every shared shape. Read this first. |
| `lib/discover.ts` | `lsof` + `ps` parsing, wrapper walk to the root pid, `groupServices` |
| `lib/merge.ts` | Joins running rows to pinned entries by `cwd` + port into `Service[]` |
| `lib/registry.ts` | `~/.devboard/*.json` reads and atomic writes. `DEVBOARD_HOME` overrides the dir. Files are re-read per request, never cached. |
| `lib/control.ts` | Spawn detached via `/bin/sh -c`, log append with 5 MB cap and 2 MB keep (rotate while the board runs), `killTree` (SIGTERM, then SIGKILL after 3s) |
| `lib/health.ts` | Explicit health URL probes only. No URL means ready. |
| `lib/restarts.ts` | `CrashWatch`: 5 tries, exponential backoff, disarmed by stop/kill |
| `lib/env.ts` | `KEY=value` parsing, live `ps -Eww` env read |
| `lib/logs.ts` | `cleanLine` (control sequences, `\r`), `parseLine` into `LogEntry`, `classifyLine`, `findIds`. The only parser; the page, the CLI, Trace, and Attention all read it. |
| `lib/attention.ts` | Alerts: port conflicts, crashed, dirty worktree, log dir size |
| `lib/projects.ts` | Project membership and aggregate views |
| `lib/worktrees.ts` | `git worktree` scan, create, retire, prune, open in editor |
| `lib/suggest.ts` | Command suggestions from `package.json`, Compose, Procfile |
| `lib/template.ts` | `devboard.json` pin template parse and import plan |
| `public/` | The whole UI. `index.html`, `app.js`, `app.css`. No build step. `app.js` is an ES module. |
| `public/log-view.js` | The log pane's pure logic: `LogEntry[]` and view state in, arrays out. No DOM, so `bun test` imports it (`test/log-view.test.ts`). |
| `bin/devboard.ts` | CLI. Talks to the board over HTTP at `DEVBOARD_URL`. |
| `tray/` | SwiftPM menu bar app. Built by `scripts/build-tray.sh` into `tray/Dist/Devboard.app`. |
| `test/` | One file per lib module plus `server.test.ts`. |
| `design.md` | The current UI spec for `public/`. Amend it in the same PR as a UI change and say why. |
| `agents/` | Scoped rules and role prompts. Plain markdown, no tool-specific format. |

## Before you change code

- Read `lib/types.ts` and the one `lib/` module you are touching. Do not load all of `public/app.js` unless the task is UI; find the function you need instead.
- UI work: read `design.md` in full first. It is the current UI spec; amend it in the same PR as a UI change and say why.
- Log-pane logic that does not touch `document`, `window`, `fetch`, or `localStorage` lives in `public/log-view.js` and gets a test in `test/log-view.test.ts`. `app.js` imports it; do not copy a pure function back into `app.js`.
- Bug reports: reproduce with `bun test -t "<name>"` or a `curl` against a running board before editing.

## Rules

**Bun and vanilla only.** No frameworks, no bundler, no new runtime deps without a written reason. `@types/bun` is the only dev dependency.

**Bind to 127.0.0.1.** The API kills processes and runs saved shell commands. Never widen the host, add CORS, or accept a remote URL for the board. `handle` rejects non-loopback Host/Origin (403), cross-site `Sec-Fetch-Site` (403), and non-JSON mutations (415). Tests may pass `allowedHosts` on `Deps`.

**UI follows `design.md`.** Match its tokens, shell, keyboard map, and menus. The scoped rule for this is `agents/graphite-ui.md`; apply it whenever a change touches `public/` or `design.md`. If a token or rule in `design.md` needs to change, amend it in the same PR and say why. Do not change the server to make a UI change easier.

**Data shape first.** New behaviour starts as a type in `lib/types.ts`, then a pure function in `lib/`, then a route, then UI. Keep `lib/` free of I/O where a parser can take text instead (`parseListeners(text)`, `parseWorktreeList(text)`), so tests feed fixtures instead of shelling out.

**Dependency injection at the top.** `createHandler({ discover, registry, control, crashes })` is how tests drive the server with a fake `discover` and a temp `DEVBOARD_HOME`. Do not reach for globals inside routes.

**Storage is plain JSON under `~/.devboard`.** `services.json`, `projects.json`, `presets.json`, `ignored.json`, `logs/<id>.log`. Writes go through `Registry` and are atomic (write temp, rename). Hand edits must keep working, so never cache these in memory.

**Idempotent operations.** Pin twice replaces. Start on an already running service returns 409 instead of spawning a duplicate. Kill on a dead pid is fine. Keep it that way.

**Destructive actions confirm in the UI, never in the API.** Stop all, project stop, kill system, remove, clear log.

## Verify before you say done

```
bun test
bash scripts/smoke.sh        # after server.ts, control, discover, or registry changes
```

For UI changes, start the board with `DEVBOARD_TRAY=0 bun run start`, open `http://127.0.0.1:4242`, and check the result against `design.md`. A screenshot beats a description. The role prompts in `agents/` exist for exactly these two checks; run them as a subagent, a second session, or by hand.

## Do not

- Commit `tray/.build/` or `tray/Dist/`. Both are ignored.
- Run `devboard install` or `bun run setup` unless asked. They write to `~/.local/bin` and `~/Applications`.
- Add tool-specific instruction files (`.cursor/`, `.claude/`, `.github/copilot-*`, and so on). Everything goes here or in `agents/`. A GitHub Actions workflow at `.github/workflows/ci.yml` is allowed.

## Gotchas that have already cost time

- `sh -c "cmd"` with a single command execs in place and leaves no tree to discover. Tests and the smoke script use `sh -c "cmd; exit 0"` to keep `sh` as the root.
- The wrapper walk stops at devboard's own pid. Services devboard starts must keep their own row; do not "fix" the walk to climb further.
- `npx foo --port 3001` shows in `ps` as `npm exec foo --port 3001`. Save it as `npm exec -- foo --port 3001` or npm eats the flag.
- Matching is `cwd` + port. If that misses and exactly one running `dev` row shares the cwd and the same command with `--port`/`-p`/`PORT=` stripped, the view adopts that row. The saved port is not rewritten. Two candidates stay unmatched.
- Health probes only run with an explicit URL. Probing `/` by default floods dev server logs.
- Restart-on-crash must be disarmed by stop and kill, or a clean shutdown bounces back.
- Log files exist only for services devboard started. There is no way to attach to a terminal's stdout on macOS.
- Killing a System row (Postgres, Redis, ControlCenter) usually gets it relaunched by launchd or Homebrew. Not a bug.

## Testing conventions

- `bun:test`. `describe` per unit, `test` names read as sentences that state the behaviour.
- Pure parsers get fixture text inline in the test. Filesystem tests get `mkdtempSync` and a fresh `Registry` or `Control` per test.
- `server.test.ts` builds a handler with `discover: async () => running` and mutates `running` between calls.
- Spawned processes are tracked and `SIGKILL`ed in `afterAll`.
- One live test (`discover.live.test.ts`) spawns a real listener. Keep it to one.

## Writing

Short declarative sentences. No marketing tone. README describes what exists, not what is planned. Commit subjects are `type: summary` in lower case (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`).
