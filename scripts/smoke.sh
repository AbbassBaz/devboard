#!/bin/bash
# End-to-end smoke run against a real devboard, driving the same API the page buttons call.
# Usage: bash scripts/smoke.sh   (uses a throwaway DEVBOARD_HOME; needs ports 4242 and 3999 free)
set -u
cd "$(dirname "$0")/.."
export DEVBOARD_HOME="${TMPDIR:-/tmp}/devboard-smoke-$$"
rm -rf "$DEVBOARD_HOME"
ok=1
DB=
TERM_SH=
STARTED=

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if listening 4242 || listening 3999; then
  echo "abort: 4242 or 3999 already has a listener; refuse to drive a real board"
  exit 1
fi

cleanup() {
  if [ -n "${DB:-}" ]; then kill -TERM "$DB" 2>/dev/null; wait "$DB" 2>/dev/null; fi
  if [ -n "${TERM_SH:-}" ]; then kill -TERM "$TERM_SH" 2>/dev/null; wait "$TERM_SH" 2>/dev/null; fi
  for p in $STARTED; do kill -TERM "$p" 2>/dev/null; done
  sleep 0.2
  for p in $STARTED; do kill -KILL "$p" 2>/dev/null; done
  rm -rf "$DEVBOARD_HOME" "$DEVBOARD_HOME.boot.log"
}
trap cleanup EXIT INT

api() {
  if [ $# -ge 3 ]; then curl -s -X "$1" "http://127.0.0.1:4242$2" -H 'content-type: application/json' -d "$3"
  elif [ "$1" != GET ]; then curl -s -X "$1" "http://127.0.0.1:4242$2" -H 'content-type: application/json'
  else curl -s -X "$1" "http://127.0.0.1:4242$2"; fi
}
row() { api GET /api/services | bun -e 'const b = await new Response(Bun.stdin).json(); const s = b.services.find(s => s.ports.includes(3999)); console.log("    " + (s ? JSON.stringify({status:s.status,name:s.name,kind:s.kind,rootPid:s.rootPid,pids:s.pids,pinned:s.pinned,hasLog:s.hasLog,id:s.id}) : "no row for 3999"));'; }
rootpid() { api GET /api/services | bun -e 'const b = await new Response(Bun.stdin).json(); console.log(b.services.find(s => s.ports.includes(3999) && s.status === "running")?.rootPid ?? "")'; }
waitfor() { for _ in $(seq 1 100); do eval "$1" >/dev/null 2>&1 && return 0; sleep 0.1; done; echo "    TIMEOUT waiting: $1"; ok=0; return 1; }
check() { if eval "$1"; then echo "    ✓ $2"; else echo "    ✗ $2"; ok=0; fi; }

echo "[1] start devboard"
bun run server.ts > "$DEVBOARD_HOME.boot.log" 2>&1 & DB=$!
if ! kill -0 "$DB" 2>/dev/null; then
  echo "abort: board pid $DB died before the first poll"
  exit 1
fi
waitfor "curl -sf http://127.0.0.1:4242/api/services"

echo "[2] start a throwaway server the way a terminal would (sh -c '...; exit 0' keeps sh as the tree root)"
sh -c "bun -e 'Bun.serve({port:3999,fetch(){return new Response(\"hi\")}});setInterval(()=>{},1e6)'; exit 0" & TERM_SH=$!
waitfor "curl -sf http://127.0.0.1:3999"
echo "[3] row appears"
waitfor "[ -n \"\$(rootpid)\" ]"
row
ROOT=$(rootpid); check "[ '$ROOT' = '$TERM_SH' ]" "root pid is the terminal's sh ($TERM_SH)"

echo "[4] pin"; bun run bin/devboard.ts pin 3999; echo
check "grep -q '\"id\": \"devboard-3999\"' '$DEVBOARD_HOME/services.json'" "services.json has devboard-3999"

echo "[5] kill"; api POST /api/kill "{\"rootPid\":$ROOT}"; echo
TERM_SH=
waitfor "! curl -sf http://127.0.0.1:3999"; sleep 0.3; row
check "api GET /api/services | grep -q '\"status\":\"stopped\"'" "row is now stopped + pinned"

echo "[6] start from dashboard"; api POST /api/start '{"id":"devboard-3999"}'; echo
waitfor "curl -sf http://127.0.0.1:3999"; sleep 0.3; row
STARTED=$(rootpid)
check "api GET /api/services | grep -q '\"hasLog\":true'" "hasLog true"
echo "    log tail:"; api GET '/api/logs/devboard-3999?lines=5' | bun -e 'const b = await new Response(Bun.stdin).json(); for (const l of b.lines ?? [String(b.error)]) console.log("    | " + l)'

echo "[7] stop devboard; the started service must survive (SIGTERM here; Ctrl-C in a terminal is SIGINT to the foreground group, which the detached child is not in)"
kill -TERM "$DB" 2>/dev/null; wait "$DB" 2>/dev/null; DB=
sleep 0.3
check "curl -sf http://127.0.0.1:3999 | grep -q hi" "3999 still answers after devboard exited"

echo "[8] restart devboard, then Restart the service, then Kill + Unpin"
bun run server.ts >> "$DEVBOARD_HOME.boot.log" 2>&1 & DB=$!
if ! kill -0 "$DB" 2>/dev/null; then
  echo "abort: board pid $DB died before the first poll"
  exit 1
fi
waitfor "curl -sf http://127.0.0.1:4242/api/services"; row
OLD=$(rootpid); check "[ -n '$OLD' ]" "row survived devboard restart (root $OLD)"
api POST /api/restart "{\"rootPid\":$OLD}"; echo
waitfor "curl -sf http://127.0.0.1:3999"; sleep 0.5
NEW=$(rootpid); check "[ -n '$NEW' ] && [ '$NEW' != '$OLD' ]" "pid changed $OLD -> $NEW"
STARTED="$NEW"
check "[ \"\$(grep -c '^=====' '$DEVBOARD_HOME/logs/devboard-3999.log' 2>/dev/null)\" = 2 ]" "log has 2 start headers"
api POST /api/kill "{\"rootPid\":$NEW}"; echo; api DELETE /api/pin/devboard-3999; echo
STARTED=
waitfor "! curl -sf http://127.0.0.1:3999"; sleep 0.3; row
check "! api GET /api/services | grep -q '3999'" "row gone after kill + unpin"

echo "[9] CLI add, ls --json, open, rm, doctor"
bun run bin/devboard.ts add smoke-cli "$PWD" "true" 3998
bun run bin/devboard.ts ls --json | bun -e 'const d = await new Response(Bun.stdin).json(); if (!Array.isArray(d) || !d.some(s => s.id === "smoke-cli-3998")) { console.error("ls --json missing smoke-cli-3998"); process.exit(1); }'
bun run bin/devboard.ts open smoke-cli-3998 >/dev/null
bun run bin/devboard.ts rm smoke-cli-3998
check "! grep -q smoke-cli-3998 '$DEVBOARD_HOME/services.json'" "CLI add/rm round-trip"
if bun run bin/devboard.ts doctor; then echo "    ✓ doctor exits 0"; else echo "    ✗ doctor exits 0"; ok=0; fi

echo "[poll cost] $( { /usr/bin/time -p curl -s -o /dev/null http://127.0.0.1:4242/api/services; } 2>&1 | grep real )"
kill -TERM "$DB" 2>/dev/null; wait "$DB" 2>/dev/null; DB=
sleep 0.2
if listening 3999 || listening 4242; then echo "LEAK: something still listens on 3999 or 4242"; ok=0; else echo "cleanup ok"; fi
[ "$ok" = 1 ] && echo "SMOKE PASSED" || { echo "SMOKE FAILED"; exit 1; }
