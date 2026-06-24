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
- The bundled **Loopy** preset (Save / Load dropdown) is a small native manual layout
  with a mix of automatic and manual signals to play with.
