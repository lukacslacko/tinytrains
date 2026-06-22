# tinytrains

A self-running railway simulation, ported from a [PICO-8](https://www.pico-8.com)
cart to a single self-contained HTML page.

The original is a clever pixel-buffer simulation: the screen *is* the game
state. Trains are five-pixel "snakes" that read the track painted into the
framebuffer and steer themselves — running their routes, pausing at stations,
taking switches, while an automatic block-signalling system (a flood-fill over
connected track) keeps them from colliding. There is no player input.

## Play

Open [`index.html`](index.html) in any browser, or just double-click it. It now
links to both versions:

- [`modern.html`](modern.html) — a new tile-based control simulation with a
  sleek editor, switch color filters, train spawns, stops, signals, draggable
  pan, mouse-wheel zoom, browser save, and JSON import/export.
- [`classic.html`](classic.html) — the original PICO-8 style port.

The classic view auto-scales to fill the window.

Classic controls: **Pause** (Space), **Reset** (R), **Speed**.

## Files

- `index.html` — version selector.
- `modern.html` — the new tile-based control simulation.
- `classic.html` — the finished, self-contained classic game (no dependencies).
- `train3.p8` — the original PICO-8 cart.
- `generate.py` — rebuilds `index.html` from the cart: `python3 generate.py`.

## How the port works

`index.html` embeds the cart's sprite (`__gfx__`) and map (`__map__`) data
verbatim, reproduces PICO-8's primitives (`cls`/`pget`/`pset`/`spr`/`mget`)
over a 128×128 colour-index framebuffer, and translates the Lua game logic 1:1
to JavaScript, so the simulation behaves like the original.

## License

[MIT](LICENSE)
