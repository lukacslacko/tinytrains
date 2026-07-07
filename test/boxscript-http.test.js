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

  // ---- draft autosave: stored beside the running script, compile-checked, cleared by deploy ----
  const running = (await api("GET", st + "/script")).script;
  const draftText = running + "\n# tweaked in the editor";
  await ok("POST", st + "/script", { draft: draftText }, "save a draft");
  const g1 = await ok("GET", st + "/script", null, "read back with draft");
  assert(g1.draft === draftText, "the draft is stored");
  assert(g1.script === running, "the RUNNING script is unchanged by the draft");
  const badDraft = await ok("POST", st + "/script", { draft: "on (any at A) { claer A }" }, "save a broken draft");
  assert(/expected a statement/.test(badDraft.error || ""), "a draft gets a live compile check");
  await ok("POST", st + "/script", { script: running }, "re-deploy");
  assert((await api("GET", st + "/script")).draft === null, "deploying brings the draft in sync (null)");

  // ---- pause/run: a paused station's script routes nothing; resume picks the train up ----
  await ok("POST", "/api/command", { type: "removeTrain", x: 10, y: 0 }, "clear the buffer (free route for the next train)");
  await ok("POST", st + "/script", { paused: true }, "pause the script");
  assert((await api("GET", st + "/script")).paused === true, "reports paused");
  await ok("POST", "/api/command", { type: "placeTrain", x: 1, y: 0, heading: "E", units: [{ kind: "engine", len: 0.5, type: 1 }] }, "place a second train");
  let deadline2 = Date.now() + 20000, second = null;
  while (Date.now() < deadline2){   // it drives up to A and stops there
    const ts = (await api("GET", "/api/trains")).trains || [];
    second = ts.find(t => t.x === 5 && !t.moving);
    if (second) break;
    await sleep(150);
  }
  assert(second, "the second train reaches A and waits");
  await sleep(2000);
  const still = ((await api("GET", "/api/trains")).trains || []).find(t => t.x === 5 && !t.moving);
  assert(still, "paused: the script does not clear it (the route ahead is free — only the pause holds it)");
  const pauseLog = await ok("GET", st + "/script-log", null, "log while paused");
  assert(pauseLog.entries.some(e => /script paused/.test(e.text)), "the pause is noted in the execution log");
  await ok("POST", st + "/script", { paused: false }, "resume the script");
  deadline2 = Date.now() + 20000;
  let released = false;
  while (Date.now() < deadline2 && !released){
    const ts = (await api("GET", "/api/trains")).trains || [];
    released = ts.some(t => t.x > 5);   // cleared through A on resume
    await sleep(150);
  }
  assert(released, "resumed: the waiting train is routed");

  // ---- the variable editor: station-state variables that guard, persist, and protect ----
  // settle: everything stopped, then clear the line east of the signal
  let dl3 = Date.now() + 20000;
  while (Date.now() < dl3 && ((await api("GET", "/api/trains")).trains || []).some(t => t.moving)) await sleep(150);
  for (const t of (await api("GET", "/api/trains")).trains || [])
    if (t.x > 5) await ok("POST", "/api/command", { type: "removeTrain", x: t.x, y: t.y }, `clear the line (train at ${t.x},${t.y})`);
  // a script referencing a variable that exists only in the editor: rejected until it is added
  const guarded = `on (red at A) { if (go) { clear A } }`;
  const rej = await ok("POST", st + "/script", { script: guarded }, "deploy a script with a missing variable");
  assert(/unknown variable "go"/.test(rej.error || ""), "compile rejects the unknown variable");
  await ok("POST", st + "/script-var", { name: "go", value: false }, "add go = false in the editor");
  const dep2 = await ok("POST", st + "/script", { script: guarded }, "re-deploy after adding the variable");
  assert(!dep2.error, `the editor-defined variable satisfies the compiler (${dep2.error})`);
  // a train waits at A while go is false…
  await ok("POST", "/api/command", { type: "placeTrain", x: 1, y: 0, heading: "E", units: [{ kind: "engine", len: 0.5, type: 1 }] }, "place a train");
  dl3 = Date.now() + 20000; let waiting3 = null;
  while (Date.now() < dl3 && !waiting3){
    waiting3 = ((await api("GET", "/api/trains")).trains || []).find(t => t.x === 5 && !t.moving);
    if (!waiting3) await sleep(150);
  }
  assert(waiting3, "the train reaches A");
  await sleep(1500);
  assert(((await api("GET", "/api/trains")).trains || []).some(t => t.x === 5 && !t.moving), "go=false: the guard holds the train");
  // …flipping the variable routes it (level-triggered event picked up on the next pass)
  await ok("POST", st + "/script-var", { name: "go", value: true }, "set go = true");
  dl3 = Date.now() + 20000; let routed3 = false;
  while (Date.now() < dl3 && !routed3){
    routed3 = ((await api("GET", "/api/trains")).trains || []).some(t => t.x > 5);
    if (!routed3) await sleep(150);
  }
  assert(routed3, "go=true: the waiting train is routed");
  // remove-protection + lifecycle
  const rm = await api("POST", st + "/script-var", { name: "go", remove: true });
  assert(rm && rm.ok === false && /uses "go"/.test(rm.error || ""), "a variable the script uses cannot be removed");
  await ok("POST", st + "/script-var", { name: "scratch", value: true }, "add an unused variable");
  const gv = await ok("GET", st + "/script", null, "GET script returns the live variables");
  assert(gv.vars && gv.vars.go === true && gv.vars.scratch === true, "live variable values come back with the script");
  const gl = await ok("GET", st + "/script-log", null, "log carries the variables too");
  assert(gl.vars && gl.vars.go === true, "script-log responses include the live variables (for the panel)");
  // variables OUTLIVE a deploy — a declaration is only a default for a missing variable
  await ok("POST", st + "/script", { script: "go := false\n" + guarded }, "deploy WITH a go := false declaration");
  const gv2 = await ok("GET", st + "/script", null, "read vars after the deploy");
  assert(gv2.vars.go === true, "deploying kept go = true (the declaration did not overwrite it)");
  assert(gv2.vars.scratch === true, "unrelated variables survive the deploy");
  await ok("POST", st + "/script-var", { name: "scratch", remove: true }, "remove the unused variable");
  assert(((await api("GET", st + "/script")).vars || {}).scratch === undefined, "removed variable is gone");

  // ---- draft + paused flag persist into the save file ----
  await ok("POST", st + "/script", { draft: "x := 1" }, "leave a draft for the save");

  // the script persists into the save file
  const saved = await ok("POST", "/api/game/save", {}, "save the game");
  const rec = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, saved.id + ".json"), "utf8"));
  const stRec = rec.snapshot.stations.find(s => s.name === "Yard");
  assert(stRec && stRec.script.includes("clear A"), "the script is in the saved snapshot");
  assert(stRec.scriptDraft === "x := 1", "the editor draft is in the saved snapshot");
  assert(stRec.scriptPaused === false, "the paused flag is in the saved snapshot");
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
