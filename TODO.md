# Tiny Trains — future work

Backlog captured from design discussion. Not yet implemented.

## 3a. Copy / cut / paste / undo with rectangular selection
- Let the user drag-select a rectangular area of tiles.
- Support bulk operations on the selection: copy, cut, paste (at a new
  location), and delete.
- Add undo (and ideally redo) for edits — at minimum for the bulk
  operations, ideally for all tile edits.

## 3b. Distant signals placed manually, further than one tile
- Once main signals can be placed via right-click (done for mains), support
  the same right-click placement for **distant** signals.
- Allow a distant signal to be placed more than one tile before its main.
- **Stop auto-placing distant signals.** Instead:
  - If a main signal has a manually placed distant, use it.
  - If a main signal has **no** distant before it, place a *virtual caution
    sign* on the tile(s) before it (in the direction toward the main). Trains
    approaching such a main always slow to a stop at the main; then, if it is
    green, they occupy the block and continue after `SIGNAL_REACTION_SECONDS`.
    (i.e. without a distant there is no "roll through on green" — the train
    always brakes to the main and reacts.)

## 3c. Multi-part trains (engine + cars)
- A train becomes multiple connected entities instead of a single point.
- Each part has a `length`; render each as a rectangle of that length and a
  width wider than the track, oriented so its ends align with the rails, and
  connect consecutive parts appropriately around curves.
- Signals/blocks count **axles** passing (treat the start and end of each
  rectangle as an axle); block occupancy is based on axle count, not a
  single point.
- For now ignore mass/inertia of cars, engine power, etc.

## 3e. Multiple signals (different directions) on the same tile
- Allow more than one signal on a single tile, facing different directions.
- This lets blocks connect seamlessly by having opposing main signals share
  a tile (a main facing each way at the same spot).

## 3f. "Caution" track type
- A new track property/overlay rendered with an orange outline.
- On a caution track, trains drive slowly and ready to stop at the next tile,
  and may encounter another train and safely stop (no crash).
- On normal (non-caution) track, encountering another train is a **crash**:
  render it with blinking red and require the user to resolve it.
- Add a tool (like Erase) that toggles the caution outline on/off for a tile.

## 3d. Recompute blocks & axle counts when signalling changes
- When a new signal is added (e.g. a main with no opposing signal yet, so its
  block covers a large area), recompute all blocks and recount the axles
  inside each.
- Goal: avoid "virtual" trains — blocks that report occupancy that no longer
  reflects reality after an edit.
