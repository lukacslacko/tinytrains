# Features for the upcoming v2 of modern tinytrains

These are the things to actually build for V2. More speculative ideas
(currently parked for V3+) are collected at the bottom.

## Done so far in V2

### Phase 0 — done
- **Remove a train via right-click.** Right-clicking a tile a train sits on
  shows a "Remove train" button that deletes just that train (or all trains on
  the tile), without erasing the track.
- **One-click block boundary (signals both ways).** The track/signal right-click
  pop-up has a "+ both" / "− both" button that places (or clears) main signals
  in all route directions at once.

### Phase 1 — done
- **Train types instead of hard-coded colours.** Each layout now has a list of
  **train types**, each identified by a numeric id (starting at 1) with a
  display-only colour and an optional name. Spawns, stop filters and switch
  branch filters all refer to a type **by id**, so a type's colour or name can
  change without affecting any routing. The train-type list is saved/loaded
  (save format bumped to v2; old v1 saves with colour-name strings migrate to
  ids on load). The left panel has an inline train-types editor (select a type
  for new spawns, recolour/rename, add, remove unused).
- **Multi-colour filters.** Stop filters and each switch branch filter now hold
  a **set of type ids** instead of a single colour. An empty set means "any"; a
  filter matches a train when its type id is in the set. The right-click pop-up
  uses multi-select chips for these filters; markers render one coloured dot per
  selected type.

### Phase 2 — done
- **Stations.** A new **Station** tool drags out a named rectangular region,
  drawn with a faint tint + border and its name at the top-left. Membership is
  geometric (a stop/switch/signal belongs to the station whose rect contains its
  tile). The sidebar has a Stations list to rename/remove. Stops, switches and
  signals can be **named** (right-click → Name; the pop-up shows which station
  they fall in) with station-local labels like `1E`, `2W`, `A`, `2`; named
  elements draw their label on the tile. Stations are saved/loaded.
- **Named stops** (the trivial part of Timetables) — covered by the element
  naming above.
- **Documentation.** Wrote `DOCS.md`, an all-encompassing explanation of every
  aspect of the game. Keep it up to date with future changes.

### Phase 3 — done
- **Timetables.** A stop can carry a **timetable for each train type that stops
  there**. A timetable entry is a **recurrence period** (in seconds) plus a list
  of **departure times** (seconds within the period). Example: a stop "Foo City
  2E" can give train type *Express* a period of 60 s and departure times `10, 50`
  so it lets that type depart at each minute's `:10` and `:50`. Stops with no
  timetable for a train's type fall back to the simple **dwell-seconds** pause.
  - A **sim clock** (`state.simFrame`, 60 frames = one sim-second, shown in the
    status line as `mm:ss`) advances one frame per sim step and pauses with the
    simulation. Timetables are expressed against this clock.
  - When a train docks at a timetabled stop it is held until its **next
    scheduled slot at or after arrival**, then released (subject to the normal
    signal/occupancy checks). Arriving after a slot simply means catching the
    next slot — that still counts as on time.
  - Editing: the stop right-click pop-up has a **Timetable** section with one row
    per served type (period + departure-times text field). Blank = simple dwell.
    Timetables are saved/loaded inside the tile (still save format v2; additive,
    so older saves load unchanged) and sanitised on load.
- **Notification system.** A scrolling **chat-style notification window**
  (bottom-left of the map, collapsible, with a Clear button) reports operational
  events with the sim-clock time:
  - **info** (green) — a train departs a stop **on time** (and a plain
    "departed" line for departures from a *named* but un-timetabled stop).
  - **warning** (orange) — a train departs a timetabled stop **late** (held past
    its slot by more than a one-second grace), with the delay in seconds.
  - **alert** (red) — a **collision**, or a **missed departure** (a train held at
    a timetabled stop right through a whole schedule period without leaving).

### Phase 3 follow-up — done
- **Add a stop from the right-click pop-up.** The track-tile right-click pop-up
  now has an **"Add a stop facing"** row — one button per route direction (the
  same pattern as "Spawn a train heading"). Clicking a button converts the track
  tile into a **stop** for trains travelling that way (empty filter = any type,
  default dwell seconds), preserving the tile's route and caution. Right-click
  the new stop again to set its filter, dwell, timetable and name. This means a
  stop can be created without switching to the Stop palette tool.

## To do for V2

### Local AI station masters
A locally running model (e.g. via ollama) can act as a **station master** for a
station:
- It has access to the trains' positions and the states and connectivity of the
  station's stops, signals and switches (by their station-local names), and knows
  the timetables.
- It can be given station-specific instructions in natural language, e.g. for a
  small end-of-line station: "receive trains on the empty track" — the AI then
  sets the switches accordingly and only clears the inbound train's signal once
  the switches are set.
- The game exposes a clean state/action interface (read positions/aspects/
  switch states + timetable; set switch positions, set signal aspects) that the
  AI drives. Actions still respect the interlocking/safety rules.
- **Reversals belong here, not in the timetable.** Making a train reverse at a
  stop (head ↔ tail, run-around, change of direction) is a *shunting* operation
  driven by the **station-master / shunting-engineer / train-driver AIs**, not a
  property of a stop's timetable. The timetable only schedules *departures*.

## Later / more speculative (V3+)

### Night and day cycle in timetables
It would be nice to be able to store trains for night/off-peak times and let
them come in for the day/peak. This would require stops which
stop/release trains on a more complicated schedule than just modulo a
time interval.

This needs to be worked out for V3.

### Timetable editor
It would be nice, for a particular train type, to render a full-day timetable
in a graphical format, listing the stops along the line in the order they
come (with special stops where trains go for night/off-peak) and allow
editing the timetable in a graphical format.

This needs to be worked out for V3.

### Shunting
This should be figured out for V3 or V4. **Train reversal** (a train changing
direction at a terminal — decouple, run the loco round, recouple at the other
end) lives here: it is a shunting manoeuvre orchestrated by the station-master /
shunting-engineer AIs, not a timetable feature.

### Train driver AIs
Once shunting exists, individual trains could have **driver AIs** that receive
shunting instructions from the station-master AI and execute them. For example,
at a two-track terminal: when the train arrives, decouple the locomotive, run it
to the end of the track, change the switch, run around the cars on the other
track, then reverse and couple to the cars from the other end — so the train can
leave in the opposite direction. Depends on shunting, so V3/V4.
