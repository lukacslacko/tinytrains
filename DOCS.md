# Tiny Trains — full documentation

This document explains every aspect of the game. It covers the **modern**
builder (`modern.html`), which is the actively-developed version. Keep this file
up to date whenever behaviour changes.

> The three HTML files in this repo:
> - **`index.html`** — the landing menu.
> - **`classic.html`** — a verbatim port of the original PICO-8 pixel train sim.
>   *Frozen — do not change.*
> - **`modern.html`** — the modern builder/simulator this document describes.
>   *Frozen files (`classic.html`, `index.html`) must stay untouched.*

---

## 1. Concept

Tiny Trains is a tile-based model railway you build and watch run. You lay
track on a grid, place spawns that emit trains, and add switches, stops and
signals so trains route themselves and never collide. The modern version is a
clean **graph model**: exactly **one track per tile**, and switches are drawn as
only their two routes (a clean Y), never as messy pixel fragments.

The simulation is continuous: trains are smooth path-followers, so it looks good
even in slow motion. Safety comes from per-cell occupancy plus a block-signal
system — trains brake, hold at red signals, and stop safely behind one another.

---

## 2. The tile graph model

The world is an infinite grid of cells. Each occupied cell holds **one tile**.
Connections between tiles use the **8 compass directions**, indexed `0..7`:

```
0 N    1 NE   2 E    3 SE   4 S    5 SW   6 W    7 NW
```

A tile exposes a set of **ports** (directions) and connects them in pairs:

- A **route** is a pair of ports a train can travel between, e.g. `[2,6]` is a
  straight E–W track; `[2,4]` is a 90° E–S curve; `[1,5]` is a NE–SW diagonal.
- Movement is symmetric along a route: a train entering from `W (6)` leaves
  `E (2)` and vice-versa.
- `opposite(d)` is `(d+4) % 8` — the reverse direction.

Tiles never have two parallel lanes; the whole point of the graph model is one
clean track per cell.

---

## 3. Tile kinds

| Kind | Purpose |
|------|---------|
| `track` | Plain track: one route (straight, curve, diagonal, bend). |
| `crossPlus` | A `+` crossing: two routes `[N–S]` and `[E–W]` that cross without connecting. |
| `crossX` | An `×` crossing: two diagonal routes `[NW–SE]` and `[NE–SW]`. |
| `switch` | A **stem** plus two **branches** (a straight + a 45° diagonal). Routes by train type. |
| `spawn` | Emits a train of a chosen type in a chosen direction, then becomes plain track. |
| `stop` | Halts matching trains for a dwell time (a station platform). |
| `signal` | A **main** block signal (green when the block ahead is clear, red when taken). |
| `distant` | A repeater placed before a main so a train can roll through on green. |

Any tile may also carry a **caution** flag (see §8) and, for stops/switches/
signals, a **name** (see §9).

### Shapes

Each placeable kind has a **shape palette** in the sidebar:

- **Tracks** — straights, 90° curves, 45° diagonals and orth↔45° bends.
- **Crossings** — `Cross +` and `Cross ×`.
- **Stops** — one per facing direction.
- **Switches** — the available stem/branch geometries.

Pick a shape from the palette, then click cells to place copies of it.

---

## 4. Editing

### Tools (left sidebar, "Tool")

| Tool | Action |
|------|--------|
| **Select** | Drag a rectangle to select tiles (for copy/cut/paste/delete). |
| **Station** | Drag a rectangle to create a named station region (see §9). |
| **Caution** | Click a tile to toggle its caution flag (see §8). |
| **Erase** | Click a tile to remove it. |

Plus the shape palettes (Tracks, Stops, Switches, Crossings): selecting a shape
makes that the active placing tool.

### Mouse

- **Left-click** a cell to place the current tile/shape.
- **Left-drag** on empty tool / track tool to **pan** the view.
- **Wheel** to **zoom** (zoom centres on the cursor).
- **Middle-click** a tile to **pick** it (adopt its kind/shape/orientation, and a
  spawn's train type, as the active tool).
- **Right-click** a configurable tile to open its **context pop-up** (see below).

### Keyboard

| Key | Action |
|-----|--------|
| `Space` | Pause / resume the simulation. |
| `s` | Single simulation step (while paused, advances one tick). |
| `Ctrl/Cmd+Z` | Undo · `Shift+Z` or `Ctrl/Cmd+Y` redo. |
| `Ctrl/Cmd+C` / `X` / `V` | Copy / cut / paste the selection (paste anchors at the hovered cell). |
| `Delete` / `Backspace` | Delete the current selection. |
| `Esc` | Close pop-ups; then clear selection; then deselect the tool. |

Undo/redo covers **tile** edits. Trains and stations are not part of tile undo
(remove a train via right-click; remove a station from the Stations list).

### Context pop-up (right-click)

The pop-up adapts to the tile kind. Common controls:

- **Route** — change the shape of a track/stop/spawn tile.
- **Spawn a train heading …** (track tiles) — turn the tile into a spawn.
- **Block signals (toggle each way)** — add/remove a main signal per direction,
  or **`+ both` / `− both`** to place/clear mains in *all* route directions at
  once (one-click block boundary).
- **Distant signals (toggle each way)** — add/remove distant repeaters.
- **Remove train** — appears when a train sits on the tile; deletes just that
  train without erasing the track.
- **Name** — for stops/switches/signals (see §9).
- **Apply** / **Delete**.

---

## 5. Train types

Colours are **not** hard-coded. A layout owns a list of **train types**:

- Each type has a **numeric id** (starting at `1`), a **display colour**, and an
  optional **name**.
- Spawns, stop filters and switch branch filters all refer to a type **by id** —
  so changing a type's colour or name **never** changes any routing.
- The type list is saved and loaded with the layout.

**Editor** (sidebar, "Train types"): each row is a type — click its swatch to use
that type for new spawns, edit its colour inline, rename it, and remove it with
`×` (only allowed when no spawn/filter/train still references it). `+ Add type`
appends a new id. There is always at least one type.

---

## 6. Spawns and trains

A **spawn** tile emits one train heading in its set direction, then immediately
becomes plain track (so the line stays clear). The emitted train carries the
spawn's **train type** (which drives colour and routing). Trains are multi-part
(an engine plus trailing cars) and follow their route smoothly, bodies trailing
through curves. A train only spawns when the cell ahead is free.

Remove a train at runtime by right-clicking its tile → **Remove train**.

---

## 7. Switches and colour routing

A switch has a **stem** and two **branches** (a straight + a 45° diagonal),
rendered as only those two routes — a clean Y.

- A train arriving on a **branch** always exits the **stem** (merge).
- A train arriving on the **stem** picks a branch by **type filter**:
  - Each branch has a filter that is a **set of train-type ids**.
  - **Routing rule:** the first branch whose set *contains* the train's type
    wins; otherwise the first branch with an **empty** set (= "any") is taken;
    otherwise the switch's default branch.
- Filters can be changed **while the simulation runs** (right-click the switch).

Branch-filter markers draw one coloured dot per selected type, at the midpoint of
the branch.

### Crossovers between parallel tracks

A crossover is built from a **diverging** switch + a couple of diagonal tiles +
a **merging** switch. Merge orientation matters: the stem must be the shared
**output** direction, with the two inputs as straight + branch — e.g.
`Switch(stem E, branches W, NW)` so both through-W and ladder-NW traffic exit E.
Getting the merge backwards derails through traffic.

---

## 8. Stops, dwell, and caution

### Stops

A **stop** halts a train heading out its facing direction for a **dwell** time
(seconds, configurable), then releases it — a station platform. A stop has a
**type filter** (a set of ids): an empty set stops **any** train; otherwise it
only stops trains whose type is in the set (others pass straight through). The
platform bar is drawn alongside the stopped train.

### Caution track

Toggle **caution** on a tile with the Caution tool (orange outline). On caution
track a train **crawls** and will **stop safely** behind another train instead of
crashing. On normal track, meeting another train is a **crash** (blinking red);
erase a crashed tile to clear it.

---

## 9. Stations and naming

A **station** is a named **rectangular region**. Membership is geometric: a stop,
switch or signal "belongs" to the station when its tile lies inside the rect.

- **Create:** pick the **Station** tool and drag a rectangle. It gets a default
  name (`Station N`) and a faint tint + border showing its extent, with its name
  drawn at the top-left.
- **Manage:** the sidebar **Stations** list lets you **rename** or **remove**
  each station. (Stations are not part of tile undo.)
- **Element names:** right-click a stop, switch or signal → **Name** to give it a
  station-local label. The pop-up shows which station it falls in. Conventionally:
  - **stops** named like platforms with a direction: `1E`, `2W`;
  - **switches** numbered: `1`, `2`;
  - **signals** lettered: `A`, `B`.
  Named elements draw their label at the bottom-left of the tile (when zoomed in
  enough to read).

These names are how a (human or, later, AI) **station master** refers to the
station's infrastructure.

---

## 10. Signals, blocks and safety

The interlocking is the safety floor — it refuses unsafe movement rather than
advising against it.

- **Blocks.** The track graph is divided into **blocks** at main signals. A block
  is the connected run of track from one main up to the next main (or a dead
  end). Blocks and their occupancy are **recomputed every frame and on every
  edit** from the live train bodies, so changing signalling never leaves a
  "virtual" train in a block.
- **Main signals** show **green** when the block they protect is clear and
  **red** when it is taken. A train may only enter a block it has been granted.
  A main can face several directions on one tile (e.g. one each way), so two
  blocks meet on a single tile — use **`+ both`** to set that up in one click.
- **Distant signals** are manual repeaters placed one or more tiles *before* a
  main. With a distant present, a train can **roll through** the main on green at
  speed. A main with **no** distant shows a hollow caution marker, and trains
  always brake to it and pause briefly before proceeding.
- **Occupancy / collisions.** Each cell tracks occupancy from train bodies. On
  normal track, two trains meeting is a crash; on caution track they queue
  safely. Trains accelerate to a max speed and brake along a curve so they coast
  to a stop exactly on the tile they must halt at.

---

## 11. Save / load and the file format

- **Save Browser / Load Browser** — persist the layout in this browser's
  `localStorage`.
- **Export JSON / Import JSON** — copy the layout to/from text.

The serialized layout (format **version 2**) is:

```json
{
  "version": 2,
  "trainTypes": [ { "id": 1, "color": "#f05264", "name": "red" }, ... ],
  "stations":   [ { "id": 1, "name": "Foo City", "rect": {"x0":..,"y0":..,"x1":..,"y1":..} }, ... ],
  "tiles":      [ { "x": 0, "y": 0, "tile": { "kind": "track", "route": [2,6] } }, ... ],
  "view":       { "x": 0, "y": 0, "zoom": 1 }
}
```

Tile fields of note: `type` (spawn's train-type id), `filter` (stop's id set),
`filters` (switch's per-branch id sets), `name` (element name), `caution`.

**Migration.** Older **v1** saves keyed spawns/filters on colour-name strings
(`"red"`, `"blue"`, …). On load they migrate automatically to the v2 model:
`red→1, blue→2, yellow→3, green→4, violet→5`; a spawn's `color` becomes `type`;
a single colour filter becomes a one-element id set; "any" becomes an empty set.
Nothing built on an old save breaks.

---

## 12. Roadmap

Done so far in V2: one-click block boundary, remove-train-by-right-click, train
types by id, multi-colour filters, stations + element naming, this document.

Still planned (see `V2_FEATURES.md`): **timetables** (named stops, per-type
departure schedules, reversing stops), and **local AI station masters** (a clean
state/action interface a scripted or LLM-driven master can drive, with the
interlocking still enforcing safety). Speculative V3+: night/day timetables,
a graphical timetable editor, shunting, and per-train driver AIs.
