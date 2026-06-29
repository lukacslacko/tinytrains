# Example games

Sample tinytrains game states, in the same JSON format the server saves to `games/` (which is
gitignored). Each file is `{ id, name, savedAt, snapshot }` — a complete, loadable save.

- **`miskolc.json`** — the Miskolc layout: 3 stations (Tiszai, Foter, Szikra) with named switches and
  manual signals and per-station Station Master instructions, 138 tiles, 8 trains. This is the layout
  used throughout the docs and the station-master examples.
- **`miskolc_depot.json`** — a depot variant of Miskolc: 4 stations, 196 tiles, 8 trains, with a
  600-second day length set, so it works with time-of-day instructions ("during game time between
  2 and 8 minutes …"). Loads as a separate game ("Miskolc Depot") alongside `miskolc.json`.

## Loading one

Either:

- copy it into the server's games dir and it shows up in the **Load game** dropdown —
  `cp examples/miskolc.json games/`, then pick it in the UI (or `node server.js` resumes the
  most-recent save); or
- in the manual UI, use **Import** (Game panel) and pick the file.
