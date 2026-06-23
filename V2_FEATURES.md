# Features for the upcoming v2 of modern tinytrains

These are the things to actually build for V2. More speculative ideas
(currently parked for V3+) are collected at the bottom.

## To do for V2

### Multi-colour filters
Filters on stops and switches can have **multiple colours/train types**
selected at once, instead of a single colour or "any". A filter matches a
train when its type is in the selected set (an empty set still means "any").
Applies to switch branch filters and stop colour filters.

### Train types instead of hard-coded colours
Train colours should not be hard-coded. Instead, each layout has a list of
**train types**:
- A train type is primarily identified by a numeric id, starting at 1.
- Each train type can also be given a colour, used only for rendering.
- Spawns, filters, timetables, etc. refer to train types by id (the colour
  is just a display attribute that can be changed without affecting logic).
- The layout's train-type list is part of what is saved/loaded.

### Remove a train via right-click
The user should be able to **right-click on a train** and remove just that
train, without having to erase the track tile it is sitting on. (Today the
only way to remove a train is to erase its tile.)

### One-click block boundary (signals both ways)
In the track tile right-click pop-up, add a single button that places
**main signals in both route directions at once**. This makes setting up a
block boundary (a signal each way on one tile) a one-click action instead of
toggling each direction separately.

### Documentation
Write an all-encompassing documentation explaining all aspects of the game.
Keep it up to date with all future changes.

### Timetables
- Stops may have names.

- Stops may have a timetable for each train type which stops there. The
  timetable has a recurrence (modulo how many minutes or seconds) and
  departure times (within that modulus, at what times it should let a train
  depart). For example, a stop can be called "Foo City 2E" for the Eastward
  departure from platform 2 of Foo City, and for a given train type it could
  have a modulus of 1 minute, and departure times 10s and 50s to let a train
  go at each minute :10 and :50.

- Stops might cause a train of some type to reverse there.

### Stations
Group signals and switches (and stops) into named **stations**:
- Draw a station boundary (a region) to define a station; give it a name.
- Station tiles are drawn with a bit of background colour to show their extent.
- Elements inside a station can be named:
  - Stops named like platforms/tracks with a direction, e.g. `1E` for the
    eastward stop of track 1.
  - Switches named `1`, `2`, …
  - Signals named `A`, `B`, …
- These names are how a (human or AI) station master refers to the station's
  infrastructure.

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

## Later / more speculative (V3+)

### Night and day cycle in timetables
It would be nice to be able to store trains for night/off-peak times and let
them come in for the day/peak. This would require stops which
stop/reverse/release trains on a more complicated schedule than just modulo a
time interval.

This needs to be worked out for V3.

### Timetable editor
It would be nice, for a particular train type, to render a full-day timetable
in a graphical format, listing the stops along the line in the order they
come (with special stops where trains go for night/off-peak) and allow
editing the timetable in a graphical format.

This needs to be worked out for V3.

### Shunting
This should be figured out for V3 or V4.

### Train driver AIs
Once shunting exists, individual trains could have **driver AIs** that receive
shunting instructions from the station-master AI and execute them. For example,
at a two-track terminal: when the train arrives, decouple the locomotive, run it
to the end of the track, change the switch, run around the cars on the other
track, then reverse and couple to the cars from the other end — so the train can
leave in the opposite direction. Depends on shunting, so V3/V4.
