// Tiny Trains — authoritative game server (Node, zero dependencies).
//
// The simulation is server-authoritative: this process owns the live game and ticks it forward
// with the SHARED engine (engine.js, the same code manual.html runs). Browsers and the Station
// Master API are both thin clients — they READ state (snapshot / SSE stream) and SEND operate
// commands; the game keeps running with no browser open. State is managed locally: games persist
// to ./games/<id>.json so they can be saved, listed, and continued.
//
//   node server.js [port]      (default 8765; or PORT env)
//   TINYTRAINS_GAMES_DIR=./games-test PORT=8788 node server.js   (isolated dir+port for testing)
//
// Static files (manual.html, engine.js, index.html, …) are served from this directory, so open
//   http://localhost:8765/manual.html
//
// REST API (all JSON; CORS-open for local tooling):
//   GET  /api/health                      → { ok, hasGame, name }
//   GET  /api/state                       → { ok, game, snapshot }            (full live state)
//   GET  /api/time                        → { ok, secondsIntoDay, dayLength, day, dayClock, simSeconds }
//   GET  /api/events                      → text/event-stream of snapshots     (Server-Sent Events)
//   GET  /api/games                       → [ { id, name, savedAt, simFrame } ] (saved games)
//   POST /api/game/new   { name, layout } → start a fresh game from a builder layout
//   POST /api/game/load  { id }           → load (continue) a saved game
//   POST /api/game/save  { name? }        → persist the current game to disk
//   POST /api/game/pause { paused }       → pause/resume the tick loop
//   POST /api/game/step                   → advance one sim frame (when paused)
//   POST /api/command    { type, ... }    → operate command (throwSwitch/setSwitch/toggleSignal/…,
//                                            setSpeed { scale }, setDayLength { seconds })
//   Station Master API:
//   GET  /api/stations                    → every station with instructions + its switches/signals/consists
//   GET  /api/stations/:id                → one station's report
//   POST /api/stations/:id/switch { name|x,y, to }                → set a switch by element name
//   POST /api/stations/:id/signal { name|x,y, dir?, action:clear|red, shunt? } → operate a manual signal
//                                            (shunt:true = clear INTO occupied track, for coupling)
//   POST /api/stations/:id/engine { action:reverse|mode|uncouple|couple, train|engine, ... }
//                                          → shunting orders to an engine standing in this station
//   POST /api/stations/:id/override { text } | { action:"clear" }      → standing instruction override

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createEngine } = require("./engine.js");

const ROOT = __dirname;
// Game persistence directory and port are overridable so a test run can use an isolated dir+port
// and never touch the directory/port someone is actually playing on (default ./games on :8765).
const GAMES_DIR = process.env.TINYTRAINS_GAMES_DIR
  ? path.resolve(process.env.TINYTRAINS_GAMES_DIR) : path.join(ROOT, "games");
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8765;
const FRAMES_PER_SECOND = 60;
const SIM_STEP_MS = 1000 / FRAMES_PER_SECOND;
const BROADCAST_EVERY = 3;     // stream a snapshot every N sim frames (~20 Hz; trains move slowly)
const AUTOSAVE_MS = 10000;     // persist the live game to disk this often

if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });

// ---- Live games (MANY run at once) -------------------------------------------------------
// games: id -> { id, name, engine, running, undo, redo, subs:Set<res>, saveTimer, lastAutosave }.
// Every running game is ticked; the UI VIEWS one (subscribes to its stream) while others keep
// playing — so station masters keep operating their game even when you switch the UI to another.
const games = new Map();

function newId(){ return "g" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
function gamePath(id){ return path.join(GAMES_DIR, path.basename(id) + ".json"); }

function makeLive({ id, name, engine }){
  const lg = { id: id || newId(), name: name || "Untitled", engine, running: true, undo: [], redo: [], subs: new Set(), saveTimer: null, lastAutosave: 0, acc: 0, sinceBroadcast: 0 };
  games.set(lg.id, lg);
  return lg;
}
function startGame({ id, name, fromLayout, fromSnapshot }){
  const engine = createEngine();
  if (fromSnapshot) engine.applySnapshot(fromSnapshot);
  else engine.deserialize(typeof fromLayout === "string" ? fromLayout : JSON.stringify(fromLayout));
  const lg = makeLive({ id, name, engine });
  saveGame(lg);        // every game is immediately a saved game (server-only: no unsaved state)
  broadcast(lg);
  return lg;
}
function loadRec(id){ const p = gamePath(id); if (!fs.existsSync(p)) return null; try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
// Resolve a game reference (id OR name) to a LIVE game, loading it from disk into the live set if it
// isn't already running. This is what lets a station master target its own game by name regardless
// of what the UI is viewing.
function resolveGame(ref){
  if (ref == null || ref === "") return null;
  ref = String(ref);
  if (games.has(ref)) return games.get(ref);
  for (const lg of games.values()) if (lg.name.toLowerCase() === ref.toLowerCase()) return lg;
  let rec = loadRec(ref);
  if (!rec){ const hit = listSaved().find(g => g.name.toLowerCase() === ref.toLowerCase()); if (hit) rec = loadRec(hit.id); }
  if (!rec) return null;
  const engine = createEngine(); engine.applySnapshot(rec.snapshot);
  return makeLive({ id: rec.id, name: rec.name, engine });
}
// The game for a request: explicit ?game=/body.game, else (convenience) the only live game.
function reqGame(query, body){
  const ref = (body && body.game != null ? body.game : null) || (query && query.get("game"));
  if (ref) return resolveGame(ref);
  return games.size === 1 ? games.values().next().value : null;
}

function saveGame(lg, name){
  if (!lg) return null;
  if (name) lg.name = name;
  const rec = { id: lg.id, name: lg.name, savedAt: Date.now(), snapshot: lg.engine.snapshot() };
  fs.writeFileSync(gamePath(lg.id), JSON.stringify(rec));
  return rec;
}
// Continuous autosave per game (debounced) so "whenever anything changes" the save updates.
function scheduleSave(lg){ if (!lg || lg.saveTimer) return; lg.saveTimer = setTimeout(() => { lg.saveTimer = null; try { saveGame(lg); } catch (e) { console.error("autosave failed:", e.message); } }, 400); }

function pushUndo(lg){ lg.undo.push(lg.engine.serialize()); if (lg.undo.length > 100) lg.undo.shift(); lg.redo.length = 0; }
function applyCommand(lg, cmd){
  if (!lg) return { ok: false, error: "no such game" };
  if (lg.engine.EDIT_COMMANDS && lg.engine.EDIT_COMMANDS.has(cmd.type)) pushUndo(lg);
  const result = lg.engine.command(cmd);
  scheduleSave(lg); broadcast(lg);
  return result;
}
function undoRedo(lg, which){
  if (!lg) return { ok: false, error: "no such game" };
  const from = which === "redo" ? lg.redo : lg.undo;
  const to = which === "redo" ? lg.undo : lg.redo;
  if (!from.length) return { ok: false, error: "nothing to " + which };
  to.push(lg.engine.serialize());
  lg.engine.applyLayout(from.pop());
  scheduleSave(lg); broadcast(lg);
  return { ok: true };
}
// Fork a game into a NEW live game (the original keeps running).
function saveAs(lg, name){
  if (!lg) return null;
  const engine = createEngine(); engine.applySnapshot(lg.engine.snapshot());
  const ng = makeLive({ name: name || lg.name, engine });
  saveGame(ng); broadcast(ng);
  return ng;
}

function listSaved(){
  return fs.readdirSync(GAMES_DIR).filter(f => f.endsWith(".json")).map(f => {
    try { const rec = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, f), "utf8"));
      return { id: rec.id, name: rec.name, savedAt: rec.savedAt, simFrame: rec.snapshot ? rec.snapshot.simFrame : 0 }; } catch { return null; }
  }).filter(Boolean);
}
// Saved games merged with live ones (live entries show the running sim frame + flags).
function listGames(){
  const map = new Map(listSaved().map(g => [g.id, g]));
  for (const lg of games.values()) map.set(lg.id, { id: lg.id, name: lg.name, savedAt: (map.get(lg.id) || {}).savedAt || 0, simFrame: lg.engine.state.simFrame });
  return [...map.values()].map(g => ({ ...g, live: games.has(g.id), running: games.has(g.id) ? games.get(g.id).running : false }))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

function gameMeta(lg){ return lg ? { id: lg.id, name: lg.name, running: lg.running } : null; }
function snapshotPayload(lg){ return lg ? { game: gameMeta(lg), snapshot: lg.engine.snapshot() } : { game: null, snapshot: null }; }

// ---- Tick loop: advance EVERY running game -----------------------------------------------
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  let elapsed = now - last; last = now;
  if (elapsed > 250) elapsed = 250;
  for (const lg of games.values()){
    if (lg.running){
      lg.acc += elapsed;
      let steps = 0;
      while (lg.acc >= SIM_STEP_MS && steps < 8){ lg.engine.simStep(); lg.acc -= SIM_STEP_MS; steps++; lg.sinceBroadcast++; }
      if (steps >= 8) lg.acc = 0;
      if (lg.sinceBroadcast >= BROADCAST_EVERY){ lg.sinceBroadcast = 0; broadcast(lg); }
    } else lg.acc = 0;
    if (now - lg.lastAutosave > AUTOSAVE_MS){ lg.lastAutosave = now; try { saveGame(lg); } catch (e) {} }
  }
}, SIM_STEP_MS);

// ---- SSE broadcast (per game, to that game's subscribers) --------------------------------
function broadcast(lg){
  if (!lg || !lg.subs.size) return;
  const data = "data: " + JSON.stringify(snapshotPayload(lg)) + "\n\n";
  for (const res of lg.subs){ try { res.write(data); } catch { lg.subs.delete(res); } }
}

// ---- HTTP plumbing -----------------------------------------------------------------------
// Highlight error lines: bold red when the log is a terminal, plus an always-on "✗" marker so they
// still stand out (and grep) when the log is redirected to a file.
const LOG_RED = process.stdout.isTTY ? "\x1b[1;31m" : "", LOG_RESET = process.stdout.isTTY ? "\x1b[0m" : "";
function logLine(text, isError){ console.log(isError ? `${LOG_RED}${text}${LOG_RESET}` : text); }
function sendJSON(res, code, obj){
  const body = JSON.stringify(obj);
  // Log the response we return, compact and on one line (JSON.stringify has no whitespace). An error
  // response (4xx/5xx, or ok:false) is highlighted with the request that caused it. TINYTRAINS_QUIET=1 silences.
  if (!process.env.TINYTRAINS_QUIET){
    const isErr = code >= 400 || (obj && obj.ok === false);
    logLine(`${new Date().toISOString().slice(11, 19)} [RES ${code}${isErr ? " ✗" : ""}] ${res._reqLine || ""} -> ${body}`, isErr);
  }
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
  res.end(body);
}
function readBody(req){
  return new Promise((resolve) => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 8e6) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}
// Print every Station Master API call (the operator UI uses /api/command + /api/events instead, so
// this stays focused on what the masters do). Set TINYTRAINS_QUIET=1 to silence.
function smlog(summary){
  if (process.env.TINYTRAINS_QUIET) return;
  const isErr = /REFUSED/.test(summary);   // the [SM] summary embeds the result; a refusal is the request half of an error pair
  logLine(`${new Date().toISOString().slice(11, 19)} [SM]${isErr ? " ✗" : ""} ${summary}`, isErr);
}
function gname(lg){ return lg ? lg.name : "?"; }

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".p8": "text/plain", ".md": "text/markdown" };

function serveStatic(req, res){
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) return sendJSON(res, 403, { error: "forbidden" });   // no path traversal
  fs.readFile(full, (err, buf) => {
    if (err) return sendJSON(res, 404, { error: "not found", path: rel });
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(buf);
  });
}

// Resolve a Station Master target tile from { name } (station-local element name) or { x, y }.
function resolveTarget(lg, stationId, body){
  if (Number.isFinite(body.x) && Number.isFinite(body.y)) return { x: body.x, y: body.y };
  if (body.name != null){
    const hit = lg.engine.resolveElement(stationId, body.name);
    if (hit) return { x: hit.x, y: hit.y, tile: hit.tile };
  }
  return null;
}

// Switch directions may be given by compass name (NW, W, …) or numeric index (0..7, N..NW).
const DIR_INDEX = { N: 0, NE: 1, E: 2, SE: 3, S: 4, SW: 5, W: 6, NW: 7 };
function parseDir(v){
  if (v == null) return v;
  if (typeof v === "number") return v;
  const s = String(v).trim().toUpperCase();
  if (s in DIR_INDEX) return DIR_INDEX[s];
  const n = Number(s);
  return Number.isFinite(n) ? n : v;
}

// The global operating brief every Station Master AI reads first (GET /api/guide). It is the same
// for every station; the station-specific orders come from GET /api/stations/:id/instructions.
const STATION_MASTER_GUIDE = `# Tiny Trains — Station Master

You run one or more stations: route trains through them by setting switches and clearing manual
signals, following each station's instructions. Elements have short local names (A, B, 1, 2 …) — the
names the instructions use. Trains run on sight and never crash; a train stops only at a red signal, a
switch set against it, or an occupied tile.

If you manage SEVERAL stations, do the setup (get_my_instructions) for EACH, then run the one loop
below: every await_events event is tagged with the station (and game) it belongs to — act on it at
that station, and pass that station to each tool.

## The easy way to route a train: set_path
Your instructions read like "when a train arrives at A: set path 1,2,3" or "train 2 → set path 5,3".
Just call **set_path** with the entry signal followed by those switches — it lines up every switch for
you and clears the entry signal:
  - "a train arrives at A: set path 1,2,3"  →  set_path(["A","1","2","3"])
  - "set path 4 East" (train at B)          →  set_path(["B","4","E"])   (final compass dir or signal
    fixes the last switch's exit if needed)
The entry signal is the one the train is arriving at — your instructions imply it, so put it first.
If set_path reports a problem, read it and fix the path. ("line N"/"train N" = train TYPE N, reported
with every event.) You can still set one switch with set_switch(element, compass) or open/close a
signal with clear_signal / set_signal_red when an instruction is that specific.

## Route by the train that is ACTUALLY at the signal
A manual signal releases whichever train is physically FIRST at it — NOT whichever you had in mind. So
a set_path + clear sends *that* train down the route you set. Each "waiting" event names the train at
the signal (its trainType + wantsDir); if two trains are queued at one signal, route the one that is
FIRST, and set the path for THAT train's type — if unsure, confirm with get_infrastructure (each
signal's \`waiting\`) or list_trains before clearing, so you don't send the wrong train the wrong way.
Also check no other train is already sitting on the path you open (between the signal and its
destination), or they will conflict.

## Your job, in a loop
1. Once: get_my_instructions, get_infrastructure (your switches + signals, and any train WAITING at
   each signal).
2. Loop with await_events — call it, act on every event it returns, then call it AGAIN immediately.
   You are told about a train only once it is STOPPED at a signal — there is NO advance/approach notice
   (this keeps you from routing too early and locking switches before they're needed). It returns:
   - mode "waiting" → a train STOPPED at a red signal (it carries waitedSeconds). When several are
     returned they come longest-wait first — clear the HIGHEST waitedSeconds FIRST; treat a large
     waitedSeconds as urgent.
   - mode "message" → the operator; reply with send_message.
   Re-try anything refused earlier (a conflicting route may have cleared). get_infrastructure (which
   also lists each signal's waiting train + waitedSeconds) and list_trains give the fuller picture.
   Don't go idle while any train is waiting — keep looping on await_events.

## Shunting (inside your station)
Trains are CONSISTS of an engine plus cars. Engines can uncouple, run around and pick up cars —
but ONLY while standing inside a station, and it is YOUR job at your station. The tools:
  - **set_drive_mode(train, "shunt" | "drive" | "stop")** — "shunt": the engine moves slowly and,
    instead of holding a tile back from other stock, creeps up until the buffers TOUCH. "drive"
    restores normal running (do this before dispatching a train onto the line). "stop" is the
    handbrake: the consist stands where it is even when it could move. A shunting consist that
    comes to a stand buffers-to-buffers enters "stop" BY ITSELF — so after **couple** nothing
    creeps off: the usual sequence is couple → reverse_engine → set_drive_mode "drive".
  - **reverse_engine(train)** — change direction (an engine behind cars then pushes them). Only
    when stopped. If the front would roll past a red manual signal, the reverse is refused —
    clear that signal first.
  - **uncouple(train, keep)** — cut the consist: keep = how many cars stay on the active engine
    (0 = the engine alone). The rest stays standing where it is.
  - **couple(train)** — couple with the stock the consist is TOUCHING (drive up to it in shunting
    mode first; the report shows \`touching\`). The engine you command stays in charge; engines in
    the picked-up consist go inactive until cut off again.
Shunting moves obey signals like any train — the LEADING end (even when it is a pushed car)
stops at a red main. Two extras exist for shunting:
  - clear_signal with **shunt:true** opens a route INTO occupied track (needed to reach stock you
    want to couple), and its route lock releases as soon as the move comes to a stand.
  - A route may end at a BUFFER (a stub), not only at the next signal.
Find your targets with get_infrastructure (each station lists its \`consists\`: id, units, mode,
what it is waiting for, whether it is touching) or list_trains. Address orders by \`train\` id or
by \`engine\` (unit) id — engine ids survive coupling, train ids change when consists merge.

## Notes
- A switch can't be re-thrown until a train clears it, nor a signal's block re-used until a train
  passes; \`watch(element,"pass")\` tells you the moment that's safe (on a switch = free to re-throw,
  on a signal = block behind cleared).
- A refused clear/set means the path isn't ready (wrong switch, occupied, or locked by another route)
  — fix or wait, then retry. Setting something already set is harmless.
- The operator may message you (arrives via await_events as \`mode:"message"\`); reply with
  send_message. Once you've worked a while, if an instruction is ambiguous or has a gap, send a
  "Suggestion: …" (don't spam, and not the same one twice).
- Some instructions are time-of-day rules — e.g. "during game time between 2 and 8 minutes: … /
  outside that: …". Call **get_time** for the current \`secondsIntoDay\` (0..\`dayLength\`) and pick the
  matching branch (2 minutes = 120s, 8 minutes = 480s). The day wraps every \`dayLength\` seconds.
- **Temporary overrides over chat.** The operator can change your orders on the fly, e.g. "Attention,
  instruction override! Until further notice, all trains arriving at B → set path 4,3,2,5." Do NOT just
  acknowledge in words — your memory of one message does not carry to the next train. Instead call
  **set_override** with the rule (\`set_override("until further notice: trains arriving at B → set path
  4,3,2,5")\`), THEN send_message to acknowledge. The override is stored on the station and **takes
  precedence over your base instructions** for every future train until the operator cancels it — then
  call **clear_override**. Your overrides come back with get_my_instructions (field \`overrides\`); when
  routing, apply any that match before falling back to your base instructions.
- Stay in your station; trains hand off to other stations' masters.
`;

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const url = parsed.pathname;
  const query = parsed.searchParams;
  res._reqLine = req.method + " " + req.url;   // so sendJSON can label the response it logs
  if (req.method === "OPTIONS") return sendJSON(res, 204, {});

  // Bare browser/tab requests for /favicon.ico get the SVG (pages also <link> it directly).
  if (url === "/favicon.ico"){ req.url = "/favicon.svg"; return serveStatic(req, res); }
  if (!url.startsWith("/api/")) return serveStatic(req, res);

  // The game a request targets (?game=<id|name> or body.game). Most endpoints need one; the helper
  // returns the only live game when unspecified (single-game convenience), else null.
  const NO_GAME = { code: 409, body: { ok: false, error: "specify ?game=<id|name> (no such / no single game)" } };

  try {
    let m;
    // ---- read-only ----
    if (url === "/api/health" && req.method === "GET")
      return sendJSON(res, 200, { ok: true, games: listGames().filter(g => g.live).map(g => ({ id: g.id, name: g.name, running: g.running })) });

    if (url === "/api/games" && req.method === "GET")
      return sendJSON(res, 200, { ok: true, games: listGames() });

    if (url === "/api/guide" && req.method === "GET"){
      smlog("get_guide");
      return sendJSON(res, 200, { ok: true, guide: STATION_MASTER_GUIDE });
    }

    if (url === "/api/state" && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      return sendJSON(res, 200, { ok: true, ...snapshotPayload(lg) });
    }

    // Current simulation time of day: seconds within the current day (0..dayLength), for time-of-day
    // rules in station instructions ("during game time between 2 and 8 minutes" = secondsIntoDay 120..480).
    if (url === "/api/time" && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const t = lg.engine.dayTime();
      smlog(`${gname(lg)} | get_time -> ${t.dayClock} (day ${t.day}, ${t.secondsIntoDay}/${t.dayLength}s)`);
      return sendJSON(res, 200, { ok: true, game: gameMeta(lg), ...t });
    }

    if (url === "/api/stations" && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      smlog(`${gname(lg)} | list_stations`);
      return sendJSON(res, 200, { ok: true, stations: lg.engine.stationsReport() });
    }

    // Where every train is + which way it's about to go (incl. trains waiting at signals).
    if (url === "/api/trains" && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      smlog(`${gname(lg)} | list_trains`);
      return sendJSON(res, 200, { ok: true, trains: lg.engine.trainsReport() });
    }

    if ((m = url.match(/^\/api\/stations\/([^\/]+)$/)) && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const st = lg.engine.stationsReport().find(s => String(s.id) === id || s.name.toLowerCase() === id.toLowerCase());
      if (!st) return sendJSON(res, 404, { ok: false, error: "no such station" });
      smlog(`${gname(lg)} ${st.name} | get_infrastructure`);
      return sendJSON(res, 200, { ok: true, station: st });
    }

    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/instructions$/)) && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const st = lg.engine.stationsReport().find(s => String(s.id) === id || s.name.toLowerCase() === id.toLowerCase());
      if (!st) return sendJSON(res, 404, { ok: false, error: "no such station" });
      smlog(`${gname(lg)} ${st.name} | get_my_instructions`);
      return sendJSON(res, 200, { ok: true, station: st.name, id: st.id, instructions: st.instructions || "", overrides: st.overrides || [] });
    }

    // ---- SSE state stream for one game (?game=<id|name>) ----
    if (url === "/api/events" && req.method === "GET"){
      const lg = reqGame(query);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
      res.write("retry: 2000\n\n");
      res.write("data: " + JSON.stringify(snapshotPayload(lg)) + "\n\n");
      if (lg){ lg.subs.add(res); req.on("close", () => lg.subs.delete(res)); }
      else req.on("close", () => {});
      return;
    }

    // ---- game lifecycle ----
    if (url === "/api/game/new" && req.method === "POST"){
      const body = await readBody(req);
      if (!body.layout) return sendJSON(res, 400, { ok: false, error: "missing layout" });
      try { const lg = startGame({ name: body.name, fromLayout: body.layout });
        return sendJSON(res, 200, { ok: true, id: lg.id, name: lg.name }); }
      catch (e) { return sendJSON(res, 400, { ok: false, error: "bad layout: " + e.message }); }
    }

    if (url === "/api/game/load" && req.method === "POST"){
      const body = await readBody(req);                          // load = ensure live; it keeps running
      const lg = resolveGame(body.id || body.game);
      if (!lg) return sendJSON(res, 404, { ok: false, error: "no such saved game" });
      return sendJSON(res, 200, { ok: true, id: lg.id, name: lg.name });
    }

    if (url === "/api/game/save" && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const rec = saveGame(lg, body.name);
      return sendJSON(res, 200, { ok: true, id: rec.id, name: rec.name, savedAt: rec.savedAt });
    }

    if (url === "/api/game/save-as" && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const ng = saveAs(lg, body.name);
      return sendJSON(res, 200, { ok: true, id: ng.id, name: ng.name });
    }

    if (url === "/api/game/rename" && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      lg.name = (body.name || "").trim() || lg.name;
      saveGame(lg); broadcast(lg);
      return sendJSON(res, 200, { ok: true, name: lg.name });
    }

    if ((url === "/api/game/undo" || url === "/api/game/redo") && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const result = undoRedo(lg, url.endsWith("redo") ? "redo" : "undo");
      return sendJSON(res, result.ok ? 200 : 400, result);
    }

    if (url === "/api/game/pause" && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      lg.running = !body.paused; lg.engine.setPaused(!lg.running); broadcast(lg);
      return sendJSON(res, 200, { ok: true, running: lg.running });
    }

    if (url === "/api/game/step" && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      lg.engine.simStep(); broadcast(lg);
      return sendJSON(res, 200, { ok: true, simFrame: lg.engine.state.simFrame });
    }

    // ---- operate / edit ----
    if (url === "/api/command" && req.method === "POST"){
      const cmd = await readBody(req); const lg = reqGame(query, cmd);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const result = applyCommand(lg, cmd);
      return sendJSON(res, result.ok ? 200 : 400, { ...result });
    }

    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/switch$/)) && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const t = resolveTarget(lg, id, body);
      if (!t) return sendJSON(res, 404, { ok: false, error: "element not found in station (give name or x,y)" });
      const result = applyCommand(lg, { type: "setSwitch", x: t.x, y: t.y, to: parseDir(body.to) });
      smlog(`${gname(lg)} ${id} | set_switch ${body.name} -> ${body.to}  ${result.ok ? "ok" : "REFUSED: " + result.error}`);
      return sendJSON(res, result.ok ? 200 : 400, { ...result, x: t.x, y: t.y });
    }

    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/signal$/)) && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const t = resolveTarget(lg, id, body);
      if (!t) return sendJSON(res, 404, { ok: false, error: "element not found in station (give name or x,y)" });
      const type = (body.action === "red") ? "redSignal" : "clearSignal";
      const result = applyCommand(lg, { type, x: t.x, y: t.y, dir: parseDir(body.dir), shunt: !!body.shunt });
      smlog(`${gname(lg)} ${id} | ${body.action === "red" ? "set_signal_red" : "clear_signal"} ${body.name}${body.dir != null ? " " + body.dir : ""}${body.shunt ? " (shunt)" : ""}  ${result.ok ? (result.action || "ok") : "REFUSED: " + result.error}`);
      return sendJSON(res, result.ok ? 200 : 400, { ...result, x: t.x, y: t.y });
    }

    // Set a whole path of switches at once (and clear the entry signal). body.path is a list of
    // station-local names: an entry signal, then switches (with an optional final signal / compass dir).
    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/path$/)) && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const result = applyCommand(lg, { type: "setPath", station: id, path: body.path });
      smlog(`${gname(lg)} ${id} | set_path [${(body.path || []).join(",")}]  ${result.ok ? "set " + (result.set || []).map(s => s.name + "=" + s.dir).join(",") + (result.cleared ? " +clear " + result.entry : "") : "REFUSED: " + result.error}`);
      return sendJSON(res, result.ok ? 200 : 400, result);
    }

    // ---- Shunting: engine orders (station-scoped) ----
    // POST /api/stations/:id/engine { action, train | engine, ... } — orders to one engine's
    // consist, allowed only while it stands inside THIS station:
    //   { action:"reverse" }                          change direction (push instead of pull)
    //   { action:"mode", mode:"shunt"|"drive"|"stop" } switch driving mode (stop = handbrake)
    //   { action:"uncouple", keep?, side?, cut? }     cut the consist (keep = cars kept on the engine)
    //   { action:"couple" }                           couple with the touching consist
    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/engine$/)) && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const st = lg.engine.stationsReport().find(s => String(s.id) === id || s.name.toLowerCase() === id.toLowerCase());
      if (!st) return sendJSON(res, 404, { ok: false, error: "no such station" });
      const sel = { train: body.train, engine: body.engine, station: st.name };
      const ACTIONS = {
        reverse:  () => ({ type: "reverse", ...sel }),
        mode:     () => ({ type: "setTrainMode", ...sel, mode: body.mode }),
        uncouple: () => ({ type: "detach", ...sel, keep: body.keep, side: body.side, cut: body.cut }),
        couple:   () => ({ type: "couple", ...sel })
      };
      const make = ACTIONS[body.action];
      if (!make) return sendJSON(res, 400, { ok: false, error: "action must be reverse | mode | uncouple | couple" });
      const result = applyCommand(lg, make());
      smlog(`${gname(lg)} ${st.name} | engine_${body.action} ${body.train != null ? "train " + body.train : "engine " + body.engine}${body.mode ? " -> " + body.mode : ""}${body.keep != null ? " keep " + body.keep : ""}  ${result.ok ? "ok" : "REFUSED: " + result.error}`);
      return sendJSON(res, result.ok ? 200 : 400, result);
    }

    // ---- Operator <-> Station Master chat ----
    // From the operator (UI) TO a station master: delivered on the master's event stream so its
    // await_events wakes with it (mode "message").
    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/message$/)) && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const st = lg.engine.stationsReport().find(s => String(s.id) === id || s.name.toLowerCase() === id.toLowerCase());
      if (!st) return sendJSON(res, 404, { ok: false, error: "no such station" });
      lg.engine.notifyOwner(st.name, body.text, "operator");
      return sendJSON(res, 200, { ok: true, station: st.name });
    }
    // Standing instruction overrides for a station: temporary operator orders that take precedence over
    // the base instructions until cleared. POST { text } to add one (the master records it when the
    // operator says "override … until further notice"); POST { action: "clear" } to drop them all.
    // Persisted with the game (every master reads them via get_my_instructions each decision).
    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/override$/)) && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const clear = body.action === "clear" || body.clear === true;
      const result = applyCommand(lg, clear ? { type: "clearOverrides", station: id } : { type: "addOverride", station: id, text: body.text });
      smlog(`${gname(lg)} ${id} | ${clear ? "clear_overrides" : `set_override "${body.text}"`}  ${result.ok ? "ok" : "REFUSED: " + result.error}`);
      return sendJSON(res, result.ok ? 200 : 400, result);
    }
    // From a station master TO the operator: shown in the game notification log + highlights the station.
    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/operator-message$/)) && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const st = lg.engine.stationsReport().find(s => String(s.id) === id || s.name.toLowerCase() === id.toLowerCase());
      if (!st) return sendJSON(res, 404, { ok: false, error: "no such station" });
      lg.engine.notifyOperator(st.name, body.text);
      broadcast(lg);
      smlog(`${gname(lg)} ${st.name} | send_message -> operator: "${body.text}"`);
      return sendJSON(res, 200, { ok: true, station: st.name });
    }

    // ---- Station Master notifications: register a watch, list/remove, long-poll ----
    if (url === "/api/watches" && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      let x = body.x, y = body.y;
      if (!(Number.isFinite(x) && Number.isFinite(y))){
        const elem = body.element != null ? body.element : body.name;
        if (body.station == null || elem == null) return sendJSON(res, 400, { ok: false, error: "give x,y or station + element" });
        const hit = lg.engine.resolveElement(body.station, elem);
        if (!hit) return sendJSON(res, 404, { ok: false, error: "element not found in station" });
        x = hit.x; y = hit.y;
      }
      const owner = body.owner != null ? String(body.owner) : (body.station != null ? String(body.station) : "");
      const w = lg.engine.addWatch({ owner, x, y, mode: body.mode, tiles: body.tiles, element: body.element || body.name || null, label: body.label });
      smlog(`${gname(lg)} ${owner} | watch ${body.element || body.name || (x + "," + y)} ${body.mode || "approach"}`);
      return sendJSON(res, 200, { ok: true, watch: w });
    }

    if (url === "/api/watches" && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      smlog(`${gname(lg)} ${query.get("owner") || ""} | list_watches`);
      return sendJSON(res, 200, { ok: true, watches: lg.engine.listWatches(query.get("owner") || undefined) });
    }

    if ((m = url.match(/^\/api\/watches\/(\d+)$/)) && req.method === "DELETE"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      smlog(`${gname(lg)} | cancel_watch ${m[1]}`);
      return sendJSON(res, 200, { ok: lg.engine.removeWatch(Number(m[1])) });
    }

    // Long-poll: hold the request open until a watched train fires an event for `owner` (seq > after)
    // or `wait` seconds pass. How a Station Master AI receives notifications (via await_events).
    if (url === "/api/notifications" && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const ownerParam = query.get("owner");                 // one station, or a comma-list of stations
      const owner = ownerParam ? ownerParam.split(",").map(s => s.trim()).filter(Boolean) : undefined;
      smlog(`${gname(lg)} ${ownerParam || ""} | await_events (poll)`);
      const after = Number(query.get("after") || 0);
      const waitMs = Math.min(Math.max(Number(query.get("wait") || 25), 0), 55) * 1000;
      const start = Date.now(), deadline = start + waitMs;
      const softMs = Math.min(4000, waitMs); // after this, surface trains already stuck (no edge event fires for them)
      let timer = null;
      const tick = () => {
        const events = lg.engine.watchEventsSince(owner, after);
        if (events.length) return sendJSON(res, 200, { ok: true, events, cursor: lg.engine.watchCursor() });
        const now = Date.now();
        if (now >= start + softMs){
          const waiting = lg.engine.waitingTrainsReport(owner); // currently-stranded trains, longest wait first
          if (waiting.length || now >= deadline)
            return sendJSON(res, 200, { ok: true, events: waiting, cursor: lg.engine.watchCursor() });
        }
        timer = setTimeout(tick, 150);
      };
      req.on("close", () => { if (timer) clearTimeout(timer); });
      tick();
      return;
    }

    return sendJSON(res, 404, { ok: false, error: "unknown endpoint " + req.method + " " + url });
  } catch (e) {
    console.error("request error:", e);
    return sendJSON(res, 500, { ok: false, error: e.message });
  }
});

// Ensure at least one game is live on boot, so the UI has a default to view. Other games come live
// on demand (resolveGame) when the UI loads them or a station master targets them — and keep running.
const EMPTY_LAYOUT = { version: 3, tiles: [], stations: [], trainTypes: [], view: { x: 0, y: 0, zoom: 1 } };
function bootGame(){
  const saved = listSaved().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  if (saved.length){
    const lg = resolveGame(saved[0].id);
    if (lg){ console.log(`Resumed "${lg.name}" (${lg.id})`); return; }
  }
  const lg = startGame({ name: "Untitled", fromLayout: EMPTY_LAYOUT });
  console.log(`Started a new empty game (${lg.id})`);
}

server.listen(PORT, () => {
  bootGame();
  console.log(`Tiny Trains server on http://localhost:${PORT}  (open /manual.html)`);
  console.log(`Games persisted in ${GAMES_DIR}`);
});
