# Station Master API + MCP (AI-driven operation)

Hook an AI up to the game as a **station master**: it reads the station's instructions and routes
trains by setting switches and clearing manual signals. The design is **one AI instance per
station**. Two layers:

1. an **HTTP API** on the game server (`server.js`) — the source of truth, usable by anything;
2. an **MCP server** (`mcp-server.js`) that wraps that API as tools for an AI host, scoped to one
   station.

Start the game server first: `node server.js` (port 8765), with a game that has stations + a switch
to load it (e.g. the Miskolc save). The station instructions are the free-text you write per
station (right-click a station name on the map) — e.g.

**The server runs many games at once.** Every API call targets a game by id or name (`?game=` on
GET, `game` in the POST body); the MCP server is pinned to one with `--game`. So the UI can switch
which game it views while station masters keep operating their own — each AI keeps playing its game.

> If a train of line 1 arrives at A, set 1 to NW and clear A.
> If a train arrives at B1, set 2 SW and clear B1.

## How notifications reach an AI (the key design question)

MCP is request/response. A server *can* send notifications to a client, but an LLM agent loop is
turn-based — between turns it isn't listening, and no host reliably wakes an idle session on an
arbitrary MCP notification. So instead of pushing, we make the agent **block on a long-poll tool**:

- `await_events` calls `GET /api/notifications` (a **long-poll**: the server holds the request open
  until a watched train fires an event, or a timeout). The notification is delivered as the tool's
  **return value** — the agent is woken because it was waiting *inside* a tool it called.
- The station master's loop is therefore: set up watches → `await_events` (block) → act on the
  event → `await_events` again. It is an event-driven worker built only from tool calls; no host
  push support is needed.

`watch` modes give **proactive** routing: `approach` fires while the train is still a few tiles away
and heading toward the point (following live switch settings), so the master can set the route and
clear the signal *before* the train has to brake. (`reach` = arrives on the tile; `pass` = tail
clears it.)

## HTTP API

Read:
- `GET /api/guide` — the global station-master operating brief (same text every master reads).
- `GET /api/stations` — all stations with their switches/signals (by station-local name) + live state.
- `GET /api/stations/:id` — one station; `GET /api/stations/:id/instructions` — just its instructions.

Operate (by station-local element name, or `x,y`):
- `POST /api/stations/:id/switch` `{ name, to }` — `to` is a compass bearing (N/NE/E/SE/S/SW/W/NW)
  or branch index.
- `POST /api/stations/:id/signal` `{ name, action: "clear" | "red" }`.

Notify:
- `POST /api/watches` `{ station, element, mode, tiles? }` (or `{ owner, x, y, mode }`) → `{ watch }`.
  `mode` ∈ `approach` | `reach` | `pass`; `tiles` is the approach lead distance (default 6). `element`
  may be a SIGNAL or a SWITCH — a `pass` watch on a switch tells the master when it's free to re-throw,
  and on a signal when the block behind has cleared for a following train.
- `GET  /api/watches?owner=:id` · `DELETE /api/watches/:id`.
- `GET  /api/notifications?owner=:id&after=:seq&wait=:secs` — **long-poll**; returns
  `{ events, cursor }` when a matching event exists (or after `wait` seconds). Each event:
  `{ seq, clock, mode, element, trainId, trainType, trainTypeName, x, y }`. Pass `after=cursor`
  from the previous response to get only new events.

(All other game endpoints — state, command, save/load, SSE — are in `server.js`.)

**Train speed.** The sidebar has a *Train speed* control (0.1×–2×); it sends `{type:"setSpeed",scale}`
to `/api/command`, scaling the whole fleet so a (slower) operator or AI has more real time to act. The
value is per game and saved.

## MCP server

`mcp-server.js` is a zero-dependency MCP server over stdio (newline-delimited JSON-RPC), scoped to
one station, that calls the HTTP API. Tools:

`get_guide`, `get_my_instructions`, `list_stations`, `get_infrastructure` (switches + signals, with
any train **waiting** at each signal), `list_trains` (where every train is + its heading + why it is
waiting), `set_switch`, `clear_signal`, `set_signal_red`, `watch`, `watch_arrivals` (approach-watch
every signal at once), `await_events` (the blocking notification receiver), `send_message`,
`list_watches`, `cancel_watch`.

Because approach/arrival notifications are edge-triggered, a master also **sweeps `get_infrastructure`
every cycle** for trains already waiting at its signals and routes them — so trains don't get
stranded when no fresh event fires (the guide drives this; the Ollama agent does it in its loop).

Run / configure (one per station):

```
node mcp-server.js --station Tiszai --game Miskolc [--server http://localhost:8765]
# or env: TINYTRAINS_STATION, TINYTRAINS_GAME, TINYTRAINS_SERVER
```

As an MCP stdio server in a host (e.g. Claude Code), one entry per station (all `--game Miskolc`):

```json
{
  "mcpServers": {
    "tiszai":  { "command": "node", "args": ["/abs/path/mcp-server.js", "--station", "Tiszai", "--game", "Miskolc"],
                 "env": { "TINYTRAINS_SERVER": "http://localhost:8765" } },
    "foter":   { "command": "node", "args": ["/abs/path/mcp-server.js", "--station", "Foter", "--game", "Miskolc"] },
    "szikra":  { "command": "node", "args": ["/abs/path/mcp-server.js", "--station", "Szikra", "--game", "Miskolc"] }
  }
}
```

Then run one AI session per station and tell it: *"You are the station master. Call get_guide and
get_my_instructions, then watch_arrivals, then loop on await_events — for each train, set the route
and clear the signal per your instructions."* The MCP server also returns that as `initialize`
instructions.

## Running an AI station master

Two ready-made launchers (start `node server.js` first; load a game with stations, e.g. Miskolc):

**Claude (via the MCP server):**
```
./station-master.sh <station> [game]            # e.g. ./station-master.sh Tiszai Miskolc
MODEL=haiku EFFORT=low ./station-master.sh Tiszai Miskolc
```
Defaults to the cheapest model + lowest reasoning effort (the task is easy). It launches `claude`
with the station's MCP server, allows only the station tools, and tells it to loop on `await_events`.
Run one per station in its own terminal.

**A local model (via Ollama) — no API, runs on your Mac:**
```
./ollama-station-master.sh <station> [game]      # e.g. ./ollama-station-master.sh Tiszai Miskolc
OLLAMA_MODEL=llama3.1:8b ./ollama-station-master.sh Tiszai Miskolc
```
Here the **script** owns the event loop (registers approach watches, long-polls for arrivals); the
local LLM only decides the switch/signal actions for each arriving train. That keeps each decision
in a short, fresh context, so a small tool-calling model is reliable. Verified working with
`qwen3.5` (it produced the correct `set_switch`/`clear_signal` calls for Tiszai's instructions);
`qwen2.5:7b`, `llama3.1:8b`, and `mistral-nemo` are also good choices.

## Operator ↔ station-master chat

Each station's pop-up (right-click its name) has a **chat** with its master. A message you send is
delivered to the master as a notification (it arrives from `await_events` as `mode:"message"`); the
master can reply with the `send_message` tool, which **pops up in the game notifications and
highlights that station** on the map. Endpoints: `POST /api/stations/:id/message` (operator→master)
and `POST /api/stations/:id/operator-message` (master→operator).

Masters are also told to **suggest clarifications** to their instructions once they've worked a while
(an uncovered train/entry point, an ambiguity, a needless stop) — sent as a `Suggestion: …` chat
message. (Verified: a local model routed an uncovered line-3 train as best it could and messaged a
suggestion noting the gap.)

## Status

Implemented and tested: the HTTP API (guide / instructions / infra / operate-by-name / watches /
long-poll), the engine watch system (approach/reach/pass, owner-scoped), and the MCP server
(handshake + all tools, including `await_events` delivering a real arrival event). Not yet built:
the engine-driver API and shunting; multi-station coordination is left to the per-station AIs.
