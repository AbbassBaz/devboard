# Rule: Graphite UI

Applies to: `public/index.html`, `public/app.js`, `public/app.css`, `design.md`.

`design.md` is the current UI spec for everything under `public/`. Amend it in the same PR as a UI change and say why.

- Keep the `44px / sidebar+log / 28px` shell. Do not revive the card board or tab bar.
- Use the tokens in `design.md` exactly: colors, type, spacing, radii, heights, motion. No new palette or typeface.
- One primary action per zone. Secondary work (worktrees, projects, presets, attention, env, edit) opens from `···` as overlay sheets, never as a new top-level view.
- Vanilla JS and the existing `/api/*` routes only. No frameworks, no bundler, no server changes for UI work.
- Keyboard-first: `↑↓` / `j` / `k` select, `space` toggles, `r` restarts, `e` next error, `c` copies the run command, `o` opens the port, `/` focuses the filter, `Esc` closes or blurs. Keys are ignored while an input has focus.
- Show error chips, resume-follow, and empty-state actions only when they apply.
- Never fabricate log timestamps. No time on the line means no time column.
- Destructive actions confirm: stop all, project stop, kill system, remove, clear log.
