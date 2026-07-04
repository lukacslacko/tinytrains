// Tiny Trains — shared, DOM-free simulation engine.
//
// Extracted verbatim from manual.html's simulator so the SAME code runs in two places:
//   • the browser (build/preview + rendering server state), and
//   • the Node server (the authoritative game loop + REST/Station-Master API).
// createEngine() returns one isolated simulation instance. All rendering, input, and DOM live
// in manual.html; this module is pure state + rules + an operate-command/snapshot API.
//
// NOTE: the bulk of this file is the byte-for-byte engine lifted out of manual.html (see
// scratchpad/extract.py). Three DOM couplings were rewritten (toggleManualSignal, notifyDeparture,
// deserialize) and the "Engine API additions" block at the end was appended.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TinyTrainsEngine = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function createEngine(){
  const DEFAULT_TYPE_COLORS = ["#f05264","#58a8ff","#f1ca57","#43d17b","#b58cff"];
  const DEFAULT_TYPE_NAMES  = ["red","blue","yellow","green","violet"];
  // Old saves stored colour-name strings; map them to the default ids on load.
  const LEGACY_COLOR_IDS = {red:1, blue:2, yellow:3, green:4, violet:5};
  const UNKNOWN_TYPE_COLOR = "#9aa6b2";
  function defaultTrainTypes(){
    return DEFAULT_TYPE_COLORS.map((color,i) => ({id:i+1, color, name:DEFAULT_TYPE_NAMES[i]}));
  }
  function trainTypeById(id){
    for (const t of state.trainTypes) if (t.id === id) return t;
    return null;
  }
  function typeColor(id){ const t = trainTypeById(id); return t ? t.color : UNKNOWN_TYPE_COLOR; }
  function nextTypeId(){ let m = 0; for (const t of state.trainTypes) if (t.id > m) m = t.id; return m + 1; }
  const MAX_SPEED = 0.018;
  const ACCEL = 0.0008;
  const DECEL = 0.0002;
  const MIN_SPEED = 0.0016;
  // Multi-part consists: engines and cars, each a length in tile units, coupled so their
  // buffers TOUCH (no gap). Bodies trail the head along its path; block occupancy follows the
  // whole body. CAR_GAP is kept (=0) for legacy callers that still add it between cars.
  const DEFAULT_CARS = [0.6, 0.5, 0.5];
  const CAR_GAP = 0;
  const CAR_WIDTH = 0.42;
  // Shunting: a consist in "shunt" mode moves slower and, instead of holding a full tile back
  // from the next train, creeps up until the buffers touch (so it can couple).
  const SHUNT_SPEED_FACTOR = 0.35;
  const TOUCH_SCAN_TILES = 2.5;    // how far ahead a shunting consist scans for a body to touch
  const TOUCH_NEAR = 0.03;         // scan sample counts as "on the obstacle" within this distance
  const COUPLE_DIST = 0.16;        // ends closer than this count as buffers-touching → may couple
  // Short pause after a held train's main signal turns green, so the clear is visible
  // before the train pulls away.
  const SIGNAL_REACTION_SECONDS = 0.5;
  // Signals are drawn beside the track, to the right of the direction they face.
  const SIGNAL_SIDE_OFFSET = 0.26;
  const SPAWN_TICK_FRAMES = 14;
  const FRAMES_PER_SECOND = 60;
  const DEFAULT_DWELL_SECONDS = 2;
  const STOP_BROWN = "#8b5a2b";
  const SIGNAL_GREEN = "#16a34a";
  const SIGNAL_RED = "#ff2a2a";
  const SIGNAL_RED_DARK = "#3a0a0a";
  const MANUAL_RING = "#ffd24a"; // manual mains carry a yellow ring to set them apart from automatic ones
  const INACTIVE_BRANCH = "#39424e"; // the set-against branch of a switch, drawn darker than the live route
  const LOCK_GREEN = "#43d17b";      // green outline of a locked manual route / disc on a locked switch
  const BLOCK_GREY = "#8f9aa5";      // grey outline of an occupied automatic block
  const DIRS = [
    {name:"N", dx:0, dy:-1, px:.5, py:0},
    {name:"NE", dx:1, dy:-1, px:1, py:0},
    {name:"E", dx:1, dy:0, px:1, py:.5},
    {name:"SE", dx:1, dy:1, px:1, py:1},
    {name:"S", dx:0, dy:1, px:.5, py:1},
    {name:"SW", dx:-1, dy:1, px:0, py:1},
    {name:"W", dx:-1, dy:0, px:0, py:.5},
    {name:"NW", dx:-1, dy:-1, px:0, py:0}
  ];
  const TRACK_SHAPES = [
    {label:"Straight E-W", route:[6,2]},
    {label:"Straight N-S", route:[0,4]},
    {label:"Straight NE-SW", route:[1,5]},
    {label:"Straight NW-SE", route:[7,3]},
    {label:"Turn W to NE", route:[6,1]},
    {label:"Turn W to SE", route:[6,3]},
    {label:"Turn E to NW", route:[2,7]},
    {label:"Turn E to SW", route:[2,5]},
    {label:"Turn N to SE", route:[0,3]},
    {label:"Turn N to SW", route:[0,5]},
    {label:"Turn S to NE", route:[4,1]},
    {label:"Turn S to NW", route:[4,7]},
    {label:"Buffer E", route:[2]},
    {label:"Buffer W", route:[6]},
    {label:"Buffer N", route:[0]},
    {label:"Buffer S", route:[4]}
  ];
  function buildDirectionalShapes(kind){
    const shapes = [];
    for (const shape of TRACK_SHAPES){
      for (const dir of shape.route){
        shapes.push({
          label: `${shape.label} ${kind} ${DIRS[dir].name}`,
          route: cloneRoute(shape.route),
          dir
        });
      }
    }
    return shapes;
  }
  function switchShape(stem, branches){
    return {
      label: `${DIRS[stem].name} to ${branches.map(b => DIRS[b].name).join(" / ")}`,
      stem,
      branches,
      defaultBranch: branches[0]
    };
  }
  function buildSwitchShapes(){
    const shapes = [];
    const seen = new Set();
    function add(stem, branches){
      const id = `${stem}:${branches.join(",")}`;
      if (seen.has(id)) return;
      seen.add(id);
      shapes.push(switchShape(stem, branches));
    }
    for (let stem=0; stem<DIRS.length; stem++){
      const oppositeDir = opposite(stem);
      add(stem, [oppositeDir, (oppositeDir + 7) % 8]);
      add(stem, [oppositeDir, (oppositeDir + 1) % 8]);
    }
    for (let stem=0; stem<DIRS.length; stem++){
      const oppositeDir = opposite(stem);
      add(stem, [(oppositeDir + 1) % 8, (oppositeDir + 7) % 8]);
    }
    return shapes;
  }
  const SWITCH_SHAPES = buildSwitchShapes();
  const SPAWN_SHAPES = buildDirectionalShapes("spawn");
  const STOP_SHAPES = buildDirectionalShapes("stop");
  const SIGNAL_SHAPES = buildDirectionalShapes("signal");
  const TOOLS = [
    ["operate","Operate"],
    ["select","Select"],
    ["station","Station"],
    ["erase","Erase"]
  ];
  const CROSSING_SHAPES = [
    {label:"Cross +", tool:"crossPlus"},
    {label:"Cross X", tool:"crossX"}
  ];

  const state = {
    tiles: new Map(),
    trains: [],
    nextTrainId: 1,
    stations: [],      // named regions {id,name,rect}; element names live on tiles
    nextStationId: 1,
    tick: 0,
    frame: 0,
    simFrame: 0,        // monotonic sim-clock frames (60 = one sim-second)
    dayLength: 600,     // sim-seconds per simulation "day"; time-of-day = simSeconds mod dayLength
    paused: false,
    selectedTool: "operate",
    lastTool: "track",   // the build tool to return to when Tab leaves Operate
    trainTypes: defaultTrainTypes(),
    selectedType: 1,
    selectedShape: 0,
    selectedSpawnShape: 0,
    selectedStopShape: 0,
    selectedSignalShape: 0,
    selectedSwitchShape: 0,
    view: {x: 0, y: 0, zoom: 1},
    drag: null,
    hover: null,
    selection: null,   // committed rectangle {x0,y0,x1,y1} in world cells
    selecting: null,   // rectangle being dragged out
    // ---- manual control (transient runtime state, not saved with the layout) ----
    manualGreen: new Set(),     // mainKeys "x,y,dir" of manual signals the operator has cleared
    routeLocks: [],             // active locked routes set up by clearing a manual signal
    lockedSwitchKeys: new Set(),// switch tile keys "x,y" currently locked by a routeLock
    message: ""
  };
  function normRect(s){
    return s && {x0:Math.min(s.x0,s.x1), y0:Math.min(s.y0,s.y1), x1:Math.max(s.x0,s.x1), y1:Math.max(s.y0,s.y1)};
  }
  // Stations are named rectangular regions. Membership is geometric: a stop,
  // switch or signal "belongs" to a station when its tile lies inside the rect.
  // The station-local names of those elements live on the tiles themselves
  // (tile.name) — a station master enumerates the tiles within its rect.
  function addStation(rect){
    const r = normRect(rect);
    const id = state.nextStationId++;
    // `instructions` is free text for the Station Master (the operator/API that sets this
    // station's switches and manual signals). It travels with the layout and is exposed by the API.
    // `overrides` are temporary operator instructions (set over chat, "until further notice …") that
    // take precedence over `instructions` until cleared; they travel with the layout like instructions.
    const st = {id, name:`Station ${id}`, instructions:"", overrides:[], rect:{x0:r.x0, y0:r.y0, x1:r.x1, y1:r.y1}};
    state.stations.push(st);
    return st;
  }
  function removeStation(id){ state.stations = state.stations.filter(s => s.id !== id); }
  // The topmost station whose rect contains (x,y), or null.
  function stationContaining(x,y){
    for (let i = state.stations.length-1; i >= 0; i--){
      const r = normRect(state.stations[i].rect);
      if (r && x>=r.x0 && x<=r.x1 && y>=r.y0 && y<=r.y1) return state.stations[i];
    }
    return null;
  }
  function key(x,y){ return `${x},${y}`; }
  function readKey(k){ const [x,y] = k.split(",").map(Number); return {x,y}; }
  function opposite(d){ return (d + 4) % 8; }
  function cloneRoute(route){ return route.slice(); }
  // A signal tile can carry main signals in several directions (e.g. one each way so two
  // blocks meet on one tile). signalDirs() reads the list, falling back to the legacy
  // single `dir`. A "main" is identified by tile position plus its direction.
  function signalDirs(tile){ return tile && tile.dirs ? tile.dirs : (tile && tile.dir != null ? [tile.dir] : []); }
  function mkMain(x,y,dir){ return `${x},${y},${dir}`; }
  function parseMain(mk){ const [x,y,dir] = mk.split(",").map(Number); return {x,y,dir}; }
  // A main signal is either *automatic* (default green when its block is clear) or *manual*
  // (default red, cleared by the operator). manualDirs lists the directions on a signal tile
  // whose main is manual; any signal direction not in it is automatic.
  function manualDirs(tile){ return (tile && tile.manualDirs) ? tile.manualDirs : []; }
  function mainIsManual(x,y,dir){ const t = getTile(x,y); return !!(t && t.kind === "signal" && manualDirs(t).includes(dir)); }
  function mainIsManualKey(mk){ const {x,y,dir} = parseMain(mk); return mainIsManual(x,y,dir); }
  // True when a train sits stopped on a RED manual main, wanting to leave via its direction.
  function manualMainHasWaiter(x,y,dir){
    if (state.manualGreen.has(mkMain(x,y,dir))) return false; // it's cleared, not red
    const tile = getTile(x,y);
    for (const t of state.trains)
      if (t.x === x && t.y === y && !trainMoving(t) && exitFor(tile, t.from) === dir) return true;
    return false;
  }
  function routesFor(tile){
    if (!tile) return [];
    if (tile.kind === "track") return [tile.route];
    if (tile.kind === "crossPlus") return [[6,2],[0,4]];
    if (tile.kind === "crossX") return [[7,3],[1,5]];
    if (tile.kind === "stop" || tile.kind === "signal" || tile.kind === "spawn") return [tile.route];
    if (tile.kind === "switch") return [[tile.stem, tile.branches[0]],[tile.stem, tile.branches[1]]];
    return [];
  }
  function tileAccepts(tile, enterDir){
    return routesFor(tile).some(route => route.includes(enterDir));
  }
  // ---- Switch helpers (manual builder) -------------------------------------------------
  // A switch has a stem and two branches. `current` is the branch the stem is connected to;
  // the switch is fixed at it (the other branch is set against and impassable). Throw it in
  // Operate mode (left-click) or in the right-click pop-up.
  function switchCurrent(tile){ return (tile.current != null) ? tile.current : (tile.defaultBranch != null ? tile.defaultBranch : tile.branches[0]); }
  function switchOther(tile){ return tile.branches.find(b => b !== switchCurrent(tile)); }
  function switchLocked(x,y){ return state.lockedSwitchKeys.has(key(x,y)); }
  // Whether a train arriving at a switch from direction `enterDir` may traverse it.
  function switchAccepts(tile, enterDir){
    if (!tile || tile.kind !== "switch") return true;
    if (enterDir === tile.stem) return true;                 // from the stem → exits the set branch
    if (!tile.branches.includes(enterDir)) return false;     // not a port of this switch
    return enterDir === switchCurrent(tile);                 // only the set branch connects to the stem
  }
  function getTile(x,y){ return state.tiles.get(key(x,y)); }
  function setTile(x,y,tile){ state.tiles.set(key(x,y), tile); }
  function removeTile(x,y){ state.tiles.delete(key(x,y)); }

  function defaultSwitch(){
    const shape = SWITCH_SHAPES[state.selectedSwitchShape];
    return {
      kind: "switch",
      stem: shape.stem,
      branches: shape.branches.slice(),
      current: shape.branches[0]     // branch the stem is set to
    };
  }
  function makeTile(tool){
    const route = cloneRoute(TRACK_SHAPES[state.selectedShape].route);
    if (tool === "track") return {kind:"track", route};
    if (tool === "crossPlus") return {kind:"crossPlus"};
    if (tool === "crossX") return {kind:"crossX"};
    if (tool === "switch") return defaultSwitch();
    if (tool === "spawn"){
      const shape = SPAWN_SHAPES[state.selectedSpawnShape];
      return {kind:"spawn", route:cloneRoute(shape.route), dir:shape.dir, type:state.selectedType};
    }
    if (tool === "stop"){
      const shape = STOP_SHAPES[state.selectedStopShape];
      return {kind:"stop", route:cloneRoute(shape.route), dir:shape.dir, dwellSeconds:DEFAULT_DWELL_SECONDS};
    }
    if (tool === "signal"){
      const shape = SIGNAL_SHAPES[state.selectedSignalShape];
      return {kind:"signal", route:cloneRoute(shape.route), dir:shape.dir};
    }
    return null;
  }

  function sortedRouteKey(route){ return route.slice().sort((a,b) => a - b).join("-"); }
  function findTrackShapeIndex(route){
    const r = sortedRouteKey(route);
    const i = TRACK_SHAPES.findIndex(s => sortedRouteKey(s.route) === r);
    return i < 0 ? state.selectedShape : i;
  }
  function findDirShapeIndex(shapes, route, dir){
    const r = sortedRouteKey(route);
    return shapes.findIndex(s => s.dir === dir && sortedRouteKey(s.route) === r);
  }
  function findSwitchShapeIndex(tile){
    const b = tile.branches.slice().sort((a,b) => a - b).join(",");
    return SWITCH_SHAPES.findIndex(s =>
      s.stem === tile.stem && s.branches.slice().sort((x,y) => x - y).join(",") === b);
  }
  // ---- Multi-part train bodies ------------------------------------------------------
  function centerW(x,y){ return {x:x+0.5, y:y+0.5}; }
  function endpointW(x,y,d){ return {x:x+DIRS[d].px, y:y+DIRS[d].py}; }
  function lerpW(a,b,t){ return {x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t}; }
  function headWorld(train){
    if (!trainMoving(train)) return centerW(train.x, train.y);
    const start = centerW(train.prevX, train.prevY);
    const joint = endpointW(train.prevX, train.prevY, train.moveDir);
    const end = centerW(train.x, train.y);
    return train.progress < .5 ? lerpW(start, joint, train.progress*2) : lerpW(joint, end, (train.progress-.5)*2);
  }
  function trainCars(train){ return train.cars && train.cars.length ? train.cars : DEFAULT_CARS; }
  // ---- Units (engines + cars) ----------------------------------------------------------
  // A train is a CONSIST of units listed FRONT-TO-BACK. Each unit: {id, kind:"engine"|"car",
  // len, type?, active?}. Exactly the consist's commanding engine has active:true; engines
  // picked up by coupling are inactive until cut off again. Legacy trains carried only
  // `cars` (an array of lengths, first = the engine) — migrated on first read.
  function nextUnitId(){ state.nextUnitId = (state.nextUnitId || 0) + 1; return state.nextUnitId; }
  function makeUnit(kind, len, type){
    const u = {id: nextUnitId(), kind, len};
    if (kind === "engine"){ u.type = type != null ? type : 1; u.active = true; }
    return u;
  }
  // An engine plus `nCars` cars (the standard consist shapes; default 2 cars).
  function unitsFor(type, nCars){
    const n = Number.isFinite(Number(nCars)) ? Math.max(0, Math.min(12, Math.round(Number(nCars)))) : DEFAULT_CARS.length - 1;
    const units = [makeUnit("engine", DEFAULT_CARS[0], type)];
    for (let i = 0; i < n; i++) units.push(makeUnit("car", DEFAULT_CARS[1] != null ? DEFAULT_CARS[1] : 0.5));
    return units;
  }
  function defaultUnits(type){ return unitsFor(type, DEFAULT_CARS.length - 1); }
  function trainUnits(train){
    if (!train.units || !train.units.length){
      // migrate a legacy train: first car length is the engine, the rest are cars
      const cars = trainCars(train);
      train.units = [makeUnit("engine", cars[0], train.type)].concat(cars.slice(1).map(len => makeUnit("car", len)));
      delete train.cars;
    }
    return train.units;
  }
  function activeEngine(train){ return trainUnits(train).find(u => u.kind === "engine" && u.active) || null; }
  function hasActiveEngine(train){ return !!activeEngine(train); }
  function trainEngines(train){ return trainUnits(train).filter(u => u.kind === "engine"); }
  function unitsLength(units){ return units.reduce((a,u)=>a+u.len,0) + Math.max(0, units.length-1)*CAR_GAP; }
  function trainTotalLength(train){ return unitsLength(trainUnits(train)); }
  // Prepend the head's world position to the trail and trim it to the body length.
  function updateTrail(train){
    if (!train.trail) train.trail = [];
    const h = headWorld(train);
    const t0 = train.trail[0];
    if (!t0 || Math.hypot(h.x-t0.x, h.y-t0.y) > 0.004) train.trail.unshift(h);
    const keep = trainTotalLength(train) + 0.6;
    let acc = 0, cut = train.trail.length;
    for (let i=0; i<train.trail.length-1; i++){
      acc += Math.hypot(train.trail[i+1].x-train.trail[i].x, train.trail[i+1].y-train.trail[i].y);
      if (acc > keep){ cut = i+2; break; }
    }
    if (cut < train.trail.length) train.trail.length = cut;
  }
  function seedTrail(train, dir){
    // straight back-fill so a freshly spawned train shows its body immediately
    const h = headWorld(train);
    const back = DIRS[dir];
    const n = Math.ceil((trainTotalLength(train)+0.6) / 0.1);
    train.trail = [];
    for (let i=0; i<=n; i++) train.trail.push({x:h.x - back.dx*0.1*i, y:h.y - back.dy*0.1*i});
  }
  function computeBodyTiles(train){
    const set = new Set();
    const trail = train.trail;
    if (!trail || trail.length < 1){
      set.add(key(train.x,train.y));
      if (trainMoving(train)) set.add(key(train.prevX,train.prevY));
      return set;
    }
    const total = trainTotalLength(train);
    const add = pt => set.add(key(Math.floor(pt.x), Math.floor(pt.y)));
    add(trail[0]);
    let acc = 0;
    for (let i=0; i<trail.length-1 && acc<total; i++){
      const a = trail[i], b = trail[i+1];
      const seg = Math.hypot(b.x-a.x, b.y-a.y);
      const steps = Math.max(1, Math.ceil(seg/0.2));
      for (let s=1; s<=steps; s++){
        if (acc + seg*(s/steps) > total) break;
        add(lerpW(a,b,s/steps));
      }
      acc += seg;
    }
    return set;
  }
  // collect trail points between distances d0..d1 behind the head (inclusive endpoints)
  function trailSpan(trail, d0, d1){
    const pts = [];
    let acc = 0, started = false;
    const at = dist => { // point at a given distance back
      let a2 = 0;
      for (let i=0; i<trail.length-1; i++){
        const seg = Math.hypot(trail[i+1].x-trail[i].x, trail[i+1].y-trail[i].y);
        if (a2 + seg >= dist) return lerpW(trail[i], trail[i+1], seg ? (dist-a2)/seg : 0);
        a2 += seg;
      }
      return trail[trail.length-1];
    };
    if (!trail.length) return pts;
    pts.push(at(d0));
    for (let i=0; i<trail.length-1; i++){
      const seg = Math.hypot(trail[i+1].x-trail[i].x, trail[i+1].y-trail[i].y);
      if (acc+seg > d0 && acc+seg < d1) pts.push(trail[i+1]);
      acc += seg;
      if (acc >= d1) break;
    }
    pts.push(at(d1));
    return pts;
  }
  // ---- Exact tile paths (the record shunting needs) -----------------------------------
  // Besides the sampled `trail`, every train keeps `path`: the ordered tiles under it,
  // HEAD-FIRST, each {x, y, enter, exit} — `enter` points at the next-deeper tile (where the
  // train came from), `exit` at the next-shallower one (null on the head tile until it steps
  // off). It is maintained exactly on every tile step, so reversing and splitting a consist
  // can re-derive the head's discrete movement state without guessing from float samples.
  function halfLen(d){ return d == null ? 0 : Math.hypot(DIRS[d].dx, DIRS[d].dy) / 2; }
  function pathEntryLen(entry, isHead){
    return (isHead ? 0 : halfLen(entry.exit)) + halfLen(entry.enter);
  }
  function trimPath(train){
    if (!train.path) return;
    const keep = trainTotalLength(train) + 1.6;
    let acc = 0;
    for (let i=0; i<train.path.length; i++){
      acc += pathEntryLen(train.path[i], i === 0);
      if (acc > keep){ train.path.length = i+1; return; }
    }
  }
  // Straight back-fill (mirror of seedTrail) for spawned trains; the virtual rear tiles need
  // not exist as track — they are geometry only, exactly like the seeded trail.
  function seedPathStraight(train, dir){
    const back = opposite(dir);
    const n = Math.ceil(trainTotalLength(train)) + 2;
    const path = [{x: train.x, y: train.y, enter: train.from, exit: null}];
    let cx = train.prevX != null ? train.prevX : train.x + DIRS[back].dx;
    let cy = train.prevY != null ? train.prevY : train.y + DIRS[back].dy;
    for (let i=0; i<n; i++){
      path.push({x: cx, y: cy, enter: back, exit: dir});
      cx += DIRS[back].dx; cy += DIRS[back].dy;
    }
    train.path = path;
  }
  // Legacy trains (old saves) have no path: derive one from the sampled trail. Diagonal moves
  // brush tile corners, so a tile the trail spends ~no length in between two diagonal
  // neighbours is a sampling artifact and is collapsed away.
  function derivePathFromTrail(train){
    const trail = train.trail;
    if (!trail || trail.length < 2) return null;
    const seq = [];
    let last = null, arcIn = 0;
    const push = (tx,ty,arc) => {
      if (last && last.x === tx && last.y === ty) return;
      if (last) last.cover = arc - arcIn;
      arcIn = arc;
      last = {x:tx, y:ty, cover:0};
      seq.push(last);
    };
    let acc = 0;
    for (let i=0; i<trail.length; i++){
      if (i > 0) acc += Math.hypot(trail[i].x-trail[i-1].x, trail[i].y-trail[i-1].y);
      push(Math.floor(trail[i].x), Math.floor(trail[i].y), acc);
    }
    if (last) last.cover = acc - arcIn;
    // collapse corner artifacts
    for (let i=1; i<seq.length-1; i++){
      const a = seq[i-1], b = seq[i], c = seq[i+1];
      const dx = c.x-a.x, dy = c.y-a.y;
      if (b.cover < 0.05 && Math.abs(dx) === 1 && Math.abs(dy) === 1) seq.splice(i--, 1);
    }
    const dirIndex = (dx,dy) => DIRS.findIndex(d => d.dx === dx && d.dy === dy);
    const path = [];
    for (let i=0; i<seq.length; i++){
      const enter = i < seq.length-1 ? dirIndex(seq[i+1].x-seq[i].x, seq[i+1].y-seq[i].y) : null;
      const exit = i > 0 ? dirIndex(seq[i-1].x-seq[i].x, seq[i-1].y-seq[i].y) : null;
      if ((i < seq.length-1 && enter < 0) || (i > 0 && exit < 0)) return null; // non-adjacent: give up
      path.push({x: seq[i].x, y: seq[i].y, enter, exit});
    }
    return path.length ? path : null;
  }
  function ensurePath(train){
    if (train.path && train.path.length && train.path[0].x === train.x && train.path[0].y === train.y) return train.path;
    train.path = derivePathFromTrail(train) || [{x: train.x, y: train.y, enter: train.from != null ? train.from : null, exit: null}];
    return train.path;
  }
  // The exact corner polyline of a train's body, rear-ward from the head, with the arc
  // distance of every tile centre and tile boundary along it. Arcs grow toward the tail;
  // when the head is mid-transition the first centre/edge behind it can be "virtual"
  // (negative arc — ahead of the head) so the placement maths stays uniform.
  function bodyGeometry(train){
    const path = ensurePath(train);
    const h = headWorld(train);
    const pts = [h];
    const centers = {}, edges = {};
    let arc = 0, k;
    const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
    if (trainMoving(train) && path.length > 1){
      const e = endpointW(train.prevX, train.prevY, train.moveDir); // edge between path[0] and path[1]
      const c1 = centerW(path[1].x, path[1].y);
      if (train.progress >= 0.5){
        centers[0] = -dist(h, centerW(path[0].x, path[0].y));      // virtual: ahead of the head
        arc += dist(h, e); edges[0] = arc; pts.push(e);
        arc += dist(e, c1); centers[1] = arc; pts.push(c1);
      } else {
        edges[0] = -dist(h, e);                                     // virtual: ahead of the head
        arc += dist(h, c1); centers[1] = arc; pts.push(c1);
      }
      k = 1;
    } else {
      centers[0] = 0;
      k = 0;
    }
    const need = trainTotalLength(train) + 0.6;
    for (; k < path.length-1 && arc < need; k++){
      if (path[k].enter == null) break;
      const e = endpointW(path[k].x, path[k].y, path[k].enter);
      arc += dist(pts[pts.length-1], e); edges[k] = arc; pts.push(e);
      const c = centerW(path[k+1].x, path[k+1].y);
      arc += dist(e, c); centers[k+1] = arc; pts.push(c);
    }
    return {pts, centers, edges, covered: arc, path};
  }
  const ARC_EPS = 0.02;
  // Where along a body an arc distance D falls: at a tile centre, or inside the transition
  // between two consecutive path tiles (with the interpolation phase for train.progress).
  function locateArc(geom, D){
    const {centers, edges, path} = geom;
    for (let k=0; k<path.length; k++){
      if (centers[k] != null && Math.abs(D - centers[k]) <= ARC_EPS) return {atCenter: true, k};
      if (centers[k] != null && centers[k+1] != null && D > centers[k] && D < centers[k+1]){
        // inside the transition path[k] <-> path[k+1]; edges[k] splits the two phases
        return {atCenter: false, k, edgeArc: edges[k], c0: centers[k], c1: centers[k+1]};
      }
    }
    return null;
  }
  // Rebuild a train's discrete head state so its REVERSED front sits at arc D of the old
  // body (D = the old body length). Also reverses units, path and trail. Internal: the
  // caller has already validated that the train is stopped and the geometry covers D.
  function applyReversal(train, geom, D){
    const path = geom.path;
    const loc = locateArc(geom, D);
    if (!loc) return {ok:false, error:"the train's body geometry is incomplete — move it a little first"};
    const L = D;
    const wasShallow = (trainMoving(train) && train.progress < 0.5) ? 1 : 0; // old path[0] never entered
    const newTrail = trailSpan(geom.pts, 0, L).reverse();
    const flip = j => ({x: path[j].x, y: path[j].y, enter: path[j].exit, exit: path[j].enter});
    const newPath = [];
    let head;
    if (loc.atCenter){
      const m = loc.k;
      if (path[m].exit == null) return {ok:false, error:"cannot reverse a zero-length body"};
      head = {x: path[m].x, y: path[m].y, from: path[m].exit, moving: null};
      for (let j=m; j>=wasShallow; j--) newPath.push(flip(j));
    } else {
      const k = loc.k;                     // reversed head moves from path[k] INTO path[k+1]
      if (!path[k+1]) return {ok:false, error:"the train's body geometry is incomplete — move it a little first"};
      const moveDir = path[k].enter;
      const progress = (L <= loc.edgeArc)
        ? 0.5 * (L - loc.c0) / Math.max(1e-9, loc.edgeArc - loc.c0)
        : 0.5 + 0.5 * (L - loc.edgeArc) / Math.max(1e-9, loc.c1 - loc.edgeArc);
      head = {x: path[k+1].x, y: path[k+1].y, from: opposite(moveDir),
              moving: {prevX: path[k].x, prevY: path[k].y, moveDir, progress: Math.max(0.001, Math.min(0.999, progress))}};
      for (let j=k+1; j>=wasShallow; j--) newPath.push(flip(j));
      // The new front sits just past the tile it is leaving. If that tile is a signal
      // governing this direction, the reversed front is PASSING it right now — moveTrain's
      // step-off bookkeeping never runs for it, so do it here: refuse to reverse past a red
      // manual main, and drop + arm a green one exactly as a normal pass would.
      const leaveTile = getTile(path[k].x, path[k].y);
      if (leaveTile && leaveTile.kind === "signal" && manualDirs(leaveTile).includes(moveDir)){
        const mk = mkMain(path[k].x, path[k].y, moveDir);
        if (!state.manualGreen.has(mk))
          return {ok:false, error:`reversing would carry the front past the red signal at ${placeLabel(path[k].x, path[k].y)} — clear it first`};
        head.dropGreen = mk;
      }
    }
    newPath[0].exit = null;
    trainUnits(train).reverse();
    train.x = head.x; train.y = head.y; train.from = head.from;
    if (head.moving){ train.prevX = head.moving.prevX; train.prevY = head.moving.prevY; train.moveDir = head.moving.moveDir; train.progress = head.moving.progress; }
    else { delete train.prevX; delete train.prevY; delete train.moveDir; delete train.progress; }
    if (head.dropGreen){                    // passed a cleared manual main while reversing
      state.manualGreen.delete(head.dropGreen);
      const rl = state.routeLocks.find(r => r.mk === head.dropGreen && !r.armed);
      if (rl){ rl.armed = true; rl.trainId = train.id; }
    }
    train.path = newPath;
    train.trail = newTrail;
    train.speed = 0; train.wait = 0;
    delete train.stopKey; train.reactedMain = null; train.wantSince = null; delete train._touch;
    train._tiles = computeBodyTiles(train);
    return {ok:true};
  }
  // Discrete head state for a NEW rear portion whose front sits at arc D of the original
  // body (same orientation as the original — it faces the way the original was going).
  function forwardHeadAt(geom, D){
    const path = geom.path;
    const loc = locateArc(geom, D);
    if (!loc) return null;
    const copy = j => ({x: path[j].x, y: path[j].y, enter: path[j].enter, exit: path[j].exit});
    if (loc.atCenter){
      const m = loc.k;
      const newPath = path.slice(m).map((e,i) => i === 0 ? {...copy(m), exit: null} : copy(m+i));
      return {x: path[m].x, y: path[m].y, from: path[m].enter, moving: null, path: newPath};
    }
    const k = loc.k;                        // front mid-transition from path[k+1] INTO path[k]
    if (!path[k+1]) return null;
    const moveDir = path[k+1].exit;
    const progress = (D >= loc.edgeArc)
      ? 0.5 * (loc.c1 - D) / Math.max(1e-9, loc.c1 - loc.edgeArc)
      : 0.5 + 0.5 * (loc.edgeArc - D) / Math.max(1e-9, loc.edgeArc - loc.c0);
    const newPath = path.slice(k).map((e,i) => i === 0 ? {...copy(k), exit: null} : copy(k+i));
    return {x: path[k].x, y: path[k].y, from: path[k].enter,
            moving: {prevX: path[k+1].x, prevY: path[k+1].y, moveDir, progress: Math.max(0.001, Math.min(0.999, progress))},
            path: newPath};
  }
  // ---- Shunt-mode touch scan -----------------------------------------------------------
  // The polyline a train's head is about to travel, following live switch settings, up to
  // maxArc tiles ahead. Traced through signals (braking for them is handled elsewhere).
  function forwardScanLine(train, maxArc){
    const pts = [headWorld(train)];
    let arc = 0;
    const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
    const pushPt = p => { arc += dist(pts[pts.length-1], p); pts.push(p); };
    let cx = train.x, cy = train.y, from = train.from;
    if (trainMoving(train)){
      if (train.progress < 0.5) pushPt(endpointW(train.prevX, train.prevY, train.moveDir));
      pushPt(centerW(cx, cy));
    }
    while (arc < maxArc){
      const tile = getTile(cx, cy);
      if (!tile) break;
      const ex = exitFor(tile, from);
      if (ex == null) break;
      const nx = cx + DIRS[ex].dx, ny = cy + DIRS[ex].dy;
      const nt = getTile(nx, ny);
      if (!nt || !tileAccepts(nt, opposite(ex)) || !switchAccepts(nt, opposite(ex))) break;
      pushPt(endpointW(cx, cy, ex));
      pushPt(centerW(nx, ny));
      cx = nx; cy = ny; from = opposite(ex);
    }
    return pts;
  }
  function pointSegDist(p, a, b){
    const vx = b.x-a.x, vy = b.y-a.y;
    const len2 = vx*vx + vy*vy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x-a.x)*vx + (p.y-a.y)*vy) / len2)) : 0;
    return Math.hypot(p.x - (a.x + vx*t), p.y - (a.y + vy*t));
  }
  // Arc distance from this train's head to the first point of another train's body along the
  // forward line, or Infinity. This is what lets a shunting consist creep up and TOUCH.
  function obstacleDistance(train){
    const line = forwardScanLine(train, TOUCH_SCAN_TILES);
    if (line.length < 2) return Infinity;
    const bodies = [];
    for (const t of state.trains){
      if (t.id === train.id) continue;
      const poly = (t.trail && t.trail.length) ? trailSpan(t.trail, 0, trainTotalLength(t)) : [headWorld(t)];
      bodies.push(poly);
    }
    if (!bodies.length) return Infinity;
    let arc = 0;
    for (let i=0; i<line.length-1; i++){
      const a = line[i], b = line[i+1];
      const seg = Math.hypot(b.x-a.x, b.y-a.y);
      const steps = Math.max(1, Math.ceil(seg / 0.04));
      for (let s=0; s<=steps; s++){
        const p = lerpW(a, b, s/steps);
        for (const poly of bodies){
          if (poly.length === 1){ if (Math.hypot(p.x-poly[0].x, p.y-poly[0].y) < TOUCH_NEAR) return arc + seg*(s/steps); continue; }
          for (let j=0; j<poly.length-1; j++){
            if (pointSegDist(p, poly[j], poly[j+1]) < TOUCH_NEAR) return arc + seg*(s/steps);
          }
        }
      }
      arc += seg;
    }
    return Infinity;
  }
  function trainMoving(train){
    return train.progress != null && train.progress < 1 && train.prevX != null && train.prevY != null;
  }
  function exitFor(tile, from){
    if (!tile) return null;
    if (tile.kind === "switch"){
      if (from === tile.stem) return switchCurrent(tile);          // stem → the set branch
      if (tile.branches.includes(from)) return from === switchCurrent(tile) ? tile.stem : null; // only the set branch connects
      return null;
    }
    for (const route of routesFor(tile)){
      if (!route.includes(from)) continue;
      if (route.length < 2) return null;
      return route[0] === from ? route[1] : route[0];
    }
    return null;
  }

  function exitsForBlock(tile, from){
    if (!tile) return [];
    if (tile.kind === "switch"){
      const dirs = [tile.stem, ...tile.branches];
      if (!dirs.includes(from)) return [];
      return dirs.filter(d => d !== from);
    }
    const exits = [];
    for (const route of routesFor(tile)){
      if (!route.includes(from) || route.length < 2) continue;
      for (const d of route){
        if (d !== from && !exits.includes(d)) exits.push(d);
      }
    }
    return exits;
  }

  function collectProtectedBlock(x,y,dir,ignoreId){
    const nx = x + DIRS[dir].dx;
    const ny = y + DIRS[dir].dy;
    return scanProtectedBlock(nx, ny, opposite(dir), ignoreId);
  }

  function scanProtectedBlock(x,y,from,ignoreId){
    const seen = new Set();
    const tiles = new Set();
    const todo = [{x,y,from}];
    let blocked = false;
    while (todo.length){
      const n = todo.pop();
      const id = `${n.x},${n.y},${n.from}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const tile = getTile(n.x,n.y);
      if (!tile) continue;
      // A signal bounds the block: it is a wall, not part of the protected run of
      // track, so it is never flooded through *and* never counts as occupancy. If a
      // boundary signal tile counted, two trains each waiting on the other's signal
      // would each see the other inside their block and deadlock forever.
      if (tile.kind === "signal") continue;
      tiles.add(key(n.x,n.y));
      if (state.trains.some(t => t.id !== ignoreId && trainOccupies(t,n.x,n.y))) blocked = true;
      for (const ex of exitsForBlock(tile,n.from)){
        todo.push({x:n.x + DIRS[ex].dx, y:n.y + DIRS[ex].dy, from:opposite(ex)});
      }
    }
    return {blocked, tiles};
  }

  // ---- Blocks & block reservation ---------------------------------------------------
  // Only AUTOMATIC mains define blocks. Each automatic main guards a block (the run of
  // track up to the next signal) with at most one holder, and carries an INVISIBLE distant
  // on the tile immediately before it (point 2): a train approaching commits to the block as
  // it steps onto the main from that tile and, if the block was free, rolls straight through;
  // if the block is taken it brakes to a stop at the main and waits for green. MANUAL mains
  // have NO block and no occupancy state — they are pure operator-cleared route gates (see
  // followManualRoute / toggleManualSignal), and trains run on sight between them.
  // buildSignalSystem() recomputes the static topology each tick.
  function regionIdFor(x,y,dir){
    const tiles = scanProtectedBlock(x + DIRS[dir].dx, y + DIRS[dir].dy, opposite(dir), null).tiles;
    return {id: [...tiles].sort().join("|"), tiles};
  }
  function buildSignalSystem(){
    const blockOfMain = new Map();    // AUTOMATIC mainKey "x,y,dir" -> blockId
    const tileOfMain = new Map();     // AUTOMATIC mainKey -> the signal tile key "x,y"
    const blockTiles = new Map();     // blockId -> Set of tile keys
    const mainsOfBlock = new Map();   // blockId -> [automatic mainKey]
    const distantCommit = new Map();  // before-tile "bx,by,dir" -> {blockId, mainKey, mainTile, approach:Set}
    const errorMains = new Set();
    for (const [k,tile] of state.tiles){
      if (tile.kind !== "signal") continue;
      const {x,y} = readKey(k);
      for (const dir of signalDirs(tile)){
        if (manualDirs(tile).includes(dir)) continue; // automatic mains only define blocks
        const mk = mkMain(x,y,dir);
        const {id, tiles} = regionIdFor(x,y,dir);
        blockOfMain.set(mk, id);
        tileOfMain.set(mk, k);
        if (!blockTiles.has(id)) blockTiles.set(id, tiles);
        if (!mainsOfBlock.has(id)) mainsOfBlock.set(id, []);
        mainsOfBlock.get(id).push(mk);
        const bx = x - DIRS[dir].dx, by = y - DIRS[dir].dy;
        distantCommit.set(mkMain(bx,by,dir), {blockId: id, mainKey: mk, mainTile: k, approach: new Set([key(bx,by), k])});
      }
    }
    // Point 8: an automatic block fed by a MANUAL entry can be entered on sight (no grant),
    // so its automatic mains can't keep it exclusive → they go into the blinking-red error.
    for (const [k,tile] of state.tiles){
      if (tile.kind !== "signal") continue;
      const {x,y} = readKey(k);
      for (const dir of signalDirs(tile)){
        if (!manualDirs(tile).includes(dir)) continue; // manual entries
        const {id} = regionIdFor(x,y,dir);
        for (const mk of (mainsOfBlock.get(id) || [])) errorMains.add(mk);
      }
    }
    // Idea 1: an automatic main must not lead out of a protected block into open track — it
    // requires an opposing-direction main (auto OR manual) on the SAME tile (the other end of
    // its route), making a complete block boundary. Without it, it blinks red and is impassable.
    for (const [k,tile] of state.tiles){
      if (tile.kind !== "signal") continue;
      const {x,y} = readKey(k);
      for (const dir of signalDirs(tile)){
        if (manualDirs(tile).includes(dir)) continue;
        if (!signalDirs(tile).includes(opposite(dir))) errorMains.add(mkMain(x,y,dir));
      }
    }
    return {blockOfMain, tileOfMain, blockTiles, mainsOfBlock, distantCommit, errorMains, holder:new Map()};
  }

  // Only AUTOMATIC, non-errored mains use the block-grant system. Manual mains never get a
  // hold — a train passes them purely on the operator's cleared green (checked in moveTrain).
  function mainEligible(mk, sys){
    if (mainIsManualKey(mk)) return false;
    return !sys.errorMains.has(mk);
  }

  // The block+main a train is reserving.
  function approachInfo(train, sys){
    // The invisible distant commits the block as the train moves OFF the tile before the main.
    if (trainMoving(train) && train.prevX != null){
      const dc = sys.distantCommit.get(mkMain(train.prevX, train.prevY, train.moveDir));
      if (dc) return {blockId: dc.blockId, mainKey: dc.mainKey, mainTile: dc.mainTile, approach: dc.approach, rollThrough: true};
    }
    const tile = getTile(train.x, train.y);
    if (!tile) return null;
    const ex = exitFor(tile, train.from);
    if (ex == null) return null;
    if (tile.kind === "signal"){
      const mk = mkMain(train.x, train.y, ex);
      if (sys.blockOfMain.has(mk)) return {blockId: sys.blockOfMain.get(mk), mainKey: mk, mainTile: sys.tileOfMain.get(mk), rollThrough: false};
    }
    return null;
  }

  function nextWantSeq(){ state.wantSeq = (state.wantSeq || 0) + 1; return state.wantSeq; }
  function trainHolds(train, blockId){ return train.holds && train.holds.some(h => h.blockId === blockId); }
  // Physical occupancy of a block's tiles (a safety net for trains that are inside a block
  // without holding it, e.g. spawned in or placed by an edit).
  function blockOccupiedByOther(blockId, sys, ignoreId){
    const tiles = sys.blockTiles.get(blockId);
    if (!tiles) return false;
    for (const t of state.trains){
      if (t.id === ignoreId) continue;
      const bt = t._tiles || computeBodyTiles(t);
      for (const tk of bt) if (tiles.has(tk)) return true;
    }
    return false;
  }
  function inBlockRegion(train, h, sys){
    const here = key(train.x, train.y);
    const tiles = sys.blockTiles.get(h.blockId);
    if (tiles && tiles.has(here)) return true;
    if (here === h.entryMainTile) return true;
    if (h.approach && h.approach.has(here)) return true; // tiles from the distant up to the main
    return false;
  }

  // Recomputes blocks and re-derives occupancy from live train bodies every call (and it is
  // called on every tile edit). Because occupancy is recounted from real positions rather
  // than a stored counter, changing the signalling never leaves "virtual" trains in a block.
  function updateSignals(){
    const sys = buildSignalSystem();
    for (const t of state.trains) t._tiles = computeBodyTiles(t);
    maintainManualState(sys);
    // release holds once the train has left the block's protected tiles and entry approach
    for (const t of state.trains){
      if (!t.holds) t.holds = [];
      t.holds = t.holds.filter(h => sys.blockTiles.has(h.blockId) && inBlockRegion(t, h, sys));
    }
    for (const t of state.trains) for (const h of t.holds) sys.holder.set(h.blockId, t.id);
    // gather contenders, then grant each free block to its longest-waiting contender
    const contenders = new Map();
    for (const t of state.trains){
      if (!hasActiveEngine(t)){ t.wantSince = null; t._ap = null; continue; } // parked cars want nothing
      const ap = approachInfo(t, sys);
      t._ap = ap;
      if (!ap || trainHolds(t, ap.blockId)){ t.wantSince = null; continue; }
      if (!mainEligible(ap.mainKey, sys)){ t.wantSince = null; continue; } // red manual / errored automatic
      if (!contenders.has(ap.blockId)) contenders.set(ap.blockId, []);
      contenders.get(ap.blockId).push({train:t, ap});
    }
    for (const [blockId, list] of contenders){
      for (const c of list) if (c.train.wantSince == null) c.train.wantSince = nextWantSeq();
      if (sys.holder.has(blockId)) continue; // reserved: everyone keeps waiting
      list.sort((a,b) => (a.train.wantSince - b.train.wantSince) || (a.train.id - b.train.id));
      const win = list[0];
      if (blockOccupiedByOther(blockId, sys, win.train.id)) continue; // physically obstructed
      win.train.holds.push({blockId, entryMainKey: win.ap.mainKey, entryMainTile: win.ap.mainTile, approach: win.ap.approach, rollThrough: win.ap.rollThrough});
      win.train.wantSince = null;
      sys.holder.set(blockId, win.train.id);
    }
    state.sys = sys;
  }

  function holdForMain(train, mainKey){ return train.holds && train.holds.find(h => h.entryMainKey === mainKey); }
  // A main is "green" for a train that holds its block via that main.
  function mainIsGreenFor(train, mainKey){ return !!holdForMain(train, mainKey); }
  // A block is free when no train holds it and none is physically inside it.
  function blockFree(id, sys){
    return !sys.holder.has(id) && !blockOccupiedByOther(id, sys, null);
  }
  // Whether a main shows green. AUTOMATIC mains are default-green: green whenever the block
  // ahead is clear (and for the train holding it while still approaching), red when taken,
  // never green while in the error state. MANUAL mains are default-red: green only while the
  // operator has them cleared.
  function mainRenderGreen(mainKey, sys, manual){
    if (manual) return state.manualGreen.has(mainKey);
    if (sys.errorMains.has(mainKey)) return false;
    const id = sys.blockOfMain.get(mainKey);
    if (blockFree(id, sys)) return true;
    const tiles = sys.blockTiles.get(id);
    for (const t of state.trains){
      if (!t.holds) continue;
      for (const h of t.holds){
        if (h.blockId === id && h.entryMainKey === mainKey && tiles && !tiles.has(key(t.x,t.y))) return true;
      }
    }
    return false;
  }
  // A manual main that is green because of a SHUNT clear (route may run into occupied track /
  // end at a buffer). Renderers show it differently: red triangle, green ring.
  function mainShuntCleared(mk){
    return state.manualGreen.has(mk) && state.routeLocks.some(r => r.mk === mk && r.shunt && !r.armed);
  }
  // True if this train may pass main `mk` without stopping (it reserved the block early at the
  // invisible distant). A train that had to stop at a red main reacts briefly before pulling away.
  function mayRollThrough(train, mk){
    const h = holdForMain(train, mk);
    return !!(h && h.rollThrough);
  }

  function occupied(x,y,ignoreId){
    return state.trains.some(t => t.id !== ignoreId && trainOccupies(t,x,y));
  }

  // ---- Manual signals & route locks -------------------------------------------------
  // Prune cleared greens / spent route locks and recompute which switches are locked. Called
  // from updateSignals each tick (and on every edit), after train body tiles are computed.
  // Each path tile (and the switches among them) is released the instant the cleared train's
  // LAST AXLE leaves it — tracked per tile, so the green outline and switch locks both shrink
  // behind the train and the route lock ends once the train has fully cleared the path.
  function maintainManualState(sys){
    for (const mk of [...state.manualGreen])
      if (!mainIsManualKey(mk)) state.manualGreen.delete(mk);
    state.routeLocks = state.routeLocks.filter(rl => {
      if (!mainIsManualKey(rl.mk)) return false;               // the manual signal is gone/changed
      if (!rl.armed) return state.manualGreen.has(rl.mk);      // awaiting a train: hold while still cleared
      const tr = state.trains.find(t => t.id === rl.trainId);
      if (!tr) return false;                                   // the cleared train vanished → release
      if ((tr.speed || 0) > 0) rl.moved = true;
      if (rl.shunt && rl.moved && trainStopped(tr)) return false; // shunt move came to a stand → release
      const bt = tr._tiles || computeBodyTiles(tr);
      for (const s of rl.path){
        if (rl.passedTile.has(s.k)) continue;
        if (bt.has(s.k)) rl.enteredTile.add(s.k);              // body is on this path tile
        else if (rl.enteredTile.has(s.k)) rl.passedTile.add(s.k); // last axle just left it
      }
      return !rl.path.every(s => rl.passedTile.has(s.k));      // done once the whole path is behind the train
    });
    state.lockedSwitchKeys = new Set();
    for (const rl of state.routeLocks)
      for (const sk of rl.switchKeys)
        if (!rl.passedTile.has(sk)) state.lockedSwitchKeys.add(sk);
  }
  // Trace the route a cleared manual signal opens: follow the live track (current switch
  // settings) from the signal to the next signal facing the way we travel — or a BUFFER (a
  // route into a stub is a legitimate terminus) — checking that (2a) it crosses no
  // already-locked switch and (2c) no axle sits anywhere on the path up to and including that
  // signal. A SHUNT clear (opts.shunt) skips the occupancy check: it opens a route INTO
  // occupied track so an engine can drive up to and couple with the cars standing there.
  // On success returns the switch tiles it crosses plus the per-tile path segments (the manual
  // signal tile and every tile up to, but not including, the terminus signal); otherwise a
  // reason and the obstacle tile.
  function followManualRoute(sx,sy,dir,opts){
    opts = opts || {};
    const switchKeys = [];
    const path = [];
    const st = getTile(sx,sy);
    if (st && st.route) path.push({k: key(sx,sy), seg: st.route.slice()}); // the signal tile itself
    let cx = sx, cy = sy, d = dir;
    for (let i=0; i<256; i++){
      const nx = cx + DIRS[d].dx, ny = cy + DIRS[d].dy;
      const nt = getTile(nx,ny);
      const from = opposite(d);
      const here = key(nx,ny);
      if (!nt || !tileAccepts(nt, from) || !switchAccepts(nt, from)) return {ok:false, reason:"the path is broken", obstacle:here};
      if (!opts.shunt && occupied(nx,ny,null)) return {ok:false, reason:"the path is occupied", obstacle:here}; // 2c (incl. the terminus signal)
      if (nt.kind === "signal"){
        // 2b: the route is only complete at a main facing the WAY WE ARE GOING — one that will
        // actually stop/hand off the train. A signal facing the other way is transparent to it.
        const sx2 = exitFor(nt, from);
        if (sx2 != null && signalDirs(nt).includes(sx2)) return {ok:true, switchKeys, path};
        return {ok:false, reason:"the path runs into a signal facing the other way", obstacle:here};
      }
      if (nt.kind === "switch"){
        if (switchLocked(nx,ny)) return {ok:false, reason:"the path crosses a switch locked by another route", obstacle:here}; // 2a
        switchKeys.push(here);
      }
      const ex = exitFor(nt, from);
      if (ex == null){
        if (nt.route && nt.route.length === 1){ path.push({k: here, seg: [from]}); return {ok:true, switchKeys, path, buffer:true}; } // stub: ends at a buffer
        return {ok:false, reason: nt.kind === "switch" ? "the path runs into a switch set against it" : "the path reaches a dead end before any signal", obstacle:here};
      }
      path.push({k: here, seg: [from, ex]});
      cx = nx; cy = ny; d = ex;
    }
    return {ok:false, reason:"the path is too long"};
  }
  // Operator clears (or cancels) a manual main. Clearing needs a clear route to a forward
  // signal (followManualRoute); it then locks every switch on that route. The main drops back
  // to red the moment a train passes it, and each switch unlocks as the train's last axle
  // clears it. While a main is green and no train has taken it yet, clicking it cancels (a
  // train that has already taken the route holds it red, so a re-clear is blocked by occupancy).
  // Clears (or cancels) a manual main. DOM-free: returns {ok, action, reason?, flash?} so the
  // caller (client UI or server) can flash/redraw/report; never touches the DOM itself.
  function toggleManualSignal(x,y,dir,opts){
    opts = opts || {};
    const tile = getTile(x,y);
    if (!tile || tile.kind !== "signal" || !manualDirs(tile).includes(dir)) return {ok:false, action:"none", error:"no manual main in that direction"};
    const mk = mkMain(x,y,dir);
    if (state.manualGreen.has(mk)){
      state.manualGreen.delete(mk);
      state.routeLocks = state.routeLocks.filter(r => r.mk !== mk);
      state.message = `Signal ${placeLabel(x,y)} set back to red`;
      updateSignals();
      return {ok:true, action:"red"};
    }
    const route = followManualRoute(x,y,dir,opts);
    if (!route.ok){
      state.message = `Cannot clear ${placeLabel(x,y)}: ${route.reason}`;
      return {ok:false, action:"refused", reason:route.reason, flash:[key(x,y), route.obstacle]};
    }
    state.flash = null;
    state.manualGreen.add(mk);
    // A shunt-cleared route lock is released as soon as the shunting move comes to a stand
    // (see maintainManualState) — its job is only to protect the movement itself.
    state.routeLocks.push({mk, switchKeys: route.switchKeys, path: route.path, trainId:null, armed:false, shunt: !!opts.shunt, moved:false, enteredTile:new Set(), passedTile:new Set()});
    state.message = `Cleared ${placeLabel(x,y)}${opts.shunt ? " for shunting" : ""}`;
    updateSignals();
    return {ok:true, action:"green", shunt: !!opts.shunt};
  }

  function trainOccupies(train,x,y){
    if (train._tiles) return train._tiles.has(key(x,y));
    return (train.x === x && train.y === y) || (trainMoving(train) && train.prevX === x && train.prevY === y);
  }

  function isShunting(train){ return train.mode === "shunt"; }
  // True if a train arriving at (x,y) via `from` can immediately continue onward; its
  // negation is what tells a moving train to brake to a stop on the tile it is entering.
  function canLeave(train, x, y, from){
    const tile = getTile(x,y);
    if (!tile) return false;
    const ex = exitFor(tile, from);
    if (ex == null) return false;
    if (tile.kind === "stop" && ex === tile.dir && !isShunting(train)){ // shunting moves skip passenger dwell
      if (train.stopKey !== key(x,y)) return false;          // hasn't docked yet
      if (state.simFrame < train.releaseFrame) return false; // still dwelling
    }
    // A shunting DISC (bidirectional marker on plain track) set to "stop" holds SHUNTING
    // moves only — every other train ignores it completely.
    if (isShunting(train) && tile.shuntSignal && tile.shuntStop) return false;
    if (tile.kind === "signal" && signalDirs(tile).includes(ex)){
      const mk = mkMain(x,y,ex);
      if (mainIsManual(x,y,ex)){
        if (!state.manualGreen.has(mk)) return false;          // red manual main: hold
      } else {
        // automatic main: needs the block, reserved early at the invisible distant (roll
        // through) or reacted to while stopped here.
        if (!mainIsGreenFor(train, mk)) return false;
        if (!mayRollThrough(train, mk) && train.reactedMain !== mk) return false;
      }
    }
    const nx = x + DIRS[ex].dx, ny = y + DIRS[ex].dy;
    const nt = getTile(nx,ny);
    if (!nt || !tileAccepts(nt, opposite(ex)) || !switchAccepts(nt, opposite(ex))) return false;
    // Shunting never leaves the station: the boundary halts a shunting consist exactly like
    // a signal at danger (it stays in shunting mode and can be reversed back). Entering a
    // station from outside is fine — only the way OUT is barred.
    if (isShunting(train) && !stationContaining(nx,ny)) return false;
    // Driving on sight: never roll onto an occupied tile, brake to a stop one tile short.
    // A SHUNTING consist is allowed closer — the touch clamp (advanceWithSpeed) stops it
    // the moment its buffers meet the other body instead.
    if (!isShunting(train) && occupied(nx,ny,train.id)) return false;
    return true;
  }

  // Advance a moving train by its current speed, easing toward MAX_SPEED or braking along
  // a sqrt curve so it coasts to a stop exactly on the tile it cannot continue past.
  // Shunting consists run slower and additionally clamp to the touch distance of the next
  // body ahead, so they come to rest buffers-to-buffers (possibly mid-tile).
  function advanceWithSpeed(train){
    if (!trainMoving(train)) return false;
    // state.speedScale (UI-adjustable, default 1) slows the whole fleet so an operator/AI has more
    // real time to act. It scales top speed + acceleration; DECEL is left so braking stays safe.
    const ss = state.speedScale || 1;
    const shunt = isShunting(train);
    const maxV = MAX_SPEED * ss * (shunt ? SHUNT_SPEED_FACTOR : 1), accV = ACCEL * ss, minV = MIN_SPEED * ss;
    const d = DIRS[train.moveDir];
    const seg = Math.hypot(d.dx,d.dy) || 1;
    const halt = !canLeave(train, train.x, train.y, train.from);
    const remaining = (1 - train.progress) * seg;
    let target = maxV;
    if (halt) target = Math.min(target, Math.sqrt(2 * DECEL * Math.max(0, remaining)));
    let obstDist = Infinity;
    // Shunting always creeps under the touch clamp. Driving normally relies on the one-tile
    // standoff instead — but when the head SHARES its tile with another body (e.g. the mode
    // was switched off shunting while standing buffers-to-buffers), that standoff is already
    // gone: engage the clamp there too, so a train can never drive THROUGH stock.
    if (shunt || occupied(train.x, train.y, train.id)) obstDist = obstacleDistance(train);
    if (obstDist < Infinity) target = Math.min(target, Math.sqrt(2 * DECEL * Math.max(0, obstDist)));
    if (train.speed < target) train.speed = Math.min(target, train.speed + accV);
    else train.speed = target;
    let advance = train.speed;
    if (advance > obstDist){ advance = Math.max(0, obstDist); train.speed = 0; } // buffers met: hard stop
    if (halt && train.speed < minV && remaining < 0.5 && obstDist >= remaining){
      train.progress = 1; // crawling and almost there: dock on the tile centre
    } else {
      train.progress = Math.min(1, train.progress + advance / seg);
    }
    train._touch = train.speed === 0 && obstDist <= 0.1;
    // Coming to a stand buffers-to-buffers drops the consist into STOP mode: after a couple
    // (or an accidental nudge) it must not creep off on its own — the master reverses it or
    // picks a mode explicitly.
    if (train._touch) train.mode = "stop";
    if (train.progress >= 1){
      delete train.prevX; delete train.prevY; delete train.moveDir;
      if (halt) train.speed = 0;
    }
    return true;
  }

  // ---- Sim clock and notifications -------------------------------------------------
  // The sim advances one simFrame per simStep (60 = one sim-second).
  function formatClock(frame){
    const s = Math.max(0, Math.floor(frame / FRAMES_PER_SECOND));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;
  }
  // A human label for a cell: "<station> <element-name>" when known, else its coordinates.
  function placeLabel(x,y){
    const t = getTile(x,y);
    const st = stationContaining(x,y);
    const parts = [];
    if (st) parts.push(st.name);
    if (t && t.name) parts.push(t.name);
    return parts.length ? parts.join(" ") : `${x},${y}`;
  }
  function trainDesc(train){
    const t = trainTypeById(train.type);
    const nm = t && t.name ? t.name : `type ${train.type}`;
    return `Train ${train.id} (${nm})`;
  }
  // Called the first frame a train docks at a stop: records when it may leave (arrival + dwell).
  function registerStopArrival(train, tile){
    train.stopKey = key(train.x, train.y);
    train.releaseFrame = state.simFrame + Math.ceil(stopDwellSeconds(tile) * FRAMES_PER_SECOND);
  }
  // Called when a train pulls away from a named stop: a plain departure line (silent otherwise).
  function notifyDeparture(train, tile, x, y){
    if (tile.name) emit("info", `${trainDesc(train)} departed ${placeLabel(x,y)}`);
  }

  function stopDwellSeconds(tile){
    if (tile.dwellSeconds != null){
      const seconds = Number(tile.dwellSeconds);
      return Number.isFinite(seconds) ? Math.max(.25, Math.min(30, seconds)) : DEFAULT_DWELL_SECONDS;
    }
    if (tile.dwell != null){
      const seconds = Number(tile.dwell) / 40;
      return Number.isFinite(seconds) ? Math.max(.25, Math.min(30, seconds)) : DEFAULT_DWELL_SECONDS;
    }
    return DEFAULT_DWELL_SECONDS;
  }

  function moveTrain(train){
    if (train.speed == null) train.speed = 0;
    if (!hasActiveEngine(train)){ train.speed = 0; return; } // a cut of cars never moves by itself
    if (train.mode === "stop"){ train.speed = 0; return; }   // held on the handbrake, even mid-tile
    if (trainMoving(train)){ advanceWithSpeed(train); return; }
    if (train.wait > 0){ train.wait--; train.speed = 0; return; }
    const tile = getTile(train.x,train.y);
    const ex = exitFor(tile, train.from);
    if (ex == null){ train.speed = 0; return; }
    if (tile.kind === "stop" && ex === tile.dir && !isShunting(train)){
      const stopKey = key(train.x,train.y);
      if (train.stopKey !== stopKey){
        registerStopArrival(train, tile);
        train.speed = 0;
        return;
      }
      if (state.simFrame < train.releaseFrame){ train.speed = 0; return; }
    }
    if (isShunting(train) && tile.shuntSignal && tile.shuntStop){ train.speed = 0; return; } // held at a shunting disc
    if (tile.kind === "signal" && signalDirs(tile).includes(ex)){
      const mk = mkMain(train.x, train.y, ex);
      if (mainIsManual(train.x, train.y, ex)){
        if (!state.manualGreen.has(mk)){ train.speed = 0; return; } // red: wait for the operator
        // A train that was stopped here (speed 0) lingers a moment when the main clears, like an
        // automatic main turning green; a train that rolls up to an already-green one does not.
        if (train.speed === 0 && train.reactedMain !== mk){
          train.reactedMain = mk;
          train.wait = Math.ceil(SIGNAL_REACTION_SECONDS * FRAMES_PER_SECOND);
          return;
        }
        // otherwise roll straight through (drive on sight)
      } else {
        if (!mainIsGreenFor(train, mk)){ train.speed = 0; return; } // red: hold until the block clears
        if (!mayRollThrough(train, mk) && train.reactedMain !== mk){
          // had to stop at the main (block was taken on approach): pause to react before leaving
          train.reactedMain = mk;
          train.wait = Math.ceil(SIGNAL_REACTION_SECONDS * FRAMES_PER_SECOND);
          train.speed = 0; return;
        }
      }
    }
    const nx = train.x + DIRS[ex].dx;
    const ny = train.y + DIRS[ex].dy;
    const nf = opposite(ex);
    const nextTile = getTile(nx,ny);
    if (!nextTile || !tileAccepts(nextTile,nf) || !switchAccepts(nextTile,nf)){ train.speed = 0; return; }
    if (isShunting(train)){
      // the station boundary halts a shunting move (still in shunting mode, ready to reverse)
      if (!stationContaining(nx,ny)){ train.speed = 0; return; }
      // buffers already touching the next body: stay put (in stop mode) instead of committing a step
      if (obstacleDistance(train) <= TOUCH_NEAR + 0.02){ train.speed = 0; train._touch = true; train.mode = "stop"; return; }
    } else if (occupied(nx,ny,train.id)){ train.speed = 0; return; } // drive on sight: stop a tile short
    // Passing a cleared MANUAL main drops it back to red and arms its route lock to this train,
    // so the switches it set stay locked until this train has fully passed them.
    if (tile.kind === "signal" && signalDirs(tile).includes(ex) && state.manualGreen.has(mkMain(train.x,train.y,ex))){
      const mk = mkMain(train.x,train.y,ex);
      state.manualGreen.delete(mk);
      const rl = state.routeLocks.find(r => r.mk === mk && !r.armed);
      if (rl){ rl.armed = true; rl.trainId = train.id; }
    }
    if (train.stopKey === key(train.x, train.y) && tile.kind === "stop") notifyDeparture(train, tile, train.x, train.y);
    delete train.stopKey;
    train.reactedMain = null; // leaving this tile; the next main needs its own reaction
    delete train._touch;
    ensurePath(train);
    train.prevX = train.x;
    train.prevY = train.y;
    train.moveDir = ex;
    train.progress = 0;
    train.x = nx;
    train.y = ny;
    train.from = nf;
    train.path[0].exit = ex;
    train.path.unshift({x: nx, y: ny, enter: nf, exit: null});
    trimPath(train);
    advanceWithSpeed(train);
  }

  function spawnTrains(){
    const spent = [];
    for (const [k,tile] of state.tiles){
      if (tile.kind !== "spawn") continue;
      const {x,y} = readKey(k);
      const nx = x + DIRS[tile.dir].dx;
      const ny = y + DIRS[tile.dir].dy;
      const nf = opposite(tile.dir);
      const nextTile = getTile(nx,ny);
      if (!nextTile || !tileAccepts(nextTile,nf) || !switchAccepts(nextTile,nf) || occupied(x,y,null) || occupied(nx,ny,null)) continue;
      const train = {id:state.nextTrainId++, x:nx, y:ny, from:nf, type:tile.type, wait:0, prevX:x, prevY:y, moveDir:tile.dir, progress:0, speed:0, holds:[], wantSince:null, units:unitsFor(tile.type, tile.cars), mode:"drive"};
      seedTrail(train, tile.dir);
      seedPathStraight(train, tile.dir);
      train._tiles = computeBodyTiles(train);
      state.trains.push(train);
      spent.push({x, y, route:cloneRoute(tile.route)});
    }
    for (const tile of spent) setTile(tile.x,tile.y,{kind:"track",route:tile.route});
  }

  function simStep(){
    state.simFrame++;
    spawnTrains();
    updateSignals();
    for (const train of state.trains) moveTrain(train);
    for (const train of state.trains) updateTrail(train);
    // Re-evaluate holders/grants against the post-move positions before drawing. Without
    // this, a block that a train just vacated reads as momentarily free for one frame
    // (the waiting train is granted only next frame), flickering every main green.
    updateSignals();
    if (checkWatches) checkWatches();   // fire train-arrival / pass notifications (added below)
    if (updateHaltTimers) updateHaltTimers();   // track how long each train has been stopped
    state.frame = (state.frame + 1) % SPAWN_TICK_FRAMES;
    if (state.frame === 0) state.tick++;
  }
  function serialize(){
    return JSON.stringify({
      version: 3,
      trainTypes: state.trainTypes.map(t => ({id: t.id, color: t.color, name: t.name || ""})),
      stations: state.stations,
      tiles: [...state.tiles].map(([k,tile]) => ({...readKey(k), tile})),
      view: state.view
    }, null, 2);
  }
  // Bring a tile up to the manual-builder model. Imports of older / modern layouts are
  // simplified: distants become plain track, caution flags drop, stop filters & timetables
  // and switch type-filters are discarded, and every switch becomes a plain manual switch
  // set to its old default branch.
  function migrateTile(tile){
    delete tile.caution;
    if (tile.kind === "distant") return {kind: "track", route: tile.route};
    if (tile.kind === "spawn" && tile.type == null && tile.color != null){
      tile.type = LEGACY_COLOR_IDS[tile.color] || 1;
      delete tile.color;
    }
    if (tile.kind === "stop"){ delete tile.filter; delete tile.timetable; }
    if (tile.kind === "switch"){
      if (tile.current == null) tile.current = (tile.default != null ? tile.default : (tile.defaultBranch != null ? tile.defaultBranch : tile.branches[0]));
      delete tile.mode; delete tile.default; delete tile.filters; delete tile.defaultBranch;
    }
    // A shunting disc lives only on plain two-ended track (never on switches, buffers,
    // crossings, stops or signal tiles — a manual signal already halts shunting moves).
    if (tile.shuntSignal && !(tile.kind === "track" && Array.isArray(tile.route) && tile.route.length === 2)){
      delete tile.shuntSignal; delete tile.shuntStop;
    }
    if (!tile.shuntSignal) delete tile.shuntStop;
    return tile;
  }
  function deserialize(text){
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.tiles)) throw new Error("Missing tiles array");
    state.trainTypes = (Array.isArray(data.trainTypes) && data.trainTypes.length)
      ? data.trainTypes.map(t => ({id: t.id, color: t.color || UNKNOWN_TYPE_COLOR, name: t.name || ""}))
      : defaultTrainTypes();
    state.tiles = new Map();
    for (const item of data.tiles){
      if (!Number.isFinite(item.x) || !Number.isFinite(item.y) || !item.tile) continue;
      setTile(item.x,item.y, migrateTile(item.tile));
    }
    if (!trainTypeById(state.selectedType)) state.selectedType = state.trainTypes[0].id;
    state.stations = (Array.isArray(data.stations) ? data.stations : [])
      .filter(s => s && s.rect && Number.isFinite(s.rect.x0) && Number.isFinite(s.rect.y1))
      .map(s => { const r = normRect(s.rect); return {id: s.id, name: s.name || `Station ${s.id}`, instructions: s.instructions || "", overrides: Array.isArray(s.overrides) ? s.overrides.slice() : [], rect:{x0:r.x0,y0:r.y0,x1:r.x1,y1:r.y1}}; });
    state.nextStationId = state.stations.reduce((m,s) => Math.max(m, s.id || 0), 0) + 1;
    state.trains = [];
    state.nextTrainId = 1;
    state.nextUnitId = 0;
    state.tick = 0;
    state.frame = 0;
    state.simFrame = 0;
    state.manualGreen = new Set();
    state.routeLocks = [];
    state.lockedSwitchKeys = new Set();
    state.events = [];
    if (data.view) state.view = {...state.view, ...data.view};
    updateSignals();
  }


    // ================= Engine API additions (DOM-free) =================
    // These exist only in the extracted engine: an event buffer (replacing the old DOM notify),
    // operate-command wrappers shared by the browser UI and the server's REST API, a full live
    // snapshot for streaming/persistence, and station reports the Station Master API reads.
    state.events = state.events || [];
    let eventSeq = 0;
    function emit(level, text, meta){
      // Keep seq monotonic across a reload: a freshly-created engine restarts eventSeq at 0, but
      // applySnapshot/deserialize restore state.events with their original (higher) seqs. Without
      // this, new emits would reuse low seqs that collide with the restored ones, and clients that
      // dedupe by seq (drainEvents) would silently drop every new notification (chat, departures, …).
      for (const ev of state.events) if (ev.seq > eventSeq) eventSeq = ev.seq;
      const e = {seq: ++eventSeq, frame: state.simFrame, level, text};
      if (meta) Object.assign(e, meta);
      state.events.push(e);
      if (state.events.length > 300) state.events.shift();
    }

    function setPaused(p){ state.paused = !!p; return {ok:true, paused: state.paused}; }
    state.speedScale = state.speedScale || 1;
    function setSpeed(scale){ const s = Number(scale); state.speedScale = Number.isFinite(s) ? Math.max(0.05, Math.min(3, s)) : 1; return {ok:true, speedScale: state.speedScale}; }
    state.dayLength = state.dayLength || 600;
    function setDayLength(seconds){ const s = Number(seconds); state.dayLength = Number.isFinite(s) ? Math.max(10, Math.min(86400, Math.round(s))) : (state.dayLength || 600); return {ok:true, dayLength: state.dayLength}; }
    // Time of day: whole sim-seconds elapsed within the current simulation day (0 .. dayLength). Lets
    // station instructions key on the clock, e.g. "during game time between 2 and 8 minutes" = 120..480.
    function dayTime(){
      const len = state.dayLength || 600;
      const simSeconds = Math.floor(state.simFrame / FRAMES_PER_SECOND);
      const secondsIntoDay = ((simSeconds % len) + len) % len;
      return { simFrame: state.simFrame, simSeconds, dayLength: len, secondsIntoDay,
        day: Math.floor(simSeconds / len), clock: formatClock(state.simFrame),
        dayClock: formatClock(secondsIntoDay * FRAMES_PER_SECOND) };
    }

    // ---- Operate commands (return {ok, ...} or {ok:false, error}) ----
    function cmdThrowSwitch(x,y){
      const tile = getTile(x,y);
      if (!tile || tile.kind !== "switch") return {ok:false, error:"no switch here"};
      if (switchLocked(x,y)) return {ok:false, error:"switch is locked by a cleared route"};
      const other = switchOther(tile);
      if (other == null) return {ok:false, error:"switch has no alternate branch"};
      tile.current = other; updateSignals();
      return {ok:true, current: other};
    }
    function cmdSetSwitch(x,y,to){
      const tile = getTile(x,y);
      if (!tile || tile.kind !== "switch") return {ok:false, error:"no switch here"};
      if (switchLocked(x,y)) return {ok:false, error:"switch is locked by a cleared route"};
      to = Number(to);
      if (!tile.branches.includes(to)) return {ok:false, error:"not a branch of this switch"};
      tile.current = to; updateSignals();
      return {ok:true, current: to};
    }
    function cmdToggleSignal(x,y,dir,opts){
      const tile = getTile(x,y);
      if (!tile || tile.kind !== "signal") return {ok:false, error:"no signal here"};
      const dirs = dir != null ? [Number(dir)] : manualDirs(tile).slice();
      if (!dirs.length) return {ok:false, error:"no manual main here"};
      let last = {ok:false, error:"no manual main in that direction"};
      for (const d of dirs) last = toggleManualSignal(x,y,d,opts);
      return last;
    }
    // green=true → clear a route; green=false → drop to red. Idempotent.
    // opts.shunt clears the route for a SHUNTING move: it may lead into occupied track (to
    // couple) and its lock is released once the move comes to a stand.
    function cmdSetSignal(x,y,dir,green,opts){
      const tile = getTile(x,y);
      if (!tile || tile.kind !== "signal") return {ok:false, error:"no signal here"};
      const dirs = dir != null ? [Number(dir)] : manualDirs(tile).slice();
      if (!dirs.length) return {ok:false, error:"no manual main here"};
      let last = {ok:false, error:"no manual main in that direction"};
      for (const d of dirs){
        const isGreen = state.manualGreen.has(mkMain(x,y,d));
        if (green === isGreen) last = {ok:true, action: isGreen ? "green" : "red", noop:true};
        else last = toggleManualSignal(x,y,d,opts);
      }
      return last;
    }
    function cmdSpawn(x,y,dir,type,cars){
      const tile = getTile(x,y);
      if (!tile || tile.kind !== "track") return {ok:false, error:"can only spawn on plain track"};
      const spawn = {kind:"spawn", route: cloneRoute(tile.route), dir: Number(dir), type: type != null ? Number(type) : state.selectedType};
      if (cars != null && Number.isFinite(Number(cars))) spawn.cars = Math.max(0, Math.min(12, Math.round(Number(cars))));
      setTile(x,y,spawn);
      updateSignals();
      return {ok:true};
    }
    function cmdRemoveTrain(x,y){
      const before = state.trains.length;
      state.trains = state.trains.filter(t => !trainOccupies(t,x,y));
      updateSignals();
      return {ok:true, removed: before - state.trains.length};
    }

    // ---- Shunting discs (operate state, like throwing a switch — no layout undo) ----
    // A shunting disc is a bidirectional marker on plain track: clear by default, and when
    // set to "stop" it halts SHUNTING moves only. Placing/removing one is a tile edit
    // (setTile with shuntSignal on the track tile); these commands flip its state.
    function cmdSetShuntSignal(x,y,stop){
      const tile = getTile(x,y);
      if (!tile || !tile.shuntSignal) return {ok:false, error:"no shunting disc here"};
      const to = !!stop;
      const was = !!tile.shuntStop;
      if (to) tile.shuntStop = true; else delete tile.shuntStop;
      updateSignals();
      if (was !== to) emit("info", `Shunting disc ${placeLabel(x,y)} set to ${to ? "stop" : "clear"}`);
      return {ok:true, stop: to, noop: was === to};
    }
    function cmdToggleShuntSignal(x,y){
      const tile = getTile(x,y);
      if (!tile || !tile.shuntSignal) return {ok:false, error:"no shunting disc here"};
      return cmdSetShuntSignal(x, y, !tile.shuntStop);
    }

    // ---- Shunting commands (reverse / mode / uncouple / couple / place) ----
    // These are STATION MASTER moves: every one of them requires the consist to stand inside
    // a station (and, when the command is scoped to a station, inside THAT station). Consists
    // are addressed by train id or by any engine unit id they contain.
    function findConsist(ref){
      if (ref == null) return null;
      const n = Number(ref);
      return state.trains.find(t => t.id === n) ||
             state.trains.find(t => trainUnits(t).some(u => u.id === n)) || null;
    }
    function resolveConsist(cmd){
      if (cmd.engine != null){
        const t = state.trains.find(tr => trainUnits(tr).some(u => u.id === Number(cmd.engine) && u.kind === "engine"));
        if (t) return t;
      }
      return findConsist(cmd.train != null ? cmd.train : cmd.engine);
    }
    function shuntGuard(t, stationRef){
      if (!t) return {ok:false, error:"no such consist (give train id or engine id)"};
      const st = stationContaining(t.x, t.y);
      if (!st) return {ok:false, error:"shunting is only allowed inside a station"};
      if (stationRef != null){
        const want = findStation(stationRef);
        if (!want) return {ok:false, error:"no such station"};
        if (want.id !== st.id) return {ok:false, error:`that consist is in ${st.name}, not ${want.name}`};
      }
      return {ok:true, station: st};
    }
    function consistStanding(t){ return (t.speed || 0) === 0; }
    function unitPublic(u){ return {id:u.id, kind:u.kind, len:u.len, type:u.type != null ? u.type : null, active:!!u.active}; }
    function consistSummary(t){
      const units = trainUnits(t);
      const ae = activeEngine(t);
      return {id:t.id, mode: t.mode || "drive", length: trainTotalLength(t),
        units: units.map(unitPublic), engines: units.filter(u => u.kind === "engine").map(u => u.id),
        activeEngine: ae ? ae.id : null};
    }
    function ensureActive(units){
      if (!units.some(u => u.kind === "engine" && u.active)){
        const e = units.find(u => u.kind === "engine");
        if (e) e.active = true;
      }
      return units;
    }
    // Reverse a whole consist in place: the leading end becomes the trailing end, so an
    // engine that pulled now pushes. Requires the consist to be standing (it may be standing
    // buffers-to-buffers mid-tile — that is fine, the geometry handles it).
    function reverseConsist(t){
      const L = trainTotalLength(t);
      const geom = bodyGeometry(t);
      if (geom.covered + ARC_EPS < L) return {ok:false, error:"the consist's body geometry is incomplete — drive it forward a little first"};
      return applyReversal(t, geom, L);
    }
    function cmdReverse(cmd){
      const t = resolveConsist(cmd);
      const g = shuntGuard(t, cmd.station); if (!g.ok) return g;
      if (!hasActiveEngine(t)) return {ok:false, error:"no active engine in that consist"};
      if (!consistStanding(t)) return {ok:false, error:"the consist is still moving — wait for it to stop"};
      const r = reverseConsist(t);
      if (!r.ok) return r;
      updateSignals();
      const tile = getTile(t.x, t.y);
      const ex = tile ? exitFor(tile, t.from) : null;
      emit("info", `${trainDesc(t)} reversed at ${placeLabel(t.x,t.y)}`);
      return {ok:true, train: t.id, heading: ex != null ? DIRNAMES[ex] : null, ...consistSummary(t)};
    }
    // Modes: "drive" (normal), "shunt" (slow, creeps to touch), "stop" (handbrake — the
    // consist stands where it is, even when signals and track would let it move). A shunting
    // consist that comes to a stand buffers-to-buffers drops into "stop" by itself, so a
    // couple order doesn't send the merged train creeping off.
    function cmdSetTrainMode(cmd){
      const t = resolveConsist(cmd);
      if (!t) return {ok:false, error:"no such consist (give train id or engine id)"};
      const mode = cmd.mode === "shunt" ? "shunt" : (cmd.mode === "stop" ? "stop" : "drive");
      if (!hasActiveEngine(t)) return {ok:false, error:"no active engine in that consist"};
      if (mode === "shunt"){
        const g = shuntGuard(t, cmd.station); if (!g.ok) return g;
      }
      // Driving assumes a one-tile standoff to other stock; standing buffers-to-buffers that
      // is already gone, so a consist touching stock AHEAD may not switch to drive — it would
      // pull straight through it. Couple, or reverse away first.
      if (mode === "drive" && obstacleDistance(t) <= 0.12)
        return {ok:false, error:"the buffers are touching the stock ahead — couple or reverse away first (or keep shunting)"};
      t.mode = mode;
      if (mode === "drive") delete t._touch;
      updateSignals();
      const modeName = mode === "shunt" ? "shunting" : (mode === "stop" ? "stop (standing)" : "driving");
      emit("info", `${trainDesc(t)} switched to ${modeName} mode`);
      return {ok:true, train: t.id, mode};
    }
    // Uncouple: cut the consist at a coupling. The cut is given either as `cut` (boundary
    // index: between units[cut] and units[cut+1]) or as `keep` — how many vehicles stay with
    // the ACTIVE ENGINE beyond the engine itself (keep:0 cuts the engine free; keep:2 keeps
    // two cars on it). `side` ("front"/"back") disambiguates when the engine is mid-consist.
    function cmdDetach(cmd){
      const t = resolveConsist(cmd);
      const g = shuntGuard(t, cmd.station); if (!g.ok) return g;
      if (!consistStanding(t)) return {ok:false, error:"the consist is still moving — wait for it to stop"};
      const units = trainUnits(t);
      if (units.length < 2) return {ok:false, error:"nothing to uncouple — the consist is a single vehicle"};
      let c;
      if (cmd.cut != null){
        c = Number(cmd.cut);
        if (!(c >= 0 && c < units.length-1)) return {ok:false, error:`cut must be 0..${units.length-2}`};
      } else {
        const ae = activeEngine(t);
        if (!ae) return {ok:false, error:"no active engine in that consist"};
        const ai = units.indexOf(ae);
        const keep = Math.max(0, Number(cmd.keep) || 0);
        let side = cmd.side;
        if (!side) side = ai === 0 ? "back" : (ai === units.length-1 ? "front" : null);
        if (!side) return {ok:false, error:"the engine is mid-consist — say side:\"front\" or side:\"back\""};
        if (side === "back"){
          c = ai + keep;
          if (c > units.length-2) return {ok:false, error:`only ${units.length-1-ai} vehicle(s) behind the engine`};
        } else {
          c = ai - keep - 1;
          if (c < 0) return {ok:false, error:`only ${ai} vehicle(s) in front of the engine`};
        }
      }
      const frontUnits = units.slice(0, c+1);
      const rearUnits = units.slice(c+1);
      const L1 = unitsLength(frontUnits);
      const L = unitsLength(units);
      const geom = bodyGeometry(t);
      if (geom.covered + ARC_EPS < L) return {ok:false, error:"the consist's body geometry is incomplete — drive it forward a little first"};
      const rearHead = forwardHeadAt(geom, L1);
      if (!rearHead) return {ok:false, error:"could not place the uncoupled portion — drive forward a little first"};
      const rear = {
        id: state.nextTrainId++, x: rearHead.x, y: rearHead.y, from: rearHead.from,
        speed: 0, wait: 0, holds: [], wantSince: null,
        units: ensureActive(rearUnits), mode: t.mode || "drive",
        trail: trailSpan(geom.pts, L1, L),
        path: rearHead.path
      };
      if (rearHead.moving){ rear.prevX = rearHead.moving.prevX; rear.prevY = rearHead.moving.prevY; rear.moveDir = rearHead.moving.moveDir; rear.progress = rearHead.moving.progress; }
      const rearEngine = rear.units.find(u => u.kind === "engine" && u.active);
      rear.type = rearEngine && rearEngine.type != null ? rearEngine.type : t.type;
      t.units = ensureActive(frontUnits);
      const frontEngine = t.units.find(u => u.kind === "engine" && u.active);
      if (frontEngine && frontEngine.type != null) t.type = frontEngine.type;
      trimPath(t);
      rear._tiles = computeBodyTiles(rear);
      state.trains.push(rear);
      updateSignals();
      emit("info", `${trainDesc(t)} uncoupled at ${placeLabel(t.x,t.y)} — ${rearUnits.length} vehicle(s) left standing`);
      return {ok:true, front: consistSummary(t), detached: consistSummary(rear)};
    }
    // Couple: merge with the consist this one is touching (buffers within COUPLE_DIST). The
    // commanded consist's active engine stays in charge; every engine in the picked-up
    // consist goes inactive until cut off again. The merged consist is a NEW train.
    function cmdCouple(cmd){
      const a = resolveConsist(cmd);
      const g = shuntGuard(a, cmd.station); if (!g.ok) return g;
      if (!hasActiveEngine(a)) return {ok:false, error:"no active engine in that consist"};
      if (!consistStanding(a)) return {ok:false, error:"the consist is still moving — wait for it to stop"};
      const LA = trainTotalLength(a);
      const geomA = bodyGeometry(a);
      if (geomA.covered + ARC_EPS < LA) return {ok:false, error:"the consist's body geometry is incomplete"};
      const headA = geomA.pts[0];
      const tailA = trailSpan(geomA.pts, LA, LA)[0];
      let best = null;
      for (const b of state.trains){
        if (b.id === a.id || !consistStanding(b)) continue;
        const LB = trainTotalLength(b);
        const geomB = bodyGeometry(b);
        const headB = geomB.pts[0];
        const tailB = trailSpan(geomB.pts, LB, LB)[0];
        const pairs = [
          {d: Math.hypot(headA.x-tailB.x, headA.y-tailB.y), mode: "aBehindB", revB: false},
          {d: Math.hypot(tailA.x-headB.x, tailA.y-headB.y), mode: "bBehindA", revB: false},
          {d: Math.hypot(headA.x-headB.x, headA.y-headB.y), mode: "aBehindB", revB: true},
          {d: Math.hypot(tailA.x-tailB.x, tailA.y-tailB.y), mode: "bBehindA", revB: true}
        ];
        for (const p of pairs) if (p.d < COUPLE_DIST && (!best || p.d < best.d)) best = {...p, b};
      }
      if (!best) return {ok:false, error:"no consist within coupling distance — drive up to it in shunting mode first"};
      const b = best.b;
      if (best.revB){
        const r = reverseConsist(b);
        if (!r.ok) return {ok:false, error:"cannot line up with the other consist: " + r.error};
      }
      // Front consist F leads the merged train; R hangs behind it.
      const F = best.mode === "aBehindB" ? b : a;
      const R = best.mode === "aBehindB" ? a : b;
      const geomF = bodyGeometry(F), geomR = bodyGeometry(R);
      const LF = trainTotalLength(F), LR = trainTotalLength(R);
      if (geomF.covered + ARC_EPS < LF || geomR.covered + ARC_EPS < LR) return {ok:false, error:"a consist's body geometry is incomplete — drive it a little first"};
      // Merge the tile paths at the junction (under the touching buffers). Two traps here:
      // F's path must end at the tile that actually CONTAINS its tail — a tail sitting exactly
      // ON a tile boundary belongs to the shallower tile (the deeper one has no F body); and a
      // mid-transition R starts its path with a committed destination tile its head has not
      // actually entered — that tile carries no body and usually duplicates an fPath tile.
      // Getting either wrong doubles tiles back and forth in the merged path, which corrupts
      // any later reversal until movement trims the garbage away.
      const fArc = Math.min(LF, geomF.covered);
      const fLoc = locateArc(geomF, fArc);
      let fDepth;
      if (!fLoc) fDepth = geomF.path.length - 1;
      else if (fLoc.atCenter) fDepth = fLoc.k;
      else fDepth = (fArc <= fLoc.edgeArc + ARC_EPS) ? fLoc.k : fLoc.k + 1;
      const fPath = geomF.path.slice(0, fDepth + 1).map(e => ({...e}));
      const rStart = (trainMoving(R) && R.progress < 0.5) ? 1 : 0;   // skip R's never-entered tile
      const rPath = geomR.path.slice(rStart).map(e => ({...e}));
      const dirIndex = (dx,dy) => DIRS.findIndex(dd => dd.dx === dx && dd.dy === dy);
      const sameTile = (a,b) => a && b && a.x === b.x && a.y === b.y;
      const lastF = fPath[fPath.length-1];
      if (!sameTile(rPath[0], lastF) && sameTile(rPath[1], lastF)) rPath.shift(); // stray duplicate
      const firstR = rPath[0];
      if (!firstR) return {ok:false, error:"the consists are not lined up on the same track"};
      if (sameTile(lastF, firstR)){
        lastF.enter = firstR.enter;                       // one shared tile under the coupling
        rPath.shift();
      } else {
        const dj = dirIndex(firstR.x - lastF.x, firstR.y - lastF.y);
        if (dj < 0) return {ok:false, error:"the consists are not lined up on the same track"};
        lastF.enter = dj;
        firstR.exit = opposite(dj);
      }
      const mergedPath = fPath.concat(rPath);
      // sanity: consecutive tiles must link via their enter/exit dirs — truncate at any break
      // (a short path only means a later reverse asks to drive forward a little first)
      for (let i = 0; i < mergedPath.length - 1; i++){
        const d = dirIndex(mergedPath[i+1].x - mergedPath[i].x, mergedPath[i+1].y - mergedPath[i].y);
        if (d < 0 || mergedPath[i].enter !== d || mergedPath[i+1].exit !== opposite(d)){ mergedPath.length = i + 1; break; }
      }
      const mergedUnits = trainUnits(F).concat(trainUnits(R));
      const aActive = activeEngine(a);
      for (const u of mergedUnits) if (u.kind === "engine") u.active = (aActive && u.id === aActive.id);
      const merged = {
        id: state.nextTrainId++, x: F.x, y: F.y, from: F.from,
        speed: 0, wait: 0, holds: [], wantSince: null,
        units: mergedUnits, mode: a.mode || "drive",
        type: aActive && aActive.type != null ? aActive.type : a.type,
        trail: trailSpan(geomF.pts, 0, LF).concat(trailSpan(geomR.pts, 0, LR)),
        path: mergedPath
      };
      if (trainMoving(F)){ merged.prevX = F.prevX; merged.prevY = F.prevY; merged.moveDir = F.moveDir; merged.progress = F.progress; }
      state.trains = state.trains.filter(t => t.id !== a.id && t.id !== b.id);
      merged._tiles = computeBodyTiles(merged);
      state.trains.push(merged);
      updateSignals();
      emit("info", `Coupled: ${trainDesc(merged)} is now ${mergedUnits.length} vehicles at ${placeLabel(merged.x,merged.y)}`);
      return {ok:true, ...consistSummary(merged)};
    }
    // Place a standing consist on the track (head at x,y, facing `heading`), its body laid
    // rearward along the existing rails. For building test scenarios and custom trains.
    function cmdPlaceTrain(cmd){
      const x = Number(cmd.x), y = Number(cmd.y);
      const heading = typeof cmd.heading === "string" ? DIRNAMES.indexOf(cmd.heading.trim().toUpperCase()) : Number(cmd.heading);
      const tile = getTile(x,y);
      if (!tile) return {ok:false, error:"no track at that tile"};
      if (!(heading >= 0 && heading < 8)) return {ok:false, error:"bad heading (N/NE/E/SE/S/SW/W/NW)"};
      let from = null;
      for (const route of routesFor(tile)){
        if (route.length >= 2 && route.includes(heading)){ from = route[0] === heading ? route[1] : route[0]; break; }
        if (route.length === 1 && route[0] === heading) from = null;
      }
      if (from == null) return {ok:false, error:"that tile has no route exiting " + DIRNAMES[heading]};
      const specs = Array.isArray(cmd.units) && cmd.units.length ? cmd.units : null;
      const units = specs
        ? specs.map(u => makeUnit(u.kind === "engine" ? "engine" : "car", Math.max(0.2, Math.min(2, Number(u.len) || 0.5)), u.type != null ? Number(u.type) : (cmd.type != null ? Number(cmd.type) : state.selectedType)))
        : unitsFor(cmd.type != null ? Number(cmd.type) : state.selectedType, cmd.cars);
      for (const u of units) if (u.kind === "engine") u.active = false;
      ensureActive(units);
      const L = unitsLength(units);
      // walk the rails rearward from the head to lay out the body
      const path = [{x, y, enter: from, exit: null}];
      let covered = halfLen(from), cx = x, cy = y, cFrom = from;
      while (covered < L + 1.2){
        const rx = cx + DIRS[cFrom].dx, ry = cy + DIRS[cFrom].dy;
        const rt = getTile(rx, ry);
        if (!rt) break;
        const exR = opposite(cFrom);                    // the train left the rear tile this way
        let enR = null;
        if (rt.kind === "switch"){
          if (exR === rt.stem) enR = switchCurrent(rt);
          else if (rt.branches.includes(exR) && exR === switchCurrent(rt)) enR = rt.stem;
          else return {ok:false, error:`the switch at ${rx},${ry} is set against the train's body`};
        } else {
          const route = routesFor(rt).find(r => r.includes(exR));
          if (!route) break;
          enR = route.length >= 2 ? (route[0] === exR ? route[1] : route[0]) : null;
        }
        path.push({x: rx, y: ry, enter: enR, exit: exR});
        covered += halfLen(exR) + halfLen(enR);
        if (enR == null) break;
        cx = rx; cy = ry; cFrom = enR;
      }
      if (covered + ARC_EPS < L) return {ok:false, error:"not enough track behind the head for the whole consist"};
      const pts = [centerW(x,y)];
      for (let k=0; k<path.length-1; k++){
        if (path[k].enter == null) break;
        pts.push(endpointW(path[k].x, path[k].y, path[k].enter));
        pts.push(centerW(path[k+1].x, path[k+1].y));
      }
      const train = {
        id: state.nextTrainId++, x, y, from,
        speed: 0, wait: 0, holds: [], wantSince: null,
        units, mode: cmd.mode === "shunt" ? "shunt" : (cmd.mode === "stop" ? "stop" : "drive"),
        trail: pts, path
      };
      const eng = units.find(u => u.kind === "engine");
      train.type = eng && eng.type != null ? eng.type : (cmd.type != null ? Number(cmd.type) : state.selectedType);
      train._tiles = computeBodyTiles(train);
      for (const tk of train._tiles){ const {x:ox, y:oy} = readKey(tk); if (occupied(ox, oy, train.id)) return {ok:false, error:"another train is in the way"}; }
      state.trains.push(train);
      updateSignals();
      return {ok:true, ...consistSummary(train)};
    }

    // ---- Edit commands (build/layout mutations) ----
    // In server-only mode the builder routes every edit through the server too, so it persists and
    // autosaves. These are the layout-changing command types (EDIT_COMMANDS) — distinct from
    // operate (throw/toggle) — so the server can keep a layout undo-history for them.
    const EDIT_COMMANDS = new Set(["setTile","removeTile","setStations","setTrainTypes","pasteTiles","removeTiles"]);
    function sanitizeStations(list){
      return (Array.isArray(list) ? list : [])
        .filter(s => s && s.rect && Number.isFinite(s.rect.x0) && Number.isFinite(s.rect.y1))
        .map(s => { const r = normRect(s.rect); return {id:s.id, name:s.name || `Station ${s.id}`, instructions:s.instructions || "", overrides: Array.isArray(s.overrides) ? s.overrides.slice() : [], rect:{x0:r.x0,y0:r.y0,x1:r.x1,y1:r.y1}}; });
    }
    function sanitizeTypes(list){
      return (Array.isArray(list) && list.length)
        ? list.map(t => ({id:t.id, color:t.color || UNKNOWN_TYPE_COLOR, name:t.name || ""})) : defaultTrainTypes();
    }
    function cmdSetTile(x,y,tile){
      if (!tile || typeof tile !== "object") return {ok:false, error:"missing tile"};
      setTile(x,y, migrateTile(tile)); updateSignals(); return {ok:true};
    }
    function cmdRemoveTile(x,y,andTrains){
      removeTile(x,y);
      if (andTrains !== false) state.trains = state.trains.filter(t => !trainOccupies(t,x,y));
      updateSignals(); return {ok:true};
    }
    function cmdSetStations(stations){
      state.stations = sanitizeStations(stations);
      state.nextStationId = state.stations.reduce((m,s) => Math.max(m, s.id || 0), 0) + 1;
      return {ok:true};
    }
    // Standing instruction overrides: temporary operator orders ("until further notice …") that take
    // precedence over a station's base instructions until cleared. Recorded by a master when the
    // operator messages one, or set directly by the operator; they persist with the layout.
    function cmdAddOverride(idOrName, text){
      const st = findStation(idOrName); if (!st) return {ok:false, error:"no such station"};
      const t = String(text == null ? "" : text).trim();
      if (!t) return {ok:false, error:"empty override"};
      if (!Array.isArray(st.overrides)) st.overrides = [];
      st.overrides.push(t);
      return {ok:true, station: st.name, overrides: st.overrides.slice()};
    }
    function cmdClearOverrides(idOrName){
      const st = findStation(idOrName); if (!st) return {ok:false, error:"no such station"};
      st.overrides = [];
      return {ok:true, station: st.name, overrides: []};
    }
    function cmdSetTrainTypes(types, selectedType){
      state.trainTypes = sanitizeTypes(types);
      if (selectedType != null && trainTypeById(selectedType)) state.selectedType = selectedType;
      else if (!trainTypeById(state.selectedType)) state.selectedType = state.trainTypes[0].id;
      return {ok:true};
    }
    function cmdPasteTiles(tiles){
      for (const it of (tiles || [])) if (it && it.tile && Number.isFinite(it.x) && Number.isFinite(it.y)) setTile(it.x, it.y, migrateTile(it.tile));
      updateSignals(); return {ok:true};
    }
    function cmdRemoveTiles(keys, andTrains){
      for (const k of (keys || [])){ const {x,y} = readKey(k); removeTile(x,y); if (andTrains) state.trains = state.trains.filter(t => !trainOccupies(t,x,y)); }
      updateSignals(); return {ok:true};
    }
    // Replace the layout (tiles/stations/types) while KEEPING the live runtime (trains, clock,
    // cleared routes). Used by the server to undo/redo edits without rewinding the simulation.
    function applyLayout(layout){
      const data = typeof layout === "string" ? JSON.parse(layout) : layout;
      state.tiles = new Map();
      for (const it of (data.tiles || [])) if (it && it.tile && Number.isFinite(it.x) && Number.isFinite(it.y)) setTile(it.x, it.y, migrateTile(it.tile));
      state.trainTypes = sanitizeTypes(data.trainTypes);
      state.stations = sanitizeStations(data.stations);
      if (!trainTypeById(state.selectedType)) state.selectedType = state.trainTypes[0].id;
      updateSignals();
      return {ok:true};
    }

    // Single dispatch point for the REST API, the Station Master, and the client's networked edits.
    function command(cmd){
      if (!cmd || typeof cmd.type !== "string") return {ok:false, error:"missing command type"};
      switch (cmd.type){
        case "throwSwitch":   return cmdThrowSwitch(cmd.x, cmd.y);
        case "setSwitch":     return cmdSetSwitch(cmd.x, cmd.y, cmd.to);
        case "toggleSignal":  return cmdToggleSignal(cmd.x, cmd.y, cmd.dir, {shunt: !!cmd.shunt});
        case "clearSignal":   return cmdSetSignal(cmd.x, cmd.y, cmd.dir, true, {shunt: !!cmd.shunt});
        case "redSignal":     return cmdSetSignal(cmd.x, cmd.y, cmd.dir, false);
        case "spawn":         return cmdSpawn(cmd.x, cmd.y, cmd.dir, cmd.type, cmd.cars);
        case "removeTrain":   return cmdRemoveTrain(cmd.x, cmd.y);
        case "reverse":       return cmdReverse(cmd);
        case "setTrainMode":  return cmdSetTrainMode(cmd);
        case "detach":        return cmdDetach(cmd);
        case "couple":        return cmdCouple(cmd);
        case "placeTrain":    return cmdPlaceTrain(cmd);
        case "toggleShuntSignal": return cmdToggleShuntSignal(cmd.x, cmd.y);
        case "setShuntSignal":    return cmdSetShuntSignal(cmd.x, cmd.y, cmd.stop);
        case "setTile":       return cmdSetTile(cmd.x, cmd.y, cmd.tile);
        case "removeTile":    return cmdRemoveTile(cmd.x, cmd.y, cmd.andTrains);
        case "setStations":   return cmdSetStations(cmd.stations);
        case "setTrainTypes": return cmdSetTrainTypes(cmd.trainTypes, cmd.selectedType);
        case "pasteTiles":    return cmdPasteTiles(cmd.tiles);
        case "removeTiles":   return cmdRemoveTiles(cmd.keys, cmd.andTrains);
        case "setPath":       return cmdSetPath(cmd.station, cmd.path);
        case "setPaused":     return setPaused(cmd.paused);
        case "setSpeed":      return setSpeed(cmd.scale);
        case "setDayLength":  return setDayLength(cmd.seconds);
        case "addOverride":   return cmdAddOverride(cmd.station, cmd.text);
        case "clearOverrides":return cmdClearOverrides(cmd.station);
        case "step":          simStep(); return {ok:true, simFrame: state.simFrame};
        default:              return {ok:false, error:"unknown command type: " + cmd.type};
      }
    }

    // ---- Station Master helpers (resolve station-local names → tiles, report status) ----
    function tilesInStation(st){
      const r = normRect(st.rect); const out = [];
      if (!r) return out;
      for (const [k,tile] of state.tiles){ const {x,y} = readKey(k); if (x>=r.x0 && x<=r.x1 && y>=r.y0 && y<=r.y1) out.push({x,y,tile}); }
      return out;
    }
    function findStation(idOrName){
      const s = String(idOrName).toLowerCase();
      return state.stations.find(st => String(st.id) === String(idOrName)) ||
             state.stations.find(st => (st.name||"").toLowerCase() === s) || null;
    }
    // Resolve "element name" (a tile.name like 1E / 2W / A) within a station to its tile.
    function resolveElement(idOrName, elname){
      const st = findStation(idOrName); if (!st) return null;
      const s = String(elname).toLowerCase();
      const hit = tilesInStation(st).find(i => i.tile.name && i.tile.name.toLowerCase() === s);
      return hit ? {station: st, x: hit.x, y: hit.y, tile: hit.tile} : null;
    }
    const DIRNAMES = ["N","NE","E","SE","S","SW","W","NW"];
    // Stopped = not gaining ground. A shunting consist halted buffers-to-buffers sits
    // mid-transition (progress < 1) with speed 0 — that counts as stopped; so do engineless
    // cuts of cars, whatever discrete state they were left in.
    function trainStopped(t){
      if ((t.speed || 0) > 0) return false;
      if (!hasActiveEngine(t)) return true;
      if (t.mode === "stop") return true;    // handbrake: standing wherever it is, even mid-tile
      if (!trainMoving(t)) return true;
      return !!t._touch;
    }
    // Track when each train last became stopped, so masters can see how long one has been waiting
    // and clear the longest-waiting first. (haltedSince is a simFrame; null when moving.)
    function updateHaltTimers(){
      for (const t of state.trains){
        if (trainStopped(t)){ if (t.haltedSince == null) t.haltedSince = state.simFrame; }
        else t.haltedSince = null;
      }
    }
    // Seconds a train has been continuously stopped (0 if moving). simFrame advances ~real-time, so
    // this is real seconds regardless of the train-speed setting.
    function waitedSecs(t){ return (t.haltedSince != null && trainStopped(t)) ? Math.round((state.simFrame - t.haltedSince) / FRAMES_PER_SECOND) : 0; }
    // Why a train is sitting still (best effort), so a master can see what to do about it.
    function trainWaitReason(t){
      if (!trainStopped(t)) return null;
      if (!hasActiveEngine(t)) return "no engine (uncoupled cars)";
      if (t._touch) return t.mode === "stop"
        ? "buffers touching — holding in stop mode (couple / reverse / set a mode)"
        : "buffers touching the consist ahead (couple or reverse)";
      if (t.mode === "stop") return "holding in stop mode (ordered to stand)";
      const tile = getTile(t.x, t.y);
      if (!tile) return "off track";
      const ex = exitFor(tile, t.from);
      if (ex == null) return "no exit (switch set against / dead end)";
      if (tile.kind === "signal" && signalDirs(tile).includes(ex)){
        const mk = mkMain(t.x, t.y, ex);
        if (manualDirs(tile).includes(ex)) return state.manualGreen.has(mk) ? null : "held at a red MANUAL signal";
        if (!mainIsGreenFor(t, mk)) return "held at a red automatic signal";
      }
      if (tile.kind === "stop" && ex === tile.dir && state.simFrame < t.releaseFrame) return "dwelling at stop";
      if (isShunting(t) && tile.shuntSignal && tile.shuntStop) return "held at a shunting disc";
      const nx = t.x + DIRS[ex].dx, ny = t.y + DIRS[ex].dy;
      if (isShunting(t) && !stationContaining(nx, ny)) return "at the station boundary (shunting stays inside the station)";
      if (occupied(nx, ny, t.id)) return "train ahead";
      const nt = getTile(nx, ny);
      if (!nt || !tileAccepts(nt, opposite(ex)) || !switchAccepts(nt, opposite(ex))) return "switch set against ahead";
      return null;
    }
    // Where every train is and which way it is about to go — the whole-board view a master needs to
    // spot trains already waiting (which fire no fresh approach event).
    function trainsReport(){
      return state.trains.map(t => {
        const tile = getTile(t.x, t.y);
        const ex = tile ? exitFor(tile, t.from) : null;
        const tt = trainTypeById(t.type);
        const st = stationContaining(t.x, t.y);
        return {
          id: t.id, type: t.type, typeName: tt && tt.name ? tt.name : `type ${t.type}`,
          x: t.x, y: t.y, station: st ? st.name : null, at: tile && tile.name ? tile.name : null,
          heading: ex != null ? DIRNAMES[ex] : null, moving: !trainStopped(t),
          waitingFor: trainWaitReason(t), waitedSeconds: waitedSecs(t),
          ...consistSummary(t), touching: !!t._touch
        };
      });
    }
    // Full status of every station for the Station Master API: its instructions plus the switches
    // and signals inside it, by station-local name, with live settings AND any train waiting there.
    function stationsReport(){
      if (!state.sys) updateSignals();
      const sys = state.sys;
      return state.stations.map(st => {
        const items = tilesInStation(st);
        const switches = items.filter(i => i.tile.kind === "switch").map(i => ({
          name: i.tile.name || null, x: i.x, y: i.y,
          stem: i.tile.stem, branches: i.tile.branches, branchDirs: i.tile.branches.map(b => DIRNAMES[b]),
          current: switchCurrent(i.tile), setTo: DIRNAMES[switchCurrent(i.tile)], locked: switchLocked(i.x,i.y)
        }));
        const signals = items.filter(i => i.tile.kind === "signal").map(i => {
          // trains stopped ON this signal tile are waiting for it — report their type + wanted way.
          const waiting = state.trains.filter(t => t.x === i.x && t.y === i.y && trainStopped(t)).map(t => {
            const ex = exitFor(i.tile, t.from); const tt = trainTypeById(t.type);
            return { trainType: t.type, trainTypeName: tt && tt.name ? tt.name : `type ${t.type}`, wantsDir: ex != null ? DIRNAMES[ex] : null, waitedSeconds: waitedSecs(t) };
          });
          return {
            name: i.tile.name || null, x: i.x, y: i.y,
            mains: signalDirs(i.tile).map(d => {
              const manual = manualDirs(i.tile).includes(d);
              return {dir: d, type: manual ? "manual" : "automatic", green: mainRenderGreen(mkMain(i.x,i.y,d), sys, manual)};
            }),
            waiting
          };
        });
        // shunting discs (bidirectional, on plain track): clear by default, "stop" halts shunting moves
        const shuntSignals = items.filter(i => i.tile.kind === "track" && i.tile.shuntSignal).map(i => ({
          name: i.tile.name || null, x: i.x, y: i.y, stop: !!i.tile.shuntStop
        }));
        // consists whose head stands inside this station — the targets of shunting orders
        const r = normRect(st.rect);
        const consists = state.trains
          .filter(t => r && t.x >= r.x0 && t.x <= r.x1 && t.y >= r.y0 && t.y <= r.y1)
          .map(t => {
            const tile = getTile(t.x, t.y);
            return {...consistSummary(t), at: tile && tile.name ? tile.name : `${t.x},${t.y}`,
              moving: !trainStopped(t), waitingFor: trainWaitReason(t), touching: !!t._touch};
          });
        return {id: st.id, name: st.name, instructions: st.instructions || "", overrides: st.overrides || [], rect: st.rect, switches, signals, shuntSignals, consists};
      });
    }
    // Trains CURRENTLY stopped at the given owners' signals — synthetic "waiting" events so the
    // long-poll can re-surface stranded trains (which fire no fresh approach/reach event). Longest
    // wait first, so a master always sees and clears the most overdue train.
    function waitingTrainsReport(owners){
      const set = owners == null ? null : new Set(Array.isArray(owners) ? owners : [owners]);
      const out = [];
      for (const st of state.stations){
        if (set && !set.has(st.name)) continue;
        for (const i of tilesInStation(st)){
          // operator-cleared signals — and shunting discs set to stop with a shunter held at them
          const disc = i.tile.kind === "track" && i.tile.shuntSignal && i.tile.shuntStop;
          if (!disc && (i.tile.kind !== "signal" || !manualDirs(i.tile).length)) continue;
          for (const t of state.trains){
            if (t.x !== i.x || t.y !== i.y || !trainStopped(t) || !trainWaitReason(t)) continue;
            if (!hasActiveEngine(t)) continue;             // parked cars are not "waiting" for a signal
            if (disc && !isShunting(t)) continue;          // a disc only concerns shunting moves
            const ex = exitFor(i.tile, t.from);
            // Only a train facing this signal in one of its MANUAL directions is the master's to clear;
            // a train passing the other (automatic) way is held by automatic logic, not this signal.
            if (!disc && (ex == null || !manualDirs(i.tile).includes(ex))) continue;
            const tt = trainTypeById(t.type);
            out.push({ mode: "waiting", owner: st.name, element: i.tile.name || null,
              trainId: t.id, trainType: t.type, trainTypeName: tt && tt.name ? tt.name : `type ${t.type}`,
              wantsDir: ex != null ? DIRNAMES[ex] : null, waitedSeconds: waitedSecs(t), clock: formatClock(state.simFrame) });
          }
        }
      }
      out.sort((a, b) => b.waitedSeconds - a.waitedSeconds);
      return out;
    }

    // ---- Set a PATH of switches (line them all up from an entry signal) ----
    // A path is [entrySignal, switch, switch, … , (final switch | signal | compass dir)?]. We trace
    // the live track from each element to the next (through plain track only — a signal or switch in
    // between breaks it) and set every switch so the route threads through it: of the two ports the
    // route uses at a switch, one is the stem and the other a branch, and the switch is set to that
    // branch. The entry signal is then cleared. This frees a master from working out each switch's
    // direction by hand. (See cmdSetPath in the guide.)
    function isDirName(s){ return typeof s === "string" && DIRNAMES.includes(s.trim().toUpperCase()); }
    function dirIndexOf(s){ return DIRNAMES.indexOf(s.trim().toUpperCase()); }
    function tilePortsOf(t){ return t.kind === "switch" ? [t.stem, ...t.branches] : (t.route || []); }
    // Follow plain track (track/stop/spawn/crossing — NOT signals/switches) from (x,y) leaving via
    // exitDir; return the first signal/switch reached and the port we arrive on, or null if broken.
    function traceSegment(x, y, exitDir){
      let cx = x, cy = y, ex = exitDir;
      for (let i = 0; i < 512; i++){
        const nx = cx + DIRS[ex].dx, ny = cy + DIRS[ex].dy;
        const nt = getTile(nx, ny);
        if (!nt) return null;
        const arrival = opposite(ex);
        if (nt.kind === "signal" || nt.kind === "switch")
          return tilePortsOf(nt).includes(arrival) ? { x: nx, y: ny, arrival } : null;
        const out = exitFor(nt, arrival);
        if (out == null) return null;
        cx = nx; cy = ny; ex = out;
      }
      return null;
    }
    // Ports to try leaving an element toward the next: a signal/first element → both its track ports;
    // a switch entered via its stem → the two branches; entered via a branch → the stem.
    function pathExits(ent, inPort, isFirst){
      if (isFirst || ent.tile.kind !== "switch") return (ent.tile.route || []).slice();
      if (inPort === ent.tile.stem) return ent.tile.branches.slice();
      if (ent.tile.branches.includes(inPort)) return [ent.tile.stem];
      return [];
    }
    // Set a switch so the route from inPort to outPort passes (one must be the stem, the other a branch).
    function setSwitchForPorts(ent, inPort, outPort){
      const stem = ent.tile.stem, branches = ent.tile.branches;
      const branchPort = [inPort, outPort].find(p => branches.includes(p));
      if (branchPort == null || ![inPort, outPort].includes(stem)) return { ok: false, error: "the route would cross between its two branches" };
      if (switchLocked(ent.x, ent.y) && switchCurrent(ent.tile) !== branchPort) return { ok: false, error: "locked by another route" };
      ent.tile.current = branchPort;
      return { ok: true, branch: branchPort };
    }
    function cmdSetPath(stationId, names){
      if (!Array.isArray(names) || names.length < 2) return { ok: false, error: 'path needs an entry signal then at least one switch, e.g. ["A","1","2"]' };
      let finalDir = null, elemNames = names.map(String);
      // An optional trailing compass direction sets the last switch's exit (if entered via its stem).
      const lastNm = elemNames[elemNames.length - 1];
      if (elemNames.length >= 3 && isDirName(lastNm) && !resolveElement(stationId, lastNm)){ finalDir = dirIndexOf(lastNm); elemNames = elemNames.slice(0, -1); }
      const ents = [];
      for (const nm of elemNames){
        const hit = resolveElement(stationId, nm);
        if (!hit) return { ok: false, error: `"${nm}" is not an element of this station` };
        ents.push({ name: nm, x: hit.x, y: hit.y, tile: hit.tile });
      }
      if (ents[0].tile.kind !== "signal") return { ok: false, error: `a path must start with a signal; "${ents[0].name}" is a ${ents[0].tile.kind}` };
      for (let i = 1; i < ents.length; i++){
        const k = ents[i].tile.kind, lastOne = i === ents.length - 1;
        if (k !== "switch" && !(lastOne && k === "signal")) return { ok: false, error: `"${ents[i].name}" is a ${k}; a path is a signal then switches (with an optional final signal/direction)` };
      }
      const set = [];
      let prevArrival = null;
      for (let i = 0; i < ents.length - 1; i++){
        const cur = ents[i], nxt = ents[i + 1];
        let conn = null;
        for (const ex of pathExits(cur, prevArrival, i === 0)){
          const seg = traceSegment(cur.x, cur.y, ex);
          if (seg && seg.x === nxt.x && seg.y === nxt.y){ conn = seg; conn.exit = ex; break; }
        }
        if (!conn) return { ok: false, error: `no clear track from "${cur.name}" to "${nxt.name}" (they don't connect directly, or a signal/switch is in between)` };
        if (cur.tile.kind === "switch"){
          const r = setSwitchForPorts(cur, prevArrival, conn.exit);
          if (!r.ok) return { ok: false, error: `switch "${cur.name}": ${r.error}` };
          set.push({ name: cur.name, dir: DIRNAMES[r.branch] });
        }
        prevArrival = conn.arrival;
      }
      const last = ents[ents.length - 1];
      if (last.tile.kind === "switch"){
        if (last.tile.branches.includes(prevArrival)){                       // entered via a branch → set to it
          if (switchLocked(last.x, last.y) && switchCurrent(last.tile) !== prevArrival) return { ok: false, error: `switch "${last.name}" is locked by another route` };
          last.tile.current = prevArrival; set.push({ name: last.name, dir: DIRNAMES[prevArrival] });
        } else if (finalDir != null){                                        // entered via stem → use the given exit dir
          if (!last.tile.branches.includes(finalDir)) return { ok: false, error: `"${DIRNAMES[finalDir]}" is not a branch of switch "${last.name}" (branches ${last.tile.branches.map(b => DIRNAMES[b]).join("/")})` };
          if (switchLocked(last.x, last.y) && switchCurrent(last.tile) !== finalDir) return { ok: false, error: `switch "${last.name}" is locked by another route` };
          last.tile.current = finalDir; set.push({ name: last.name, dir: DIRNAMES[finalDir] });
        } else {
          return { ok: false, error: `the last switch "${last.name}" is entered from its stem — add a final compass direction (e.g. "E") or a signal to say which way to set it` };
        }
      }
      updateSignals();
      let cleared = null;
      if (manualDirs(ents[0].tile).length) cleared = cmdSetSignal(ents[0].x, ents[0].y, undefined, true);  // route the train
      return { ok: true, entry: ents[0].name, set, cleared };
    }

    // ---- Train-location watches (notifications) ----
    // A watch fires events when a train interacts with a tile, so an external Station Master can be
    // notified instead of polling the whole board. Three modes:
    //   "approach" — the train is heading toward the tile and is within `tiles` cells of it (live
    //                switch settings). Fires EARLY so the master can set the route / clear the
    //                signal before the train has to brake — proactive routing.
    //   "reach"    — the train's head arrives ON the tile.
    //   "pass"     — the train's tail clears the tile (whole body gone).
    // Edge-detected per train id, so each visit fires once. Watches are tagged with an `owner`
    // (the station) so each station master only sees its own. Events queue on state.watchEvents.
    const DEFAULT_APPROACH_TILES = 6;
    state.watches = state.watches || [];
    state.watchEvents = state.watchEvents || [];
    let watchIdSeq = 0, watchEventSeq = 0;
    // Tiles the train will roll onto next, in order, following the LIVE switch settings (so a
    // diverging switch ahead is honoured). Traces through red signals (the point is lead time).
    function forwardPath(train, maxTiles){
      const out = [];
      let cx = train.x, cy = train.y, from = train.from;
      for (let i = 0; i < maxTiles; i++){
        const tile = getTile(cx, cy);
        if (!tile) break;
        const ex = exitFor(tile, from);
        if (ex == null) break;                               // dead end / switch set against
        const nx = cx + DIRS[ex].dx, ny = cy + DIRS[ex].dy;
        const nt = getTile(nx, ny);
        if (!nt || !tileAccepts(nt, opposite(ex)) || !switchAccepts(nt, opposite(ex))) break;
        out.push(key(nx, ny));
        cx = nx; cy = ny; from = opposite(ex);
      }
      return out;
    }
    function fireWatch(w, trainId){
      const t = state.trains.find(x => x.id === trainId);
      const type = t ? t.type : null;
      const tt = trainTypeById(type);
      state.watchEvents.push({
        seq: ++watchEventSeq, frame: state.simFrame, clock: formatClock(state.simFrame),
        watchId: w.id, owner: w.owner, label: w.label || null, element: w.element || null,
        mode: w.mode, x: w.x, y: w.y,
        trainId, trainType: type, trainTypeName: tt && tt.name ? tt.name : (type != null ? `type ${type}` : null)
      });
      if (state.watchEvents.length > 500) state.watchEvents.shift();
    }
    // The exit direction a train will have AT the watched tile, tracing the LIVE forward path to it
    // (so a diverging switch is honoured). null if its path doesn't reach the tile within maxTiles.
    function approachExitDir(t, wx, wy, maxTiles){
      let cx = t.x, cy = t.y, from = t.from;
      for (let i = 0; i < maxTiles; i++){
        const tile = getTile(cx, cy); if (!tile) return null;
        const ex = exitFor(tile, from); if (ex == null) return null;
        const nx = cx + DIRS[ex].dx, ny = cy + DIRS[ex].dy;
        const nt = getTile(nx, ny);
        if (!nt || !tileAccepts(nt, opposite(ex)) || !switchAccepts(nt, opposite(ex))) return null;
        if (nx === wx && ny === wy) return exitFor(nt, opposite(ex)); // stepping onto the watched tile
        cx = nx; cy = ny; from = opposite(ex);
      }
      return null;
    }
    // A MANUAL signal only concerns trains passing in one of its manual directions. Some manual signals
    // point opposite to the normal running direction; a train passing the NORMAL way is not the master's
    // business and must not notify (it was confusing the station-master LLMs). Returns true to SUPPRESS a
    // train exiting the (signal) tile in direction `dir`. Only manual-signal tiles filter; switches and
    // automatic-only signals are unaffected, and an undeterminable dir is never suppressed (don't miss real events).
    function watchDirSuppressed(tile, dir){
      if (!tile || tile.kind !== "signal") return false;
      const md = manualDirs(tile);
      if (!md.length || dir == null) return false;
      return !md.includes(dir);
    }
    function checkWatches(){
      if (!state.watches.length) return;
      for (const w of state.watches){
        const tk = key(w.x, w.y);
        const wt = getTile(w.x, w.y);
        const cur = new Set();
        w._dir = w._dir || new Map();   // trainId -> traversal exit dir, captured while the head is on the tile
        for (const t of state.trains){
          const onTile = (t.x === w.x && t.y === w.y);
          // Capture the traversal dir while the head is on the tile; it survives the whole cover (the
          // train stays in `cur`), so a pass watch can still tell the direction when the tail clears.
          if (onTile && wt) w._dir.set(t.id, exitFor(wt, t.from));
          if (w.mode === "reach"){ if (onTile) cur.add(t.id); }
          else if (w.mode === "pass"){ const bt = t._tiles || computeBodyTiles(t); if (bt.has(tk)) cur.add(t.id); }
          else { if (!onTile && forwardPath(t, w.tiles || DEFAULT_APPROACH_TILES).includes(tk)) cur.add(t.id); }
        }
        const prev = w._on || new Set();
        // Edge-detect, then fire only if the train traverses the tile in a MANUAL direction of the signal.
        const fireIds = (w.mode === "pass")
          ? [...prev].filter(id => !cur.has(id))     // tail cleared (leaving edge)
          : [...cur].filter(id => !prev.has(id));    // entered (approach/reach entering edge)
        for (const id of fireIds){
          let dir;
          if (w.mode === "approach"){ const t = state.trains.find(x => x.id === id); dir = t ? approachExitDir(t, w.x, w.y, w.tiles || DEFAULT_APPROACH_TILES) : null; }
          else dir = w._dir.get(id);                 // reach/pass: dir captured while the head was on the tile
          if (!watchDirSuppressed(wt, dir)) fireWatch(w, id);
        }
        w._on = cur;
        for (const id of [...w._dir.keys()]) if (!cur.has(id) && !prev.has(id)) w._dir.delete(id); // keep while covering / one step after
      }
    }
    function publicWatch(w){ return {id:w.id, owner:w.owner, x:w.x, y:w.y, mode:w.mode, tiles:w.tiles, element:w.element||null, label:w.label||null}; }
    function addWatch(opts){
      opts = opts || {};
      const owner = opts.owner || "", x = Number(opts.x), y = Number(opts.y);
      const mode = (opts.mode === "reach" || opts.mode === "pass") ? opts.mode : "approach";
      // Dedupe: re-registering the same watch (e.g. a master that reconnects) returns the existing
      // one instead of stacking duplicate notifications.
      const dup = state.watches.find(w => w.owner === owner && w.x === x && w.y === y && w.mode === mode);
      if (dup) return publicWatch(dup);
      const w = {id: ++watchIdSeq, owner, x, y, mode,
        tiles: opts.tiles != null ? Number(opts.tiles) : DEFAULT_APPROACH_TILES,
        element: opts.element || null, label: opts.label || null, _on: new Set()};
      state.watches.push(w);
      return publicWatch(w);
    }
    function removeWatch(id){ const before = state.watches.length; state.watches = state.watches.filter(w => w.id !== Number(id)); return before !== state.watches.length; }
    function clearWatches(owner){ const before = state.watches.length; state.watches = state.watches.filter(w => owner && w.owner !== owner); return before - state.watches.length; }
    function listWatches(owner){ return state.watches.filter(w => !owner || w.owner === owner).map(publicWatch); }
    function watchCursor(){ return watchEventSeq; }
    // Events for `owner` with seq > after. If `after` is ahead of the cursor (e.g. the game was
    // reloaded and the counter reset), start from 0 so the poller resynchronises.
    function watchEventsSince(owner, after){
      const a = (after > watchEventSeq) ? 0 : (after || 0);
      const set = owner == null ? null : new Set(Array.isArray(owner) ? owner : [owner]); // one or many owners
      return state.watchEvents.filter(e => (!set || set.has(e.owner)) && e.seq > a);
    }
    // ---- Operator <-> Station Master chat ----
    // notifyOwner: a message FOR a station master — queued on its event stream so await_events
    // delivers it (same channel as train arrivals, with mode "message").
    function notifyOwner(owner, text, from){
      state.watchEvents.push({ seq: ++watchEventSeq, frame: state.simFrame, clock: formatClock(state.simFrame),
        owner: String(owner), mode: "message", from: from || "operator", text: String(text || ""),
        label: null, element: null, trainId: null, trainType: null, trainTypeName: null });
      if (state.watchEvents.length > 500) state.watchEvents.shift();
      return { ok: true };
    }
    // notifyOperator: a message FROM a station master to the human — emitted onto the game event
    // log (carried in the snapshot) tagged with the station so the UI can show + highlight it.
    function notifyOperator(station, text){ emit("master", String(text || ""), { station: String(station) }); return { ok: true }; }

    // ---- Live snapshot for streaming + persistence (Sets/transients made JSON-safe) ----
    function serHold(h){ return {blockId:h.blockId, entryMainKey:h.entryMainKey, entryMainTile:h.entryMainTile, approach: h.approach ? [...h.approach] : null, rollThrough: !!h.rollThrough}; }
    function cleanTrain(t){
      const o = {};
      for (const k in t){ if (k.startsWith("_")) continue; if (k === "holds") o.holds = (t.holds||[]).map(serHold); else o[k] = t[k]; }
      return o;
    }
    function serRouteLock(rl){ return {mk:rl.mk, switchKeys:rl.switchKeys, path:rl.path, trainId:rl.trainId, armed:rl.armed, shunt:!!rl.shunt, moved:!!rl.moved, enteredTile:[...rl.enteredTile], passedTile:[...rl.passedTile]}; }
    function snapshot(){
      return {
        version: 3,
        simFrame: state.simFrame, frame: state.frame, tick: state.tick, paused: state.paused, speedScale: state.speedScale || 1, dayLength: state.dayLength || 600,
        nextTrainId: state.nextTrainId, nextStationId: state.nextStationId, nextUnitId: state.nextUnitId || 0, selectedType: state.selectedType,
        trainTypes: state.trainTypes, stations: state.stations,
        tiles: [...state.tiles].map(([k,tile]) => ({...readKey(k), tile})),
        trains: state.trains.map(cleanTrain),
        manualGreen: [...state.manualGreen],
        routeLocks: state.routeLocks.map(serRouteLock),
        events: state.events.slice(-200)
      };
    }
    function deHydrateTrain(t){ const o = {...t}; o.holds = (t.holds||[]).map(h => ({...h, approach: h.approach ? new Set(h.approach) : null})); return o; }
    function deRouteLock(rl){ return {...rl, enteredTile: new Set(rl.enteredTile||[]), passedTile: new Set(rl.passedTile||[])}; }
    // Load a streamed snapshot. Deliberately does NOT touch state.view or state.selectedType — the
    // viewing client owns its own camera and its "type for new spawns" choice. updateSignals()
    // re-derives state.sys so renderers have it.
    function applySnapshot(s){
      if (!s) return;
      state.simFrame = s.simFrame||0; state.frame = s.frame||0; state.tick = s.tick||0;
      state.paused = !!s.paused;
      state.speedScale = s.speedScale || 1;
      state.dayLength = s.dayLength || 600;
      state.nextTrainId = s.nextTrainId||1; state.nextStationId = s.nextStationId||1;
      state.trainTypes = (Array.isArray(s.trainTypes) && s.trainTypes.length)
        ? s.trainTypes.map(t => ({id:t.id, color:t.color||UNKNOWN_TYPE_COLOR, name:t.name||""})) : defaultTrainTypes();
      state.stations = (Array.isArray(s.stations) ? s.stations : [])
        .filter(st => st && st.rect)
        .map(st => { const r = normRect(st.rect); return {id:st.id, name:st.name||`Station ${st.id}`, instructions:st.instructions||"", overrides: Array.isArray(st.overrides) ? st.overrides.slice() : [], rect:{x0:r.x0,y0:r.y0,x1:r.x1,y1:r.y1}}; });
      state.tiles = new Map();
      for (const it of (s.tiles||[])){ if (it && it.tile && Number.isFinite(it.x) && Number.isFinite(it.y)) setTile(it.x, it.y, it.tile); }
      state.trains = (s.trains||[]).map(deHydrateTrain);
      // keep unit ids unique across a reload (legacy trains migrate lazily via trainUnits)
      state.nextUnitId = s.nextUnitId || 0;
      for (const t of state.trains) for (const u of (t.units || [])) if (u.id > state.nextUnitId) state.nextUnitId = u.id;
      state.manualGreen = new Set(s.manualGreen||[]);
      state.routeLocks = (s.routeLocks||[]).map(deRouteLock);
      state.lockedSwitchKeys = new Set();
      state.events = s.events || [];
      updateSignals();
    }

    return { DEFAULT_TYPE_COLORS, DEFAULT_TYPE_NAMES, LEGACY_COLOR_IDS, UNKNOWN_TYPE_COLOR, defaultTrainTypes, trainTypeById, typeColor, nextTypeId, MAX_SPEED, ACCEL, DECEL, MIN_SPEED, DEFAULT_CARS, CAR_GAP, CAR_WIDTH, SHUNT_SPEED_FACTOR, COUPLE_DIST, SIGNAL_REACTION_SECONDS, SIGNAL_SIDE_OFFSET, SPAWN_TICK_FRAMES, FRAMES_PER_SECOND, DEFAULT_DWELL_SECONDS, STOP_BROWN, SIGNAL_GREEN, SIGNAL_RED, SIGNAL_RED_DARK, MANUAL_RING, INACTIVE_BRANCH, LOCK_GREEN, BLOCK_GREY, DIRS, TRACK_SHAPES, buildDirectionalShapes, switchShape, buildSwitchShapes, SWITCH_SHAPES, SPAWN_SHAPES, STOP_SHAPES, SIGNAL_SHAPES, TOOLS, CROSSING_SHAPES, state, normRect, addStation, removeStation, stationContaining, key, readKey, opposite, cloneRoute, signalDirs, mkMain, parseMain, manualDirs, mainIsManual, mainIsManualKey, manualMainHasWaiter, routesFor, tileAccepts, switchCurrent, switchOther, switchLocked, switchAccepts, getTile, setTile, removeTile, defaultSwitch, makeTile, sortedRouteKey, findTrackShapeIndex, findDirShapeIndex, findSwitchShapeIndex, centerW, endpointW, lerpW, headWorld, trainCars, trainUnits, activeEngine, hasActiveEngine, trainEngines, unitsLength, defaultUnits, unitsFor, isShunting, trainTotalLength, updateTrail, seedTrail, computeBodyTiles, trailSpan, bodyGeometry, obstacleDistance, trainMoving, exitFor, exitsForBlock, collectProtectedBlock, scanProtectedBlock, regionIdFor, buildSignalSystem, mainEligible, approachInfo, nextWantSeq, trainHolds, blockOccupiedByOther, inBlockRegion, updateSignals, holdForMain, mainIsGreenFor, blockFree, mainRenderGreen, mainShuntCleared, mayRollThrough, occupied, maintainManualState, followManualRoute, toggleManualSignal, trainOccupies, canLeave, advanceWithSpeed, formatClock, placeLabel, trainDesc, registerStopArrival, notifyDeparture, stopDwellSeconds, moveTrain, spawnTrains, simStep, serialize, migrateTile, emit, setPaused, command, cmdThrowSwitch, cmdSetSwitch, cmdToggleSignal, cmdSetSignal, cmdSpawn, cmdRemoveTrain, cmdReverse, cmdSetTrainMode, cmdDetach, cmdCouple, cmdPlaceTrain, resolveConsist, consistSummary, tilesInStation, findStation, resolveElement, stationsReport, trainsReport, waitingTrainsReport, snapshot, applySnapshot, deserialize, applyLayout, dayTime, setDayLength, EDIT_COMMANDS, addWatch, removeWatch, clearWatches, listWatches, watchCursor, watchEventsSince, notifyOwner, notifyOperator };
  }
  return { createEngine };
});
