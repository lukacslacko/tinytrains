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
