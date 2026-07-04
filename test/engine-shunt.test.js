// Tiny Trains — in-process shunting tests: unit/consist geometry (reverse, uncouple,
// couple), shunt-mode driving (touch instead of tile standoff, slower, signals still
// obeyed, buffer terminus, shunt clears into occupied track) and one full run-around
// round trip on the shuttle layout — the same choreography test/shuttle.test.js runs
// over HTTP.
//
//   node test/engine-shunt.test.js
"use strict";
const { createEngine } = require("../engine.js");
const { buildLayout, SHUTTLE_UNITS } = require("./shuttle-layout.js");

let failures = 0, checks = 0;
function assert(cond, msg){
  checks++;
  if (!cond){ failures++; console.error("  ✗ " + msg); }
}
function assertOk(r, msg){ assert(r && r.ok, `${msg}: ${r && r.error ? r.error : JSON.stringify(r)}`); return r; }
function near(a, b, eps){ return Math.abs(a - b) <= (eps || 0.03); }

function straightLine(n){
  const tiles = [];
  for (let x = 0; x <= n; x++) tiles.push({x, y:0, tile:{kind:"track", route:[6,2]}});
  return { version:3, tiles, trainTypes: [],
    stations: [{id:1, name:"Yard", instructions:"", overrides:[], rect:{x0:0, y0:0, x1:n, y1:0}}] };
}
function engineWith(layout){
  const E = createEngine();
  E.deserialize(JSON.stringify(layout));
  return E;
}
function stopped(E, t){ return (t.speed || 0) === 0 && (!E.trainMoving(t) || t._touch); }
// Step the sim until pred() holds (or fail after maxFrames).
function waitFor(E, pred, maxFrames, what){
  for (let i = 0; i < (maxFrames || 6000); i++){
    if (pred()) return true;
    E.simStep();
  }
  assert(false, `timed out waiting for: ${what}`);
  return false;
}
function trainById(E, id){ return E.state.trains.find(t => t.id === id); }

// ---------------------------------------------------------------------------
console.log("reverse: round trip returns the exact geometry");
{
  const E = engineWith(straightLine(12));
  const r = assertOk(E.command({type:"placeTrain", x:6, y:0, heading:"E", units:SHUTTLE_UNITS}), "place");
  const t = trainById(E, r.id);
  const before = {x: t.x, y: t.y, from: t.from, head: E.headWorld(t), units: t.units.map(u => u.id)};
  assertOk(E.command({type:"reverse", train: t.id}), "first reverse");
  assert(t.x === 5 && t.y === 0 && t.from === 2, `reversed head at (5,0) from E — got (${t.x},${t.y}) from ${t.from}`);
  assert(near(E.headWorld(t).x, 5.5) && near(E.headWorld(t).y, 0.5), "reversed head world at centre of (5,0)");
  assert(t.units[0].kind === "car" && t.units[1].kind === "engine", "units flipped: car leads");
  assertOk(E.command({type:"reverse", train: t.id}), "second reverse");
  assert(t.x === before.x && t.y === before.y && t.from === before.from, "double reverse restores head tile");
  assert(near(E.headWorld(t).x, before.head.x) && near(E.headWorld(t).y, before.head.y), "double reverse restores head point");
  assert(t.units.map(u => u.id).join() === before.units.join(), "double reverse restores unit order");
}

// ---------------------------------------------------------------------------
console.log("uncouple: engine cuts off, cars stay put with exact geometry");
{
  const E = engineWith(straightLine(12));
  const r = assertOk(E.command({type:"placeTrain", x:8, y:0, heading:"E",
    units:[{kind:"engine", len:0.5, type:1}, {kind:"car", len:0.5}, {kind:"car", len:0.5}]}), "place E+2C");
  const t = trainById(E, r.id);
  const d = assertOk(E.command({type:"detach", train: t.id, keep: 0}), "detach keep 0");
  assert(d.front.units.length === 1 && d.front.units[0].kind === "engine", "front portion is the engine alone");
  assert(d.detached.units.length === 2 && d.detached.units.every(u => u.kind === "car"), "two cars left standing");
  const cars = trainById(E, d.detached.id);
  // engine head at centre of (8,0) = x 8.5; cars span x 8.0 → 7.0
  const carsHead = E.headWorld(cars);
  assert(near(carsHead.x, 8.0) && near(carsHead.y, 0.5), `cars' front at the coupling point (x 8.0) — got ${carsHead.x.toFixed(3)}`);
  assert(!E.hasActiveEngine(cars), "car cut has no active engine");
  // the cars never move even though the sim runs
  const fx = carsHead.x;
  for (let i = 0; i < 300; i++) E.simStep();
  assert(near(E.headWorld(cars).x, fx, 0.001), "parked cars do not move");
  // uncoupling a single vehicle is refused
  const d2 = E.command({type:"detach", train: t.id, keep: 0});
  assert(!d2.ok && /single vehicle/.test(d2.error), "uncoupling a lone engine is refused");
}

// ---------------------------------------------------------------------------
console.log("shunt vs drive: standoff distance and touching");
{
  const E = engineWith(straightLine(14));
  assertOk(E.command({type:"placeTrain", x:9, y:0, heading:"E", units:[{kind:"car", len:0.5}, {kind:"car", len:0.5}]}), "place parked cars");
  const cars = E.state.trains[0];
  const r = assertOk(E.command({type:"placeTrain", x:2, y:0, heading:"E", units:[{kind:"engine", len:0.5, type:1}]}), "place engine");
  const eng = trainById(E, r.id);
  // drive mode: stops a full tile short of the cars' body (body tiles 9 and 8)
  waitFor(E, () => stopped(E, eng) && !E.trainMoving(eng) && eng.x === 7, 4000, "drive-mode engine holds at (7,0), one tile short");
  assert(!eng._touch, "drive-mode standoff is not a touch");
  // shunting: creeps up and touches
  assertOk(E.command({type:"setTrainMode", train: eng.id, mode: "shunt"}), "shunt mode");
  waitFor(E, () => eng._touch, 4000, "shunting engine touches the cars");
  const gap = 8.5 - E.headWorld(eng).x;   // cars: head at x 9.5, body 1.0 long → rear buffer at x 8.5
  assert(gap >= -0.005 && gap < 0.1, `buffers touch (gap ${gap.toFixed(3)} tiles)`);
  // touching drops the shunter onto the handbrake: stop mode, so nothing creeps
  assert(eng.mode === "stop", "touching auto-enters stop mode");
  // couple: merged consist, engine stays active, cars ahead of it — and it HOLDS (stop mode)
  const c = assertOk(E.command({type:"couple", train: eng.id}), "couple");
  assert(c.units.length === 3, "merged consist has 3 vehicles");
  assert(c.activeEngine === r.activeEngine, "commanding engine stays active");
  assert(c.mode === "stop", "coupled consist holds in stop mode");
  const merged = trainById(E, c.id);
  assert(trainById(E, eng.id) == null && trainById(E, cars.id) == null, "old consists are gone");
  const hx = E.headWorld(merged).x;
  for (let i = 0; i < 300; i++) E.simStep();
  assert(Math.abs(E.headWorld(merged).x - hx) < 0.001, "stop mode: the coupled train does not move by itself");
  // couple → reverse → drive: pull the cars away westwards
  assertOk(E.command({type:"reverse", train: merged.id}), "reverse merged");
  assertOk(E.command({type:"setTrainMode", train: merged.id, mode: "drive"}), "drive mode");
  waitFor(E, () => E.headWorld(merged).x < 6.0, 4000, "engine hauls the cars west");
  assert(merged.units[0].kind === "engine", "engine leads after reversal");
}

// ---------------------------------------------------------------------------
console.log("signals while shunting: red holds, buffer terminus, shunt clear into occupied track");
{
  const layout = straightLine(12);
  layout.tiles = layout.tiles.filter(t => !(t.x === 6 && t.y === 0));
  layout.tiles.push({x:6, y:0, tile:{kind:"signal", route:[6,2], dirs:[2], manualDirs:[2], name:"S"}});
  layout.tiles = layout.tiles.filter(t => !(t.x === 12 && t.y === 0));
  layout.tiles.push({x:12, y:0, tile:{kind:"track", route:[6]}});       // buffer
  const E = engineWith(layout);
  assertOk(E.command({type:"placeTrain", x:9, y:0, heading:"E", units:[{kind:"car", len:0.5}]}), "park a car beyond the signal");
  const r = assertOk(E.command({type:"placeTrain", x:2, y:0, heading:"E", units:[{kind:"engine", len:0.5, type:1}], mode:"shunt"}), "place shunting engine");
  const eng = trainById(E, r.id);
  waitFor(E, () => !E.trainMoving(eng) && eng.x === 6 && (eng.speed||0) === 0, 6000, "shunting engine stops at the red signal");
  const plain = E.command({type:"clearSignal", x:6, y:0, dir:2});
  assert(!plain.ok, "a plain clear into occupied track is refused");
  const shuntClear = assertOk(E.command({type:"clearSignal", x:6, y:0, dir:2, shunt:true}), "shunt clear into occupied track");
  assert(shuntClear.action === "green", "shunt clear turns the main green");
  waitFor(E, () => eng._touch, 6000, "engine creeps through the green up to the car");
  assertOk(E.command({type:"couple", train: eng.id}), "couple beyond the signal");
  const merged = E.state.trains.find(t => E.hasActiveEngine(t));
  assert(merged.mode === "stop", "merged holds in stop mode after coupling");
  // now clear the (empty) route ahead: it ends at a BUFFER, which is a valid terminus
  const toBuffer = assertOk(E.command({type:"clearSignal", x:6, y:0, dir:2, shunt:true}), "clear to the buffer (already past signal — idempotent green)");
  assert(toBuffer.ok, "buffer counts as a route terminus");
  assertOk(E.command({type:"setTrainMode", train: merged.id, mode: "shunt"}), "release the handbrake: back to shunting");
  waitFor(E, () => !E.trainMoving(merged) && merged.x === 12 && (merged.speed||0) === 0, 9000, "consist parks on the buffer");
}

// ---------------------------------------------------------------------------
console.log("station rule: shunting commands are refused outside stations");
{
  const layout = straightLine(12);
  layout.stations = [{id:1, name:"Yard", instructions:"", overrides:[], rect:{x0:0, y0:0, x1:4, y1:0}}];
  const E = engineWith(layout);
  const r = assertOk(E.command({type:"placeTrain", x:8, y:0, heading:"E", units:SHUTTLE_UNITS}), "place outside the station");
  const rev = E.command({type:"reverse", train: r.id});
  assert(!rev.ok && /station/.test(rev.error), "reverse refused outside a station");
  const det = E.command({type:"detach", train: r.id, keep:0});
  assert(!det.ok && /station/.test(det.error), "uncouple refused outside a station");
  const r2 = assertOk(E.command({type:"placeTrain", x:3, y:0, heading:"E", units:[{kind:"engine", len:0.5, type:1}]}), "place inside the station");
  const wrongStation = E.command({type:"reverse", train: r2.id, station: "Nowhere"});
  assert(!wrongStation.ok, "unknown station scope refused");
  assertOk(E.command({type:"reverse", train: r2.id, station: "Yard"}), "reverse allowed inside its station");
}

// ---------------------------------------------------------------------------
console.log("snapshot round trip preserves consists mid-shunt");
{
  const E = engineWith(straightLine(14));
  assertOk(E.command({type:"placeTrain", x:9, y:0, heading:"E", units:[{kind:"car", len:0.5}]}), "park a car");
  const r = assertOk(E.command({type:"placeTrain", x:2, y:0, heading:"E", units:[{kind:"engine", len:0.5, type:1}], mode:"shunt"}), "place engine");
  waitFor(E, () => trainById(E, r.id)._touch, 6000, "touches");
  const snap = JSON.parse(JSON.stringify(E.snapshot()));
  const E2 = createEngine();
  E2.applySnapshot(snap);
  const eng2 = E2.state.trains.find(t => t.id === r.id);
  assert(eng2 && eng2.units && eng2.units.length === 1 && eng2.path && eng2.path.length > 0, "units + path survive the snapshot");
  assertOk(E2.command({type:"couple", train: r.id}), "can couple right after reload");
}

// ---------------------------------------------------------------------------
// Regression: a consist standing buffers-to-buffers must not be able to DRIVE through
// the stock ahead. Switching to drive while touching is refused; and even if the mode
// is forced (old snapshot, direct edit), the drive-mode overlap clamp holds the train.
console.log("drive mode cannot pass through touching stock");
{
  const E = engineWith(straightLine(14));
  assertOk(E.command({type:"placeTrain", x:9, y:0, heading:"E", units:[{kind:"car", len:0.5}]}), "park a single car");
  const r = assertOk(E.command({type:"placeTrain", x:3, y:0, heading:"E", units:[{kind:"engine", len:0.5, type:1}], mode:"shunt"}), "place a shunting engine");
  const eng = trainById(E, r.id);
  waitFor(E, () => eng._touch, 6000, "engine touches the car");
  const sw = E.command({type:"setTrainMode", train: eng.id, mode:"drive"});
  assert(!sw.ok && /touching/.test(sw.error), "switching to drive while touching is refused");
  // force the mode anyway: the overlap clamp must still keep it off the car (rear at x 9.0)
  eng.mode = "drive";
  for (let i = 0; i < 400; i++) E.simStep();
  assert(E.headWorld(eng).x <= 9.02, `clamped short of the car even in drive mode (head x ${E.headWorld(eng).x.toFixed(3)})`);
  assert(eng.mode === "stop", "the anomaly drops the consist onto the handbrake");
  // reversing away and THEN driving is fine
  assertOk(E.command({type:"reverse", train: eng.id}), "reverse away from the car");
  assertOk(E.command({type:"setTrainMode", train: eng.id, mode:"drive"}), "drive is allowed once the stock is behind");
  waitFor(E, () => E.headWorld(eng).x < 7, 4000, "engine drives away west");
}

// ---------------------------------------------------------------------------
// Regression: couple with a TWO-car cut whose tail sits exactly ON a tile boundary,
// then reverse IMMEDIATELY (before anything moves). The merged tile path used to pick
// up doubled-back duplicate tiles at the junction (F's path cut one tile too deep +
// R's committed-but-never-entered destination tile), corrupting the reversal geometry
// until movement trimmed it away.
console.log("couple at a tile-boundary junction, then reverse immediately");
{
  const E = engineWith(straightLine(14));
  const r0 = assertOk(E.command({type:"placeTrain", x:10, y:0, heading:"E", mode:"stop",
    units:[{kind:"engine", len:0.5, type:1}, {kind:"car", len:0.5}, {kind:"car", len:0.5}]}), "place E+2C on the handbrake");
  const d = assertOk(E.command({type:"detach", train: r0.id, keep: 0}), "cut the engine off");
  // the cut's front is exactly at the 9/10 tile edge, its tail exactly at the 8/9 edge
  // a 0.6 engine makes the merged length 1.6 — misaligned with the corrupted path's
  // landmarks, which is exactly the case that used to reverse the train the WRONG way
  const r = assertOk(E.command({type:"placeTrain", x:3, y:0, heading:"E", units:[{kind:"engine", len:0.6, type:1}], mode:"shunt"}), "place a second engine");
  const eng = trainById(E, r.id);
  waitFor(E, () => eng._touch, 6000, "engine touches the cut's tail");
  const c = assertOk(E.command({type:"couple", train: eng.id}), "couple at the boundary junction");
  const merged = trainById(E, c.id);
  // the merged path must visit each tile at most once — the old merge doubled back
  const seen = new Set();
  for (const e of merged.path){
    assert(!seen.has(`${e.x},${e.y}`), `merged path visits ${e.x},${e.y} only once`);
    seen.add(`${e.x},${e.y}`);
  }
  const rev = assertOk(E.command({type:"reverse", train: merged.id}), "reverse IMMEDIATELY after coupling");
  assert(rev.ok && merged.units[0].kind === "engine", "engine leads after the immediate reversal");
  // the new front is the old tail (the second engine's rear, ~x 8.35) — no teleporting
  assert(near(E.headWorld(merged).x, 8.35, 0.12), `reversed head sits at the old tail (got x ${E.headWorld(merged).x.toFixed(3)})`);
  assertOk(E.command({type:"setTrainMode", train: merged.id, mode: "drive"}), "drive");
  waitFor(E, () => E.headWorld(merged).x < 6.5, 6000, "the coupled train pulls away west, engine leading");
}

// ---------------------------------------------------------------------------
// The full shuttle choreography, in-process: one complete round trip
// West A → East (run-around) → West (run-around) → back at West A facing E.
console.log("shuttle: full round trip with run-arounds at both ends");
{
  const E = engineWith(buildLayout());
  const r = assertOk(E.command({type:"placeTrain", x:6, y:0, heading:"E", units:SHUTTLE_UNITS}), "place the shuttle on West track 1");
  let trainId = r.id;
  const t = () => trainById(E, trainId);
  const stoppedAt = (x, y) => () => { const tr = t(); return tr && tr.x === x && tr.y === y && stopped(E, tr) && !E.trainMoving(tr); };
  const cmd = (c, what) => assertOk(E.command(c), what);

  waitFor(E, stoppedAt(8, 0), 4000, "shuttle waits at West A");

  // one full run-around at a station; mirrored by parameters.
  //   A: main signal, B: track-1 signal, sw1/sw2: switches, buffer: stub end,
  //   inDir/outDir: arrival/departure travel directions at A.
  function runAround(side){
    const P = side === "east"
      ? {A:{x:16,y:0}, B:{x:21,y:0}, sw1:{x:17,y:0}, sw2:{x:22,y:0}, buffer:{x:24,y:0},
         inDir:2, outDir:6, track1Branch1:2, loopBranch1:3, track1Branch2:6, loopBranch2:5, carTile:{x:20,y:0}}
      : {A:{x:8,y:0}, B:{x:3,y:0}, sw1:{x:7,y:0}, sw2:{x:2,y:0}, buffer:{x:0,y:0},
         inDir:6, outDir:2, track1Branch1:6, loopBranch1:5, track1Branch2:2, loopBranch2:3, carTile:{x:4,y:0}};
    // ARRIVAL: route the waiting train onto track 1
    cmd({type:"setSwitch", x:P.sw1.x, y:P.sw1.y, to:P.track1Branch1}, side+": sw1 → track 1");
    cmd({type:"clearSignal", x:P.A.x, y:P.A.y, dir:P.inDir}, side+": clear A for the arrival");
    waitFor(E, stoppedAt(P.B.x, P.B.y), 12000, side+": train stops at B on track 1");
    // RUN-AROUND
    const d = cmd({type:"detach", train: trainId, keep: 0}, side+": uncouple the engine");
    const carId = d.detached.id;
    cmd({type:"setTrainMode", train: trainId, mode:"shunt"}, side+": engine to shunt mode");
    cmd({type:"setSwitch", x:P.sw2.x, y:P.sw2.y, to:P.track1Branch2}, side+": sw2 → track 1");
    cmd({type:"clearSignal", x:P.B.x, y:P.B.y, dir:P.outDir === 2 ? 6 : 2, shunt:true}, side+": clear B to the stub");
    waitFor(E, stoppedAt(P.buffer.x, P.buffer.y), 12000, side+": engine parks at the buffer");
    cmd({type:"setSwitch", x:P.sw2.x, y:P.sw2.y, to:P.loopBranch2}, side+": sw2 → loop");
    cmd({type:"setSwitch", x:P.sw1.x, y:P.sw1.y, to:P.loopBranch1}, side+": sw1 → loop");
    cmd({type:"reverse", train: trainId}, side+": reverse at the buffer");
    waitFor(E, stoppedAt(P.A.x, P.A.y), 20000, side+": engine loops around to A");
    cmd({type:"setSwitch", x:P.sw1.x, y:P.sw1.y, to:P.track1Branch1}, side+": sw1 back to track 1");
    cmd({type:"clearSignal", x:P.A.x, y:P.A.y, dir:P.inDir, shunt:true}, side+": shunt clear A into the occupied track 1");
    cmd({type:"reverse", train: trainId}, side+": reverse toward the car");
    waitFor(E, () => { const tr = t(); return tr && tr._touch; }, 12000, side+": engine touches the car");
    const c = cmd({type:"couple", train: trainId}, side+": couple");
    trainId = c.id;
    assert(c.mode === "stop", side+": coupled consist holds in stop mode (no creep)");
    assert(trainById(E, carId) == null, side+": the car cut merged into the new consist");
    // couple → reverse → drive: the whole point of the auto stop mode
    cmd({type:"reverse", train: trainId}, side+": reverse the whole train");
    cmd({type:"setTrainMode", train: trainId, mode:"drive"}, side+": back to driving mode");
    waitFor(E, stoppedAt(P.A.x, P.A.y), 12000, side+": train stands at A ready to depart");
    const tr = t();
    assert(tr.units[0].kind === "engine" && tr.units.length === 2, side+": engine leads the two-vehicle train");
    // DEPARTURE
    cmd({type:"clearSignal", x:P.A.x, y:P.A.y, dir:P.outDir}, side+": clear A for departure");
  }

  // depart West → arrive East
  cmd({type:"clearSignal", x:8, y:0, dir:2}, "West: clear A for the first departure");
  waitFor(E, stoppedAt(16, 0), 20000, "shuttle crosses the single line to East A");
  runAround("east");
  waitFor(E, stoppedAt(8, 0), 20000, "shuttle returns across the single line to West A");
  runAround("west");
  waitFor(E, stoppedAt(16, 0), 20000, "second departure: shuttle reaches East A again");
  const tr = t();
  assert(tr.units.length === 2 && tr.units[0].kind === "engine", "shuttle intact after a full round trip");
}

console.log(failures ? `\n${failures}/${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
