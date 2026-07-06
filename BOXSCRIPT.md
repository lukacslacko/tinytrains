# Boxscript — the station automation language

A small, event-driven DSL for automating one station: a **scripted station master**. It is the
third kind of master besides a human and an LLM — same job, same powers, deterministic.
*Implemented*: the interpreter lives in `boxscript.js`, runs **in the server** (one instance per
station, driven from the engine's `simStep`, 4 passes per sim-second), and drives the *same
internal operations the Station Master API exposes* (`set_path`, signal ops, engine orders).
Everything the script can do, the interlocking still polices — a script can request an unsafe
route, and it simply fails (and the failure shows up in the execution log).

The script is stored on the station (next to its free-text instructions — edit it in the
station pop-up's **Automation script** box, or via `POST /api/stations/:id/script` /
the `set_script` MCP tool) and **persists with the game**, including the interpreter's live
state: variables, in-flight manoeuvres and the execution log ride along in every snapshot, so a
server restart resumes a script mid-shunt. A script that does not compile is stored anyway (so
you can fix it) but runs nothing; the compile error comes back from the save and is logged.

**Editing workflow** (the station pop-up; same protocol over the API):

- What you type is a **draft, auto-saved as you type** (`POST { draft }` — persisted with the
  game, compile-checked live, shown again when you reopen the pop-up). The running script is
  untouched until you press **Deploy** (`POST { script }`), which lights up whenever the editor
  differs from what is running. Deploying brings the draft back in sync.
- **Pause / Run** (`POST { paused: true|false }`): a paused station's script routes nothing —
  arrange the trains by hand, then press Run. Its state (variables, chains, log) is kept, and
  the pause itself is noted in the execution log. Time triggers that came due while paused
  fire once (their latest missed moment) on resume. The flag persists with the game.
- **Format** reprints the script through `boxscript.js`'s token-based formatter: indentation
  and spacing are normalized, comments and the author's line structure survive (a one-liner
  body stays a one-liner), redundant end-of-line semicolons drop. A broken script is never
  "formatted" — you get the syntax error instead.
- Clicking into the script box **widens the pop-up** and grows the editor; it shrinks back
  when focus leaves the script section.

```
# A two-platform terminus, fully automated.
platform_1_busy := false
platform_2_busy := false

on (any at A) {
  if (!platform_1_busy)      { clear 1,2,3,C; platform_1_busy := true }
  elif (!platform_2_busy)    { clear 1,4,D;   platform_2_busy := true }
}
on (any at C) { clear 3,2,B;   platform_1_busy := false }
on (any at D) { clear 4,3,2,B; platform_2_busy := false }
on (any at X) { reverse }
on (any at Y) { reverse }
```

Statements separate by newline or `;`; comments start with `#`.

---

## 1. Elements a script can talk about

Scripts refer to infrastructure by **station-local names**, exactly as the Station Master API
does — and *any* tile can now carry a name:

- **signals** — letters by convention (`A`, `B`);
- **switches** — numbers (`1`, `2`);
- **shunting discs** — e.g. `S`;
- **stubs** — a dead-end/buffer track tile takes a letter too (`X`, `Y`): it is signal-like in
  that trains stop and stand at it, so it fires events and can be a `permit … to` limit;
- **plain track** — a named plain tile is a **waypoint** a `permit` path can steer by (useful
  to pin down which of two routes a shunt should take, e.g. through a loop).

Right-click any track tile → **Name** to set one; named tiles draw their label on the map.
Only consists **with an active engine** generate events; a parked cut of cars never fires
`at` — you reach it by shunting onto it and coupling.

## 2. Events and the scheduler

Handlers have the form

```
on [PRIO] (GUARD) { BODY }
```

`PRIO` is any integer, default `0`, higher = more urgent. `GUARD` is either a **train guard**
`TYPE at ELEMENT` (`TYPE` = a train-type name or id, or `any`) or a **time** (§5).

**Events are level-triggered, not edge-triggered.** A pending event exists for every train
currently *standing* at a named element of the station, stamped with when it stopped there.
(This is the lesson already baked into the LLM masters, which must sweep for already-waiting
trains because notifications are edge-triggered — the DSL builds the sweep in, so no train is
ever stranded by a missed edge.)

The **handle loop** runs a pass four times per sim-second:

1. Any **due time handlers** run first, each exactly once per trigger (§5).
2. Chains in progress (§7) advance where their conditions have come true.
3. For each priority tier, highest first: take the pending train events **longest wait first**;
   for each, try its matching handlers **in script order** until one *resolves* it.
4. The moment anything resolves, **restart the pass from the top** — a resolution changes the
   world (a platform variable freed, a route released), and the longest-waiting train must get
   first claim on the new state. (25 rounds per pass is the livelock backstop.)

**Resolution and failure.** Within a body, statements run in order. An *action* can fail
(route won't lock, reverse refused, `require` false): failure **stops the attempt there** —
"don't do the rest" — earlier statements are not rolled back, and the event **stays pending**,
to be retried on a later pass. An attempt that reaches the end of the body **resolves** the
event iff at least one action succeeded along the way. A body that completes but did nothing
(e.g. every `if` arm false) does **not** resolve — the event stays pending and simply gets
re-evaluated as the world changes. That is exactly what the platform example above wants: a
train at `A` with both platforms busy waits, and the pass-restart after `on (any at C)` frees
platform 1 routes it in immediately.

A resolved event is **consumed**: that (train, element) pair won't match again until the train
has actually left the element and stopped there anew. So `clear` won't re-fire during the
seconds between clearing the signal and the train pulling away.

**Retries re-run the whole body segment** — statements before the failing action run again.
The convention (no special language machinery): **put assignments after the action they
record**, as in the platform example, so a retried failure never double-counts.

## 3. Actions

Every action grounds in an existing operation:

| Action | Meaning |
|---|---|
| `clear P1,…,Pn` | Set the whole route and clear the entry signal for its direction (`set_path`). |
| `clear S` | Clear signal `S` (every manual main on it — use the form below to pick one way). |
| `clear S,DIR` | Clear only signal `S`'s main facing compass `DIR`, e.g. `clear A,E` for a departure east — the way to disambiguate a both-ways signal. |
| `permit P1,…,Pn [to L]` | Clear a **shunting route** (§6). |
| `red S` | Put signal `S` back to danger. |
| `reverse` | Reverse the event's train (only while stopped). |
| `uncouple after N` | Cut so `N` vehicles stay behind the active engine (`uncouple {keep:N}`). |
| `couple` | Merge with the touching consist. The engine **settles the merged geometry automatically** (the "short pull" that used to be needed by hand), so reverse/uncouple immediately after coupling just work. |
| `shunt` / `drive` / `stop` | Set the consist's mode (`stop` = handbrake). |
| `wait until (T)` | Suspend the rest of the body until time `T` (§5). Waits **once** per event: if a later statement fails and the body is retried, the wait is already satisfied and is not re-waited. |
| `require (EXPR)` | Fail the attempt unless `EXPR` is true. |
| `say EXPR` | Message the operator (station chat / notifications), e.g. `say "train " + train.id + " stored"`. |

**Path shorthand.** In a train-event handler, if a `clear` path does not begin with a signal,
the event's element is prepended — so `on (red at A) { clear 1,2,B }` sets the path `A,1,2,B`
and clears `A`, and `on (any at C) { clear 3,2,B }` routes out from `C`. Write the full path
(`clear A,1,2,B`) when clearing on behalf of no train, e.g. in a time handler.

Engine orders (`reverse`, `couple`, `uncouple`, modes) implicitly act on **the event's train**;
in a time handler they are an error. A train's identity survives shunting (it is its active
engine's fixed id), so a chain keeps addressing the right consist across cuts and couplings.

## 4. Variables and expressions

- `name := expr` at **top level** declares a station variable and sets its initial value at
  script (re)load. Inside a body, `:=` assigns; an undeclared name is a **compile error**.
- Values: booleans, numbers, strings, times. Operators: `! && ||`, comparisons, `+ -`
  (`+` concatenates when either side is a string; `==` compares strings case-insensitively).
- `if (…) { } elif (…) { } else { }`.
- In a train-event body, `train` is bound: `train.id`, `train.type` (type name),
  `train.typeId`, `train.cars`, `train.units`, `train.touching`, and **`train.heading`** (the
  compass it wants to leave by — `"W"`, `"NE"`, … — the way to tell an arrival from a
  departure at a both-ways signal). `train at E` is a boolean (usable in `require`/`if`).
- `time` is the current game time of day (§5), comparable against time literals.

Guarding with a variable gives condition-events for free: `on (any at A) { if (daytime) {
clear 1,2,B } }` leaves the train pending until `daytime` flips true — the pass after
`on (6:00) { daytime := true }` picks it up.

## 5. Time

The game's day clock is `dayLength` sim-seconds long (`get_time`). Boxscript time literals are
**24-hour-clock times mapped onto that day**: `H:MM` means the fraction `(H·3600+M·60)/86400`
of `dayLength` — with the default 600-second day, `12:00` is 300 s into the day. `hh` is a
wildcard hour, so `hh:00` means "the next top of (any) hour".

- `on (3:00) { … }` fires **once** when the clock reaches/passes 3:00, once per game day.
  A pattern guard (`on (hh:30)`) fires once per matching moment. On script load, times already
  past today count as fired. Time handlers run once even if their body fails partway — like
  `wait until`, time triggers never re-arm for the same moment.
- `wait until (hh:00)` inside a handler is the timetable primitive:

```
on (red at B) { wait until (hh:00); clear 1,2,B }
```

  The train is claimed when the wait arms; at the hour, the rest of the body runs (and is
  retried on failure — but the wait itself is spent).

Time handlers cannot contain `when`/`wait until` (there is no train to follow).

## 6. Shunting permits

`permit P1,…,Pn [to L]` clears a shunting route along the listed waypoints — **any named
elements**, in travel order: signals, switches, discs, stubs, named plain tiles. Switches the
route crosses **must be listed** (that is how the route is pinned down); everything else is
walked through. An optional final compass direction (`permit A,1,W`) disambiguates a last
switch entered via its stem, exactly like `set_path`.

- Listed switches are set so the route threads through them (locked switches refuse).
- Every **manual main facing the move** along the route is cleared **for shunting**
  (white / red-with-green-outline) — including signals you list as waypoints, e.g.
  `permit B,1 to X` shunt-clears `B` itself. (Each such clear still needs a valid route
  terminus ahead — the next facing signal or a buffer — like any shunt clear.)
- Every **disc** on the route is set to *clear* (white).
- **`to L` sets the limit of movement**: a signal there is set (kept) **red** facing the
  arriving move; a disc there is set to **blue** (stop); a stub needs nothing — the track ends.
- **No `to`** — movement is permitted until a natural obstacle: touching stock (buffers meet),
  a buffer, or the station boundary (a shunting consist never leaves the station).

A shunting route may lead into occupied track (that is how you go and couple), and its lock
releases when the move comes to a stand — all existing semantics. `permit` is also on the API:
`POST /api/stations/:id/path { path, shunt:true, to? }`.

## 7. Sequential shunting: `when` chains

Multi-step manoeuvres read sequentially; the interpreter compiles them into a chain of one-shot
handlers bound to the specific train — **the user never sees the state machine**:

```
BODY0
when (COND1) { BODY1 }
when (COND2) { BODY2 }
…
```

- `BODY0` runs as a normal handler attempt; reaching the first `when` **claims the train** and
  arms `COND1` for it.
- Chain conditions: `at ELEMENT`, `touching`, a time, or any boolean expression — all
  evaluated for the chain's train.
- When an armed condition becomes true, its body is attempted; **on failure it is retried** on
  later passes (the condition, once fired, stays fired — same "once" rule as `wait until`);
  on success the next `when` arms. `wait until (T); rest` is exactly sugar for
  `when (time ≥ T) { rest }`.
- A **claimed** train is skipped by ordinary `on` handlers until the chain ends (last body
  resolves) — the run-around must not be interrupted by the arrival rule matching its engine at
  some signal mid-manoeuvre.
- If the chain becomes impossible (train removed, drove out of the station in drive mode, the
  script was edited), it aborts with an alert in the execution log and the train is released.
- `when` / `wait until` live at the **top level** of a handler or `when` body — never inside
  `if` arms (the chain must be linear).

The scripted run-around from `test/boxscript.test.js` — the same choreography the shuttle
example plays by hand, here fully automated at West (stub named `X`, one loop tile named `L`):

```
on (any at A) {
  if (train.heading == "W") { clear 1,B }     # arrival: onto track 1
  else { clear A,E }                          # departure: out east
}
on (any at B) { runaround(train) }

macro runaround(t) {
  require (t at B)
  uncouple after 0
  shunt
  permit B,2 to X                             # pull clear onto the stub
  when (at X)     { permit 2,L,1 to A; reverse }   # around the loop, up to A
  when (at A)     { permit A,1,W; reverse }        # back onto occupied track 1
  when (touching) { couple; reverse; drive }
}
```

## 8. Macros

```
macro NAME(param, …) { … }
```

Macros expand inline at the call site (no recursion); arguments substitute into expressions
*and* into element names/paths. `when` inside a macro joins the caller's chain, so a whole
manoeuvre packages up as one word:

```
macro store_last_car(t) {
  require (t at B)
  uncouple after 1                       # leave the last car standing at B
  shunt
  permit B,1 to X
  when (at X)      { permit 1,2,S,3,4 to T }
  when (at T)      { permit 4,A; reverse }
  when (touching)  { couple; reverse; uncouple after 2; permit A,4 to T }
  when (at T)      { permit 4,3,S,2 to Y }
  when (at Y)      { uncouple after 1; permit 2,S,3,4 to X }
  when (at X)      { permit 4,A; reverse }
  when (touching)  { couple; reverse; stop }
}

on (freight at B) { store_last_car(train) }
```

(`S` is a named shunting disc appearing mid-path; `X`, `Y`, `T` are named stubs.)

## 9. The execution log

Every station script keeps an **execution log**: each event that fired, each action taken
(with its result), each failure (with the engine's reason), chain steps, time triggers, script
loads and compile errors — stamped with the sim clock, last 300 entries, persisted with the
game. Repeated retries of the *same* failure are logged once, so a blocked route doesn't flood
the log four times a second.

- **UI** — the station pop-up shows the log under the script editor (live while open).
- **API** — `GET /api/stations/:id/script-log?after=N` → `{ entries, cursor }`; pass the
  previous `cursor` as `after` to get only what's new.
- **MCP** — `get_script_log(after?)`, next to `get_script` / `set_script`.

This is what makes scripts a **token saver for AI station masters**: a master can write a
script for the mechanical part of its instructions, leave it running, and check the log at the
end of its shift — instead of being woken for every train. (The operating guide tells masters
exactly that.)

## 10. Grammar

```
script    := { topstmt }
topstmt   := NAME ":=" expr  |  handler  |  macro
handler   := "on" [ INT ] "(" guard ")" block
guard     := type "at" NAME  |  timepat
type      := "any" | NAME | INT
macro     := "macro" NAME "(" [ NAME {"," NAME} ] ")" block
block     := "{" { stmt } "}"
stmt      := action | assign | ifstmt | whenstmt | call
assign    := NAME ":=" expr
ifstmt    := "if" "(" expr ")" block { "elif" "(" expr ")" block } [ "else" block ]
whenstmt  := "when" "(" cond ")" block
call      := NAME "(" [ expr {"," expr} ] ")"
action    := "clear" path | "permit" path [ "to" NAME ] | "red" NAME
           | "reverse" | "couple" | "uncouple" "after" INT
           | "shunt" | "drive" | "stop"
           | "wait" "until" "(" timepat ")" | "require" "(" expr ")" | "say" expr
path      := NAME { "," NAME }
cond      := "at" NAME | "touching" | timepat | expr
timepat   := (HOUR | "hh") ":" MINUTE
expr      := the usual: ! && || == != < <= > >= + -, literals, names,
             "train" "." field, EXPR "at" NAME, "time", "true", "false"
```

Words are `[A-Za-z0-9_]+`, so element names like `1E` are single tokens; newlines are plain
whitespace (`;` optional).

## 11. Where it lives

- `boxscript.js` — lexer/parser/compiler, the token-based `format`, + the per-station
  scheduler (`compile`, `createRunner`); UMD like `engine.js`, so the browser uses it too
  (the Format button runs it client-side).
- `engine.js` — attaches a runner per engine, drives it from `simStep`; `setScript` /
  `permitPath` commands; `getScript` / `scriptLog` readers; the coupling geometry
  auto-settle (`extendPathAlongRails`); station `script` field through every persistence path.
- `server.js` — `GET/POST /api/stations/:id/script`, `GET …/script-log`, `permit` on the
  `/path` endpoint; the operating guide's *Scripts* section.
- `mcp-server.js` — `get_script`, `set_script`, `get_script_log`.
- `manual.html` — the station pop-up's script editor (draft autosave, Deploy with
  dirty-highlight, Pause/Run, Format, focus-widening) + live log; the Name field on any track
  tile (stub letters, waypoints).
- Tests — `test/boxscript-parse.test.js` (grammar), `test/boxscript.test.js` (scheduler
  semantics + the fully scripted shuttle run-around), `test/boxscript-http.test.js` (API).

## 12. TODO

- **Cross-station coordination** by message passing: a `send STATION, "text"` action and
  `on (message "…")` events, so one station's script can announce a departure and the next
  station's script can prepare the path. Out of scope for now (as it is for the AI masters —
  coordination is left to the per-station instances).
- Operator overrides (`set_override`) do not yet pause or shadow a running script; for now the
  operator edits the script itself (or clears it) to intervene.
