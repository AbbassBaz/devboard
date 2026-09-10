#!/bin/bash
# End-to-end smoke run against a real devboard, driving the same API the page buttons call.
# Usage: bash scripts/smoke.sh   (uses a throwaway DEVBOARD_HOME; needs ports 4242 and 3999 free)
set -u
cd "$(dirname "$0")/.."
export DEVBOARD_HOME="${TMPDIR:-/tmp}/devboard-smoke-$$"
rm -rf "$DEVBOARD_HOME"
ok=1
api() {
  if [ $# -ge 3 ]; then curl -s -X "$1" "http://127.0.0.1:4242$2" -H 'content-type: application/json' -d "$3"
  else curl -s -X "$1" "http://127.0.0.1:4242$2"; fi
}
row() { api GET /api/services | bun -e 'const b = await new Response(Bun.stdin).json(); const s = b.services.find(s => s.ports.includes(3999)); console.log("    " + (s ? JSON.stringify({status:s.status,name:s.name,kind:s.kind,rootPid:s.rootPid,pids:s.pids,pinned:s.pinned,hasLog:s.hasLog,id:s.id}) : "no row for 3999"));'; }
rootpid() { api GET /api/services | bun -e 'const b = await new Response(Bun.stdin).json(); console.log(b.services.find(s => s.ports.includes(3999) && s.status === "running")?.rootPid ?? "")'; }
waitfor() { for _ in $(seq 1 50); do eval "$1" >/dev/null 2>&1 && return 0; sleep 0.1; done; echo "    TIMEOUT waiting: $1"; ok=0; return 1; }
check() { if eval "$1"; then echo "    ✓ $2"; else echo "    ✗ $2"; ok=0; fi; }
stop_devboard() { kill -TERM "$1" 2>/dev/null; wait "$1" 2>/dev/null; }

echo "[1] start devboard"
bun run server.ts > "$DEVBOARD_HOME.boot.log" 2>&1 & DB=$!
waitfor "curl -sf http://127.0.0.1:4242/api/services"

echo "[2] start a throwaway server the way a terminal would (sh -c '...; exit 0' keeps sh as the tree root)"
sh -c "bun -e 'Bun.serve({port:3999,fetch(){return new Response(\"hi\")}});setInterval(()=>{},1e6)'; exit 0" & TERM_SH=$!
waitfor "curl -sf http://127.0.0.1:3999"; sleep 0.3

echo "[3] row appears"; row
ROOT=$(rootpid); check "[ '$ROOT' = '$TERM_SH' ]" "root pid is the terminal's sh ($TERM_SH)"

echo "[4] pin"; api POST /api/pin "{\"rootPid\":$ROOT}"; echo
check "grep -q '\"id\": \"devboard-3999\"' '$DEVBOARD_HOME/services.json'" "services.json has devboard-3999"

echo "[5] kill"; api POST /api/kill "{\"rootPid\":$ROOT}"; echo
waitfor "! curl -sf http://127.0.0.1:3999"; sleep 0.3; row
check "api GET /api/services | grep -q '\"status\":\"stopped\"'" "row is now stopped + pinned"

echo "[6] start from dashboard"; api POST /api/start '{"id":"devboard-3999"}'; echo
waitfor "curl -sf http://127.0.0.1:3999"; sleep 0.3; row
check "api GET /api/services | grep -q '\"hasLog\":true'" "hasLog true"
echo "    log tail:"; api GET '/api/logs/devboard-3999?lines=5' | bun -e 'const b = await new Response(Bun.stdin).json(); for (const l of b.lines ?? [String(b.error)]) console.log("    | " + l)'

echo "[7] stop devboard; the started service must survive (SIGTERM here; Ctrl-C in a terminal is SIGINT to the foreground group, which the detached child is not in)"
stop_devboard "$DB"; sleep 0.3
check "curl -sf http://127.0.0.1:3999 | grep -q hi" "3999 still answers after devboard exited"

echo "[8] restart devboard, then Restart the service, then Kill + Unpin"
bun run server.ts >> "$DEVBOARD_HOME.boot.log" 2>&1 & DB=$!
waitfor "curl -sf http://127.0.0.1:4242/api/services"; row
OLD=$(rootpid); check "[ -n '$OLD' ]" "row survived devboard restart (root $OLD)"
api POST /api/restart "{\"rootPid\":$OLD}"; echo
waitfor "curl -sf http://127.0.0.1:3999"; sleep 0.5
NEW=$(rootpid); check "[ -n '$NEW' ] && [ '$NEW' != '$OLD' ]" "pid changed $OLD -> $NEW"
check "[ \"\$(grep -c '^=====' '$DEVBOARD_HOME/logs/devboard-3999.log' 2>/dev/null)\" = 2 ]" "log has 2 start headers"
api POST /api/kill "{\"rootPid\":$NEW}"; echo; api DELETE /api/pin/devboard-3999; echo
waitfor "! curl -sf http://127.0.0.1:3999"; sleep 0.3; row
check "! api GET /api/services | grep -q '3999'" "row gone after kill + unpin"

echo "[poll cost] $( { /usr/bin/time -p curl -s -o /dev/null http://127.0.0.1:4242/api/services; } 2>&1 | grep real )"
stop_devboard "$DB"
if lsof -nP -iTCP:3999 -sTCP:LISTEN >/dev/null 2>&1 || lsof -nP -iTCP:4242 -sTCP:LISTEN >/dev/null 2>&1; then echo "LEAK: something still listens on 3999 or 4242"; ok=0; else echo "cleanup ok"; fi
rm -rf "$DEVBOARD_HOME" "$DEVBOARD_HOME.boot.log"
[ "$ok" = 1 ] && echo "SMOKE PASSED" || { echo "SMOKE FAILED"; exit 1; }
