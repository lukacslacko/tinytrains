# Manual control (`manual.html`)

`manual.html` is a copy of `modern.html` reworked to support **manual control of
switches and blocks**, alongside the automatic switches and signals of the modern
builder. This file tracks the requested feature set and what is implemented.

> `modern.html` and `classic.html`/`index.html` are unchanged. All work here lives
> in `manual.html`. Layouts use their own browser-save key
> (`tinytrains-manual-layout`) and serialize as `version: 3`. Importing a modern
> (`version: 2`) layout is supported: it is auto-simplified on load (see point 2).

## Interaction model

- A new **Operate** tool (the default) is for *running* the railway. Press **Tab** to
  flip between Operate and the last build tool.
  - **Left-click a switch** → throw it (set the other branch). Locked switches refuse
    to throw (and flash red).
  - **Left-click a manual signal** → clear it to green (or set it back to red). If a
    clear is refused, the signal's tile and the offending tile **flash red** for a
    second.
  - Drag still pans; wheel still zooms.
- **Right-click** any tile opens the context pop-up, which is where you *configure*:
  a switch's set **direction**; a signal's per-direction **Auto ↔ Manual** type; stop
  dwell; names; etc.
- Build with the **Tracks / Stops / Switches** palettes and the right-click
  spawn/signal actions, exactly as in the modern builder.

---

## Feature checklist

### 1. Manual control of switches and blocks — **done**
Switches (points 5/6) and manual signals (point 7) are implemented, including the
lighter flank-protection scheme (point 9) and on-sight running (point 4).

### 2. Simplification: drop distants, caution, visible pre-signal caution — **done**
- **Distant signals** removed entirely (tile kind, palette, context actions,
  rendering, and the distant reservation logic). On import, any `distant` tile
  becomes plain track.
- **Caution tracks** removed (the Caution tool, the per-tile flag, the orange
  stripe rendering, and caution-only braking). On import, caution flags are dropped.
- The (formerly visible) caution marker in front of a main is gone. Instead **every
  automatic main carries an *invisible distant* on the tile immediately before it**:
  a train that crosses it while the block is **free** takes the block and rolls
  through without slowing; if the block is **occupied** it brakes to a stop at the
  main and waits until the main shows green. (Implemented as an implicit
  `distantCommit` for every automatic main in `buildSignalSystem`.)
- "Main signal" is now "**automatic main signal**" in the UI / docs.

### 3. No crashes — all trains proceed with caution — **done**
Collisions are removed. A train only enters a tile when it is empty; otherwise it
brakes to a stop before it (the old "caution" behaviour, now universal). `crashTrains`
and all crash rendering/notifications are gone.

### 4. Remove timetables and all stop/switch filters — **done**
Timetables (schedules, slots, per-stop scheduler, missed-departure alerts, the
per-type period) are removed. A stop now simply **dwells** and halts every train.
Stop type-filters and switch branch type-filters are removed; routing is purely by
switch setting. Train **types** remain but are now cosmetic (they colour spawned
trains). On import, filters/timetables are discarded.

### 5. Switches — **done (manual only)**
All switches are **manually set**: fixed at their `current` branch, with the other
branch set against and impassable (a train arriving on it stops before the switch).
*(The earlier "defaulting / spring-back" mode was removed per request — there is no
longer a `mode` on a switch.)*

### 6. Switch rendering + click controls — **done**
- The **set route** (stem ↔ current branch) is drawn bright; the other branch a bit
  **darker** so the set direction is clear.
- A switch carries **no marker when free**, and a **green disc** when locked into a
  cleared manual route (green = "good / reserved").
- **Left-click (Operate)** throws the switch (also flashes red if it's locked);
  **right-click** opens the pop-up to set its direction.

### 7. Non-automatic (manual) main signals — **done**
Every main is automatic or manual (toggle per direction in the signal pop-up).
- **Automatic**: default green when its block is clear (block-based, single occupant).
- **Manual**: default **red** and has **no block / no occupancy state** — it is a pure
  operator-cleared *route gate*. In Operate mode click it to clear a route, which
  succeeds only when (following the live switch settings) the path:
  - crosses **no switch already locked** by another cleared route *(2a)*;
  - reaches a signal **facing the direction of travel** *(2b — a signal facing the
    other way is transparent and does not count)*;
  - has **no axle anywhere on it, up to and including that signal** *(2c)*.
  On success it **locks every switch on the route** and turns green *(2d)*. The main
  drops back to **red the moment a train passes**, and each switch unlocks the instant
  the train's **last axle clears it** *(point 3)*. Click a cleared (not-yet-taken)
  signal again to cancel.
- Trains run **on sight** in manual territory *(point 4)*: a train stops only for an
  occupied tile directly ahead, a **manual** switch set against it, or a red signal —
  nothing else. More than one train may move in manual territory at once *(2e/2f)*.
- A cleared route is drawn on the map as a **green outline** along the set track (a
  thick green band, then black, then the white rail on top). As the train runs the
  route the outline (and the switch locks) **drop tile-by-tile behind it**; the tiles
  ahead stay marked until it has passed them.
- Automatic and manual mains render distinctly (manual = yellow outline).

### 8. Automatic mains need all-automatic block entries — **done**
An automatic main is valid only if **every** entry into the block it protects is also
an automatic main. A block with a **manual entry** could be entered on sight (no
grant), so its automatic mains can't keep it exclusive → they show the **blinking-red
error state** and **trains cannot pass** them.

**Plus idea 1 — no protected-block→open-track leak:** an automatic main must also have
an **opposing-direction main on the same tile** (the other end of its route; build it
with `+ both`). Without one it blinks red and is impassable — otherwise it would lead a
train out of a protected block into completely unprotected track. *(I read "an opposing
direction signal on its track" as **same tile**; in an automatic-only layout this makes
every block boundary complete, so a train always meets a forward-facing main at the far
end of any block it enters.)*

### 9. Flank protection — **done (lighter scheme, per idea 2)**
Achieved without the heavy defaulting-switch flood originally sketched:
- Clearing a manual route **locks all its switches**, and a route **cannot be cleared
  across a switch another route already locked** *(2a)*. So two routes never share a
  switch, and a locked switch can't be thrown under a train.
- Every train in manual territory is on a cleared, switch-locked route and drives on
  sight, so a flank train can't be admitted onto a path it would foul, and even two
  trains meeting stop rather than collide.
- With switches now manual-only, a switch set against a movement is **impassable**
  (no yielding), which removes the earlier defaulting-switch caveat entirely. Automatic
  blocks still flood through both switch legs, so an occupied flank leg also blocks an
  automatic grant.

### 10. This document — **done**
Points are listed here with status, and the work was delivered incrementally.

---

## Shunting — **done** (branch `shunting`)

Trains are **consists of units** — engines and cars, front-to-back, each unit with a persistent
id; exactly one engine per consist is **active** and drives it. A cut of cars (no active engine)
never moves but occupies track. Coupled vehicles **touch** (no gap); rendering insets each unit's
rounded caps so bodies meet at the coupling without overlapping. Inactive (hauled) engines draw
dimmed; the front-of-consist dot is white in drive mode, amber while shunting.

- **Exact tile paths.** Besides the sampled trail, every train keeps `path` — the ordered tiles
  under it (`{x, y, enter, exit}` head-first), maintained on every step. Reversing and splitting
  re-derive the head's discrete state from it exactly, including mid-tile (buffers-touching) stops.
- **Reverse** flips units/path/trail in place; an engine behind cars then pushes them. Refused if
  the new front would pass a red manual main; passing a green one does the normal drop-red+arm-lock
  bookkeeping.
- **Uncouple / couple.** `detach` cuts at a coupling (`keep` cars stay on the active engine); the
  standing portion becomes a new engineless consist. `couple` merges with the touching consist
  (either end; the other consist is reversed in place if needed) — the commanding engine stays
  active, picked-up engines go inactive, and the merged train keeps its identity: a consist is
  EXPOSED (UI/API/MCP) under its **active engine's fixed unit id** — engine "2" dropping some
  cars and picking up others is still train "2"; a pure cut of cars goes by its first vehicle's
  id. Internal consist ids stay internal.
- **Modes** (`setTrainMode`): `drive` (normal), `shunt` (~⅓ speed, skips stop dwell, and replaces
  the one-tile standoff with a per-frame forward scan that clamps motion to the **touch distance**
  of the next body) and `stop` (the handbrake: the consist stands where it is even when it could
  move). A shunting consist that comes to a stand buffers-to-buffers enters `stop` by itself, so a
  `couple` never sends the merged train creeping off — couple → reverse → drive is the idiom.
  Switching to `drive` is refused while the buffers touch stock ahead (the one-tile standoff is
  already gone and a driving train would pull straight through) — and as a belt-and-braces
  backstop, a drive-mode train whose head shares a tile with another body engages the touch clamp
  too, so stock can never be driven through even from a forced state.
  Signals apply to the leading end in every mode (3d: the "flagman" rides the leading car).
  A shunting consist also **never crosses a station boundary outward**: it halts on the last
  tile inside the station like at a signal at danger, stays in shunting mode, and can be
  reversed back — the boundary is a natural shunting limit (entering a station is allowed).
- **Signalling extensions.** A manual route may terminate at a **buffer** (stub), and a **shunt
  clear** (`clearSignal … shunt:true`) may open a route into occupied track (to couple); its route
  lock releases once the move comes to a stand.
- **Shunting discs.** A bidirectional shunt-only signal carried by a plain two-ended track tile
  (`shuntSignal`; never on switches, buffers, crossings, stops or signal tiles — a manual signal
  already halts shunting moves). **Clear by default**: a white disc with a black rim at the tile
  centre, drawn above the rails but below the trains (a shunter standing on it covers it, like
  any lineside equipment; its state stays visible in reports); set to
  **stop** it turns **bright blue** and halts SHUNTING moves at the disc — every other train
  ignores it in both states. Operate-click toggles it; the right-click menu on a track tile
  adds/removes one (placed clear) and names it. State flips via the operate commands
  `toggleShuntSignal` / `setShuntSignal` (no layout undo, like throwing a switch), the
  station API `POST /api/stations/:id/shunt-signal`, and MCP `set_shunt_signal`; station reports
  list `shuntSignals`, and a held shunter surfaces as a `waiting` event.
- **Station rule.** reverse/uncouple/couple (and entering shunt mode) are refused unless the
  consist stands inside a station — and inside *that* station when ordered through the
  station-scoped API. Shunting is the station master's job (see `STATION_MASTER.md`).
- **UI.** Right-click any tile under a consist: composition, Reverse, Drive/Shunt/Stop, Couple,
  and an Uncouple button per coupling; manual signals gain per-direction "clear for shunting"
  buttons. A shunt-cleared main renders as a **red triangle with a green ring** (vs. the proper
  green of a normal clear); the front-of-consist dot is white/amber/red for drive/shunt/stop.
  Every **closed coupling** carries a small light disc, so connected vehicles read differently
  from ones merely standing buffer-to-buffer; a cut with **no engine** draws a **red outline**
  (handbrakes on) instead of the normal black one. Under an occupied-block / cleared-route halo
  (whose dark band runs along BOTH legs of a switch) the switch's **set-against outbound leg
  draws its inactive marker thick**, cutting through the band's black outline (the inbound stem
  keeps its normal outlined look), so the dead leg can't be mistaken for a live rail and which
  way the switch lies stays obvious.
  Left-clicking a **bidirectional** manual signal in Operate operates the main on the side of the
  track that was clicked (each main's triangle sits to the right of its travel direction).
  Spawning a train (right-click a track tile, or a spawn tile's config) takes a **number of
  cars** to put behind the engine.
- **Test case.** `examples/shuttle.json` — a single line between two run-around termini; an
  engine+car shuttle whose engine runs around the car at each end. `node test/engine-shunt.test.js`
  (in-process geometry + a full round trip) and `node test/shuttle.test.js` (the same choreography
  through the HTTP Station-Master API against a real isolated server).

---

## Server-only authoritative mode + external control API — **done**

The game **always** runs on a **server** (there is no single-page / offline mode), so it can be
driven from outside through an API (now the **Station Master**; later the engine driver), and games
are saved/loaded/continued directly on disk. Run it with **`node server.js`** (default port 8765),
then open `http://localhost:8765/manual.html`.

- **Shared engine (`engine.js`).** The DOM-free simulation was extracted out of `manual.html`
  into `engine.js` and is the single source of truth — the **same code** runs in the browser and
  on the server. `TinyTrainsEngine.createEngine()` returns one isolated sim with: the state +
  rules (tiles, switches, signals, route locks, `simStep`, `updateSignals`, …), `serialize` /
  `deserialize` / `applyLayout`, a full `snapshot()` / `applySnapshot()` (Sets made JSON-safe), an
  event buffer (`emit`, replacing the old DOM `notify`), **one `command()` dispatch for every
  mutation** — operate (`throwSwitch`/`setSwitch`/`toggleSignal`/`clearSignal`/`redSignal`/`spawn`/
  `removeTrain`) **and** edit (`setTile`/`removeTile`/`setStations`/`setTrainTypes`/`pasteTiles`/
  `removeTiles`) — plus Station Master helpers (`stationsReport`, `resolveElement`).

- **Server (`server.js`, Node, zero deps).** Serves the static files; owns the **one live game**;
  ticks it with the shared engine (authoritative — runs with no browser open); streams snapshots
  over Server-Sent Events. On boot it **resumes the most recently saved game** (or creates an empty
  one), and it **autosaves the current game after every change** to `./games/<id>.json`, so
  "whenever anything changes" the saved state is updated. Edit commands feed a layout undo/redo
  history that does not rewind the running sim.
  - General API: `GET /api/state`, `GET /api/time` (simulation time of day — seconds within the
    current `dayLength`), `GET /api/events` (SSE), `GET /api/games`, `POST /api/command`
    (any of the command types above, incl. `setSpeed` and `setDayLength`),
    `POST /api/game/{new,load,save,save-as,rename,pause,step,undo,redo}`.
  - **Station Master API:** `GET /api/stations` (each station's **instructions** plus its switches
    and manual signals, by station-local name, with live settings),
    `POST /api/stations/:id/switch` `{name|x,y, to}` and
    `POST /api/stations/:id/signal` `{name|x,y, dir?, action:clear|red}` — the station master sets
    switches and clears/holds manual signals by the same station-local labels a human uses;
    `POST /api/stations/:id/override` `{text}` / `{action:"clear"}` — set or clear a **standing
    instruction override** (temporary chat orders that take precedence until cleared; persisted).

- **Client (server-only).** `manual.html` is a thin client: on load it connects to the live game
  (`/api/events`), renders each streamed snapshot, and sends **every** action — operate *and* edit
  (build, stations, train types, paste/delete, pause/step, undo/redo) — to the server as a command
  (`POST /api/command` or the `/api/game/*` endpoints). It never simulates locally. The **Game**
  panel shows the live status, the current game's name (editable → autosaved rename), a **Load
  game** dropdown of saved games, **Save as new game** (fork to a new save), **New from template**,
  and Export/Import JSON (Import starts a new game). There is no browser save / "Run on server" /
  "Disconnect" — the server is always the source of truth and autosaves continuously.

## Station Master instructions — **done**

Every station carries free-text **`instructions`** for its Station Master (the operator/API that
sets the station's switches and manual signals). **Right-click a station's name** on the map (or
the `✎` button in the sidebar station list) to rename it and edit the instructions; a station with
instructions shows a `✎` after its name. The field travels with the layout (serialize/deserialize)
and is surfaced to the Station Master API via `GET /api/stations`.

---

## Implementation notes (where things live in `manual.html`)

- **Switch model & traversal**: `defaultSwitch` (manual only — `current`),
  `switchCurrent/Other/Accepts`, `exitFor`.
- **Automatic blocks only**: `buildSignalSystem` builds blocks/`distantCommit` for
  **automatic** mains only and fills `errorMains` (point 8 manual-entry + idea-1
  opposing-main checks); `approachInfo`, `updateSignals` grant via `mainEligible`
  (manual mains are never eligible — they have no block).
- **Manual signals & route locks**: `state.manualGreen`, `state.routeLocks` (each with
  a `path` of `{k,seg}` tiles plus `enteredTile`/`passedTile`), `state.lockedSwitchKeys`;
  `followManualRoute` (2a/2b/2c, returns the path), `toggleManualSignal`,
  `maintainManualState` (per-tile release behind the train, point 3); the pass-revert/arm
  block in `moveTrain`. The on-map green outline is `drawManualRouteOutlines` (green then
  black bands under the rails, skipping `passedTile`).
- **Drive-on-sight (point 4)**: the next-tile checks in `moveTrain`/`canLeave`
  (`occupied`, `switchAccepts`) plus the manual-green / automatic-grant signal gate.
- **Operate / refusal flash / Tab**: `operateClick` (wired from `pointerup`),
  `flashTiles` + `drawFlash` (red 1 s flash on a refused operation, wall-clock timed),
  and the `Tab` handler in the `keydown` listener (toggles Operate ↔ `state.lastTool`).
- **Rendering**: `drawTileRoutes` (set route bright, other branch darker via
  `INACTIVE_BRANCH`), `drawTileMarkers` (green disc `drawLock` when a switch is
  locked, nothing otherwise; signal auto/manual/error/green/red).

## Known limitations / next steps

- **Idea 1 is same-tile** (an automatic main needs its opposing partner on the same
  tile). If you actually meant "anywhere along the block," say so and it can change.
- Automatic blocks still flood through *both* legs of a switch for occupancy.
- The Save / Load dropdown ships two native manual layouts to play with: **Loopy**
  (small) and **Miskolc** (larger), both mixing automatic and manual signals.
