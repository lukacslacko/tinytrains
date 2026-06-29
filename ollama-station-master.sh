#!/usr/bin/env bash
# Run a Station Master driven by a LOCAL LLM via Ollama, for one station.
#
#   ./ollama-station-master.sh <station> [game]
#   OLLAMA_MODEL=llama3.1:8b ./ollama-station-master.sh Tiszai Miskolc
#
# Defaults to qwen2.5:7b (a small, reliable tool-caller; runs comfortably on a MacBook Pro).
# Requires the game server running (`node server.js`) and Ollama (https://ollama.com).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# On Windows/Git Bash, give node a Windows-style path (C:/…); cygpath is absent on macOS/Linux,
# where the POSIX path is already correct, so this is a no-op there.
command -v cygpath >/dev/null 2>&1 && DIR="$(cygpath -m "$DIR")"

STATION="${1:-}"; GAME="${2:-}"   # <station> may be a comma list, e.g. Tiszai,Foter,Szikra
if [ -z "$STATION" ]; then echo "usage: $0 <station[,station2,...]> [game]   (env: OLLAMA_MODEL, TINYTRAINS_SERVER, OLLAMA_URL)" >&2; exit 1; fi

MODEL="${OLLAMA_MODEL:-qwen2.5:7b}"
OLLAMA="${OLLAMA_URL:-http://localhost:11434}"
SERVER="${TINYTRAINS_SERVER:-http://localhost:8765}"

command -v ollama >/dev/null 2>&1 || { echo "Ollama is not installed — get it at https://ollama.com" >&2; exit 1; }
if ! curl -fsS "$OLLAMA/api/tags" >/dev/null 2>&1; then echo "starting ollama serve…" >&2; (ollama serve >/dev/null 2>&1 &) ; sleep 2; fi
if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$MODEL"; then echo "pulling $MODEL (first run only)…" >&2; ollama pull "$MODEL"; fi
if ! curl -fsS "$SERVER/api/health" >/dev/null 2>&1; then echo "⚠  game server not reachable at $SERVER — start it with: node \"$DIR/server.js\"" >&2; fi

echo "▶ ollama station master — station=$STATION game=${GAME:-<default>} model=$MODEL" >&2
exec node "$DIR/ollama-station-master.js" --station "$STATION" ${GAME:+--game "$GAME"} --model "$MODEL" --ollama "$OLLAMA" --server "$SERVER"
