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
- `POST /api/stations/:id/path` `{ path: [entrySignal, switch, switch, …, (signal|compass)?] }` —
  **sets a whole route at once**: traces the live track element-to-element and sets every switch so
  the route threads through it (one port is the stem, the other the set branch), then clears the entry
  signal. An optional final signal/compass fixes the last switch's exit when it's entered via its stem.
  This is the easy way to satisfy a "set path 1,2,3" instruction without computing switch directions.

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
waiting), `get_time` (the current **simulation time of day** — `secondsIntoDay` within a `dayLength`,
for instructions like "during game time between 2 and 8 minutes"), **`set_path`** (route a train in
one call — `["A","1","2","3"]` lines up the switches and
clears the entry signal; the easy way to follow "set path …" instructions), `set_switch`,
`clear_signal`, `set_signal_red`, `watch`, `watch_arrivals` (approach-watch every signal at once),
`await_events` (the blocking notification receiver), `send_message`, `set_override` / `clear_override`
(record/cancel a **standing operator override** given over chat — "until further notice …" — which
takes precedence over the base instructions until cleared), `note` / `remember`
(write the station's **daily notebook** — a scratchpad wiped each midnight — and its **long-term
memory** — kept across days; both ride along every decision, so a master can carry state like "which
side did I last let through"), `report_to_superintendent` (file the day's report),
`list_watches`, `cancel_watch`.

**End of day.** When the sim clock turns midnight the game pauses and each master receives an
`end_of_day` event: it should `report_to_superintendent`, fold anything worth keeping into `remember`,
and its notebook is then cleared. A `review_reports` event then shares every station's report back for
reading (and optional `note`s for tomorrow); the game resumes once everyone has reported and reviewed
(each phase is timeout-bounded so a slow/absent master can't wedge the game).

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
./station-master.sh <station[,station2,…]> [game]   # e.g. ./station-master.sh Tiszai Miskolc
./station-master.sh Tiszai,Foter,Szikra Miskolc     # one AI managing three stations
MODEL=haiku EFFORT=low ./station-master.sh Tiszai Miskolc
```
Defaults to the cheapest model + lowest reasoning effort (the task is easy). It launches `claude`
with the MCP server, allows only the station tools, and tells it to loop on `await_events`.

**One master, many stations (and games).** `--station` is a comma list; each entry is `Station` (in
`--game`) or `Game:Station` to be explicit. The MCP server then polls all of them, and **every
`await_events` event is tagged with its `station` and `game`** — the master acts on it at that station
and passes the station to each tool. (A master with a single station may omit the station argument.)

**A local model (via Ollama) — no API, runs on your Mac:**
```
./ollama-station-master.sh <station[,station2,…]> [game]   # e.g. ./ollama-station-master.sh Tiszai Miskolc
OLLAMA_MODEL=llama3.1:8b ./ollama-station-master.sh Tiszai Miskolc
```
Here the **script** owns the loop: it polls `/api/trains` for trains STOPPED at the station and asks
the local LLM only for the routing decision (no pre-announcement / look-ahead). Each decision is a
short, fresh context, so a small tool-calling model is reliable. Verified working with `qwen3.5`;
`qwen2.5:7b`, `llama3.1:8b`, and `mistral-nemo` are also good choices. One process can run several
stations (comma list), deciding each in its own context.

**A fleet — one model server, one parallel client per station.** `ollama-fleet.sh` takes a single
model, a comma list of stations, and a game, and launches an INDEPENDENT agent per station, all driving
the same model server concurrently:
```
./ollama-fleet.sh <model> <station,station,…> <game>
./ollama-fleet.sh qwen3.5:9b Tiszai,Foter,Szikra Miskolc
```
It (1) makes sure `ollama serve` is up with that model pulled + preloaded, tuned to serve every client
at once (`OLLAMA_NUM_PARALLEL` = number of stations, a single model resident), and (2) starts one
`ollama-station-master.js` process per station. Ctrl-C stops the whole fleet.

*Why one model server is enough for N clients (the "which session?" worry):* Ollama's `/api/chat` is
**stateless** — each agent sends its full prompt (system + user + tool turns) on every request, so
Ollama keeps no per-session state and the clients never clash. Each station is just a separate process
with its own fresh context per decision. The only shared resource is the model server's compute, set by
**`OLLAMA_NUM_PARALLEL`** (how many requests one model serves at once — so all the clients run together
instead of queueing). The script sets it when it starts `ollama serve`; if Ollama is already running it
can't re-tune it, so it prints the `OLLAMA_NUM_PARALLEL=… ollama serve` line to restart it with.
(Running several `ollama-station-master.sh` in separate terminals works identically — the fleet just
orchestrates them and tunes that knob for you.)

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
