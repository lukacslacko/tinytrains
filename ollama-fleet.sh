#!/usr/bin/env bash
# Run a FLEET of Ollama Station Masters on ONE model server: one client per station, all in parallel.
#
#   ./ollama-fleet.sh <model> <station,station,…> <game>
#   ./ollama-fleet.sh qwen3.5:9b Tiszai,Foter,Szikra Miskolc
#
# It does two things:
#   1) makes sure an `ollama serve` is up with that model loaded, tuned to serve every client at once
#      (OLLAMA_NUM_PARALLEL = number of stations; a single model stays resident);
#   2) launches one ollama-station-master.js process per station, all driving the same tinytrains
#      server. Press Ctrl-C to stop the whole fleet.
#
# Why one model server is enough for N clients (the "which session?" worry): Ollama's /api/chat is
# STATELESS — each client sends its full prompt on every request, so they never clash. The server just
# needs OLLAMA_NUM_PARALLEL high enough to run them concurrently instead of queueing. The two knobs only
# take effect when `ollama serve` STARTS; if Ollama is already running this script can't re-tune it, so
# it prints the command to restart it with.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODEL="${1:-}"; STATIONS_CSV="${2:-}"; GAME="${3:-}"
if [ -z "$MODEL" ] || [ -z "$STATIONS_CSV" ] || [ -z "$GAME" ]; then
  echo "usage: $0 <model> <station,station,...> <game>" >&2
  echo "   e.g. $0 qwen3.5:9b Tiszai,Foter,Szikra Miskolc" >&2
  exit 1
fi

OLLAMA="${OLLAMA_URL:-http://localhost:11434}"
SERVER="${TINYTRAINS_SERVER:-http://localhost:8765}"

# Split the comma list into stations (drop spaces — station names never contain any). bash-3.2 safe.
STATIONS_CSV="${STATIONS_CSV// /}"
IFS=',' read -r -a stations <<< "$STATIONS_CSV"
NUM="${#stations[@]}"
[ "$NUM" -gt 0 ] || { echo "no stations given" >&2; exit 1; }

command -v ollama >/dev/null 2>&1 || { echo "Ollama is not installed — get it at https://ollama.com" >&2; exit 1; }

# One model serving all N clients at once.
WANT_PARALLEL="${OLLAMA_NUM_PARALLEL:-$NUM}"
if curl -fsS "$OLLAMA/api/tags" >/dev/null 2>&1; then
  echo "ℹ ollama already running at $OLLAMA. For all $NUM clients to run at once it must have been" >&2
  echo "      started with:  OLLAMA_NUM_PARALLEL=$WANT_PARALLEL ollama serve" >&2
  echo "  Restart ollama serve with that if the fleet feels serialized." >&2
else
  echo "starting ollama serve (OLLAMA_NUM_PARALLEL=$WANT_PARALLEL, one resident model)…" >&2
  OLLAMA_NUM_PARALLEL="$WANT_PARALLEL" OLLAMA_MAX_LOADED_MODELS=1 ollama serve >/dev/null 2>&1 &
  for i in $(seq 1 20); do curl -fsS "$OLLAMA/api/tags" >/dev/null 2>&1 && break; sleep 0.5; done
fi

# Pull the model once (first run only), then preload it so the first decisions aren't a cold start.
if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$MODEL"; then echo "pulling $MODEL (first run only)…" >&2; ollama pull "$MODEL"; fi
echo "loading $MODEL into the model server…" >&2
curl -fsS "$OLLAMA/api/generate" -H 'Content-Type: application/json' -d "{\"model\":\"$MODEL\",\"keep_alive\":\"1h\"}" >/dev/null 2>&1 || true

curl -fsS "$SERVER/api/health" >/dev/null 2>&1 || echo "⚠  tinytrains server not reachable at $SERVER — start it with: node \"$DIR/server.js\"" >&2

pids=()
cleanup(){ trap - INT TERM EXIT; echo >&2; echo "stopping fleet…" >&2; for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; }
trap cleanup INT TERM EXIT

echo "▶ fleet on game \"$GAME\" with model $MODEL — $NUM client(s):" >&2
for st in "${stations[@]}"; do
  [ -n "$st" ] || continue
  echo "    $st" >&2
  # One independent client per station; each tags its own log lines with [station]. Run node directly
  # (no pipe) so $! is the node PID and Ctrl-C cleanly kills every member.
  node "$DIR/ollama-station-master.js" --station "$st" --game "$GAME" --model "$MODEL" --ollama "$OLLAMA" --server "$SERVER" &
  pids+=("$!")
done
wait
