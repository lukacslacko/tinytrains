#!/usr/bin/env bash
# Launch a Claude "station master" for ONE station of a Tiny Trains game.
#
#   ./station-master.sh <station> [game]
#   MODEL=haiku EFFORT=low ./station-master.sh Tiszai Miskolc
#
# Defaults to the cheapest model + lowest reasoning effort (this task is easy).
# Override with env: MODEL (e.g. haiku|sonnet|opus or a full id), EFFORT (low|medium|high|xhigh|max),
# TINYTRAINS_SERVER (default http://localhost:8765).
#
# Prerequisites: the game server running (`node server.js`) and the `claude` CLI on PATH.
# Run one of these per station (in separate terminals) to staff a whole game.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STATION="${1:-}"
GAME="${2:-}"
if [ -z "$STATION" ]; then
  echo "usage: $0 <station> [game]   (env: MODEL, EFFORT, TINYTRAINS_SERVER)" >&2
  exit 1
fi

MODEL="${MODEL:-haiku}"                 # cheapest model by default
EFFORT="${EFFORT:-low}"                 # lowest reasoning effort by default
SERVER="${TINYTRAINS_SERVER:-http://localhost:8765}"

if ! curl -fsS "$SERVER/api/health" >/dev/null 2>&1; then
  echo "⚠  game server not reachable at $SERVER — start it with:  node \"$DIR/server.js\"" >&2
fi

# MCP config (one stdio server, pinned to this station + game).
GAME_ARG=""; [ -n "$GAME" ] && GAME_ARG=", \"--game\", \"$GAME\""
MCP="{ \"mcpServers\": { \"tinytrains\": { \"command\": \"node\", \"args\": [\"$DIR/mcp-server.js\", \"--station\", \"$STATION\"$GAME_ARG, \"--server\", \"$SERVER\"] } } }"

# Allow only this game's station tools to run without a prompt.
TOOLS="mcp__tinytrains__get_guide mcp__tinytrains__get_my_instructions mcp__tinytrains__list_stations mcp__tinytrains__get_infrastructure mcp__tinytrains__set_switch mcp__tinytrains__clear_signal mcp__tinytrains__set_signal_red mcp__tinytrains__watch mcp__tinytrains__watch_arrivals mcp__tinytrains__await_events mcp__tinytrains__list_watches mcp__tinytrains__cancel_watch"

PROMPT="You are the Station Master for station \"$STATION\"${GAME:+ in game \"$GAME\"}. \
First call get_guide and get_my_instructions to learn how the railway works and what your orders are. \
Then call watch_arrivals once. Then loop forever: call await_events to wait for a train; when one \
approaches, look up your instructions for that train type + entry point, set the switches (set_switch) \
and clear the entry signal (clear_signal) BEFORE it arrives, then call await_events again. Keep going; \
do not stop. Use only the station tools. If, after working a while, you find a gap or ambiguity in your \
instructions, suggest a clarification to the operator with send_message (prefix it 'Suggestion:')."

echo "▶ station master — station=$STATION game=${GAME:-<default>} model=$MODEL effort=$EFFORT server=$SERVER"

if [ -n "${DRYRUN:-}" ]; then
  echo "MCP: $MCP"
  echo "claude --model $MODEL --effort $EFFORT --mcp-config <json> --strict-mcp-config --allowedTools <12 tools> \"<prompt>\""
  exit 0
fi

exec claude \
  --model "$MODEL" \
  --effort "$EFFORT" \
  --mcp-config "$MCP" \
  --strict-mcp-config \
  --allowedTools $TOOLS \
  "$PROMPT"
