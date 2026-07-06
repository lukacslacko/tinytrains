// Tiny Trains — boxscript over HTTP: the script endpoints (get/set/execution log) on a
// REAL server (isolated port + games dir, never the live :8765/./games), including the
// scripted routing actually driving a train and the script persisting into the save file.
//
//   node test/boxscript-http.test.js
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = 8933;
const BASE = `http://localhost:${PORT}`;
const GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tinytrains-boxscript-"));

let failures = 0, checks = 0;
function assert(cond, msg){ checks++; if (!cond){ failures++; console.error("  ✗ " + msg); } }

let GAME = null;
async function api(method, p, body){
  const url = BASE + p + (method === "GET" && GAME ? (p.includes("?") ? "&" : "?") + "game=" + encodeURIComponent(GAME) : "");
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" },
    body: method !== "GET" ? JSON.stringify({ game: GAME, ...(body || {}) }) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return json;
}
async function ok(method, p, body, what){
  const r = await api(method, p, body);
  assert(r && r.ok, `${what}: ${r && r.error ? r.error : JSON.stringify(r)}`);
  return r;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the same simple yard as the in-process tests: signal A (x5, facing E), named buffer X (x10)
function yardLayout(){
  const tiles = [];
  for (let x = 0; x <= 10; x++) tiles.push({ x, y: 0, tile: { kind: "track", route: [6, 2] } });
  tiles[5] = { x: 5, y: 0, tile: { kind: "signal", route: [6, 2], dirs: [2], manualDirs: [2], name: "A" } };
  tiles[10] = { x: 10, y: 0, tile: { kind: "track", route: [6], name: "X" } };
  return { version: 3, tiles, trainTypes: [{ id: 1, color: "#f05264", name: "red" }],
    stations: [{ id: 1, name: "Yard", instructions: "", overrides: [], rect: { x0: 0, y0: 0, x1: 10, y1: 0 } }] };
}

async function main(){
  const st = "/api/stations/Yard";

  // a broken script is stored, and the compile error is reported
  const bad = await ok("POST", st + "/script", { script: "on (any at A) { claer A }" }, "set a broken script");
  assert(bad.error && /expected a statement/.test(bad.error), `compile error reported (got: ${bad.error})`);
  const back1 = await ok("GET", st + "/script", null, "read the script back");
  assert(back1.script.includes("claer") && back1.error, "broken text stored, error still flagged");

  // a good script replaces it and routes the train
  await ok("POST", st + "/script", { script: `on (red at A) { clear A }\non (any at X) { say "arrived" }` }, "set a working script");
  const back2 = await ok("GET", st + "/script", null, "read it back");
  assert(!back2.error, "no compile error on the working script");
  await ok("POST", "/api/command", { type: "setSpeed", scale: 3 }, "speed up");
  await ok("POST", "/api/command", { type: "placeTrain", x: 2, y: 0, heading: "E", units: [{ kind: "engine", len: 0.5, type: 1 }] }, "place a train");
  const deadline = Date.now() + 30000;
  let parked = false;
  while (Date.now() < deadline && !parked){
    const ts = (await api("GET", "/api/trains")).trains || [];
    parked = ts.some(t => t.x === 10 && !t.moving);
    await sleep(150);
  }
  assert(parked, "the script cleared A and the train parked at the stub");

  // the execution log shows the event + actions; the cursor filters what's new
  const log1 = await ok("GET", st + "/script-log", null, "read the execution log");
  assert(log1.entries.some(e => e.kind === "event" && /red at A/.test(e.text)), "log has the event");
  assert(log1.entries.some(e => e.kind === "action" && /clear A/.test(e.text)), "log has the action");
  assert(log1.entries.some(e => /arrived/.test(e.text)), "log has the stub say");
  const log2 = await ok("GET", st + `/script-log?after=${log1.cursor}`, null, "read after the cursor");
  assert(log2.entries.length === 0, "nothing new after the cursor");

  // the path endpoint speaks permit too (validation-level check)
  const noSuch = await api("POST", st + "/path", { path: ["A", "nowhere"], shunt: true });
  assert(noSuch && noSuch.ok === false && /not an element/.test(noSuch.error || ""), "permit path validates element names");

  // the script persists into the save file
  const saved = await ok("POST", "/api/game/save", {}, "save the game");
  const rec = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, saved.id + ".json"), "utf8"));
  const stRec = rec.snapshot.stations.find(s => s.name === "Yard");
  assert(stRec && stRec.script.includes("clear A"), "the script is in the saved snapshot");
  assert(rec.snapshot.boxscript && rec.snapshot.boxscript["1"], "the runtime state (log, vars) is in the saved snapshot");
}

// ---- boot an isolated server, run, clean up -------------------------------------------
const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT), TINYTRAINS_GAMES_DIR: GAMES_DIR, TINYTRAINS_QUIET: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stderr.on("data", d => process.stderr.write("[server] " + d));

(async () => {
  try {
    for (let i = 0; i < 50; i++){ try { if ((await api("GET", "/api/health")).ok) break; } catch {} await sleep(200); }
    const g = await ok("POST", "/api/game/new", { name: "BoxscriptYard", layout: yardLayout() }, "new game");
    GAME = g.id;
    await main();
  } catch (e) {
    failures++;
    console.error("  ✗ aborted: " + e.message);
  } finally {
    server.kill();
    try { fs.rmSync(GAMES_DIR, { recursive: true, force: true }); } catch {}
  }
  console.log(failures ? `\n${failures} FAILURES (${checks} checks)` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})();
