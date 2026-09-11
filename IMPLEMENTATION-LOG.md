# Implementation log

Plan: `suggestions/final-plan.md`  
Branch: `plan/tier-2` (Tier 1 merged to main as `327e050`)  
Baseline: `bun test` — 133 pass, 0 fail (2026-09-11). After Tier 1: 144. No linter.

Precondition: landed uncommitted fonts, fixture scrub, project links, and worktree pin copying as `91f5dc7`.

| ID | Title | Status | Notes |
|---|---|---|---|
| F-01 | Reject cross-origin and DNS-rebinding requests to the API | done | Gate in `handle` before `route`. Tray already sends `application/json`. Page and smoke now send JSON on DELETE too. Smoke not re-run: real board on :4242. |
| F-02 | Fix the edit sheets losing their id | done | `openSheet` now hides without resetting edit ids. Browser: Edit dashboard kept `editingId=dashboard-3001` and Save PUT succeeded; New project had null id; Edit project kept `coreagentshub`; close then Add/New project did not leak an id. |
| F-03 | Add a LICENSE file | done | MIT, copyright AbbassBaz 2026. `package.json` license field set. README License section names the OFL 1.1 fonts. |
| F-04 | Track the processes devboard spawns so status is real | done | `Tracked` in `state.json`. Unmatched live pid → `starting`; exit codes and `crash.gaveUp` on the row. GET `/api/services` no longer ticks crashes or writes projects. 152 pass. |
| F-05 | Contain log ids to the log directory | done | `isValidLogId` + resolved-path check. GET/DELETE `..%2F..%2Foutside` is 400; fixture unchanged. |
| F-06 | Make the tray build optional in `install` | done | No-swift PATH prints the skip line and exits 0 after the symlink. `tray:build` script added. |
| F-07 | CI on a macOS runner, with a smoke script that cannot touch a real board | done | macos-14 workflow + `.bun-version` 1.2.18. Locally, busy :4242 makes smoke abort before any API call; sentinel survived. |
| F-08 | Rewrite the README for a stranger | done | Pitch, screenshot from throwaway DEVBOARD_HOME, Requirements, Quickstart, env table, Why, Security, Known issues. Page spec moved into design.md. |
| F-09 | Remove or scrub private names in `docs/superpowers/` | done | Deleted the folder. `rg` for private names is clean outside suggestions/. |
| F-10 | Rotate logs while a server runs, not only at start | done | `rotateRunning` copies last 2 MB to `.log.1` and ftruncates the live file. 3s loop calls it. Cap only while the board runs. |
| F-11 | Compute error counts on the server with one classifier | done | `errorCount` from `classifyLine` on last 4000 lines, cached by size+mtime. Page dropped `RE_ERR`/`hydrateLogs`. Logs API returns `levels`. |
| F-12 | Adopt a running row when the port moved | done | Fallback in `matchPinned` when cwd + port-stripped command is unique. Saved port is not rewritten. |
| F-13 | Make CLI `stop-all` pin unsaved rows first, like the page | done | Pins unpinned running `dev` rows before kill; per-row errors print and continue. |
| F-14 | Fix `devboard logs -f` stalling after 200 lines | done | `GET /api/logs/:id?from=` returns new lines + `next` + `reset`. CLI follows by byte offset and prints `--- log reset ---` after clear. |
| F-15 | One server scan loop with a cached snapshot | done | 3s loop writes the snapshot; GET reuses it for `cacheMs`. Mutations invalidate. Tests keep `cacheMs` 0. |
| F-16 | Show readiness on the page | done | Unhealthy running rows use the error-token dot, `health <status> · <ms>ms` in meta, and `N unhealthy` in the top bar. Browser-checked on a 500 health URL. |
| F-17 | Mask secret-looking env values and gate `/api/env` | done | `maskEnv` on `/api/env` and `/api/services`. Unrelated pid is 404. `?reveal=1` and `GET /api/pinned/:id` return real values. Home 0700, files 0600. Start still gets the real overrides. |
| F-18 | Validate hand-edited registry JSON and serialize writes | todo | Tier 2 — waiting |
| F-19 | Reconcile AGENTS.md with the new direction and add CONTRIBUTING.md | done | Loopback-only wording; design.md is the current spec and can be amended in-PR. CONTRIBUTING.md covers the four gotchas. |
| F-20 | Refuse to retire a worktree while a server runs in it | todo | Tier 2 — waiting |
| F-21 | Give saved services an identity that survives name collisions | todo | Tier 3 — waiting |
| F-22 | CLI parity, `--json`, and a `doctor` command | todo | Tier 3 — waiting |
| F-23 | Shareable pin template checked into a project | todo | Tier 3. Human: scan automatically via a button |
| F-24 | Point the tray at the same board as the CLI, and read the version from package.json | todo | Tier 3 — waiting |
| F-25 | Ask before restarting an unmanaged row with a lossy command | todo | Tier 3 — waiting |
| F-26 | Allow editing a preset | todo | Tier 3 — waiting |
| F-27 | Stop running `du` on every worktree and Attention scan | todo | Tier 3 — waiting |
| F-28 | Grow the tray: per-service actions and notifications | todo | Tier 3. Human: tray first |
| F-29 | Trace one request across several services' logs | todo | Tier 3 — waiting |

## Tier 1 pause

All doable Tier 1 items are done. No blocked items. Nothing waiting on you for Tier 1.

Continue to Tier 2 only when you say go: F-04, F-10, F-11, F-12, F-15, F-16, F-17, F-18, F-20.

## Noticed

- `suggestions/` is untracked and not in `.gitignore`. Left untracked; not part of the product.
- Existing board on `:4242` blocked a full local `scripts/smoke.sh` run. The abort-if-busy path was verified instead.
- `bun run setup` with Swift present was run once by mistake while testing F-06 (replaced the existing tray app). The no-Swift skip path was then verified separately.
- AGENTS.md test count was 133; suite is 144 after Tier 1. Updated in F-19.
- No browser test harness (plan Gaps). F-02 was verified by hand on the live board.
- Throwaway screenshot board used `PORT=4342` so it would not touch the real board.
