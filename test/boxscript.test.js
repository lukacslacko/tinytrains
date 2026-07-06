// Tiny Trains — boxscript RUNTIME tests, in-process: the scheduler's level-triggered
// events, variable guards, time triggers, wait until, when-chains — capped by the full
// shuttle run-around driven entirely by a script macro (the same choreography
// engine-shunt.test.js performs by hand, here performed by the station's script).
//
//   node test/boxscript.test.js
"use strict";
const { createEngine } = require("../engine.js");
const { buildLayout, SHUTTLE_UNITS } = require("./shuttle-layout.js");

let failures = 0, checks = 0;
function assert(cond, msg){
  checks++;
  if (!cond){ failures++; console.error("  ✗ " + msg); }
}
function assertOk(r, msg){ assert(r && r.ok, `${msg}: ${r && r.error ? r.error : JSON.stringify(r)}`); return r; }
function waitFor(E, pred, maxFrames, what){
  for (let i = 0; i < (maxFrames || 6000); i++){
    if (pred()) return true;
    E.simStep();
  }
  assert(false, `timed out waiting for: ${what}`);
  return false;
}
function trainById(E, id){ return E.state.trains.find(t => E.publicTrainId(t) === id); }
function stoppedAt(E, id, x, y){ return () => { const t = trainById(E, id); return !!t && t.x === x && t.y === y && (t.speed || 0) === 0 && !E.trainMoving(t); }; }
function logText(E, stId){ return E.scriptLog(stId, 0).entries.map(e => e.kind + ": " + e.text).join("\n"); }

// A simple test yard: track x0..x10, manual signal A (x5, facing E), named buffer X (x10).
function yard(script){
  const tiles = [];
  for (let x = 0; x <= 10; x++) tiles.push({ x, y: 0, tile: { kind: "track", route: [6, 2] } });
  tiles[5] = { x: 5, y: 0, tile: { kind: "signal", route: [6, 2], dirs: [2], manualDirs: [2], name: "A" } };
  tiles[10] = { x: 10, y: 0, tile: { kind: "track", route: [6], name: "X" } };
  const E = createEngine();
  E.deserialize(JSON.stringify({ version: 3, tiles, trainTypes: [{ id: 1, color: "#f05264", name: "red" }],
    stations: [{ id: 1, name: "Yard", instructions: "", overrides: [], script: script || "", rect: { x0: 0, y0: 0, x1: 10, y1: 0 } }] }));
  return E;
}
function placeEngineAt2(E){ return assertOk(E.command({ type: "placeTrain", x: 2, y: 0, heading: "E", units: [{ kind: "engine", len: 0.5, type: 1 }] }), "place engine"); }

// ---------------------------------------------------------------------------
console.log("level-triggered event: a waiting train is routed, exactly once");
{
  const E = yard(`on (red at A) { clear A }`);
  const r = placeEngineAt2(E);
  waitFor(E, stoppedAt(E, r.id, 10, 0), 8000, "train cleared through A and parked at X");
  const events = E.scriptLog(1, 0).entries.filter(e => e.kind === "event");
  assert(events.length === 1, `the event fired exactly once (got ${events.length}: ${logText(E, 1)})`);
}

// ---------------------------------------------------------------------------
console.log("variable guard: the train waits until a time handler flips the variable");
{
  const E = yard(`
    daytime := false
    on (any at A) { if (daytime) { clear A } }
    on (0:01) { daytime := true }
  `);
  E.command({ type: "setDayLength", seconds: 86400 });   // 0:01 = 60 sim-seconds into the day
  const r = placeEngineAt2(E);
  waitFor(E, stoppedAt(E, r.id, 5, 0), 4000, "train stops at A");
  for (let i = 0; i < 30 * 60; i++) E.simStep();          // 30 sim-seconds: still night
  assert(trainById(E, r.id).x === 5, "train still held at A before 0:01 (guard false, event stays pending)");
  waitFor(E, stoppedAt(E, r.id, 10, 0), 60 * 60, "at 0:01 the pending event is re-tried and the train is released");
  assert(/on \(0:01\)/.test(logText(E, 1)), "log shows the time handler firing");
}

// ---------------------------------------------------------------------------
console.log("wait until: claims the train, releases it at the hour");
{
  const E = yard(`on (any at A) { wait until (0:01); clear A }`);
  E.command({ type: "setDayLength", seconds: 86400 });
  const r = placeEngineAt2(E);
  waitFor(E, stoppedAt(E, r.id, 5, 0), 4000, "train stops at A");
  for (let i = 0; i < 30 * 60; i++) E.simStep();
  assert(trainById(E, r.id).x === 5, "train held during the wait");
  assert(/claimed/.test(logText(E, 1)), "log shows the train claimed by the handler");
  waitFor(E, stoppedAt(E, r.id, 10, 0), 60 * 60, "released at 0:01");
  assert(/sequence complete/.test(logText(E, 1)), "chain completes after the timed clear");
}

// ---------------------------------------------------------------------------
console.log("priorities: a higher tier is served before a longer-waiting lower tier");
{
  // two signals, two trains: the train at B stops FIRST (waited longest), but the handler
  // for A carries priority 1 — so A must be served before B.
  const tiles = [];
  for (let x = 0; x <= 12; x++) tiles.push({ x, y: 0, tile: { kind: "track", route: [6, 2] } });
  tiles[3] = { x: 3, y: 0, tile: { kind: "signal", route: [6, 2], dirs: [2], manualDirs: [2], name: "A" } };
  tiles[7] = { x: 7, y: 0, tile: { kind: "signal", route: [6, 2], dirs: [2], manualDirs: [2], name: "B" } };
  const E = createEngine();
  // both events pend behind `go` (bodies do nothing → stay pending); the 0:01 time handler
  // flips it, and THAT pass must serve prio-1 A before prio-0 B despite B's longer wait.
  E.deserialize(JSON.stringify({ version: 3, tiles, trainTypes: [{ id: 1, color: "#f05264", name: "red" }],
    stations: [{ id: 1, name: "Yard", instructions: "", overrides: [], script: `
      go := false
      on (any at B) { if (go) { say "served B" } }
      on 1 (any at A) { if (go) { say "served A" } }
      on (0:01) { go := true }
    `, rect: { x0: 0, y0: 0, x1: 12, y1: 0 } }] }));
  E.command({ type: "setDayLength", seconds: 86400 });
  const r1 = assertOk(E.command({ type: "placeTrain", x: 5, y: 0, heading: "E", units: [{ kind: "engine", len: 0.5, type: 1 }] }), "place train toward B");
  waitFor(E, stoppedAt(E, r1.id, 7, 0), 4000, "first train stops at B");
  for (let i = 0; i < 300; i++) E.simStep();   // give B a clear head start on waiting
  const r2 = assertOk(E.command({ type: "placeTrain", x: 1, y: 0, heading: "E", units: [{ kind: "engine", len: 0.5, type: 1 }] }), "place train toward A");
  waitFor(E, stoppedAt(E, r2.id, 3, 0), 4000, "second train stops at A");
  waitFor(E, () => E.scriptLog(1, 0).entries.some(e => /served B/.test(e.text)) && E.scriptLog(1, 0).entries.some(e => /served A/.test(e.text)),
    90 * 60, "at 0:01 both pending events are served");
  const lines = E.scriptLog(1, 0).entries.map(e => e.text);
  const aIdx = lines.findIndex(t => /served A/.test(t)), bIdx = lines.findIndex(t => /served B/.test(t));
  assert(aIdx >= 0 && bIdx > aIdx, `priority 1 (A) served before the longer-waiting priority 0 (B) — log order ${aIdx} vs ${bIdx}`);
}

// ---------------------------------------------------------------------------
console.log("snapshot round trip: script + runtime state survive (mid-wait chain)");
{
  const E = yard(`on (any at A) { wait until (0:01); clear A }`);
  E.command({ type: "setDayLength", seconds: 86400 });
  const r = placeEngineAt2(E);
  waitFor(E, stoppedAt(E, r.id, 5, 0), 4000, "train stops at A");
  for (let i = 0; i < 20 * 60; i++) E.simStep();          // mid-wait
  const snap = JSON.parse(JSON.stringify(E.snapshot()));
  const E2 = createEngine();
  E2.applySnapshot(snap);
  assert(E2.state.stations[0].script.includes("wait until"), "script text survives the snapshot");
  assert((E2.state.boxscript["1"] || E2.state.boxscript[1]).chains.length === 1, "the armed chain survives the snapshot");
  waitFor(E2, stoppedAt(E2, r.id, 10, 0), 90 * 60, "the restored engine releases the train at 0:01");
}

// ---------------------------------------------------------------------------
console.log("script errors: reported, logged, nothing runs");
{
  const E = yard("");
  const res = E.command({ type: "setScript", station: "Yard", script: "on (any at A) { claer A }" });
  assert(res.ok && /expected a statement|unknown/.test(res.error || ""), `setScript stores but reports the compile error (got ${res.error})`);
  assert(E.getScript("Yard").script.includes("claer"), "broken text is stored for fixing");
  const r = placeEngineAt2(E);
  for (let i = 0; i < 600; i++) E.simStep();
  assert(trainById(E, r.id).x === 5, "a broken script routes nothing");
  assert(/script error/.test(logText(E, 1)), "the compile error is in the execution log");
}

// ---------------------------------------------------------------------------
// The showpiece: the WEST shuttle run-around driven entirely by the station script —
// uncouple, park at the buffer, loop around the car, shunt onto it, couple, depart.
// (engine-shunt.test.js does this same choreography by hand over the API.)
console.log("shuttle run-around, fully scripted (when-chain macro + permit)");
{
  const E = createEngine();
  E.deserialize(JSON.stringify(buildLayout()));
  // the script refers to the stub and a loop tile by name — name them (nameable stubs!)
  assertOk(E.command({ type: "setTile", x: 0, y: 0, tile: { kind: "track", route: [2], name: "X" } }), "name the west buffer X");
  assertOk(E.command({ type: "setTile", x: 4, y: 1, tile: { kind: "track", route: [6, 2], name: "L" } }), "name a west loop tile L");
  const SCRIPT = `
    # West terminus, automated: route arrivals onto track 1, run the engine around, depart.
    on (any at A) {
      if (train.heading == "W") { clear 1,B }     # arrival: onto track 1
      else { clear A,E }                          # departure: out east
    }
    on (any at B) { runaround(train) }
    macro runaround(t) {
      require (t at B)
      uncouple after 0
      shunt
      permit B,2 to X                             # pull clear onto the stub
      when (at X)     { permit 2,L,1 to A; reverse }   # around the loop, up to A
      when (at A)     { permit A,1,W; reverse }        # back onto occupied track 1
      when (touching) { couple; reverse; drive }
    }
  `;
  const res = assertOk(E.command({ type: "setScript", station: "West", script: SCRIPT }), "install the West script");
  assert(!res.error, `script compiles (${res.error})`);
  const r = assertOk(E.command({ type: "placeTrain", x: 12, y: 0, heading: "W", units: SHUTTLE_UNITS }), "place the shuttle on the single line heading west");
  const id = r.id;
  waitFor(E, stoppedAt(E, id, 3, 0), 20000, "script routes the arrival onto track 1 (stops at B)");
  waitFor(E, stoppedAt(E, id, 0, 0), 20000, "engine uncouples and parks at the stub X");
  waitFor(E, stoppedAt(E, id, 8, 0), 30000, "engine loops around to A");
  waitFor(E, () => { const t = trainById(E, id); return !!t && t._touch; }, 20000, "engine shunts onto the car and touches");
  waitFor(E, () => { const t = trainById(E, id); return !!t && t.units.length === 2 && t.units[0].kind === "engine" && t.mode === "drive"; },
    20000, "couple + reverse + drive: engine leads the reassembled train");
  waitFor(E, () => { const t = trainById(E, id); return !!t && t.x >= 12; }, 30000, "the script departs the train east onto the single line");
  const log = logText(E, 1);
  assert(/claimed/.test(log) && /sequence complete/.test(log), "the chain claimed the train and completed");
  const t = trainById(E, id);
  assert(t.units.length === 2 && t.units[0].kind === "engine", "shuttle intact, engine leading");
}

console.log(failures ? `\n${failures}/${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
