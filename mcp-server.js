// Tiny Trains — Station Master MCP server (Node, zero dependencies).
//
// Exposes station controls to an AI as MCP tools. ONE instance can manage one OR several stations
// (and even stations in different games). It is a thin client of the game server (server.js) over HTTP.
//
//   node mcp-server.js --station Tiszai[,Foter,...] [--game Miskolc] [--server http://localhost:8765]
//   (env: TINYTRAINS_STATION, TINYTRAINS_GAME, TINYTRAINS_SERVER)
//   --station is a comma list; each entry is "Station" (in --game) or "Game:Station" to be explicit.
//
// Configure it in an MCP host (e.g. Claude Code) as a stdio server:
//   "tinytrains": { "command": "node",
//     "args": ["/abs/path/mcp-server.js", "--station", "Tiszai,Foter,Szikra", "--game", "Miskolc"],
//     "env": { "TINYTRAINS_SERVER": "http://localhost:8765" } }
//
// Transport: MCP over stdio = newline-delimited JSON-RPC 2.0 (one message per line) on stdin/stdout.
// Notifications: the AI calls `await_events`, which long-polls the server and BLOCKS until something
// happens at one of its stations, then returns the event TAGGED with its station and game. Keep
// calling it — it is the master's event loop. (MCP can't reliably wake an idle model; a blocking
// tool the agent waits inside is the robust, host-agnostic pattern.)

"use strict";

function arg(name, envName, def){
  const i = process.argv.indexOf("--" + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (envName && process.env[envName]) return process.env[envName];
  return def;
}
const SERVER = (arg("server", "TINYTRAINS_SERVER", "http://localhost:8765")).replace(/\/$/, "");
const DEFAULT_GAME = arg("game", "TINYTRAINS_GAME", "");
// POSTS = the {game, station} assignments this master holds.
const POSTS = arg("station", "TINYTRAINS_STATION", "").split(",").map(s => s.trim()).filter(Boolean).map(entry => {
  const i = entry.indexOf(":");
  return i >= 0 ? { game: entry.slice(0, i).trim(), station: entry.slice(i + 1).trim() } : { game: DEFAULT_GAME, station: entry };
});
const cursors = {};       // game -> last seen watch-event seq, advanced by await_events

function log(...a){ process.stderr.write("[station-master] " + a.join(" ") + "\n"); } // stderr: never the protocol stream

async function api(method, path, body, game){
  let url = SERVER + path;
  if (method === "GET" && game) url += (path.includes("?") ? "&" : "?") + "game=" + encodeURIComponent(game);
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" },
    body: method !== "GET" ? JSON.stringify(Object.assign({ game }, body || {})) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, body: json };
}
// Which {game, station} a tool call targets: from the station arg (+ optional game). A master with
// exactly one post may omit the station; one managing several must name it.
function post(a){
  const station = a && a.station, game = a && a.game;
  if (station){
    const m = POSTS.filter(p => p.station.toLowerCase() === String(station).toLowerCase() && (!game || p.game.toLowerCase() === String(game).toLowerCase()));
    if (m.length === 1) return m[0];
    if (m.length > 1) throw new Error(`station "${station}" is in several games — also pass game`);
    return { game: game || DEFAULT_GAME, station };           // not one of mine: act on it anyway
  }
  if (POSTS.length === 1) return POSTS[0];
  throw new Error(`you manage ${POSTS.length} stations — pass the station argument (${POSTS.map(p => p.station).join(", ")})`);
}
function someGame(a){ return (a && a.game) || DEFAULT_GAME || (POSTS[0] && POSTS[0].game); }

// ---- Tools --------------------------------------------------------------------------------
// Every per-station tool takes an optional `station` (and `game`); a master with one post may omit
// it, one with several must name the station each event told it about.
const STATION_PROP = { station: { type: "string", description: "which of your stations (omit if you manage only one)" }, game: { type: "string", description: "game name (only if a station name is ambiguous across games)" } };
const TOOLS = [
  { name: "get_guide",
    description: "Read the global Station Master operating brief FIRST: how the railway works, set_path, and the await_events loop. If you manage several stations, you run the same loop for each.",
    inputSchema: { type: "object", properties: {} },
    run: async () => (await api("GET", "/api/guide")).body.guide },

  { name: "get_my_instructions",
    description: "A station's free-text orders: which switches to set / signals to clear for each arriving train. Read it for EACH station you manage. Also returns `overrides` — any STANDING operator overrides in effect (set via chat, \"until further notice …\"); these take precedence over the base instructions until cleared.",
    inputSchema: { type: "object", properties: STATION_PROP },
    run: async (a) => { const p = post(a); return { station: p.station, game: p.game, ...(await api("GET", `/api/stations/${encodeURIComponent(p.station)}/instructions`, null, p.game)).body }; } },

  { name: "list_stations",
    description: "List all stations in a game (names). Also reports which stations YOU manage.",
    inputSchema: { type: "object", properties: { game: { type: "string" } } },
    run: async (a) => ({ youManage: POSTS, stations: ((await api("GET", "/api/stations", null, someGame(a))).body.stations || []).map(s => ({ name: s.name, switches: s.switches.length, signals: s.signals.length })) }) },

  { name: "get_infrastructure",
    description: "A station's switches, signals and consists with LIVE state: each switch's branches + current set direction (compass) and whether it is locked; each signal's mains (manual/automatic, green/red) AND any train currently WAITING at it (type, which way it wants to go, and waitedSeconds = how long it has been stuck); plus `consists` — every train standing in the station with its units (engines+cars, ids), mode (drive/shunt), active engine, and whether its buffers are touching other stock. Check regularly: route waiting trains, clearing the one with the HIGHEST waitedSeconds first.",
    inputSchema: { type: "object", properties: STATION_PROP },
    run: async (a) => { const p = post(a); return (await api("GET", `/api/stations/${encodeURIComponent(p.station)}`, null, p.game)).body.station; } },

  { name: "list_trains",
    description: "Where EVERY consist in a game is and which way it is about to go: type, station/element, heading (compass), moving?, (if stopped) why it is waiting, waitedSeconds, its units (engine/car, ids, which engine is active), mode (drive/shunt) and touching (buffers met). A consist with no active engine is a cut of parked cars. Spot trains stranded a long time and prioritise them.",
    inputSchema: { type: "object", properties: { game: { type: "string" } } },
    run: async (a) => (await api("GET", "/api/trains", null, someGame(a))).body.trains },

  { name: "get_time",
    description: "The current simulation time of day. Returns secondsIntoDay (0..dayLength), dayLength (seconds per day), day (day number), simSeconds (total elapsed), and dayClock (MM:SS within the day). Use for time-of-day rules in your instructions: 'during game time between 2 and 8 minutes' means secondsIntoDay between 120 and 480; outside that means below 120 or above 480. The day wraps every dayLength seconds.",
    inputSchema: { type: "object", properties: { game: { type: "string" } } },
    run: async (a) => (await api("GET", "/api/time", null, someGame(a))).body },

  { name: "set_switch",
    description: "Set one switch so its stem connects to the given branch. direction is a compass bearing (N/NE/E/SE/S/SW/W/NW) and must be one of the switch's branches. Refused if locked by a route in progress.",
    inputSchema: { type: "object", properties: { element: { type: "string", description: "switch name, e.g. '1'" }, direction: { type: "string", description: "compass N/NE/E/SE/S/SW/W/NW" }, ...STATION_PROP }, required: ["element", "direction"] },
    run: async (a) => { const p = post(a); return (await api("POST", `/api/stations/${encodeURIComponent(p.station)}/switch`, { name: a.element, to: a.direction }, p.game)).body; } },

  { name: "clear_signal",
    description: "Clear one manual signal to green, opening (and locking) the route ahead by the current switch settings. Set the switches FIRST. A signal can carry manual mains BOTH ways — pass `direction` (compass) to clear a specific one, else every manual main on the element is cleared. Set shunt:true for a SHUNTING move: the route may then lead into OCCUPIED track (to go couple with standing stock) or end at a buffer, and its lock releases once the move stops. Refused (with a reason) if the path is broken/occupied/conflicting.",
    inputSchema: { type: "object", properties: { element: { type: "string", description: "signal name, e.g. 'A'" }, direction: { type: "string", description: "compass N/NE/E/SE/S/SW/W/NW — which main to clear (needed when a signal has manual mains both ways)" }, shunt: { type: "boolean", description: "clear for a shunting move (may enter occupied track; lock releases at standstill)" }, ...STATION_PROP }, required: ["element"] },
    run: async (a) => { const p = post(a); return (await api("POST", `/api/stations/${encodeURIComponent(p.station)}/signal`, { name: a.element, action: "clear", dir: a.direction, shunt: !!a.shunt }, p.game)).body; } },

  { name: "set_signal_red",
    description: "Set one manual signal back to red (only before a train has taken the cleared route). Pass `direction` (compass) to target one main of a both-ways signal.",
    inputSchema: { type: "object", properties: { element: { type: "string" }, direction: { type: "string", description: "compass N/NE/E/SE/S/SW/W/NW" }, ...STATION_PROP }, required: ["element"] },
    run: async (a) => { const p = post(a); return (await api("POST", `/api/stations/${encodeURIComponent(p.station)}/signal`, { name: a.element, action: "red", dir: a.direction }, p.game)).body; } },

  // ---- Shunting: engine orders (only while the consist stands inside YOUR station) ----
  { name: "reverse_engine",
    description: "Reverse a consist: its leading end becomes its trailing end, so an engine behind cars PUSHES them. Only while it is stopped, and only inside your station. Refused if the new front would roll past a red manual signal — clear that signal first. Address it by `train` (consist id) or `engine` (engine unit id — survives coupling).",
    inputSchema: { type: "object", properties: { train: { type: "number", description: "consist (train) id" }, engine: { type: "number", description: "engine unit id (alternative to train)" }, ...STATION_PROP } },
    run: async (a) => { const p = post(a); return (await api("POST", `/api/stations/${encodeURIComponent(p.station)}/engine`, { action: "reverse", train: a.train, engine: a.engine }, p.game)).body; } },

  { name: "set_drive_mode",
    description: "Switch a consist between 'drive', 'shunt' and 'stop'. SHUNT: slow, ignores passenger stops, and instead of holding a tile back it creeps up until buffers TOUCH other stock (so it can couple) — signals are still obeyed by the leading end. STOP: handbrake — the consist stands where it is even when it could move; a shunting consist that comes to a stand buffers-to-buffers enters STOP by itself (so after `couple` nothing creeps off — typically you couple, reverse, then set 'drive'). DRIVE: normal running with the one-tile standoff; set it before dispatching a train onto the line. REFUSED while the buffers touch stock ahead (it would pull through it) — couple or reverse away first.",
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["drive", "shunt", "stop"] }, train: { type: "number" }, engine: { type: "number" }, ...STATION_PROP }, required: ["mode"] },
    run: async (a) => { const p = post(a); return (await api("POST", `/api/stations/${encodeURIComponent(p.station)}/engine`, { action: "mode", mode: a.mode, train: a.train, engine: a.engine }, p.game)).body; } },

  { name: "uncouple",
    description: "Cut a standing consist at a coupling. keep = how many cars stay attached to the ACTIVE engine (0 = the engine runs alone; 2 = engine keeps two cars). The cut-off portion stays standing exactly where it is (it has no engine). If the engine is mid-consist pass side:'front'|'back'. Returns both resulting consists (the standing one gets a NEW train id).",
    inputSchema: { type: "object", properties: { keep: { type: "number", description: "cars kept on the engine (default 0)" }, side: { type: "string", enum: ["front", "back"] }, train: { type: "number" }, engine: { type: "number" }, ...STATION_PROP } },
    run: async (a) => { const p = post(a); return (await api("POST", `/api/stations/${encodeURIComponent(p.station)}/engine`, { action: "uncouple", keep: a.keep, side: a.side, train: a.train, engine: a.engine }, p.game)).body; } },

  { name: "couple",
    description: "Couple a consist with the stock it is TOUCHING (drive up to it in shunting mode first — get_infrastructure shows `touching:true` when the buffers meet). Your engine stays the active one; engines inside the picked-up stock go inactive until cut off again. Returns the merged consist — NOTE it has a NEW train id (engine unit ids are stable, so addressing by `engine` keeps working).",
    inputSchema: { type: "object", properties: { train: { type: "number" }, engine: { type: "number" }, ...STATION_PROP } },
    run: async (a) => { const p = post(a); return (await api("POST", `/api/stations/${encodeURIComponent(p.station)}/engine`, { action: "couple", train: a.train, engine: a.engine }, p.game)).body; } },

  { name: "set_path",
    description: "Route a train in one call — the EASY way to follow a 'set path …' instruction. Give the path as element names: the entry SIGNAL the train arrives at, then the SWITCHES in order, and optionally a final signal or compass direction. It lines up every switch and clears the entry signal. The entry signal is implied by your instruction: 'arrives at A: set path 1,2,3' → set_path(path=[\"A\",\"1\",\"2\",\"3\"]); 'set path 4 East' at B → set_path(path=[\"B\",\"4\",\"E\"]). Returns which switches were set, or why it couldn't.",
    inputSchema: { type: "object", properties: { path: { type: "array", items: { type: "string" }, description: "[entry signal, switch, …, optional final signal or compass]" }, ...STATION_PROP }, required: ["path"] },
    run: async (a) => { const p = post(a); return (await api("POST", `/api/stations/${encodeURIComponent(p.station)}/path`, { path: a.path }, p.game)).body; } },

  { name: "watch",
    description: "Optional: be notified when a train has PASSED an element (its tail has CLEARED it) — on a SWITCH that means it is now free to re-throw, on a SIGNAL that the block behind has cleared for a following train. ('reach' = a train's head is on the element.) There is NO advance/approach notice: you are told about a train only once it is STOPPED at a signal, via await_events. Returns a watch id.",
    inputSchema: { type: "object", properties: { element: { type: "string", description: "signal or switch name" }, mode: { type: "string", enum: ["pass", "reach"], description: "default 'pass'" }, ...STATION_PROP }, required: ["element"] },
    run: async (a) => { const p = post(a); return (await api("POST", "/api/watches", { station: p.station, owner: p.station, element: a.element, mode: a.mode || "pass" }, p.game)).body.watch; } },

  { name: "await_events",
    description: "BLOCK until something happens at ANY of your stations, then return the event(s), EACH TAGGED with its station and game: a train currently STOPPED at a red signal (mode 'waiting', with waitedSeconds — handle the HIGHEST waitedSeconds FIRST), a MESSAGE from the operator (mode 'message'), or — only if you set a pass-watch — a watched element a train has PASSED (mode 'pass'). There is NO advance/approach notice: you hear about a train only once it is stopped at a signal. THIS IS HOW YOU RECEIVE NOTIFICATIONS — call it, act on each event at the station it names (route per that station's instructions; answer messages with send_message), then call it AGAIN immediately. Empty just means call it again.",
    inputSchema: { type: "object", properties: { timeout_seconds: { type: "number", description: "how long to block, default 25, max 55" } } },
    run: async (a) => {
      if (!POSTS.length) throw new Error("no stations configured — start with --station");
      const wait = Math.min(Math.max(Number(a.timeout_seconds) || 25, 1), 55);
      const byGame = {};
      for (const p of POSTS) (byGame[p.game] = byGame[p.game] || []).push(p.station);
      const ctrls = [];
      const polls = Object.entries(byGame).map(([game, stations]) => {
        const ctrl = new AbortController(); ctrls.push(ctrl);
        const owner = stations.map(encodeURIComponent).join(",");
        return fetch(`${SERVER}/api/notifications?owner=${owner}&after=${cursors[game] || 0}&wait=${wait}${game ? "&game=" + encodeURIComponent(game) : ""}`, { signal: ctrl.signal })
          .then(r => r.json()).then(j => ({ game, j })).catch(() => ({ game, j: { events: [] } }));
      });
      // Resolve as soon as one game returns events (so we don't wait the full timeout); else when all do.
      const winner = await new Promise(resolve => {
        let pending = polls.length, lastEmpty = { game: Object.keys(byGame)[0], j: { events: [] } };
        polls.forEach(pp => pp.then(r => { if (r.j.events && r.j.events.length) resolve(r); else { lastEmpty = r; if (--pending === 0) resolve(lastEmpty); } }));
      });
      ctrls.forEach(c => { try { c.abort(); } catch (e) {} });
      const { game, j } = winner;
      if (typeof j.cursor === "number") cursors[game] = j.cursor;
      const events = (j.events || []).map(e =>
        e.mode === "message" ? { game, station: e.owner, mode: "message", from: e.from || "operator", message: e.text, clock: e.clock }
        : e.mode === "waiting" ? { game, station: e.owner, mode: "waiting", train: e.trainTypeName, trainType: e.trainType, trainId: e.trainId, element: e.element, wantsDir: e.wantsDir, waitedSeconds: e.waitedSeconds, clock: e.clock }
        : { game, station: e.owner, mode: e.mode, train: e.trainTypeName, trainType: e.trainType, trainId: e.trainId, element: e.element, clock: e.clock });
      return events.length ? { events } : { events: [], note: "nothing within " + wait + "s — call await_events again to keep watching" };
    } },

  { name: "send_message",
    description: "Send a message to the human operator (pops up in the game and highlights the station). Report status, ask a question, reply to an operator message, or — once you've worked a while — SUGGEST A CLARIFICATION to a station's instructions when you find a gap/ambiguity/improvement (prefix 'Suggestion:').",
    inputSchema: { type: "object", properties: { text: { type: "string" }, ...STATION_PROP }, required: ["text"] },
    run: async (a) => { const p = post(a); return (await api("POST", `/api/stations/${encodeURIComponent(p.station)}/operator-message`, { text: a.text }, p.game)).body; } },

  { name: "set_override",
    description: "Record a STANDING instruction override the operator gave you over chat (e.g. \"until further notice, all trains arriving at B → set path 4,3,2,5\"). It is stored on the station and TAKES PRECEDENCE over your base instructions for EVERY future train until cleared — so the rule survives past this one message. Call this (then send_message to acknowledge) whenever the operator says to override/change routing until further notice. Overrides also come back in get_my_instructions (field `overrides`).",
    inputSchema: { type: "object", properties: { text: { type: "string" }, ...STATION_PROP }, required: ["text"] },
    run: async (a) => { const p = post(a); return (await api("POST", `/api/stations/${encodeURIComponent(p.station)}/override`, { text: a.text }, p.game)).body; } },

  { name: "clear_override",
    description: "Remove ALL standing overrides for a station (the operator cancelled the override / said go back to normal instructions).",
    inputSchema: { type: "object", properties: STATION_PROP },
    run: async (a) => { const p = post(a); return (await api("POST", `/api/stations/${encodeURIComponent(p.station)}/override`, { action: "clear" }, p.game)).body; } },

  { name: "list_watches",
    description: "List the watches registered for a station.",
    inputSchema: { type: "object", properties: STATION_PROP },
    run: async (a) => { const p = post(a); return (await api("GET", `/api/watches?owner=${encodeURIComponent(p.station)}`, null, p.game)).body.watches; } },

  { name: "cancel_watch",
    description: "Remove a watch by its id (id is within a game).",
    inputSchema: { type: "object", properties: { id: { type: "number" }, ...STATION_PROP }, required: ["id"] },
    run: async (a) => { const p = post(a); return (await api("DELETE", `/api/watches/${Number(a.id)}`, null, p.game)).body; } }
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));

// ---- JSON-RPC over stdio ------------------------------------------------------------------
function send(msg){ process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result){ send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message){ send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg){
  const { id, method, params } = msg;
  if (method === "initialize"){
    const list = POSTS.map(p => p.station + (p.game ? ` (game ${p.game})` : "")).join(", ") || "(none configured)";
    const multi = POSTS.length > 1;
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "tinytrains-station-master", version: "0.2.0" },
      instructions: `You are the Station Master for: ${list}. Call get_guide once, then get_my_instructions for EACH station you manage. Then loop on await_events — it returns each event TAGGED with its station${multi ? " and game" : ""} (a train STOPPED at a signal, or an operator message); act on it at that station (pass the station argument to every tool${multi ? "" : "; you have just one, so you may omit it"}).`
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // no response
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === "tools/call"){
    const tool = TOOL_BY_NAME[params && params.name];
    if (!tool) return reply(id, { content: [{ type: "text", text: "unknown tool: " + (params && params.name) }], isError: true });
    try {
      const out = await tool.run((params && params.arguments) || {});
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      return reply(id, { content: [{ type: "text", text }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: "error: " + (e && e.message ? e.message : String(e)) }], isError: true });
    }
  }
  if (id != null) return replyError(id, -32601, "method not found: " + method);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0){
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    Promise.resolve(handle(msg)).catch(e => log("handler error:", e && e.message));
  }
});
process.stdin.on("end", () => process.exit(0));
log(`ready — managing [${POSTS.map(p => p.station + (p.game ? "@" + p.game : "")).join(", ") || "none"}] server=${SERVER}`);
