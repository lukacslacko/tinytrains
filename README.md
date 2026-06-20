# tinytrains

A self-running railway simulation, ported from a [PICO-8](https://www.pico-8.com)
cart to a single self-contained HTML page.

The original is a clever pixel-buffer simulation: the screen *is* the game
state. Trains are five-pixel "snakes" that read the track painted into the
framebuffer and steer themselves — running their routes, pausing at stations,
taking switches, while an automatic block-signalling system (a flood-fill over
connected track) keeps them from colliding. There is no player input.

## Play

Open [`index.html`](index.html) in any browser, or just double-click it. The
view auto-scales to fill the window.

Controls: **Pause** (Space), **Reset** (R), **Speed**, **Sound**.

## Files

- `index.html` — the finished, self-contained game (no dependencies).
- `train3.p8` — the original PICO-8 cart.
- `generate.py` — rebuilds `index.html` from the cart: `python3 generate.py`.

## How the port works

`index.html` embeds the cart's sprite (`__gfx__`), map (`__map__`), and sound
(`__sfx__`) data verbatim, reproduces PICO-8's primitives (`cls`/`pget`/`pset`/
`spr`/`mget`/`sfx`) over a 128×128 colour-index framebuffer, and translates the
Lua game logic 1:1 to JavaScript, so the simulation behaves like the original.

## License

[MIT](LICENSE)
