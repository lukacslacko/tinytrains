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
  // Multi-part trains: an engine plus cars, each a length in tile units, joined by a small
  // gap. Bodies trail the head along its path; block occupancy follows the whole body.
  const DEFAULT_CARS = [0.6, 0.5, 0.5];
  const CAR_GAP = 0.12;
  const CAR_WIDTH = 0.42;
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
    const st = {id, name:`Station ${id}`, instructions:"", rect:{x0:r.x0, y0:r.y0, x1:r.x1, y1:r.y1}};
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
  function trainTotalLength(train){
    const cars = trainCars(train);
    return cars.reduce((a,c)=>a+c,0) + (cars.length-1)*CAR_GAP;
  }
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
  // settings) from the signal to the next signal facing the way we travel, checking that
  // (2a) it crosses no already-locked switch and (2c) no axle sits anywhere on the path up to
  // and including that signal. On success returns the switch tiles it crosses plus the per-tile
  // path segments (the manual signal tile and every tile up to, but not including, the terminus
  // signal); otherwise a reason and the obstacle tile.
  function followManualRoute(sx,sy,dir){
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
      if (occupied(nx,ny,null)) return {ok:false, reason:"the path is occupied", obstacle:here}; // 2c (incl. the terminus signal)
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
      if (ex == null) return {ok:false, reason: nt.kind === "switch" ? "the path runs into a switch set against it" : "the path reaches a dead end before any signal", obstacle:here};
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
  function toggleManualSignal(x,y,dir){
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
    const route = followManualRoute(x,y,dir);
    if (!route.ok){
      state.message = `Cannot clear ${placeLabel(x,y)}: ${route.reason}`;
      return {ok:false, action:"refused", reason:route.reason, flash:[key(x,y), route.obstacle]};
    }
    state.flash = null;
    state.manualGreen.add(mk);
    state.routeLocks.push({mk, switchKeys: route.switchKeys, path: route.path, trainId:null, armed:false, enteredTile:new Set(), passedTile:new Set()});
    state.message = `Cleared ${placeLabel(x,y)}`;
    updateSignals();
    return {ok:true, action:"green"};
  }

  function trainOccupies(train,x,y){
    if (train._tiles) return train._tiles.has(key(x,y));
    return (train.x === x && train.y === y) || (trainMoving(train) && train.prevX === x && train.prevY === y);
  }

  // True if a train arriving at (x,y) via `from` can immediately continue onward; its
  // negation is what tells a moving train to brake to a stop on the tile it is entering.
  function canLeave(train, x, y, from){
    const tile = getTile(x,y);
    if (!tile) return false;
    const ex = exitFor(tile, from);
    if (ex == null) return false;
    if (tile.kind === "stop" && ex === tile.dir){
      if (train.stopKey !== key(x,y)) return false;          // hasn't docked yet
      if (state.simFrame < train.releaseFrame) return false; // still dwelling
    }
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
    // All trains proceed with caution: never roll onto an occupied tile, brake to a stop.
    if (occupied(nx,ny,train.id)) return false;
    return true;
  }

  // Advance a moving train by its current speed, easing toward MAX_SPEED or braking along
  // a sqrt curve so it coasts to a stop exactly on the tile it cannot continue past.
  function advanceWithSpeed(train){
    if (!trainMoving(train)) return false;
    // state.speedScale (UI-adjustable, default 1) slows the whole fleet so an operator/AI has more
    // real time to act. It scales top speed + acceleration; DECEL is left so braking stays safe.
    const ss = state.speedScale || 1;
    const maxV = MAX_SPEED * ss, accV = ACCEL * ss, minV = MIN_SPEED * ss;
    const d = DIRS[train.moveDir];
    const seg = Math.hypot(d.dx,d.dy) || 1;
    const halt = !canLeave(train, train.x, train.y, train.from);
    const remaining = (1 - train.progress) * seg;
    let target = maxV;
    if (halt) target = Math.min(target, Math.sqrt(2 * DECEL * Math.max(0, remaining)));
    if (train.speed < target) train.speed = Math.min(target, train.speed + accV);
    else train.speed = target;
    if (halt && train.speed < minV && remaining < 0.5){
      train.progress = 1; // crawling and almost there: dock on the tile centre
    } else {
      train.progress = Math.min(1, train.progress + train.speed / seg);
    }
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
    if (trainMoving(train)){ advanceWithSpeed(train); return; }
    if (train.wait > 0){ train.wait--; train.speed = 0; return; }
    const tile = getTile(train.x,train.y);
    const ex = exitFor(tile, train.from);
    if (ex == null){ train.speed = 0; return; }
    if (tile.kind === "stop" && ex === tile.dir){
      const stopKey = key(train.x,train.y);
      if (train.stopKey !== stopKey){
        registerStopArrival(train, tile);
        train.speed = 0;
        return;
      }
      if (state.simFrame < train.releaseFrame){ train.speed = 0; return; }
    }
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
    if (occupied(nx,ny,train.id)){ train.speed = 0; return; } // proceed with caution: never collide
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
    train.prevX = train.x;
    train.prevY = train.y;
    train.moveDir = ex;
    train.progress = 0;
    train.x = nx;
    train.y = ny;
    train.from = nf;
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
      const train = {id:state.nextTrainId++, x:nx, y:ny, from:nf, type:tile.type, wait:0, prevX:x, prevY:y, moveDir:tile.dir, progress:0, speed:0, holds:[], wantSince:null, cars:DEFAULT_CARS.slice()};
      seedTrail(train, tile.dir);
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
      .map(s => { const r = normRect(s.rect); return {id: s.id, name: s.name || `Station ${s.id}`, instructions: s.instructions || "", rect:{x0:r.x0,y0:r.y0,x1:r.x1,y1:r.y1}}; });
    state.nextStationId = state.stations.reduce((m,s) => Math.max(m, s.id || 0), 0) + 1;
    state.trains = [];
    state.nextTrainId = 1;
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
    function cmdToggleSignal(x,y,dir){
      const tile = getTile(x,y);
      if (!tile || tile.kind !== "signal") return {ok:false, error:"no signal here"};
      const dirs = dir != null ? [Number(dir)] : manualDirs(tile).slice();
      if (!dirs.length) return {ok:false, error:"no manual main here"};
      let last = {ok:false, error:"no manual main in that direction"};
      for (const d of dirs) last = toggleManualSignal(x,y,d);
      return last;
    }
    // green=true → clear a route; green=false → drop to red. Idempotent.
    function cmdSetSignal(x,y,dir,green){
      const tile = getTile(x,y);
      if (!tile || tile.kind !== "signal") return {ok:false, error:"no signal here"};
      const dirs = dir != null ? [Number(dir)] : manualDirs(tile).slice();
      if (!dirs.length) return {ok:false, error:"no manual main here"};
      let last = {ok:false, error:"no manual main in that direction"};
      for (const d of dirs){
        const isGreen = state.manualGreen.has(mkMain(x,y,d));
        if (green === isGreen) last = {ok:true, action: isGreen ? "green" : "red", noop:true};
        else last = toggleManualSignal(x,y,d);
      }
      return last;
    }
    function cmdSpawn(x,y,dir,type){
      const tile = getTile(x,y);
      if (!tile || tile.kind !== "track") return {ok:false, error:"can only spawn on plain track"};
      setTile(x,y,{kind:"spawn", route: cloneRoute(tile.route), dir: Number(dir), type: type != null ? Number(type) : state.selectedType});
      updateSignals();
      return {ok:true};
    }
    function cmdRemoveTrain(x,y){
      const before = state.trains.length;
      state.trains = state.trains.filter(t => !trainOccupies(t,x,y));
      updateSignals();
      return {ok:true, removed: before - state.trains.length};
    }

    // ---- Edit commands (build/layout mutations) ----
    // In server-only mode the builder routes every edit through the server too, so it persists and
    // autosaves. These are the layout-changing command types (EDIT_COMMANDS) — distinct from
    // operate (throw/toggle) — so the server can keep a layout undo-history for them.
    const EDIT_COMMANDS = new Set(["setTile","removeTile","setStations","setTrainTypes","pasteTiles","removeTiles"]);
    function sanitizeStations(list){
      return (Array.isArray(list) ? list : [])
        .filter(s => s && s.rect && Number.isFinite(s.rect.x0) && Number.isFinite(s.rect.y1))
        .map(s => { const r = normRect(s.rect); return {id:s.id, name:s.name || `Station ${s.id}`, instructions:s.instructions || "", rect:{x0:r.x0,y0:r.y0,x1:r.x1,y1:r.y1}}; });
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
        case "toggleSignal":  return cmdToggleSignal(cmd.x, cmd.y, cmd.dir);
        case "clearSignal":   return cmdSetSignal(cmd.x, cmd.y, cmd.dir, true);
        case "redSignal":     return cmdSetSignal(cmd.x, cmd.y, cmd.dir, false);
        case "spawn":         return cmdSpawn(cmd.x, cmd.y, cmd.dir, cmd.type);
        case "removeTrain":   return cmdRemoveTrain(cmd.x, cmd.y);
        case "setTile":       return cmdSetTile(cmd.x, cmd.y, cmd.tile);
        case "removeTile":    return cmdRemoveTile(cmd.x, cmd.y, cmd.andTrains);
        case "setStations":   return cmdSetStations(cmd.stations);
        case "setTrainTypes": return cmdSetTrainTypes(cmd.trainTypes, cmd.selectedType);
        case "pasteTiles":    return cmdPasteTiles(cmd.tiles);
        case "removeTiles":   return cmdRemoveTiles(cmd.keys, cmd.andTrains);
        case "setPath":       return cmdSetPath(cmd.station, cmd.path);
        case "setPaused":     return setPaused(cmd.paused);
        case "setSpeed":      return setSpeed(cmd.scale);
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
    function trainStopped(t){ return !(trainMoving(t) || (t.speed || 0) > 0); }
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
      const nx = t.x + DIRS[ex].dx, ny = t.y + DIRS[ex].dy;
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
          waitingFor: trainWaitReason(t), waitedSeconds: waitedSecs(t)
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
        return {id: st.id, name: st.name, instructions: st.instructions || "", rect: st.rect, switches, signals};
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
          if (i.tile.kind !== "signal" || !manualDirs(i.tile).length) continue; // only operator-cleared signals
          for (const t of state.trains){
            if (t.x === i.x && t.y === i.y && trainStopped(t) && trainWaitReason(t)){
              const ex = exitFor(i.tile, t.from); const tt = trainTypeById(t.type);
              out.push({ mode: "waiting", owner: st.name, element: i.tile.name || null,
                trainId: t.id, trainType: t.type, trainTypeName: tt && tt.name ? tt.name : `type ${t.type}`,
                wantsDir: ex != null ? DIRNAMES[ex] : null, waitedSeconds: waitedSecs(t), clock: formatClock(state.simFrame) });
            }
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
    function checkWatches(){
      if (!state.watches.length) return;
      for (const w of state.watches){
        const tk = key(w.x, w.y);
        const cur = new Set();
        for (const t of state.trains){
          if (w.mode === "reach"){ if (t.x === w.x && t.y === w.y) cur.add(t.id); }
          else if (w.mode === "pass"){ const bt = t._tiles || computeBodyTiles(t); if (bt.has(tk)) cur.add(t.id); }
          else { // "approach"
            if (t.x === w.x && t.y === w.y) continue;          // already arrived → not "approaching"
            if (forwardPath(t, w.tiles || DEFAULT_APPROACH_TILES).includes(tk)) cur.add(t.id);
          }
        }
        const prev = w._on || new Set();
        if (w.mode === "pass"){ for (const id of prev) if (!cur.has(id)) fireWatch(w, id); }     // leaving edge
        else { for (const id of cur) if (!prev.has(id)) fireWatch(w, id); }                       // entering edge
        w._on = cur;
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
      for (const k in t){ if (k === "_tiles" || k === "_ap") continue; if (k === "holds") o.holds = (t.holds||[]).map(serHold); else o[k] = t[k]; }
      return o;
    }
    function serRouteLock(rl){ return {mk:rl.mk, switchKeys:rl.switchKeys, path:rl.path, trainId:rl.trainId, armed:rl.armed, enteredTile:[...rl.enteredTile], passedTile:[...rl.passedTile]}; }
    function snapshot(){
      return {
        version: 3,
        simFrame: state.simFrame, frame: state.frame, tick: state.tick, paused: state.paused, speedScale: state.speedScale || 1,
        nextTrainId: state.nextTrainId, nextStationId: state.nextStationId, selectedType: state.selectedType,
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
      state.nextTrainId = s.nextTrainId||1; state.nextStationId = s.nextStationId||1;
      state.trainTypes = (Array.isArray(s.trainTypes) && s.trainTypes.length)
        ? s.trainTypes.map(t => ({id:t.id, color:t.color||UNKNOWN_TYPE_COLOR, name:t.name||""})) : defaultTrainTypes();
      state.stations = (Array.isArray(s.stations) ? s.stations : [])
        .filter(st => st && st.rect)
        .map(st => { const r = normRect(st.rect); return {id:st.id, name:st.name||`Station ${st.id}`, instructions:st.instructions||"", rect:{x0:r.x0,y0:r.y0,x1:r.x1,y1:r.y1}}; });
      state.tiles = new Map();
      for (const it of (s.tiles||[])){ if (it && it.tile && Number.isFinite(it.x) && Number.isFinite(it.y)) setTile(it.x, it.y, it.tile); }
      state.trains = (s.trains||[]).map(deHydrateTrain);
      state.manualGreen = new Set(s.manualGreen||[]);
      state.routeLocks = (s.routeLocks||[]).map(deRouteLock);
      state.lockedSwitchKeys = new Set();
      state.events = s.events || [];
      updateSignals();
    }

    return { DEFAULT_TYPE_COLORS, DEFAULT_TYPE_NAMES, LEGACY_COLOR_IDS, UNKNOWN_TYPE_COLOR, defaultTrainTypes, trainTypeById, typeColor, nextTypeId, MAX_SPEED, ACCEL, DECEL, MIN_SPEED, DEFAULT_CARS, CAR_GAP, CAR_WIDTH, SIGNAL_REACTION_SECONDS, SIGNAL_SIDE_OFFSET, SPAWN_TICK_FRAMES, FRAMES_PER_SECOND, DEFAULT_DWELL_SECONDS, STOP_BROWN, SIGNAL_GREEN, SIGNAL_RED, SIGNAL_RED_DARK, MANUAL_RING, INACTIVE_BRANCH, LOCK_GREEN, BLOCK_GREY, DIRS, TRACK_SHAPES, buildDirectionalShapes, switchShape, buildSwitchShapes, SWITCH_SHAPES, SPAWN_SHAPES, STOP_SHAPES, SIGNAL_SHAPES, TOOLS, CROSSING_SHAPES, state, normRect, addStation, removeStation, stationContaining, key, readKey, opposite, cloneRoute, signalDirs, mkMain, parseMain, manualDirs, mainIsManual, mainIsManualKey, manualMainHasWaiter, routesFor, tileAccepts, switchCurrent, switchOther, switchLocked, switchAccepts, getTile, setTile, removeTile, defaultSwitch, makeTile, sortedRouteKey, findTrackShapeIndex, findDirShapeIndex, findSwitchShapeIndex, centerW, endpointW, lerpW, headWorld, trainCars, trainTotalLength, updateTrail, seedTrail, computeBodyTiles, trailSpan, trainMoving, exitFor, exitsForBlock, collectProtectedBlock, scanProtectedBlock, regionIdFor, buildSignalSystem, mainEligible, approachInfo, nextWantSeq, trainHolds, blockOccupiedByOther, inBlockRegion, updateSignals, holdForMain, mainIsGreenFor, blockFree, mainRenderGreen, mayRollThrough, occupied, maintainManualState, followManualRoute, toggleManualSignal, trainOccupies, canLeave, advanceWithSpeed, formatClock, placeLabel, trainDesc, registerStopArrival, notifyDeparture, stopDwellSeconds, moveTrain, spawnTrains, simStep, serialize, migrateTile, emit, setPaused, command, cmdThrowSwitch, cmdSetSwitch, cmdToggleSignal, cmdSetSignal, cmdSpawn, cmdRemoveTrain, tilesInStation, findStation, resolveElement, stationsReport, trainsReport, waitingTrainsReport, snapshot, applySnapshot, deserialize, applyLayout, EDIT_COMMANDS, addWatch, removeWatch, clearWatches, listWatches, watchCursor, watchEventsSince, notifyOwner, notifyOperator };
  }
  return { createEngine };
});
