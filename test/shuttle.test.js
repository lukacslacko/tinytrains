// Tiny Trains — end-to-end shunting test over HTTP: boots a REAL server (isolated port +
// games dir, never the live :8765/./games), loads the shuttle layout, places the
// engine+car train, then plays BOTH station masters through the Station-Master API
// (switch / signal / engine endpoints) for a full round trip with a run-around at each
// end — exactly what an AI master does over MCP.
//
//   node test/shuttle.test.js
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { buildLayout, SHUTTLE_UNITS } = require("./shuttle-layout.js");

const PORT = 8931;
const BASE = `http://localhost:${PORT}`;
const GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tinytrains-shuttle-"));

let failures = 0, checks = 0;
function assert(cond, msg){ checks++; if (!cond){ failures++; console.error("  ✗ " + msg); } }

let GAME = null;   // the server also boots a default empty game, so every request names ours
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
async function trains(){ return (await api("GET", "/api/trains")).trains || []; }
async function waitFor(pred, timeoutMs, what){
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline){
    const ts = await trains();
    const hit = pred(ts);
    if (hit) return hit;
    await sleep(150);
  }
  assert(false, `timed out waiting for: ${what} — trains: ${JSON.stringify(await trains())}`);
  throw new Error("timeout: " + what);
}
const stoppedAt = (id, x, y) => ts => { const t = ts.find(t => t.id === id); return (t && t.x === x && t.y === y && !t.moving) ? t : null; };

async function main(){
  // speed the sim up so the round trip stays quick in wall-clock time
  await ok("POST", "/api/command", { type: "setSpeed", scale: 3 }, "speed up");
  await ok("POST", "/api/command", { type: "placeTrain", x: 6, y: 0, heading: "E", units: SHUTTLE_UNITS }, "place the shuttle");
  let trainId = (await trains())[0].id;

  const st = name => `/api/stations/${name}`;
  const sw = (station, el, to, what) => ok("POST", st(station) + "/switch", { name: el, to }, what);
  const clear = (station, el, dir, shunt, what) => ok("POST", st(station) + "/signal", { name: el, action: "clear", dir, shunt: !!shunt }, what);
  const eng = (station, action, body, what) => ok("POST", st(station) + "/engine", { action, train: trainId, ...body }, what);

  await waitFor(stoppedAt(trainId, 8, 0), 30000, "shuttle waits at West A");

  // guide mentions shunting so AI masters learn the tools
  const guide = await api("GET", "/api/guide");
  assert(/Shunting/.test(guide.guide || ""), "the operating guide documents shunting");
  assert(/shunting disc/i.test(guide.guide || ""), "the operating guide documents shunting discs");

  // shunting discs over the station API: place one on West track 1, set stop, read it back, clear
  await ok("POST", "/api/command", { type: "setTile", x: 5, y: 0, tile: { kind: "track", route: [6,2], shuntSignal: true, name: "D" } }, "place a disc");
  const stopped1 = await ok("POST", st("West") + "/shunt-signal", { name: "D", action: "stop" }, "set the disc to stop");
  assert(stopped1.stop === true, "disc reports stop");
  const westReport = (await api("GET", st("West"))).station;
  assert(westReport.shuntSignals && westReport.shuntSignals.some(d => d.name === "D" && d.stop), "station report lists the disc at stop");
  const cleared1 = await ok("POST", st("West") + "/shunt-signal", { name: "D", action: "clear" }, "clear the disc");
  assert(cleared1.stop === false, "disc reports clear");
  // it stays clear through the choreography below — the shunting engine passes right over it

  // shunting orders are refused outside the commanding station's limits
  const wrong = await api("POST", st("East") + "/engine", { action: "reverse", train: trainId });
  assert(wrong && wrong.ok === false && /West/.test(wrong.error || ""), "East may not order an engine standing in West");

  async function runAround(side){
    const P = side === "east"
      ? {name:"East", A:"A", B:"B", sw1:"1", sw2:"2", ax:16, bx:21, bufx:24,
         inDir:"E", outDir:"W", t1b1:"E", loop1:"SE", t1b2:"W", loop2:"SW"}
      : {name:"West", A:"A", B:"B", sw1:"1", sw2:"2", ax:8, bx:3, bufx:0,
         inDir:"W", outDir:"E", t1b1:"W", loop1:"SW", t1b2:"E", loop2:"SE"};
    const S = P.name;
    // ARRIVAL onto track 1
    await sw(S, P.sw1, P.t1b1, `${S}: switch 1 to track 1`);
    await clear(S, P.A, P.inDir, false, `${S}: clear A for the arrival`);
    await waitFor(stoppedAt(trainId, P.bx, 0), 60000, `${S}: train stops at B`);
    // RUN-AROUND
    const d = await eng(S, "uncouple", { keep: 0 }, `${S}: uncouple the engine`);
    assert(d.front.units.length === 1 && d.detached.units.length === 1, `${S}: engine alone + one car standing`);
    const carId = d.detached.id;
    await eng(S, "mode", { mode: "shunt" }, `${S}: engine to shunting mode`);
    await sw(S, P.sw2, P.t1b2, `${S}: switch 2 to track 1`);
    await clear(S, P.B, P.outDir === "E" ? "W" : "E", true, `${S}: clear B to the stub (shunt)`);
    await waitFor(stoppedAt(trainId, P.bufx, 0), 60000, `${S}: engine parks at the buffer`);
    await sw(S, P.sw2, P.loop2, `${S}: switch 2 to the loop`);
    await sw(S, P.sw1, P.loop1, `${S}: switch 1 to the loop`);
    await eng(S, "reverse", {}, `${S}: reverse at the buffer`);
    await waitFor(stoppedAt(trainId, P.ax, 0), 60000, `${S}: engine runs around the loop to A`);
    await sw(S, P.sw1, P.t1b1, `${S}: switch 1 back to track 1`);
    await clear(S, P.A, P.inDir, true, `${S}: shunt-clear A into the occupied track 1`);
    await eng(S, "reverse", {}, `${S}: reverse toward the car`);
    await waitFor(ts => { const t = ts.find(t => t.id === trainId); return (t && t.touching) ? t : null; }, 60000, `${S}: buffers touch the car`);
    const c = await eng(S, "couple", {}, `${S}: couple`);
    assert(c.id === trainId, `${S}: the train keeps its engine's id through coupling`);
    trainId = c.id;
    assert(c.units.length === 2, `${S}: coupled consist has engine + car`);
    assert(c.mode === "stop", `${S}: coupled consist holds in stop mode (no creep)`);
    assert(!(await trains()).some(t => t.id === carId), `${S}: the standing car merged in`);
    // couple → reverse → drive: the auto stop mode means nothing moves until ordered
    await eng(S, "reverse", {}, `${S}: reverse the whole train`);
    await eng(S, "mode", { mode: "drive" }, `${S}: back to driving mode`);
    await waitFor(stoppedAt(trainId, P.ax, 0), 60000, `${S}: train ready at A`);
    const t = (await trains()).find(t => t.id === trainId);
    assert(t.units[0].kind === "engine", `${S}: engine leads the departing train`);
    await clear(S, P.A, P.outDir, false, `${S}: clear A for the departure`);
  }

  await clear("West", "A", "E", false, "West: first departure");
  await waitFor(stoppedAt(trainId, 16, 0), 60000, "shuttle reaches East A");
  await runAround("east");
  await waitFor(stoppedAt(trainId, 8, 0), 60000, "shuttle returns to West A");
  await runAround("west");
  await waitFor(stoppedAt(trainId, 16, 0), 60000, "shuttle reaches East A again — full round trip done");
}

// ---- boot an isolated server, run, clean up -------------------------------------------
const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT), TINYTRAINS_GAMES_DIR: GAMES_DIR, TINYTRAINS_QUIET: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stderr.on("data", d => process.stderr.write("[server] " + d));

(async () => {
  try {
    // wait for the server, then start a game from the shuttle layout
    for (let i = 0; i < 50; i++){ try { if ((await api("GET", "/api/health")).ok) break; } catch {} await sleep(200); }
    const g = await ok("POST", "/api/game/new", { name: "Shuttle", layout: buildLayout() }, "new game");
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
