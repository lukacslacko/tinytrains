# Features for the upcoming v2 of modern tinytrains

## Documentation
Write an all-encompassing documentation explaining all aspects of the game.
Keep it up to date with all future changes.

## Timetables

- Stops may have names.

- Stops may have a timetable for each train color which stops there. The
  timetable has a recurrence (module how many minutes or seconds) and
departure times (within that modulus, at what times it should let a train
depart). For example, a stop can be called "Foo City 2E" for the Eastward
departure from platform 2 of Foo City, and for red trains it could have a modulus of 1
minute, and departure times 10s and 50s to let a train go at each minute :10
and :50.

- Stops might cause a train of some color reverse there.

## Night and day cycle in timetables

It would be nice to be able to store trains for night/off-peak times and let
them come in for the day/peak. This would require stops which
stop/reverse/release trains on more complicated schedule than just module a
time interval.

This needs to be worked out for V3.

## Timetable editor

It would be nice, for a particular color of trains, to render a full-day
timetable in a graphical format, listing the stops along the line in the
order they come (with special stops where trains go for night/off-peak) and
allows editing the timetable in a graphical format.

This needs to be worked out for V3.

## Shunting

This should be figured out for V3 or V4.
