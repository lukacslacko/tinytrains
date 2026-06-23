# Tiny Trains — work log

All items below have been implemented in `modern.html`.

## 3a. Copy / cut / paste / undo with rectangular selection — done
- Select tool drag-selects a rectangle (Esc clears).
- Copy/Cut/Paste (Ctrl/Cmd+C/X/V); paste anchors at the hovered cell.
  Delete/Backspace clears the selection.
- Undo/Redo of all tile edits (Ctrl/Cmd+Z / Shift+Z / Ctrl+Y, plus buttons).

## 3b. Manual distant signals, possibly several tiles before the main — done
- Distants are placed by right-click (toggle each way) and may sit one or
  more tiles before their signal; they repeat the main's aspect.
- Auto-distants removed. A main with a distant lets a train roll through on
  green; a main with no distant shows a hollow caution marker and trains
  always brake to it and react before going.

## 3c. Multi-part trains (engine + cars) — done
- Trains have a `cars` list of lengths; the body trails the head along its
  path and renders as engine + cars (bands wider than the rail), following
  curves. Block occupancy is taken from the whole body (axle-equivalent).

## 3d. Recompute blocks & axle counts when signalling changes — done
- Blocks are rebuilt and occupancy re-derived from live train bodies every
  frame and on every edit, so changing signalling never leaves "virtual"
  trains in a block.

## 3e. Multiple signals (different directions) on one tile — done
- Signal tiles carry a `dirs` list; the block system is keyed by
  (tile, direction), so a main each way can share a tile and join blocks.

## 3f. "Caution" track type — done
- Caution tool toggles an orange-outlined caution flag on a tile. Trains
  crawl on caution tiles and stop safely behind one another; on normal
  track meeting another train is a crash (blinking red, erase to clear).
