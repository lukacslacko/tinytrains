// Tiny Trains — the shunting test layout: a single-track line between two terminus
// stations, each with a run-around loop (two switches + a parallel track) and a stub
// with a buffer. A one-engine-one-car shuttle works the line: at each end the engine
// cuts off, runs around the car via the loop, couples back on and hauls the train back.
//
//   buffer─track─[2]──B──track1──[1]──A══════single line══════A──[1]──track1──B──[2]─track─buffer
//                  └────loop (y=1)────┘                        └────loop (y=1)────┘
//              WEST (x 0..8)                                          EAST (x 16..24)
//
// Used by test/engine-shunt.test.js (in-process) and test/shuttle.test.js (HTTP), and
// exported as examples/shuttle.json for playing with in the UI.
"use strict";

const WEST_INSTRUCTIONS = `Terminus with a run-around loop. Elements: A = main signal (manual both ways: E = departures, W = arrivals), B = track-1 exit signal (faces W, toward the stub), 1 = east switch (branches W = track 1, SW = loop), 2 = west switch (branches E = track 1, SE = loop). West of switch 2 lies a stub with a buffer.

The shuttle train is one engine + one car. Work it like this:
- ARRIVAL (train waiting at A wanting W): set switch 1 to W, then clear A westwards. The train runs onto track 1 and stops at B.
- RUN-AROUND (after it stopped at B): 1) uncouple the engine (keep 0 cars). 2) set the engine to shunting mode. 3) make sure switch 2 points E, then clear B for shunting — the engine parks on the stub and stops at the buffer. 4) set switch 2 to SE and switch 1 to SW, then reverse the engine: it runs around the loop and stops at A facing E. 5) set switch 1 to W and clear A westwards FOR SHUNTING (track 1 is occupied by the car — a shunt clear is allowed into it), then reverse the engine: it creeps up to the car, touches it and drops onto the handbrake (stop mode). 6) couple — the merged train keeps holding in stop mode, nothing moves. 7) reverse it, then set it to driving mode: it runs to A and stops there facing E.
- DEPARTURE (train at A wanting E, in driving mode): clear A eastwards. The single line ends at East station's A signal.`;

const EAST_INSTRUCTIONS = `Terminus with a run-around loop (mirror of West). Elements: A = main signal (manual both ways: W = departures, E = arrivals), B = track-1 exit signal (faces E, toward the stub), 1 = west switch (branches E = track 1, SE = loop), 2 = east switch (branches W = track 1, SW = loop). East of switch 2 lies a stub with a buffer.

The shuttle train is one engine + one car. Work it like this:
- ARRIVAL (train waiting at A wanting E): set switch 1 to E, then clear A eastwards. The train runs onto track 1 and stops at B.
- RUN-AROUND (after it stopped at B): 1) uncouple the engine (keep 0 cars). 2) set the engine to shunting mode. 3) make sure switch 2 points W, then clear B for shunting — the engine parks on the stub and stops at the buffer. 4) set switch 2 to SW and switch 1 to SE, then reverse the engine: it runs around the loop and stops at A facing W. 5) set switch 1 to E and clear A eastwards FOR SHUNTING (track 1 is occupied by the car), then reverse the engine: it creeps up to the car, touches it and drops onto the handbrake (stop mode). 6) couple — the merged train keeps holding in stop mode, nothing moves. 7) reverse it, then set it to driving mode: it runs to A and stops there facing W.
- DEPARTURE (train at A wanting W, in driving mode): clear A westwards.`;

function buildLayout(){
  const tiles = [];
  const T = (x, y, tile) => tiles.push({x, y, tile});
  const EW = [6, 2];
  // ---- West station (x 0..8) ----
  T(0, 0, {kind:"track", route:[2]});                                            // buffer (open E)
  T(1, 0, {kind:"track", route:EW});
  T(2, 0, {kind:"switch", stem:6, branches:[2,3], current:2, name:"2"});         // E = track 1, SE = loop
  T(3, 0, {kind:"signal", route:EW, dirs:[6], manualDirs:[6], name:"B"});        // track-1 exit toward the stub
  T(4, 0, {kind:"track", route:EW});
  T(5, 0, {kind:"track", route:EW});
  T(6, 0, {kind:"track", route:EW});
  T(7, 0, {kind:"switch", stem:2, branches:[6,5], current:6, name:"1"});         // W = track 1, SW = loop
  T(8, 0, {kind:"signal", route:EW, dirs:[2,6], manualDirs:[2,6], name:"A"});    // main: departures E / arrivals W
  // West loop (y=1)
  T(3, 1, {kind:"track", route:[7,2]});                                          // NW ↔ E
  T(4, 1, {kind:"track", route:EW});
  T(5, 1, {kind:"track", route:EW});
  T(6, 1, {kind:"track", route:[6,1]});                                          // W ↔ NE
  // ---- Single line (x 9..15) ----
  for (let x = 9; x <= 15; x++) T(x, 0, {kind:"track", route:EW});
  // ---- East station (x 16..24, mirror) ----
  T(16, 0, {kind:"signal", route:EW, dirs:[6,2], manualDirs:[6,2], name:"A"});   // main: departures W / arrivals E
  T(17, 0, {kind:"switch", stem:6, branches:[2,3], current:2, name:"1"});        // E = track 1, SE = loop
  T(18, 0, {kind:"track", route:EW});
  T(19, 0, {kind:"track", route:EW});
  T(20, 0, {kind:"track", route:EW});
  T(21, 0, {kind:"signal", route:EW, dirs:[2], manualDirs:[2], name:"B"});       // track-1 exit toward the stub
  T(22, 0, {kind:"switch", stem:2, branches:[6,5], current:6, name:"2"});        // W = track 1, SW = loop
  T(23, 0, {kind:"track", route:EW});
  T(24, 0, {kind:"track", route:[6]});                                           // buffer (open W)
  // East loop (y=1)
  T(18, 1, {kind:"track", route:[7,2]});
  T(19, 1, {kind:"track", route:EW});
  T(20, 1, {kind:"track", route:EW});
  T(21, 1, {kind:"track", route:[6,1]});
  return {
    version: 3,
    trainTypes: [{id:1, color:"#f05264", name:"shuttle"}],
    stations: [
      {id:1, name:"West", instructions: WEST_INSTRUCTIONS, overrides:[], rect:{x0:0, y0:0, x1:8, y1:1}},
      {id:2, name:"East", instructions: EAST_INSTRUCTIONS, overrides:[], rect:{x0:16, y0:0, x1:24, y1:1}}
    ],
    tiles,
    view: {x: -400, y: 0, zoom: 1.4}
  };
}

// The shuttle consist: one short engine + one car (0.5 each — the engine fits a single
// tile, which keeps it clear of switches while it waits at signals).
const SHUTTLE_UNITS = [{kind:"engine", len:0.5, type:1}, {kind:"car", len:0.5}];

module.exports = { buildLayout, SHUTTLE_UNITS, WEST_INSTRUCTIONS, EAST_INSTRUCTIONS };
