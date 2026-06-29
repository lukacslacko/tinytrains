#!/usr/bin/env bash
# Run a FLEET of Ollama Station Masters: one INDEPENDENT process per station, each with its own model,
# all driving the same tinytrains server in parallel.
#
#   ./ollama-fleet.sh <game> <station[:model]> [station[:model] ...]
#   ./ollama-fleet.sh Miskolc Tiszai:qwen2.5:7b Foter:llama3.1:8b Szikra
#
# A station with no ":model" uses $OLLAMA_MODEL (default qwen2.5:7b). Press Ctrl-C to stop the fleet.
#
# WHY THIS IS THE RIGHT WAY (the "which session?" worry): Ollama's /api/chat is STATELESS — the agent
# sends the FULL prompt (system + user + tool turns) on every request, so Ollama keeps no per-session
# state and the clients never clash. Each station is just a separate process with its own model and its
# own short, fresh context per decision. The only shared resource is the Ollama server's compute, set
# by two knobs that only apply when `ollama serve` STARTS:
#   OLLAMA_NUM_PARALLEL      — concurrent requests one model will serve at once (so same-model stations
#                              run together instead of queueing)
#   OLLAMA_MAX_LOADED_MODELS — how many distinct models stay resident (so different-model stations don't
#                              thrash swapping models in and out)
# This script sets both when it launches `ollama serve`. If ollama is already running it can't change
# them, so it prints the command to restart it with the right values.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GAME="${1:-}"; shift 2>/dev/null || true
if [ -z "$GAME" ] || [ "$#" -eq 0 ]; then
  echo "usage: $0 <game> <station[:model]> [station[:model] ...]" >&2
  echo "   e.g. $0 Miskolc Tiszai:qwen2.5:7b Foter:llama3.1:8b Szikra" >&2
  exit 1
fi

DEFAULT_MODEL="${OLLAMA_MODEL:-qwen2.5:7b}"
OLLAMA="${OLLAMA_URL:-http://localhost:11434}"
SERVER="${TINYTRAINS_SERVER:-http://localhost:8765}"

# Parse "station[:model]" specs. Split on the FIRST colon only — model names contain colons (qwen2.5:7b).
stations=(); models=()
for spec in "$@"; do
  st="${spec%%:*}"
  if [ "$st" = "$spec" ]; then m="$DEFAULT_MODEL"; else m="${spec#*:}"; fi
  stations+=("$st"); models+=("$m")
done
NUM_STATIONS="${#stations[@]}"
# Distinct models without bash-4 associative arrays (macOS ships bash 3.2); model names have no spaces.
UNIQ_MODELS=""
for m in "${models[@]}"; do
  case " $UNIQ_MODELS " in *" $m "*) ;; *) UNIQ_MODELS="${UNIQ_MODELS:+$UNIQ_MODELS }$m" ;; esac
done
NUM_MODELS=0; for m in $UNIQ_MODELS; do NUM_MODELS=$((NUM_MODELS + 1)); done

command -v ollama >/dev/null 2>&1 || { echo "Ollama is not installed — get it at https://ollama.com" >&2; exit 1; }

# Each model should serve up to one request per station that uses it; keep all distinct models resident.
WANT_PARALLEL="${OLLAMA_NUM_PARALLEL:-$NUM_STATIONS}"
WANT_LOADED="${OLLAMA_MAX_LOADED_MODELS:-$NUM_MODELS}"
if curl -fsS "$OLLAMA/api/tags" >/dev/null 2>&1; then
  echo "ℹ ollama already running at $OLLAMA. For full parallelism it must have been started with:" >&2
  echo "      OLLAMA_NUM_PARALLEL=$WANT_PARALLEL OLLAMA_MAX_LOADED_MODELS=$WANT_LOADED ollama serve" >&2
  echo "  If the fleet feels serialized, restart ollama serve with those." >&2
else
  echo "starting ollama serve (OLLAMA_NUM_PARALLEL=$WANT_PARALLEL OLLAMA_MAX_LOADED_MODELS=$WANT_LOADED)…" >&2
  OLLAMA_NUM_PARALLEL="$WANT_PARALLEL" OLLAMA_MAX_LOADED_MODELS="$WANT_LOADED" ollama serve >/dev/null 2>&1 &
  for i in $(seq 1 20); do curl -fsS "$OLLAMA/api/tags" >/dev/null 2>&1 && break; sleep 0.5; done
fi

# Pull each distinct model once (first run only).
for m in $UNIQ_MODELS; do
  if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$m"; then echo "pulling $m (first run only)…" >&2; ollama pull "$m"; fi
done

curl -fsS "$SERVER/api/health" >/dev/null 2>&1 || echo "⚠  tinytrains server not reachable at $SERVER — start it with: node \"$DIR/server.js\"" >&2

pids=()
cleanup(){ trap - INT TERM EXIT; echo >&2; echo "stopping fleet…" >&2; for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; }
trap cleanup INT TERM EXIT

echo "▶ fleet on game \"$GAME\" — $NUM_STATIONS station(s), $NUM_MODELS model(s):" >&2
for i in "${!stations[@]}"; do
  st="${stations[$i]}"; m="${models[$i]}"
  echo "    $st  ←  $m" >&2
  # One independent agent process per station. Each tags its own log lines with [station]. Run node
  # directly (no pipe) so $! is the node PID and Ctrl-C cleanly kills every member.
  node "$DIR/ollama-station-master.js" --station "$st" --game "$GAME" --model "$m" --ollama "$OLLAMA" --server "$SERVER" &
  pids+=("$!")
done
wait
