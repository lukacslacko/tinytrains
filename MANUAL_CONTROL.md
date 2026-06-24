# Manual control (`manual.html`)

`manual.html` is a copy of `modern.html` reworked to support **manual control of
switches and blocks**, alongside the automatic switches and signals of the modern
builder. This file tracks the requested feature set and what is implemented.

> `modern.html` and `classic.html`/`index.html` are unchanged. All work here lives
> in `manual.html`. Layouts use their own browser-save key
> (`tinytrains-manual-layout`) and serialize as `version: 3`. Importing a modern
> (`version: 2`) layout is supported: it is auto-simplified on load (see point 2).

## Interaction model

- A new **Operate** tool (the default) is for *running* the railway:
  - **Left-click a switch** → throw it (toggle its direction). For a defaulting
    switch this moves the direction it rests at; for a manual switch it sets the
    fixed direction. Locked switches refuse to throw.
  - **Left-click a manual signal** → clear it to green (or set it back to red).
  - Drag still pans; wheel still zooms.
- **Right-click** any tile opens the context pop-up, which is where you *configure*:
  a switch's **Mode** (defaulting / manual) and default/current direction; a
  signal's per-direction **Auto ↔ Manual** type; stop dwell; names; etc.
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

### 5. Manual vs. defaulting switches — **done**
A switch has a **mode**:
- **Manual** — fixed at its `current` branch; the other branch is set against and
  impassable (a train arriving on it stops before the switch).
- **Defaulting** — rests at its `default` branch (stem → default). It can still be
  merged into from *either* branch (it yields), and **springs back** to its default
  once no train sits on it.

### 6. Switch rendering + click controls — **done**
- The **live route** (stem ↔ current branch) is drawn bright; the other branch dim,
  so the current direction is visible.
- A centre glyph shows the **mode**: a teal **circle** = defaulting, a yellow
  **square** = manual. A **red outline** marks a switch locked by a cleared route.
- **Left-click (Operate)** toggles the direction; **right-click** opens the pop-up
  which *allows* changing the mode (and default/current direction).

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

  *Residual caveat:* a **defaulting** switch on a locked route still yields to a train
  arriving on its other leg (locking prevents *throwing*, not *traversing*). In normal
  play no train can legally be on such a leg (that needs its own conflicting cleared
  route, which 2a forbids), so this is safe — noted rather than fully proven. Automatic
  blocks still flood through both switch legs, so an occupied flank leg also blocks an
  automatic grant.

### 10. This document — **done**
Points are listed here with status, and the work was delivered incrementally.

---

## Implementation notes (where things live in `manual.html`)

- **Switch model & traversal**: `defaultSwitch`, `switchCurrent/Default/Other`,
  `switchAccepts`, `exitFor`; defaulting spring-back in `revertDefaultingSwitches`
  and the in-`moveTrain` flip.
- **Automatic blocks only**: `buildSignalSystem` builds blocks/`distantCommit` for
  **automatic** mains only and fills `errorMains` (point 8 manual-entry + idea-1
  opposing-main checks); `approachInfo`, `updateSignals` grant via `mainEligible`
  (manual mains are never eligible — they have no block).
- **Manual signals & route locks**: `state.manualGreen`, `state.routeLocks` (each with
  per-switch `enteredSwitch`/`passedSwitch`), `state.lockedSwitchKeys`;
  `followManualRoute` (2a/2b/2c), `toggleManualSignal`, `maintainManualState`
  (per-switch unlock, point 3); the pass-revert/arm block in `moveTrain`.
- **Drive-on-sight (point 4)**: the next-tile checks in `moveTrain`/`canLeave`
  (`occupied`, `switchAccepts`) plus the manual-green / automatic-grant signal gate.
- **Operate tool**: `operateClick` (wired from `pointerup`).
- **Rendering**: `drawTileRoutes` (switch emphasis), `drawTileMarkers` (switch glyph
  + signal auto/manual/error/green/red).

## Known limitations / next steps

- **Residual flank caveat (point 9):** a *defaulting* switch on a locked route can
  still be *traversed* (not thrown) from its other leg; argued safe but not proven.
- **Idea 1 is same-tile** (an automatic main needs its opposing partner on the same
  tile). If you actually meant "anywhere along the block," say so and it can change.
- Automatic blocks still flood through *both* legs of a switch for occupancy.
- The bundled **Miskolc** preset was authored for the modern builder (type-routed
  switches, distants, timetables). It loads and runs, but every switch now rests at
  its default and its single-direction automatic signals **blink red** under idea 1
  (no opposing main), so it needs re-signalling/re-routing by hand to be interesting.
