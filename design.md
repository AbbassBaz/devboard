# Graphite workspace

Standing UI rules for `public/index.html`, `public/app.js`, and `public/app.css`. Match the tokens, shell, and behaviour here; if they need to change, amend this file in the same PR and say why. Vanilla JS + Bun, no frameworks. No server changes for UI work; wire actions to the existing `/api/*` endpoints.

## Principles

- Two jobs on one screen at all times: **see what's running** (sidebar) and **read its logs** (right pane).
- One primary action per zone. Everything else lives in a `···` menu.
- Error and follow controls appear only when relevant.
- Keyboard-first. Keys are ignored while an input is focused (`Esc` blurs).
- Dense, IDE-like, dark. No grain, gradients, display type, or card-grid chrome.
- Secondary surfaces (worktrees, projects, presets, attention, env, full edit) open as overlay sheets from the top-bar or log `···` menu — never as extra top-level views.

## The page

Dark, dense, keyboard-first. Three fixed rows: a 44px top bar, the workspace, and a 28px status bar with the key map. The workspace is a sidebar and a log pane.

**Top bar.** Counts of servers up, down, and with errors in their log. A clock. `+ Add` opens the add form. `···` holds Start all, Stop all, and the sheets: Worktrees, New project, Presets, Attention.

**Sidebar.** One row per dev server, grouped under its project (or "Other"). Each row has a state dot, the name, a port link, `pid · cpu · MB · uptime` when running, an error count when the log has errors, a CPU bar, and a switch. The switch is the state: green and on means running, grey and off means stopped, amber means starting or stopping. Switching off kills the process tree; an unpinned server is pinned first so it stays on the board and can be switched back on. Switching on runs the saved command. Each group header has its own `start` and `stop` for the whole project. The filter box at the top matches name or port; `/` focuses it. System processes (Postgres, Redis, macOS services) sit in a collapsed **System** list with only a Kill action. Hidden servers sit in a collapsed **Hidden** list with a Show action.

**Log pane.** The selected server: dot, name, `localhost:PORT ↗`, and state. One primary button: **Start** when stopped, **Restart** when running. `···` holds Open in browser, Open in editor, Copy run command, Show errors only, Follow, Clear log, then Pin or Edit, Env, Add to or Remove from a project, Hide, and Remove. Under that, click-to-copy `cwd` and `$ command`. The toolbar has a text filter, an error chip that appears only when the log has errors (click jumps to the next one, shift-click shows errors only), and a `↓ Resume follow` button that appears only when you have scrolled away from the tail. Lines are coloured by content: errors red, warnings amber, ready and listening green. Click a line to copy it. Id-shaped tokens (UUID, 16+ hex, `req-`/`req_`, W3C trace id) are accent buttons that open a Trace view in this pane; JSON lines with `requestId` / `reqId` / `traceId` / `trace_id` / `correlationId` / `x-request-id` also get a small id label. Timestamps show only when the log has them.

**Keys.** `↑↓` or `j`/`k` select. `space` toggles the selected server. `r` restarts. `e` jumps to the next error. `c` copies `cd <cwd> && <command>`. `o` opens the port in the browser. `/` focuses the filter. `Esc` closes a menu or sheet. Keys are ignored while an input has focus.

**Sheets.** Worktrees, projects, presets, attention, env, and the full server edit open as overlays from the `···` menus. `Esc` or a click on the backdrop closes them. Destructive actions (stop all, stop project, kill system, remove, clear log) ask first. Retire and orphan-remove refuse while a server is running or starting under that path (409, then the status-bar Stop and retire action). The env sheet masks secret-looking live values and has a Reveal text button; a note says `ps eww` cuts values at the first space.

The token, layout, and state rules below are the rest of the spec.

## Shell

```
body:  height 100vh; display:grid; grid-template-rows: 44px 1fr 28px; background #16181c
work:  display:grid; grid-template-columns: minmax(300px, 380px) 1fr
```

Fixed two-column workspace (sidebar min 300px). Header rows wrap rather than clip. Everything uses `font-variant-numeric: tabular-nums`.

## Tokens

### Color

| Role | Hex | Use |
|---|---|---|
| bg | `#16181c` | page, log pane, inputs |
| surface | `#191c21` | sidebar, log filter field |
| bar | `#1c1f24` | top bar, status bar, add form, sheets |
| menu | `#1f232a` | menus, log-line hover |
| hover | `#23272e` | row hover, text-button hover |
| sel | `#242932` | selected row |
| border | `#2a2e35` | major edges |
| border-sm | `#22262c` | log meta / toolbar |
| border-btn | `#2f343c` | buttons, menus |
| focus | `#4a5160` | input focus, control hover, line numbers |
| fg | `#d7dae0` | primary text, count numbers, key glyphs |
| secondary | `#aeb4bf` | group labels, outlined button text |
| dim | `#8b919c` | meta, stopped names, empty copy, hints |
| timestamp | `#5d636e` | log times, menu key hints |
| accent | `#8ab4f8` | brand mark, links, add/primary sheet, caret, copy toast |
| ink | `#0f1420` | text on accent / green fills |
| running | `#4fb477` | on-dot, on-switch, Start fill |
| busy | `#d4a72c` | starting/stopping |
| error | `#e5534b` | counts, chips, kill hover, Remove |
| error-fg | `#f28b82` | error log text |
| warn | `#e2b96a` | warning log text |
| ok | `#8fd3a6` | success log text |
| off | `#3a3e46` | stopped dot, switch border |

Selection highlight: `#3a4a66`. Scrollbar thumb: `#3a3e46`.

### Type

- UI: IBM Plex Sans 400/500/600 — 14 pane title, 13 base, 12 buttons, 11 labels. Line-height 1.45.
- Data: JetBrains Mono 400/500/600 — 12 data and log, 11 meta and hints. Log line-height 1.6.
- Ports, pids, metrics, paths, log text, clock, and key hints are always mono.

### Space, radius, height, motion

- Spacing scale: 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20.
- Radii: 3 log line, 4 chips and menu items, 5 buttons and inputs, 6 rows, 7 menus, 8 switch. Brand mark radius 2.
- Heights: top/log-A 44, status 28, toolbar 38, controls 26, inputs 28, switch 16×30, `···` 28×26.
- Transitions: hover bg `.12s`; switch `.2s`; CPU bars `.8s cubic-bezier(.2,.8,.2,1)`.
- Shadows: menu `0 12px 32px rgba(0,0,0,.5)`; running dot `0 0 0 3px rgba(79,180,119,.15)`.
- Respect `prefers-reduced-motion`.

## Zones

### Top bar — 44px, `#1c1f24`, border-bottom `#2a2e35`, padding `0 16px`, gap 20

- Brand: 8×8 `#8ab4f8` square + “devboard” 600.
- Counts, mono 12 dim: `N up` (number `#d7dae0`); `N down` (whole span `#d7dae0` if >0 else dim); `N err` (`#e5534b` if >0 else dim); `N unhealthy` (error token if >0). Errors come from `errorCount` on the service row.
- Right: clock `HH:MM:SS` mono 12 dim · `+ Add` · `···`. Menu: Start all · Stop all · ─ · Worktrees… · New project… · Presets… · Attention….

### Sidebar — `#191c21`, border-right `#2a2e35`

- Filter 28px, radius 5, bg `#16181c`, placeholder “Filter servers  /”. Name or port. `/` focuses it.
- `+ Add` opens an inline form under the filter (bg `#1c1f24`): name, folder, command \| port (`1fr 80px`), Cancel / **Add** (accent fill, ink, 600). Folder blur → `GET /api/suggest` and `GET /api/import`. When the folder has a `devboard.json` with pins that are not already saved, **Import N pins** appears on the left of the actions and POSTs `/api/import`. Submit → `POST /api/pinned`. Extra fields (health, env, restart-on-crash) stay on the Edit sheet.
- Group header (`10px 12px 4px`, 11px): uppercase 600 `.06em` `#aeb4bf` (project name, or “Other”) · mono `running/total` dim · localhost port links `:3000` and any saved project links · project text buttons `start` / `stop` (hover `#23272e`, green / red) → `/api/projects/:id/start|stop`.
- Row: `10px 1fr auto auto`, gap 10, margin `0 6px`, padding `7px 8px 7px 10px`, radius 6. Selected `#242932`, hover `#23272e`. Click selects.
  - Dot 8px: running `#4fb477` + ring; busy `#d4a72c` pulse `.8s`; stopped `#3a3e46`; running + `readiness: unhealthy` uses the error token and an `unhealthy` title.
  - Name 500 (`#8b919c` if stopped) + port link `:3003` → `http://localhost:PORT`.
  - Meta mono 11 dim: running `pid · cpu% · MB · up`; append `health <status> · <ms>ms` or the probe error when unhealthy; busy/starting `starting… waiting for :PORT`; stopped `stopped · saved` / `stopped` / `stopped · exit N` when a tracked process exited with that code.
  - Error pill only if >0: 600 11 `#e5534b` on `rgba(229,83,75,.12)`. `restart failed ×5` in the same token when crash-restart gave up.
  - CPU bar 40×3, track `#2a2e35`, fill accent (error above 75% of scale). Width `cpu/6*100%`, capped.
  - Switch 30×16: on green / knob `#0f1a14` +14px; busy amber wash, `cursor: progress`; off `#23272e` / `#3a3e46` / dim. Same start / pin-then-kill as today. `stopPropagation` — do not change selection.
- System `<details>` collapsed: hollow dot, name + ports, ellipsized command, `kill` → confirm → `POST /api/kill`. Hidden cards stay in a collapsed Hidden group.

### Log pane — `#16181c`

**A** (min 44, `8px 16px`, wrap, border `#2a2e35`): dot · name 600 14 · `localhost:PORT ↗` · state dim (`unhealthy` in the error token when the probe fails). Primary: **Start** green fill when stopped; **Restart** outlined when running; `starting…` disabled when busy. Then `···` (200px menu): Open in browser (`o`) · Open in editor · Copy run command (`c`) · ─ · Show errors only / Show all · Follow / Stop following · Clear log · ─ · Pin (unpinned) · Edit… (pinned) · Env… · Add to / Remove from project · Hide · Remove (red, pinned).

**B** (30px, mono 11 dim, border `#22262c`): click-to-copy `cwd` and `$ command` (glyph `#4a5160`, hover `#d7dae0`); `pid · cpu · MB · up` when running.

**Toolbar** (min 38, `6px 16px`, wrap, border `#22262c`): log filter (26px, flex 1, min 120). Error chip only if the log has errors — click cycles next error, ⇧click toggles errors-only (`1 error ↓` → `error 1/3 ↓` → `errors only · 3`). `↓ Resume follow` (accent outline) only when follow is off; while follow is off it reads `↓ N new` for the lines that have arrived since, and the count resets when follow resumes. Right: `N lines` or `k/N lines`, `title` = log path. While Trace is open the filter, error chip, and follow hide; **Close trace** and `N hits` take their place.

**Body** (`10px 16px 20px`, mono 12 / 1.6, `#c3c8d1`):
- Every line is cleaned before it is rendered: CSI, OSC, and single-character escape sequences removed and a `\r` progress bar resolved to its last frame (`cleanLine` in `lib/logs.ts`). No raw control byte — `[?25h` and friends — ever reaches the pane, and a download bar shows one line, not every frame.
- Line: flex, gap 14, pad `0 8px`, margin `0 -8px`, radius 3, `cursor: copy`; hover `#1f232a`. Columns: ln 30px right `#4a5160` · time `#5d636e` · text.
- Color by `entry.level` from `GET /api/logs/:id`: error → `#f28b82` on `rgba(229,83,75,.1)`; warn → `#e2b96a`; info → `#8fd3a6`; a devboard marker (`entry.marker`) → dim. The level is decided once, on the server, by `classifyLine` in `lib/logs.ts`: a tagged level (a `LEVEL logger - msg` prefix or a JSON `level` field) first, then the HTTP status (5xx error, 4xx warn), then the word heuristics. Error pills and the top-bar count use `errorCount` from `GET /api/services`, which reads the same classifier.
- Current error: `box-shadow: inset 2px 0 0 #e5534b`.
- Blinking 7×14 accent caret at the tail while running (1s steps).
- Empty (Plex, dim, max 520): stopped → “*name* is stopped…” + Start; unmanaged running → “Started outside devboard…”; filtered → “Nothing matches the current filter.”
- Click a line copies its text. If lines have no timestamps, omit the time column — do not invent times.
- Id tokens use the accent wash (`rgba(138,180,248,.12)`). Click opens Trace for that token. Default services: the selected row's project members, else every running `dev` row.
- Trace stays in this pane (not a sheet): token, one chip per service, hits grouped by service in file order. A chip or hit jumps to that log at that line and highlights it. Esc or Close leaves Trace. No time-window fallback — children write straight to the file, so lines have no board timestamp.

### Status bar — 28px, `#1c1f24`, border-top `#2a2e35`, mono 11 dim, `0 12px`

`↑↓` select · `␣` on/off · `r` restart · `e` next err · `c` copy run cmd · `o` open · `/` filter. Keys `#d7dae0`. Right: `poll 3s · 127.0.0.1:4242`. Copy toast 1.6s here: `copied · <text>` accent / dim. Retire or remove while a server is running or starting in that checkout shows `Stop and retire · <names>` for 8s with a text-button action that kills those rows and retries.

### Overlay sheets

Graphite surfaces (`#1c1f24`, border `#2a2e35`, radius 7, same shadow). Used for worktrees, project create/edit, presets, attention, env, and full server edit. Clicking the dimmed backdrop or `Esc` closes. Do not revive the old tabbed board. A worktree card shows disk as `…` until size arrives (Attention skips `du`). A worktree card shows **Import pins** when that checkout has a `devboard.json`. Launch and project Add from folder import the same file when it exists (idempotent, no overwrite). A preset row has Edit; it pre-fills the form and PUTs `/api/presets/:id` (set the editing id after `openSheet`).

## Behaviour

- Select by row click or `↑↓` / `j`/`k` through **visible** (filtered) rows. Changing selection resets the error cursor, closes Trace, and, if follow is on, scrolls the log to the tail. Persist `sel` in `localStorage`. `?sel=<id>` (tray Logs) selects that row on load and writes the same key.
- `Space` toggles the selected server. `r` restarts if running. Restarting an unpinned row whose command still has quotes or shell metacharacters (rebuilt from `ps`) returns 409 and opens Edit so you can check quoting; Save pins and restarts. `e` next error. `c` copies `cd <cwd> && <command>`. `o` opens `http://localhost:<port>`.
- Busy is optimistic: switch, dot, and primary go amber until `/api/services` agrees (or 15s). On start, append `=== devboard start · <cmd>` and `$ <cmd>` immediately.
- Follow is on by default. Next-error turns it off. Resume follow turns it on and jumps to the tail. Scrolling away from the tail also turns it off.
- Poll `/api/services` every 3s. The selected log loads `?lines=4000` once, then polls `?from=<byte cursor>` every 1s and appends only what arrived — an idle poll is a few hundred bytes and nothing already on screen is re-rendered. A full repaint happens only when view state changes (selection, filter, errors-only, status). The page keeps at most 10 000 entries: older ones drop off the front and the line numbers keep counting up. `reset` (the log was cleared or rotated) reloads the window.
- Copy via `navigator.clipboard.writeText`, then the status-bar toast.
- One open menu. Outside click or item click closes it.
- Destructive actions (stop all, project stop, kill system, remove, clear log) still confirm.

## State

`servers[]`, `busy{id: "starting"|"stopping"}`, `sel`, `query`, `logFilter`, `errOnly`, `follow`, `errCursor`, `jumpLine`, `trace` (`null|{token, groups}`), `menu` (`null|"top"|"log"`), `addOpen`, `toast`, `logs{id: LogEntry[]}`.

## Endpoints

`/api/services`, `/api/logs/:id` (returns `LogTail`: `entries: LogEntry[]` parsed by `lib/logs.ts`, plus `path`, `size`, `next`, `reset`; there is no `lines` or `levels` array), `/api/trace` (hits are `LogEntry`), `/api/start`, `/api/restart`, `/api/kill`, `/api/pin`, `/api/pinned`, `/api/projects/:id/start|stop|members`, `/api/suggest`, `/api/import`, `/api/open`, plus existing worktrees / presets / attention / env / ignore routes for the sheet features.

## Do not

- Introduce a framework, a new typeface, or a new palette.
- Put Worktrees / Attention / Presets back in a top-level tab bar.
- Show error chips, resume-follow, or empty-state buttons when they do not apply.
- Fabricate log timestamps.
- Copy prototype runtimes or mock HTML into `public/`.
