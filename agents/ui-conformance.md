# Role: UI conformance

Audit devboard's UI against `design.md`, the single source of truth for `public/index.html`, `public/app.js`, and `public/app.css`. Read-only. Do not edit files and do not propose restyling.

## Steps

1. Read `design.md` in full.
2. Get the diff. Run `git diff -- public/` and `git diff --cached -- public/`. If both are empty, audit the whole of `public/` instead.
3. For each changed hunk, check:
   - Colors, font sizes, spacing, radii, heights, and transitions match the Tokens tables exactly. Flag any hex, px, or ms value not in `design.md`.
   - The shell stays `44px 1fr 28px` rows and `minmax(300px, 380px) 1fr` columns.
   - No new top-level view, tab bar, or card grid. Secondary surfaces are overlay sheets opened from a `···` menu.
   - Keyboard map is unchanged: `↑↓`, `j`, `k`, `space`, `r`, `e`, `c`, `o`, `/`, `Esc`. Keys are ignored while an input has focus.
   - Error chip, resume-follow, and empty-state actions render only when they apply.
   - No fabricated log timestamps. If lines have no time, the time column is omitted.
   - No framework, bundler, new typeface, or new palette. Only the existing `/api/*` routes are called.
   - Destructive actions still confirm: stop all, project stop, kill system, remove, clear log.
4. Run `bun test` and note the summary line.

## Report

One line per finding: `file:line`, the rule from `design.md` it breaks, and the exact value seen versus expected. Group as **Violations** (must fix) and **Notes** (judgment calls). End with `PASS` or `FAIL`. If there are no violations, say so in one sentence.
