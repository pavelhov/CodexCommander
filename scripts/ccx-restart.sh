#!/usr/bin/env bash
# Restart the local CodexCommander proxy fully detached from the caller's TTY/session, so an agent
# session that launches it does not get killed when the agent turn ends. Waits for the new
# runtime-port.json and prints a health line. Usage: scripts/ccx-restart.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${CCX_RESTART_LOG:-/tmp/codexcommander-restart.log}"

# Use the one canonical state root.
if [ -n "${CODEXCOMMANDER_HOME:-}" ]; then
  STATE_ROOT="${CODEXCOMMANDER_HOME}"
else
  STATE_ROOT="$HOME/.codexcommander"
fi
PORT_FILE="$STATE_ROOT/runtime-port.json"

read_runtime_port() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
const allowed = new Set(["schemaVersion", "pid", "port", "hostname", "attestationSecret"]);
const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
const valid = keys.length >= 3
  && keys.every(key => allowed.has(key))
  && value.schemaVersion === 1
  && Number.isSafeInteger(value.pid) && value.pid > 0
  && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
  && (!Object.hasOwn(value, "hostname") || typeof value.hostname === "string")
  && (!Object.hasOwn(value, "attestationSecret")
    || (typeof value.attestationSecret === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.attestationSecret)));
if (!valid) process.exit(1);
process.stdout.write(String(value.port));
NODE
}

cd "$REPO_DIR"

echo "[codexcommander-restart] stopping current proxy (if any)..."
bun run src/cli/index.ts stop >/dev/null 2>&1 || true
sleep 2
rm -f "$STATE_ROOT/codexcommander.pid"

echo "[codexcommander-restart] starting detached proxy (log: $LOG_FILE)..."
# setsid + nohup fully detaches from the controlling terminal and process group, so the proxy
# survives the agent turn. </dev/null prevents any stdin coupling.
setsid nohup bun run src/cli/index.ts start >"$LOG_FILE" 2>&1 </dev/null &
disown || true

for i in $(seq 1 30); do
  if [ -f "$PORT_FILE" ]; then
    PORT="$(read_runtime_port "$PORT_FILE" 2>/dev/null || true)"
    if [ -n "$PORT" ] && curl -sf "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
      echo "[codexcommander-restart] healthy on port $PORT (pid $(cat "$STATE_ROOT/codexcommander.pid" 2>/dev/null))"
      exit 0
    fi
  fi
  sleep 1
done

echo "[codexcommander-restart] WARN: proxy did not report healthy within 30s; tail of log:" >&2
tail -n 15 "$LOG_FILE" >&2 || true
exit 1
