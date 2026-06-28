// Tiny Trains — authoritative game server (Node, zero dependencies).
//
// The simulation is server-authoritative: this process owns the live game and ticks it forward
// with the SHARED engine (engine.js, the same code manual.html runs). Browsers and the Station
// Master API are both thin clients — they READ state (snapshot / SSE stream) and SEND operate
// commands; the game keeps running with no browser open. State is managed locally: games persist
// to ./games/<id>.json so they can be saved, listed, and continued.
//
//   node server.js [port]      (default 8765)
//
// Static files (manual.html, engine.js, index.html, …) are served from this directory, so open
//   http://localhost:8765/manual.html
//
// REST API (all JSON; CORS-open for local tooling):
//   GET  /api/health                      → { ok, hasGame, name }
//   GET  /api/state                       → { ok, game, snapshot }            (full live state)
//   GET  /api/events                      → text/event-stream of snapshots     (Server-Sent Events)
//   GET  /api/games                       → [ { id, name, savedAt, simFrame } ] (saved games)
//   POST /api/game/new   { name, layout } → start a fresh game from a builder layout
//   POST /api/game/load  { id }           → load (continue) a saved game
//   POST /api/game/save  { name? }        → persist the current game to disk
//   POST /api/game/pause { paused }       → pause/resume the tick loop
//   POST /api/game/step                   → advance one sim frame (when paused)
//   POST /api/command    { type, ... }    → operate command (throwSwitch/setSwitch/toggleSignal/…)
//   Station Master API:
//   GET  /api/stations                    → every station with instructions + its switches/signals
//   GET  /api/stations/:id                → one station's report
//   POST /api/stations/:id/switch { name|x,y, to }                → set a switch by element name
//   POST /api/stations/:id/signal { name|x,y, dir?, action:clear|red } → operate a manual signal

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createEngine } = require("./engine.js");

const ROOT = __dirname;
const GAMES_DIR = path.join(ROOT, "games");
const PORT = Number(process.argv[2]) || 8765;
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
function sendJSON(res, code, obj){
  const body = JSON.stringify(obj);
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
const STATION_MASTER_GUIDE = `# Tiny Trains — Station Master briefing

You are the **Station Master** of one station on a live model railway. Your job is to route trains
through YOUR station by setting its switches and clearing its manual signals, following the orders
in your station's instructions. One AI runs per station; you control only your own station's
infrastructure.

## How the railway works
- Trains drive **on sight**: a train only stops for an occupied tile ahead, a switch set against it,
  or a **red signal**. There are no crashes.
- **Switches** route by their set branch. A switch points its stem at one branch; the other branch
  is set against and a train arriving on it stops. Set a switch with \`set_switch(element, direction)\`
  where direction is a compass bearing (N, NE, E, SE, S, SW, W, NW) — the branch you want the stem
  connected to.
- **Manual signals** are **red by default** and have no automatic logic. Clearing one
  (\`clear_signal(element)\`) opens a route: the engine checks the path ahead (following the live
  switch settings) to the next signal facing the train; if it is clear it turns the signal green and
  **locks every switch along that route** until the train has passed. Set it back to red with
  \`set_signal_red(element)\` (only works before a train has taken it). A clear can be refused (path
  broken, occupied, or crosses a switch another route already locked) — read the reason and fix the
  switches or wait.
- Some signals are **automatic** (not yours to operate); you only ever set MANUAL signals and
  switches that belong to your station. Elements are addressed by their **station-local name**
  (e.g. \`A\`, \`B\`, \`1\`, \`2\`) — the labels used in your instructions.

## Your instructions
Call \`get_my_instructions\`. They are event-driven orders, e.g. "when a train of line 1 arrives at
A, set 1 to NW and clear A" or "when a train arrives at C: for train 2 set path 5,3; for train 3 set
path 5,2,1,4". Notation:
- "set 1 to NW" → \`set_switch("1", "NW")\`.
- "clear A" / "A green" → \`clear_signal("A")\`.
- "set path 1,2,3" → set switches 1, 2, 3 to route the train along that path, **then clear the entry
  signal** the train is arriving at. Clearing the entry signal locks the route you have set, so set
  the switches first, then clear.
- "line 1" / "train 2" refer to the train's **type number**, which is reported with every
  notification (e.g. type 1 is "line 1"). Match the instruction's line/train number to the
  notified train type.

## Operate PROACTIVELY (this is the point)
Don't wait for trains to stop at red signals. Set the route and clear the entry signal **while the
train is still approaching**, so it rolls straight through without braking. The notification system
gives you that lead time:

1. Once, learn your station: \`get_my_instructions\`, \`get_infrastructure\` (your switches + signals
   with their live state), \`list_stations\` (for context).
2. Set an **approach watch** on each entry signal named in your instructions — easiest is
   \`watch_arrivals()\`, which watches every signal in your station; or \`watch(element, "approach")\`
   for specific ones. ("approach" fires while the train is still a few tiles away and heading toward
   the point; "reach" fires when it arrives; "pass" fires when its tail clears.)
3. Call \`await_events\` and **block**. It returns when a watched train approaches/arrives, telling
   you the train's type and which element. (This is how notifications reach you — keep calling it;
   it is your event loop.)
4. For that train + element, look up your instructions, set the switches, and clear the entry signal
   — now, before it arrives. Then go back to \`await_events\`.

## Talking to the operator
The human operator can message you; those arrive from \`await_events\` as \`mode: "message"\` with the
text. Read them as instructions or questions, act if appropriate, and reply with \`send_message\`
(your message pops up in the game and highlights your station). You may also \`send_message\` anytime
to report status or flag a problem.

## Good practice
- Be **idempotent**: setting a switch already in position or clearing an already-green signal is
  harmless. If unsure of the current state, call \`get_infrastructure\`.
- If \`set_switch\` is refused, the switch is locked by a route in progress — wait for that train.
- If \`clear_signal\` is refused, the path isn't ready (wrong switch, occupied, or conflicting route);
  fix the switches or wait, then retry.
- Stay in your station. Other stations have their own masters; trains hand off between you.
`;

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const url = parsed.pathname;
  const query = parsed.searchParams;
  if (req.method === "OPTIONS") return sendJSON(res, 204, {});

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

    if (url === "/api/guide" && req.method === "GET")
      return sendJSON(res, 200, { ok: true, guide: STATION_MASTER_GUIDE });

    if (url === "/api/state" && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      return sendJSON(res, 200, { ok: true, ...snapshotPayload(lg) });
    }

    if (url === "/api/stations" && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      return sendJSON(res, 200, { ok: true, stations: lg.engine.stationsReport() });
    }

    if ((m = url.match(/^\/api\/stations\/([^\/]+)$/)) && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const st = lg.engine.stationsReport().find(s => String(s.id) === id || s.name.toLowerCase() === id.toLowerCase());
      if (!st) return sendJSON(res, 404, { ok: false, error: "no such station" });
      return sendJSON(res, 200, { ok: true, station: st });
    }

    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/instructions$/)) && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const st = lg.engine.stationsReport().find(s => String(s.id) === id || s.name.toLowerCase() === id.toLowerCase());
      if (!st) return sendJSON(res, 404, { ok: false, error: "no such station" });
      return sendJSON(res, 200, { ok: true, station: st.name, id: st.id, instructions: st.instructions || "" });
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
      const t = resolveTarget(lg, decodeURIComponent(m[1]), body);
      if (!t) return sendJSON(res, 404, { ok: false, error: "element not found in station (give name or x,y)" });
      const result = applyCommand(lg, { type: "setSwitch", x: t.x, y: t.y, to: parseDir(body.to) });
      return sendJSON(res, result.ok ? 200 : 400, { ...result, x: t.x, y: t.y });
    }

    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/signal$/)) && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const t = resolveTarget(lg, decodeURIComponent(m[1]), body);
      if (!t) return sendJSON(res, 404, { ok: false, error: "element not found in station (give name or x,y)" });
      const type = (body.action === "red") ? "redSignal" : "clearSignal";
      const result = applyCommand(lg, { type, x: t.x, y: t.y, dir: body.dir });
      return sendJSON(res, result.ok ? 200 : 400, { ...result, x: t.x, y: t.y });
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
    // From a station master TO the operator: shown in the game notification log + highlights the station.
    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/operator-message$/)) && req.method === "POST"){
      const body = await readBody(req); const lg = reqGame(query, body);
      if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const id = decodeURIComponent(m[1]);
      const st = lg.engine.stationsReport().find(s => String(s.id) === id || s.name.toLowerCase() === id.toLowerCase());
      if (!st) return sendJSON(res, 404, { ok: false, error: "no such station" });
      lg.engine.notifyOperator(st.name, body.text);
      broadcast(lg);
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
      return sendJSON(res, 200, { ok: true, watch: w });
    }

    if (url === "/api/watches" && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      return sendJSON(res, 200, { ok: true, watches: lg.engine.listWatches(query.get("owner") || undefined) });
    }

    if ((m = url.match(/^\/api\/watches\/(\d+)$/)) && req.method === "DELETE"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      return sendJSON(res, 200, { ok: lg.engine.removeWatch(Number(m[1])) });
    }

    // Long-poll: hold the request open until a watched train fires an event for `owner` (seq > after)
    // or `wait` seconds pass. How a Station Master AI receives notifications (via await_events).
    if (url === "/api/notifications" && req.method === "GET"){
      const lg = reqGame(query); if (!lg) return sendJSON(res, NO_GAME.code, NO_GAME.body);
      const owner = query.get("owner") || undefined;
      const after = Number(query.get("after") || 0);
      const waitMs = Math.min(Math.max(Number(query.get("wait") || 25), 0), 55) * 1000;
      const deadline = Date.now() + waitMs;
      let timer = null;
      const tick = () => {
        const events = lg.engine.watchEventsSince(owner, after);
        if (events.length || Date.now() >= deadline)
          return sendJSON(res, 200, { ok: true, events, cursor: lg.engine.watchCursor() });
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
