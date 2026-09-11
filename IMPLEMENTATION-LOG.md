# Implementation log

Plan: `suggestions/final-plan.md`  
Branch: `plan/tier-1`  
Baseline: `bun test` — 133 pass, 0 fail (2026-09-11). No linter.

Precondition: landed uncommitted fonts, fixture scrub, project links, and worktree pin copying as `91f5dc7`.

| ID | Title | Status | Notes |
|---|---|---|---|
| F-01 | Reject cross-origin and DNS-rebinding requests to the API | done | Gate in `handle` before `route`. Tray already sends `application/json`. Page and smoke now send JSON on DELETE too. Smoke not re-run: real board on :4242. |
| F-02 | Fix the edit sheets losing their id | done | `openSheet` now hides without resetting edit ids. Browser: Edit dashboard kept `editingId=dashboard-3001` and Save PUT succeeded; New project had null id; Edit project kept `coreagentshub`; close then Add/New project did not leak an id. |
| F-03 | Add a LICENSE file | todo | Human: MIT. Copyright holder: AbbassBaz (repo owner). |
| F-04 | Track the processes devboard spawns so status is real | todo | Tier 2 — waiting |
| F-05 | Contain log ids to the log directory | todo | |
| F-06 | Make the tray build optional in `install` | todo | |
| F-07 | CI on a macOS runner, with a smoke script that cannot touch a real board | todo | |
| F-08 | Rewrite the README for a stranger | todo | |
| F-09 | Remove or scrub private names in `docs/superpowers/` | todo | Human: delete the folder |
| F-10 | Rotate logs while a server runs, not only at start | todo | Tier 2 — waiting |
| F-11 | Compute error counts on the server with one classifier | todo | Tier 2 — waiting |
| F-12 | Adopt a running row when the port moved | todo | Tier 2. Human: may fall back to cwd + command (port stripped) when unique |
| F-13 | Make CLI `stop-all` pin unsaved rows first, like the page | todo | |
| F-14 | Fix `devboard logs -f` stalling after 200 lines | todo | |
| F-15 | One server scan loop with a cached snapshot | todo | Tier 2 — waiting |
| F-16 | Show readiness on the page | todo | Tier 2 — waiting |
| F-17 | Mask secret-looking env values and gate `/api/env` | todo | Tier 2 — waiting |
| F-18 | Validate hand-edited registry JSON and serialize writes | todo | Tier 2 — waiting |
| F-19 | Reconcile AGENTS.md with the new direction and add CONTRIBUTING.md | todo | |
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

## Noticed

- `suggestions/` is untracked and not in `.gitignore`. Left untracked; not part of the product.
