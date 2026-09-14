# Graphite workspace

Standing UI rules for `public/index.html`, `public/app.js`, `public/log-view.js`, and `public/app.css`. Match the tokens, shell, and behaviour here; if they need to change, amend this file in the same PR and say why. Vanilla JS + Bun, no frameworks. No server changes for UI work; wire actions to the existing `/api/*` endpoints.

`index.html` loads `app.js` as an ES module, so it can import `log-view.js`, which holds the log pane's pure logic (`LogEntry[]` and view state in, arrays out) and is covered by `bun test`. Still no build step: the browser does the importing and the server serves the two files as they are.

## Principles

- Two jobs on one screen at all times: **see what's running** (sidebar) and **read its logs** (right pane).
- One primary action per zone. Everything else lives in a `···` menu.
- Error and freeze controls appear only when relevant; the level, search, freeze, and clear controls are always on the row.
- Keyboard-first. Keys are ignored while an input is focused (`Esc` blurs).
- Dense, IDE-like, dark. No grain, gradients, display type, or card-grid chrome.
- Secondary surfaces (worktrees, projects, presets, attention, env, full edit) open as overlay sheets from the top-bar or log `···` menu — never as extra top-level views.

## The page

Dark, dense, keyboard-first. Three fixed rows: a 44px top bar, the workspace, and a 28px status bar with the key map. The workspace is a sidebar and a log pane.

**Top bar.** Counts of servers up, down, and with errors in their log. A clock. `+ Add` opens the add form. `···` holds Start all, Stop all, and the sheets: Worktrees, New project, Presets, Attention.

**Sidebar.** One row per dev server, grouped under its project (or "Other"). Each row has a state dot, the name, a port link, `pid · cpu · MB · uptime` when running, an error count when the log has errors, a CPU bar, and a switch. The switch is the state: green and on means running, grey and off means stopped, amber means starting or stopping. Switching off kills the process tree; an unpinned server is pinned first so it stays on the board and can be switched back on. Switching on runs the saved command. Each group header has its own `start` and `stop` for the whole project. The filter box at the top matches name or port; `/` focuses it. System processes (Postgres, Redis, macOS services) sit in a collapsed **System** list with only a Kill action. Hidden servers sit in a collapsed **Hidden** list with a Show action.

**Log pane.** The selected server: dot, name, `localhost:PORT ↗`, and state. One primary button: **Start** when stopped, **Restart** when running. `···` holds Open in browser, Open in editor, Copy run command, then the rarely used view toggles (Wrap lines, Show timestamps, Expand all JSON), the copy variants, and `Clear log file…`, then Pin or Edit, Env, Add to or Remove from a project, Hide, and Remove. Under that, click-to-copy `cwd` and `$ command`. The toolbar under that is one visible row: search, a Levels dropdown, a conditional error chip, This run, Freeze/Live, Clear, and the line count. Each line carries a level badge in the gutter; error lines are tinted and everything else reads in the foreground colour. Click a line to copy it. Id-shaped tokens (UUID, 16+ hex, `req-`/`req_`, W3C trace id) are accent buttons that open a Trace view in this pane; JSON lines with `requestId` / `reqId` / `traceId` / `trace_id` / `correlationId` / `x-request-id` also get a small id label. Timestamps show only when the log has them.

**Keys.** `↑↓` or `j`/`k` select. `space` toggles the selected server. `r` restarts. `c` copies `cd <cwd> && <command>`. `o` opens the port in the browser. `/` focuses the sidebar filter. In the log: `f` focuses search, `e` and `E` step through errors, `⌘K` clears the view, `g` and `G` go to the top and the tail (`G` also goes live). `Esc` closes a menu or sheet. Keys are ignored while an input has focus; every one of them is an accelerator for a visible control.

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

**A** (min 44, `8px 16px`, wrap, border `#2a2e35`): dot · name 600 14 · `localhost:PORT ↗` · state dim (`unhealthy` in the error token when the probe fails). Primary: **Start** green fill when stopped; **Restart** outlined when running; `starting…` disabled when busy. Then `···` (200px menu): Open in browser (`o`) · Open in editor · Copy run command (`c`) · ─ · Wrap lines ✓ · Show timestamps ✓ · Expand all JSON ✓ · Copy visible lines · Copy last error · Clear log file… · ─ · Pin (unpinned) · Edit… (pinned) · Env… · Add to / Remove from project · Hide · Remove (red, pinned).

**B** (30px, mono 11 dim, border `#22262c`): click-to-copy `cwd` and `$ command` (glyph `#4a5160`, hover `#d7dae0`); `pid · cpu · MB · up` when running.

**Toolbar** (min 38, `6px 16px`, wrap, border `#22262c`). One visible row, in this order, present whenever a service is selected:

```
[ Search log                         3/41 ▲ ▼ ⊘ ] [ Levels ▾ ] [ 20 errors ↓ ] [ This run ] [ ⏸ Freeze ] [ Clear ]          k/N lines
```

- Controls are 26px, outlined, mono 12. An active toggle takes the accent border and the accent wash. A conditional chip takes the colour of what it counts. No new palette.
- The row fits one line at 1280px with the sidebar at its 380px maximum; below that it wraps, search first.
- **Search** (input, flex 1, min 200, placeholder `Search log  f`). Esc clears and blurs. F-37 adds the match counter, the `▲ ▼` steps, and the `⊘` mode toggle inside its right edge.
- **Levels ▾** — the one dropdown on this row. The label reads the state: `All levels`, `Errors`, `Errors · Warnings`, or `Custom`. The menu (220px) is one row per level with a check, the badge, and the count, then the `All` and `Errors only` presets. Persists per browser.
- **N errors ↓** — conditional, error token, shown only when the visible log has an error. Click jumps to the next error; with a cursor set it reads `error 2/20 ↓`. `e` and `E` are the accelerators, and a stop is a head, so a crash is one stop.
- **This run** — toggle, hides everything before the last `start` marker. Persists per browser.
- **⏸ Freeze / ▶ Live** — one button, two states. Live: the view appends and follows the tail. Frozen: nothing on screen moves while the buffer keeps filling, and the label reads `▶ Live · +42`. Scrolling away from the tail enters the same state, so there is exactly one control for "take me back to the tail". Clicking it while frozen appends what was held, jumps to the tail, and goes live.
- **Clear** — clears the view, not the file: entries before now are hidden and the count reads `k/N lines · cleared · show all`. `⌘K` is the accelerator. Truncating the file is `Clear log file…` in the `···` menu, with its confirm.
- Right: `N lines` or `k/N lines` (mono 11 dim), `title` = log path.
- Nothing else opens a menu from this row, and no action lives only behind a shortcut. While Trace is open the row keeps only **Close** and `N hits`; the search field and Levels do not filter trace hits, so they hide with the rest until F-44 makes Search own that view.

**Body** (`10px 16px 20px`, mono 12 / 1.6, `#c3c8d1`):
- Every line is cleaned before it is rendered: CSI, OSC, and single-character escape sequences removed and a `\r` progress bar resolved to its last frame (`cleanLine` in `lib/logs.ts`). No raw control byte — `[?25h` and friends — ever reaches the pane, and a download bar shows one line, not every frame.
- Line: flex, wrap, gap 14, pad `0 8px`, margin `0 -8px`, radius 3, `cursor: copy`; hover `#1f232a`.
- Columns: ln 30px right `#4a5160` · time `#5d636e` (only when the log has times) · lvl 3ch · content.
- Badge: `ERR` `WRN` `INF` `DBG`, mono 600 11, `user-select: none`, blank for `other` so a marker line stays quiet. Error `#e5534b`, warn `#e2b96a`, info `#8fd3a6`, debug `#8b919c`.
- Badge and tint by `entry.level` from `GET /api/logs/:id`; text is `#c3c8d1` except error lines, which keep `#f28b82` on `rgba(229,83,75,.1)`. A devboard marker (`entry.marker`) is dim. The level is decided once, on the server, by `classifyLine` in `lib/logs.ts`: a tagged level (a `LEVEL logger - msg` prefix or a JSON `level` field) first, then the HTTP status (5xx error, 4xx warn), then the word heuristics. Error pills and the top-bar count use `errorCount` from `GET /api/services`, which reads the same classifier.
- Structured line. When the server split the line, the content column reads `logger` in dim then `msg` in the foreground, and the `LEVEL` word the process printed is gone — the badge carries it. A `logger` is a button: clicking it puts the name in the search field, which is how you filter to one logger. When `entry.ctx` is set, a `{…}` chevron closes the line and toggles a `<pre class="ctx">` under it: `prettyCtx` at 2-space indent, keys dim, strings fg, numbers `#8fd3a6`. `⌥click` on any chevron toggles every context in the pane. Open contexts are keyed by the absolute line key (`base + i`), so an append or a buffer trim does not disturb them.
- Request line. When `entry.http` is set the method is secondary, the path foreground, the status coloured by class (2xx `#8fd3a6`, 3xx dim, 4xx `#e2b96a`, 5xx `#f28b82`), and the duration dim — or `#e2b96a` at 1000ms and over.
- Folding. A `cont` line (stack frame, indented dump, closing brace) renders under the line above it, not as a line of its own: `foldEntries` in `log-view.js` turns the buffer into groups of one head and its tail. A group with a tail shows a `▶ +N lines` chevron at the end of the head; clicking it opens the tail indented, dim, and without badges. The newest error group with a tail opens itself, and closes again when a newer one arrives, so one crash is open at a time. Open tails are keyed by the absolute line key. Clicking a head copies the head and its tail; clicking a frame copies the frame. `e` and the error chip step between heads, so one crash is one stop. A text filter that hits a folded line keeps its whole group.
- Repeats. Consecutive groups that say the same thing — same level, same logger, same message, whatever the folded context holds — collapse into the last one, which keeps its own time and shows `×N` in the timestamp token after the line number. Only groups with nothing folded under them collapse, so a repeated crash dump never loses the frames of the copy it replaces.
- Current error: `box-shadow: inset 2px 0 0 #e5534b`.
- Blinking 7×14 accent caret at the tail while running (1s steps).
- Empty (Plex, dim, max 520): stopped → “*name* is stopped…” + Start; unmanaged running → “Started outside devboard…”; filtered → “Nothing matches the current filter.”
- Click a line copies its text. If lines have no timestamps, omit the time column — do not invent times.
- Id tokens use the accent wash (`rgba(138,180,248,.12)`). Click opens Trace for that token. Default services: the selected row's project members, else every running `dev` row.
- Trace stays in this pane (not a sheet): token, one chip per service, hits grouped by service in file order. A chip or hit jumps to that log at that line and highlights it. Esc or Close leaves Trace. No time-window fallback — children write straight to the file, so lines have no board timestamp.

### Status bar — 28px, `#1c1f24`, border-top `#2a2e35`, mono 11 dim, `0 12px`

`↑↓` select · `␣` on/off · `r` restart · `c` copy run cmd · `o` open · `/` filter · `f` search · `e/E` err · `⌘K` clear · `g/G` top/tail. Keys `#d7dae0`. Right: `poll 3s · 127.0.0.1:4242`. Copy toast 1.6s here: `copied · <text>` accent / dim. Retire or remove while a server is running or starting in that checkout shows `Stop and retire · <names>` for 8s with a text-button action that kills those rows and retries.

### Overlay sheets

Graphite surfaces (`#1c1f24`, border `#2a2e35`, radius 7, same shadow). Used for worktrees, project create/edit, presets, attention, env, and full server edit. Clicking the dimmed backdrop or `Esc` closes. Do not revive the old tabbed board. A worktree card shows disk as `…` until size arrives (Attention skips `du`). A worktree card shows **Import pins** when that checkout has a `devboard.json`. Launch and project Add from folder import the same file when it exists (idempotent, no overwrite). A preset row has Edit; it pre-fills the form and PUTs `/api/presets/:id` (set the editing id after `openSheet`).

## Behaviour

- Select by row click or `↑↓` / `j`/`k` through **visible** (filtered) rows. Changing selection resets the error cursor, the folds, the open contexts, and the freeze, closes Trace, and scrolls the log to the tail. Persist `sel` in `localStorage`. `?sel=<id>` (tray Logs) selects that row on load and writes the same key.
- `Space` toggles the selected server. `r` restarts if running. Restarting an unpinned row whose command still has quotes or shell metacharacters (rebuilt from `ps`) returns 409 and opens Edit so you can check quoting; Save pins and restarts. `e` and `E` step through errors. `c` copies `cd <cwd> && <command>`. `o` opens `http://localhost:<port>`.
- Busy is optimistic: switch, dot, and primary go amber until `/api/services` agrees (or 15s). On start, append `=== devboard start · <cmd>` and `$ <cmd>` immediately.
- The view is live by default: it appends and follows the tail. Freeze, next-error, `g`, and scrolling away from the tail all freeze it; the buffer keeps filling and the button counts what it holds. Pressing `▶ Live`, `G`, or scrolling back to the tail with nothing held goes live again.
- Poll `/api/services` every 3s. The selected log loads `?lines=4000` once, then polls `?from=<byte cursor>` every 1s and appends only what arrived — an idle poll is a few hundred bytes and nothing already on screen is re-rendered. A full repaint happens only when view state changes (selection, filter, errors-only, status). The page keeps at most 10 000 entries: older ones drop off the front and the line numbers keep counting up. `reset` (the log was cleared or rotated) reloads the window.
- Copy via `navigator.clipboard.writeText`, then the status-bar toast.
- One open menu. Outside click or item click closes it.
- Destructive actions (stop all, project stop, kill system, remove, clear log) still confirm.

## State

`servers[]`, `busy{id: "starting"|"stopping"}`, `sel`, `query`, `logQuery`, `levels` (`Set<LogLevel>`), `runOnly`, `frozen`, `held`, `viewStart{id: key}`, `wrap`, `showTs`, `ctxOpen` / `ctxAll`, `tailOpen`, `errCursor`, `jumpLine`, `trace` (`null|{token, groups}`), `menu` (`null|"top"|"log"|"levels"`), `addOpen`, `toast`, `logs{id: {entries, next, base}}`. `levels`, `runOnly`, `wrap`, and `showTs` persist in `localStorage["devboard.logView"]`.

## Endpoints

`/api/services`, `/api/logs/:id` (returns `LogTail`: `entries: LogEntry[]` parsed by `lib/logs.ts`, plus `path`, `size`, `next`, `reset`; there is no `lines` or `levels` array), `/api/trace` (hits are `LogEntry`), `/api/start`, `/api/restart`, `/api/kill`, `/api/pin`, `/api/pinned`, `/api/projects/:id/start|stop|members`, `/api/suggest`, `/api/import`, `/api/open`, plus existing worktrees / presets / attention / env / ignore routes for the sheet features.

## Do not

- Introduce a framework, a new typeface, or a new palette.
- Put Worktrees / Attention / Presets back in a top-level tab bar.
- Show the error chip or empty-state buttons when they do not apply, or hide search, levels, freeze, or clear behind a menu.
- Fabricate log timestamps.
- Copy prototype runtimes or mock HTML into `public/`.
