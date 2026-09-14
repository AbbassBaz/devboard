# Implementation log

Plan: `suggestions/logs-plan.md`  
Branch: `plan/tier-5` (Tier 4 merged to main as `2a07516`)  
Baseline: `bun test` — 133 pass, 0 fail (2026-09-11). After Tier 1: 144. After Tier 3: 190. Tier 4 baseline: 190 pass, 0 fail (2026-09-12); 227 after F-33. Tier 5 baseline: 227 pass, 0 fail (2026-09-14); 260 after F-40. No linter.

Precondition: landed uncommitted fonts, fixture scrub, project links, and worktree pin copying as `91f5dc7`.

| ID | Title | Status | Notes |
|---|---|---|---|
| F-01 | Reject cross-origin and DNS-rebinding requests to the API | done | Gate in `handle` before `route`. Tray already sends `application/json`. Page and smoke now send JSON on DELETE too. Smoke not re-run: real board on :4242. |
| F-02 | Fix the edit sheets losing their id | done | `openSheet` now hides without resetting edit ids. Browser: Edit dashboard kept `editingId=dashboard-3001` and Save PUT succeeded; New project had null id; Edit project kept `coreagentshub`; close then Add/New project did not leak an id. |
| F-03 | Add a LICENSE file | done | MIT, copyright AbbassBaz 2026. `package.json` license field set. README License section names the OFL 1.1 fonts. |
| F-04 | Track the processes devboard spawns so status is real | done | `Tracked` in `state.json`. Unmatched live pid → `starting`; exit codes and `crash.gaveUp` on the row. GET `/api/services` no longer ticks crashes or writes projects. 152 pass. |
| F-05 | Contain log ids to the log directory | done | `isValidLogId` + resolved-path check. GET/DELETE `..%2F..%2Foutside` is 400; fixture unchanged. |
| F-06 | Make the tray build optional in `install` | done | No-swift PATH prints the skip line and exits 0 after the symlink. `tray:build` script added. |
| F-07 | CI on a macOS runner, with a smoke script that cannot touch a real board | done | macos-14 tests + macos-15 tray (Swift 6 skip if missing). Smoke waits for a discovered row after :3999 listens so the F-15 3s snapshot cannot hide it. Busy :4242 still aborts before any API call. |
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
| F-18 | Validate hand-edited registry JSON and serialize writes | done | Skip bad entries and log one line. GET leaves a `{ "nope": true }` file untouched. Per-path write queue + unique tmp names; 20 concurrent adds keep all 20. |
| F-19 | Reconcile AGENTS.md with the new direction and add CONTRIBUTING.md | done | Loopback-only wording; design.md is the current spec and can be amended in-PR. CONTRIBUTING.md covers the four gotchas. |
| F-20 | Refuse to retire a worktree while a server runs in it | done | Retire and orphan-remove 409 with names while running or starting under the path. Toast offers Stop and retire. Main-worktree protection unchanged. Browser: starting `wt-sleep` in a throwaway worktree blocked Retire; Stop and retire killed it and removed the checkout. |
| F-21 | Give saved services an identity that survives name collisions | done | `add` suffixes on id collision when cwd differs. `replace` keeps the id. Same cwd+port pin replaces in place. Existing `services.json` loads unchanged. |
| F-22 | CLI parity, `--json`, and a `doctor` command | done | `add`/`rm`/`pin`/`open`/`ls --json`/`doctor`. Smoke step [4] pins via CLI; step [9] round-trips add/ls/open/rm. Non-GET CLI calls always send JSON. |
| F-23 | Shareable pin template checked into a project | done | `devboard.json` at a project root. Import via + Add, worktree Import pins, Launch, and project Add from folder. Idempotent; never writes live status back. |
| F-24 | Point the tray at the same board as the CLI, and read the version from package.json | done | Tray reads `DevboardURL` from Info.plist. `build-tray.sh` writes it from `DEVBOARD_URL`/`PORT` and the version from `package.json`. Rebuild required for a new URL. |
| F-25 | Ask before restarting an unmanaged row with a lossy command | done | `commandLooksLossy` on rebuilt `ps` commands. Unpinned `POST /api/restart` by rootPid is 409 unless `confirm`. Page opens Edit; Save pins and restarts. |
| F-26 | Allow editing a preset | done | `PUT /api/presets/:id` keeps the id. Edit in the preset sheet; unknown id is 404. |
| F-27 | Stop running `du` on every worktree and Attention scan | done | `diskMb` cached by `.git` mtime, 10 min TTL. Attention passes `disk: false`. Card shows `…` until size arrives. |
| F-28 | Grow the tray: per-service actions and notifications | done | Per-row menu: Open, Restart, Stop, Copy run command, Logs (`?sel=`). One notification when `unhealthy` or `crash.gaveUp` flips. First poll is primed so existing alerts do not fire. |
| F-29 | Trace one request across several services' logs | done | `findIds` + `GET /api/trace`. Clickable ids in the log pane open a Trace view grouped by service. JSON `requestId` and kin become the token. No time-window fallback. |
| F-30 | Strip every terminal control sequence and resolve carriage returns | done | `cleanLine` runs CSI, OSC, and single-escape patterns, resolves `\r` to the last frame, then drops any remaining C0 byte except tab — that last sweep is beyond the plan text but is what makes the "no byte below 0x20" check true. Fixture holds real bytes. decision 1: recommendation used. Smoke could not run: the owner's board holds :4242, so it aborts with "abort: 4242 or 3999 already has a listener; refuse to drive a real board". |
| F-31 | Parse each line once on the server into `LogEntry` | done | `parseLine` and its seven parts in `lib/logs.ts`, types in `lib/types.ts`, `entries` from `/api/logs/:id` and `/api/trace`, `ERROR_LINE` gone from Attention, ten identifiers deleted from `app.js`. A tagged level wins over the HTTP status, as the plan words it. `$ ` and `> ` lines are no longer dim — the page has no regex for them and `entry.marker` is the honest signal; design.md says so. decision 3: recommendation used. Smoke aborted as above. |
| F-32 | Fetch the selected log incrementally and append to the DOM | done | `logs[id]` is `{entries, next, base}`; `?from=` every 1 s, append-only DOM, 10 000 cap with a front drop. Line keys are absolute so a trim never rebuilds: the first attempt rebuilt 10 000 lines (192 ms) every second at the cap and `↓ N new` never counted. Idle poll measured at 96 B with `curl` (no DevTools in this environment). decision 4: recommendation used. Smoke aborted as above. |
| F-33 | Put the page's pure log logic in `public/log-view.js` and test it with `bun test` | done | Eight pure functions, 10 tests, `app.js` is a module. Two deviations: `server.ts` had to serve the new file (not in Touches; the page 404'd without it), and the "pure functions move" rule was applied to log-pane logic, not to sidebar or HTML helpers. Smoke aborted as above. |
| F-34 | Level badge gutter and structured line layout | done | 3-character badge in the gutter, warn and info text back to `#c3c8d1`, error tint kept. `logger` is a button that searches for it, `ctx` folds behind `{…}` with ⌥click for the whole pane, request lines colour method/path/status/duration. Eight new pure functions; `linkIds` became `richText` over merged spans so ids keep priority. Open contexts are keyed by `base + i`, and toggling one patches its node instead of repainting — a repaint would throw away the reading position. Two sets, not one: a head can have both a context and (after F-35) a tail. decision 2: recommendation used. `{"pid": 72519}` still stays in the message: `parseStructured` folds only a trailing object of 20 characters or more (F-31, left alone). Smoke aborted as above. |
| F-35 | Fold continuation lines under their parent and collapse repeats | done | `foldEntries` + `collapseRepeats` + `visibleGroups`; the body renders groups, not lines, and `errorIndexes` returns heads only. Two judgment calls, both commented in the code: the repeat key ignores the folded `ctx` when the entry has a `msg`, or the nine livekit `plugin registered` lines (which differ only inside their JSON) would never collapse and the Done-when could not be met; and only tail-free groups collapse, so a repeated crash dump never silently loses the frames of the copy it replaces. The append path re-renders the last group and appends the rest, which is why a group carries the `start` and `end` it covers. Browser: the emitter's dump reads as one head with `▶ +8 lines` (eight frames, not the nine of the owner's `docs-3010.log`, which was not read), exactly one crash open at a time, `e` lands only on heads, nine near-identical lines collapsed to `×9`. Smoke aborted as above. |
| F-36 | The toolbar: search, levels, errors, this run, freeze, clear | done | The contract's row in its order; `logFilter`, `followBtn`, `traceClose`, `errOnly`, and `follow` are gone (grep is 0 in both files). `levels`, `runOnly`, `wrap`, `showTs` persist in `localStorage["devboard.logView"]`; `frozen`/`held`/`viewStart` replace follow. Contract over item text in two places: `viewStart` is an absolute line key, not the buffer position the item names, because the buffer trims at 10 000 (Tier 4's rule); and while Trace is open the search field and Levels hide with the This run / Freeze / Clear group, because they do not filter trace hits — the contract only requires that group to become one Close button. Browser at 1280×800 with the sidebar at 380: `.log-tools` is 39px (38px of content plus the 1px border), one line, ending at x=1264. Smoke aborted as above. |
| F-37 | Search: matching, highlighting, stepping, syntax | done | `parseFilter` / `matches` / `matchSpans` / `matchIndexes`, memoised by `compileFilter`. A token whose flags are not real regex flags is a plain term, so `/_next/static` searches for that path instead of failing as a regex — F-40's own example needs it. `<mark>` nests inside id and request spans rather than being dropped, so searching `POST` highlights the method. Browser: `POST` left 222 lines all marked and read `1/222`, `⊘` restored 2674 with the same highlights, `/(/` reddened the field and showed nothing, Enter / ⇧Enter / `n` / `N` stepped, and a hit inside a folded tail opened its group. Smoke aborted as above. |
| F-38 | Run dividers and the unread divider | done | Markers render as dividers, not lines; `run N · time · command · 2m ago`. `runBoundaries` arrived early in F-36 (This run needed it) and is tested here. "Remove it when the tail is reached" is read as reaching the tail deliberately (`▶ Live`, `G`, or the Freeze button while frozen): selection change already scrolls a live view to the tail, so clearing it there would delete the divider in the frame it appeared. A full window reload also drops it, because that renumbers from zero. Smoke aborted as above. |
| F-39 | Open URLs and `file:line:col` from a log line | done | `findLinks` marks URLs and file references, skipping `node:`, `webpack-internal:`, `internal/`, and `node_modules` on the whole token. `openInEditor(path, line?, col?)` uses `-g` for cursor and code, `file:line:col` for subl; `POST /api/open` takes `{ path, line?, col?, cwd? }` and is 400 (not 500) for a resolved path that does not exist. Deviation: the "resolves under `cwd`" half of the Done-when is tested on `resolveOpenPath` in `test/worktrees.test.ts`, because driving the route with a path that exists spawns a real editor on whatever machine runs `bun test`; the browser check drove the whole route with a stand-in `cursor` on PATH that recorded `cursor -g /tmp/devboard-tier5/src/app/page.tsx:12:5`. Smoke aborted as above. |
| F-40 | Hide rules from the search field | done | `Hide these` in the search field saves a rule per service in `localStorage["devboard.logHide"]`; the `N hidden` chip toggles them and `Forget hide rules` in `···` drops them. `N hidden` counts the rules, not the lines: the item's own check (one rule over nine lines reading `1 hidden`) only holds that way, and the chip's title spells out the rules. Rules reuse the search syntax, so F-37's "impossible flags means a term" rule is what makes `/_next/static` work. Browser: hide, reload, toggle back dimmed at 0.45, forget — all as written; with two rules and the error chip the row is still one line ending at x=1264. Smoke aborted as above. |

## Tier 1 pause

All doable Tier 1 items are done. No blocked items. Nothing waiting on you for Tier 1.

Continue to Tier 2 only when you say go: F-04, F-10, F-11, F-12, F-15, F-16, F-17, F-18, F-20.

## Tier 2 pause

All doable Tier 2 items are done (F-04, F-10, F-11, F-12, F-15, F-16, F-17, F-18, F-20). No blocked items.

Continue to Tier 3 only when you say go: F-21, F-22, F-23, F-24, F-25, F-26, F-27, F-28, F-29.

## Tier 4 pause

All four Tier 4 items are done: F-30, F-31, F-32, F-33. Nothing is blocked and nothing
is waiting on you. Decisions 1, 3, and 4 were open, so the recommended option was used
in each case and is named in the row above; to reverse one, the item that applies it is
the only place to change. Decision 2 (badge gutter) belongs to F-34 and is still yours.

`bash scripts/smoke.sh` could not run at any point: the real board holds :4242, so the
script aborts by design with "abort: 4242 or 3999 already has a listener; refuse to
drive a real board". Everything else was checked, including browser work on a throwaway
board on :4342 with its own `DEVBOARD_HOME`.

Continue to Tier 5 only when you say go: F-34, F-35, F-36, F-37, F-38, F-39, F-40.

## Tier 5 pause

All seven Tier 5 items are done: F-34, F-35, F-36, F-37, F-38, F-39, F-40. Nothing is
blocked and nothing is waiting on you. Decision 2 was open, so the recommended option was
used — the level badge gutter, text back to the foreground colour, the error tint kept —
and it is named in F-34's row; that item is the only place to change to reverse it.
Decisions 1, 3, and 4 were applied in Tier 4.

Three Done-when checks were met a different way, each named in its row and in the PR:
`viewStart` is an absolute line key rather than a buffer position (F-36); the "resolves
under `cwd`" half of F-39 is tested on `resolveOpenPath` rather than through the route,
because the route would spawn a real editor during `bun test`; and `N hidden` counts hide
rules rather than lines (F-40). The toolbar contract overrode the item text twice, both in
F-36's row.

`bash scripts/smoke.sh` was run once and could not proceed: the owner's board holds :4242,
so it aborts by design with "abort: 4242 or 3999 already has a listener; refuse to drive a
real board". Everything else was checked, including browser work at 1280×800 on a throwaway
board on :4342 with its own `DEVBOARD_HOME` and a pin printing a line every 50 ms across all
five levels, plus a Node crash dump, a Python `time - LEVEL logger - msg {json}` line, a
pino JSON line, and Next request lines.

After merging, restart the board on :4242. It serves `public/` from disk but holds its
routes in memory, and `/api/open` changed in F-39.

Continue to Tier 6 only when you say go: F-41, F-42, F-43, F-44.

## Noticed

- `suggestions/` is untracked and not in `.gitignore`. Left untracked; not part of the product.
- Existing board on `:4242` blocked a full local `scripts/smoke.sh` run. The abort-if-busy path was verified instead.
- `bun run setup` with Swift present was run once by mistake while testing F-06 (replaced the existing tray app). The no-Swift skip path was then verified separately.
- AGENTS.md test count was 133; suite is 144 after Tier 1. Updated in F-19.
- No browser test harness (plan Gaps). F-02 was verified by hand on the live board.
- Throwaway screenshot board used `PORT=4342` so it would not touch the real board.
- Tier 4: `public/` cannot import `lib/`, so `log-view.js` and `lib/logs.ts` will hold two copies of `parseFilter` / `matches` when F-44 lands. The plan names this and asks for a shared fixture test.
- Tier 4: the log window is the last 4 000 lines, so displayed line numbers start at 1 for whatever the window begins with, not at the file's own first line. They stay monotonic within a session, which is what F-32 asks for.
- Tier 4: `app.js` is an ES module now, so its top-level bindings are not reachable by name from the devtools console. Debug through the DOM or export from `log-view.js`.
- Tier 5: the throwaway board keeps its routes in memory, so a server change (F-39) needs it restarted before a browser check can see it. `public/` is read from disk per request and does not.
- Tier 5: F-44 will want `parseFilter` in `lib/logs.ts` too. The page's version treats a `/…/` token whose flags are not real regex flags as a plain term (so `/_next/static` is a path, not a broken regex); the shared fixture test the plan asks for has to cover that, or the two copies will disagree.
- Tier 5: nothing in the pane hides behind a right-click or a shortcut alone. If Tier 6 adds an action, the contract says it needs a visible control on the row or an item in the `···` menu.
- Tier 5: the level badge occupies a 3ch gutter column on every line, and `richText` merges id, link, and request spans with `<mark>` nested inside. F-41's diagnosis card and F-42's problems menu should reuse `visibleGroups` and `errorKeys` rather than re-deriving heads.
