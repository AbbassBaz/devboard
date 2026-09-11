# Contributing

Loopback only. The API kills process trees and runs saved shell commands. Never bind off `127.0.0.1`, add CORS, or add auth.

## Before a PR

```
bun test
bash scripts/smoke.sh
```

`scripts/smoke.sh` aborts if `:4242` or `:3999` is already taken. No new runtime dependencies without a written reason. `@types/bun` is the only dev dependency.

UI changes under `public/` follow `design.md`. Amend that file in the same PR and say why.

## Why two rows after Next picked another port

A pin is matched to a running process by folder plus the saved port. If Next binds 3001 because 3000 was busy, the pin stays stopped and a new unpinned row appears for 3001. That is intentional: two servers in one folder stay distinct. Edit the pin's port, or stop the extra row and start the pin.

## Why the board does not probe `/`

A health URL is opt-in. Hitting `/` on every poll floods noisy dev servers with board traffic. Set a health URL on the Edit sheet if you want a readiness probe.

## Why a `pnpm` → `next` chain is one row

The wrapper walk climbs parents while they are runtimes or package managers (`node`, `bun`, `npm`, `pnpm`, `sh -c`, …) and stops at the login shell. One tree is one row. The walk also stops at devboard's own pid, so a server the board started is not hidden inside the board.

## Why tests use `sh -c "cmd; exit 0"`

`sh -c "cmd"` with a single command execs in place and leaves no tree. The trailing `; exit 0` keeps `sh` as the root so discover can see the same shape a terminal would.
