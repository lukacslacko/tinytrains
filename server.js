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

// ---- The one live game -------------------------------------------------------------------
// { id, name, engine, running, createdAt } — engine holds the authoritative state.
let game = null;
const sseClients = new Set();
let lastAutosave = 0;

function newId(){ return "g" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
function gamePath(id){ return path.join(GAMES_DIR, path.basename(id) + ".json"); }

function startGame({ id, name, fromLayout, fromSnapshot }){
  const engine = createEngine();
  if (fromSnapshot) engine.applySnapshot(fromSnapshot);
  else engine.deserialize(typeof fromLayout === "string" ? fromLayout : JSON.stringify(fromLayout));
  game = { id: id || newId(), name: name || "Untitled", engine, running: true, createdAt: Date.now(), undo: [], redo: [] };
  saveGame();        // every game is immediately a saved game (server-only: there is no unsaved state)
  broadcast();
  return game;
}

function saveGame(name){
  if (!game) return null;
  if (name) game.name = name;
  const rec = { id: game.id, name: game.name, savedAt: Date.now(), snapshot: game.engine.snapshot() };
  fs.writeFileSync(gamePath(game.id), JSON.stringify(rec));
  return rec;
}
// Autosave is continuous: any change marks the game dirty and it is flushed shortly after. This is
// what makes "whenever anything changes, update the saved game state" hold without writing on every
// 60 Hz tick.
let saveTimer = null;
function scheduleSave(){ if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; try { saveGame(); } catch (e) { console.error("autosave failed:", e.message); } }, 400); }

// Layout undo/redo history (edit commands only — operating switches/signals is not an "edit").
function pushUndo(){ if (!game) return; game.undo.push(game.engine.serialize()); if (game.undo.length > 100) game.undo.shift(); game.redo.length = 0; }
function applyCommand(cmd){
  if (!game) return { ok:false, error:"no active game" };
  if (game.engine.EDIT_COMMANDS && game.engine.EDIT_COMMANDS.has(cmd.type)) pushUndo();
  const result = game.engine.command(cmd);
  scheduleSave();
  broadcast();
  return result;
}
function undoRedo(which){
  if (!game) return { ok:false, error:"no active game" };
  const from = which === "redo" ? game.redo : game.undo;
  const to = which === "redo" ? game.undo : game.redo;
  if (!from.length) return { ok:false, error:"nothing to " + which };
  to.push(game.engine.serialize());
  game.engine.applyLayout(from.pop());
  scheduleSave();
  broadcast();
  return { ok:true };
}
// Fork the current state into a brand-new saved game and switch to working on it.
function saveAs(name){
  if (!game) return null;
  const snap = game.engine.snapshot();
  game.id = newId(); game.name = name || game.name; game.undo = []; game.redo = [];
  const rec = { id: game.id, name: game.name, savedAt: Date.now(), snapshot: snap };
  fs.writeFileSync(gamePath(game.id), JSON.stringify(rec));
  broadcast();
  return rec;
}

function listGames(){
  return fs.readdirSync(GAMES_DIR).filter(f => f.endsWith(".json")).map(f => {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, f), "utf8"));
      return { id: rec.id, name: rec.name, savedAt: rec.savedAt, simFrame: rec.snapshot ? rec.snapshot.simFrame : 0 };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

function gameMeta(){ return game ? { id: game.id, name: game.name, running: game.running } : null; }
function snapshotPayload(){ return game ? { game: gameMeta(), snapshot: game.engine.snapshot() } : { game: null, snapshot: null }; }

// ---- Tick loop (authoritative) -----------------------------------------------------------
let acc = 0, last = Date.now(), sinceBroadcast = 0;
setInterval(() => {
  const now = Date.now();
  let elapsed = now - last; last = now;
  if (elapsed > 250) elapsed = 250;                 // clamp long stalls
  if (game && game.running){
    acc += elapsed;
    let steps = 0;
    while (acc >= SIM_STEP_MS && steps < 8){ game.engine.simStep(); acc -= SIM_STEP_MS; steps++; sinceBroadcast++; }
    if (steps >= 8) acc = 0;
    if (sinceBroadcast >= BROADCAST_EVERY){ sinceBroadcast = 0; broadcast(); }
  } else {
    acc = 0;
  }
  if (game && now - lastAutosave > AUTOSAVE_MS){ lastAutosave = now; try { saveGame(); } catch (e) { console.error("autosave failed:", e.message); } }
}, SIM_STEP_MS);

// ---- SSE broadcast -----------------------------------------------------------------------
function broadcast(){
  if (!sseClients.size) return;
  const data = "data: " + JSON.stringify(snapshotPayload()) + "\n\n";
  for (const res of sseClients){ try { res.write(data); } catch { sseClients.delete(res); } }
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
function resolveTarget(stationId, body){
  if (Number.isFinite(body.x) && Number.isFinite(body.y)) return { x: body.x, y: body.y };
  if (body.name != null){
    const hit = game.engine.resolveElement(stationId, body.name);
    if (hit) return { x: hit.x, y: hit.y, tile: hit.tile };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  if (req.method === "OPTIONS") return sendJSON(res, 204, {});

  if (!url.startsWith("/api/")) return serveStatic(req, res);

  try {
    // ---- read-only ----
    if (url === "/api/health" && req.method === "GET")
      return sendJSON(res, 200, { ok: true, hasGame: !!game, name: game && game.name });

    if (url === "/api/state" && req.method === "GET")
      return sendJSON(res, 200, { ok: true, ...snapshotPayload() });

    if (url === "/api/games" && req.method === "GET")
      return sendJSON(res, 200, { ok: true, games: listGames() });

    if (url === "/api/stations" && req.method === "GET"){
      if (!game) return sendJSON(res, 409, { ok: false, error: "no active game" });
      return sendJSON(res, 200, { ok: true, stations: game.engine.stationsReport() });
    }

    let m;
    if ((m = url.match(/^\/api\/stations\/([^\/]+)$/)) && req.method === "GET"){
      if (!game) return sendJSON(res, 409, { ok: false, error: "no active game" });
      const st = game.engine.stationsReport().find(s => String(s.id) === decodeURIComponent(m[1]) ||
        s.name.toLowerCase() === decodeURIComponent(m[1]).toLowerCase());
      if (!st) return sendJSON(res, 404, { ok: false, error: "no such station" });
      return sendJSON(res, 200, { ok: true, station: st });
    }

    // ---- SSE state stream ----
    if (url === "/api/events" && req.method === "GET"){
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
      res.write("retry: 2000\n\n");
      res.write("data: " + JSON.stringify(snapshotPayload()) + "\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // ---- mutations ----
    if (url === "/api/game/new" && req.method === "POST"){
      const body = await readBody(req);
      if (!body.layout) return sendJSON(res, 400, { ok: false, error: "missing layout" });
      try { const g = startGame({ name: body.name, fromLayout: body.layout });
        return sendJSON(res, 200, { ok: true, id: g.id, name: g.name }); }
      catch (e) { return sendJSON(res, 400, { ok: false, error: "bad layout: " + e.message }); }
    }

    if (url === "/api/game/load" && req.method === "POST"){
      const body = await readBody(req);
      const p = gamePath(String(body.id || ""));
      if (!body.id || !fs.existsSync(p)) return sendJSON(res, 404, { ok: false, error: "no such saved game" });
      const rec = JSON.parse(fs.readFileSync(p, "utf8"));
      startGame({ id: rec.id, name: rec.name, fromSnapshot: rec.snapshot });
      return sendJSON(res, 200, { ok: true, id: rec.id, name: rec.name });
    }

    if (url === "/api/game/save" && req.method === "POST"){
      if (!game) return sendJSON(res, 409, { ok: false, error: "no active game" });
      const body = await readBody(req);
      const rec = saveGame(body.name);
      return sendJSON(res, 200, { ok: true, id: rec.id, name: rec.name, savedAt: rec.savedAt });
    }

    // Fork the current game into a new saved game and switch to it (the only explicit save in
    // server-only mode; ordinary changes autosave the current game).
    if (url === "/api/game/save-as" && req.method === "POST"){
      if (!game) return sendJSON(res, 409, { ok: false, error: "no active game" });
      const body = await readBody(req);
      const rec = saveAs(body.name);
      return sendJSON(res, 200, { ok: true, id: rec.id, name: rec.name });
    }

    if (url === "/api/game/rename" && req.method === "POST"){
      if (!game) return sendJSON(res, 409, { ok: false, error: "no active game" });
      const body = await readBody(req);
      game.name = (body.name || "").trim() || game.name;
      saveGame(); broadcast();
      return sendJSON(res, 200, { ok: true, name: game.name });
    }

    if ((url === "/api/game/undo" || url === "/api/game/redo") && req.method === "POST"){
      const result = undoRedo(url.endsWith("redo") ? "redo" : "undo");
      return sendJSON(res, result.ok ? 200 : 400, result);
    }

    if (url === "/api/game/pause" && req.method === "POST"){
      if (!game) return sendJSON(res, 409, { ok: false, error: "no active game" });
      const body = await readBody(req);
      game.running = !body.paused;
      game.engine.setPaused(!game.running);
      broadcast();
      return sendJSON(res, 200, { ok: true, running: game.running });
    }

    if (url === "/api/game/step" && req.method === "POST"){
      if (!game) return sendJSON(res, 409, { ok: false, error: "no active game" });
      game.engine.simStep();
      broadcast();
      return sendJSON(res, 200, { ok: true, simFrame: game.engine.state.simFrame });
    }

    if (url === "/api/command" && req.method === "POST"){
      if (!game) return sendJSON(res, 409, { ok: false, error: "no active game" });
      const cmd = await readBody(req);
      const result = applyCommand(cmd);
      return sendJSON(res, result.ok ? 200 : 400, { ...result });
    }

    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/switch$/)) && req.method === "POST"){
      if (!game) return sendJSON(res, 409, { ok: false, error: "no active game" });
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const t = resolveTarget(id, body);
      if (!t) return sendJSON(res, 404, { ok: false, error: "element not found in station (give name or x,y)" });
      const result = applyCommand({ type: "setSwitch", x: t.x, y: t.y, to: body.to });
      return sendJSON(res, result.ok ? 200 : 400, { ...result, x: t.x, y: t.y });
    }

    if ((m = url.match(/^\/api\/stations\/([^\/]+)\/signal$/)) && req.method === "POST"){
      if (!game) return sendJSON(res, 409, { ok: false, error: "no active game" });
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const t = resolveTarget(id, body);
      if (!t) return sendJSON(res, 404, { ok: false, error: "element not found in station (give name or x,y)" });
      const type = (body.action === "red") ? "redSignal" : "clearSignal";
      const result = applyCommand({ type, x: t.x, y: t.y, dir: body.dir });
      return sendJSON(res, result.ok ? 200 : 400, { ...result, x: t.x, y: t.y });
    }

    return sendJSON(res, 404, { ok: false, error: "unknown endpoint " + req.method + " " + url });
  } catch (e) {
    console.error("request error:", e);
    return sendJSON(res, 500, { ok: false, error: e.message });
  }
});

// Server-only mode: there is ALWAYS a current game. On boot, resume the most recently saved game;
// if there are none, create an empty one to build on.
const EMPTY_LAYOUT = { version: 3, tiles: [], stations: [], trainTypes: [], view: { x: 0, y: 0, zoom: 1 } };
function bootGame(){
  const saved = listGames();
  if (saved.length){
    try {
      const rec = JSON.parse(fs.readFileSync(gamePath(saved[0].id), "utf8"));
      startGame({ id: rec.id, name: rec.name, fromSnapshot: rec.snapshot });
      console.log(`Resumed "${rec.name}" (${rec.id})`);
      return;
    } catch (e) { console.error("could not resume latest save:", e.message); }
  }
  startGame({ name: "Untitled", fromLayout: EMPTY_LAYOUT });
  console.log(`Started a new empty game (${game.id})`);
}

server.listen(PORT, () => {
  bootGame();
  console.log(`Tiny Trains server on http://localhost:${PORT}  (open /manual.html)`);
  console.log(`Games persisted in ${GAMES_DIR}`);
});
