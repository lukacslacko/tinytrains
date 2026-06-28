// Tiny Trains — Station Master MCP server (Node, zero dependencies).
//
// Exposes one station's controls to an AI as MCP tools, so you can run ONE AI instance per station,
// each acting as that station's master. It is a thin client of the game server (server.js) over
// HTTP, scoped to a single station.
//
//   node mcp-server.js --station <name|id> [--server http://localhost:8765]
//   (env: TINYTRAINS_STATION, TINYTRAINS_SERVER)
//
// Configure it in an MCP host (e.g. Claude Code) as a stdio server, one per station:
//   "tinytrains-tiszai": { "command": "node",
//     "args": ["/abs/path/mcp-server.js", "--station", "Tiszai"],
//     "env": { "TINYTRAINS_SERVER": "http://localhost:8765" } }
//
// Transport: MCP over stdio = newline-delimited JSON-RPC 2.0 (one message per line) on stdin/stdout.
// The notification mechanism: the AI calls `await_events`, which long-polls the server and BLOCKS
// until a watched train approaches/arrives, then returns the event. Keep calling it — it is the
// station master's event loop. (MCP has no reliable way to spontaneously wake an idle model; a
// blocking tool the agent waits inside is the robust, host-agnostic pattern.)

"use strict";

function arg(name, envName, def){
  const i = process.argv.indexOf("--" + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (envName && process.env[envName]) return process.env[envName];
  return def;
}
const SERVER = (arg("server", "TINYTRAINS_SERVER", "http://localhost:8765")).replace(/\/$/, "");
const STATION = arg("station", "TINYTRAINS_STATION", "");
const GAME = arg("game", "TINYTRAINS_GAME", ""); // which game on the server this station belongs to

let cursor = 0; // last seen watch-event seq, advanced by await_events

function log(...a){ process.stderr.write("[station-master] " + a.join(" ") + "\n"); } // stderr: never on the protocol stream

// Every call is scoped to this server's GAME: appended to the query for GET, merged into the body
// for POST/DELETE. So this MCP instance only ever touches its own game.
async function api(method, path, body){
  let url = SERVER + path;
  if (method === "GET" && GAME) url += (path.includes("?") ? "&" : "?") + "game=" + encodeURIComponent(GAME);
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method !== "GET" ? JSON.stringify(Object.assign({ game: GAME }, body || {})) : undefined
  });
  let json = null; try { json = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, body: json };
}
function need(station){
  const s = station || STATION;
  if (!s) throw new Error("no station configured — start with --station <name> or pass a station argument");
  return s;
}

// ---- Tools --------------------------------------------------------------------------------
const TOOLS = [
  { name: "get_guide",
    description: "Read the global Station Master operating brief FIRST: how the railway works, how to read your instructions, and the proactive routing loop (watch arrivals → await_events → set route + clear signal before the train arrives).",
    inputSchema: { type: "object", properties: {} },
    run: async () => (await api("GET", "/api/guide")).body.guide },

  { name: "get_my_instructions",
    description: "Your station's free-text orders: which switches to set and signals to clear for each arriving train (by line/type and entry point). Read this after the guide.",
    inputSchema: { type: "object", properties: { station: { type: "string", description: "station override (defaults to this server's station)" } } },
    run: async (a) => (await api("GET", `/api/stations/${encodeURIComponent(need(a.station))}/instructions`)).body },

  { name: "list_stations",
    description: "List all stations on the railway (names) for context. You only operate your own.",
    inputSchema: { type: "object", properties: {} },
    run: async () => ((await api("GET", "/api/stations")).body.stations || []).map(s => ({ name: s.name, switches: s.switches.length, signals: s.signals.length })) },

  { name: "get_infrastructure",
    description: "Your station's switches and signals with their LIVE state: each switch's branches and current set direction (and whether it is locked by a route), and each signal's mains (manual/automatic, green/red). Use station-local element names from here.",
    inputSchema: { type: "object", properties: { station: { type: "string" } } },
    run: async (a) => (await api("GET", `/api/stations/${encodeURIComponent(need(a.station))}`)).body.station },

  { name: "set_switch",
    description: "Set one of your switches so its stem connects to the given branch. direction is a compass bearing: N, NE, E, SE, S, SW, W, NW (it must be one of the switch's branches). Refused if the switch is locked by a route in progress.",
    inputSchema: { type: "object", properties: {
      element: { type: "string", description: "station-local switch name, e.g. '1'" },
      direction: { type: "string", description: "compass bearing: N/NE/E/SE/S/SW/W/NW" },
      station: { type: "string" }
    }, required: ["element", "direction"] },
    run: async (a) => (await api("POST", `/api/stations/${encodeURIComponent(need(a.station))}/switch`, { name: a.element, to: a.direction })).body },

  { name: "clear_signal",
    description: "Clear one of your manual signals to green, opening (and locking) the route ahead following the current switch settings. Set the switches FIRST. Refused (with a reason) if the path is broken, occupied, or conflicts with another locked route.",
    inputSchema: { type: "object", properties: { element: { type: "string", description: "station-local signal name, e.g. 'A'" }, station: { type: "string" } }, required: ["element"] },
    run: async (a) => (await api("POST", `/api/stations/${encodeURIComponent(need(a.station))}/signal`, { name: a.element, action: "clear" })).body },

  { name: "set_signal_red",
    description: "Set one of your manual signals back to red (only works before a train has taken the cleared route).",
    inputSchema: { type: "object", properties: { element: { type: "string" }, station: { type: "string" } }, required: ["element"] },
    run: async (a) => (await api("POST", `/api/stations/${encodeURIComponent(need(a.station))}/signal`, { name: a.element, action: "red" })).body },

  { name: "watch",
    description: "Ask to be notified about a train at one of your elements. mode: 'approach' (fires EARLY, while the train is still heading toward it a few tiles away — use this to route proactively), 'reach' (train arrives on it), or 'pass' (train's tail clears it). Returns a watch id. Then call await_events to receive the notifications.",
    inputSchema: { type: "object", properties: {
      element: { type: "string", description: "station-local element name" },
      mode: { type: "string", enum: ["approach", "reach", "pass"], description: "default 'approach'" },
      tiles: { type: "number", description: "for 'approach': how many tiles of lead (default 6)" },
      station: { type: "string" }
    }, required: ["element"] },
    run: async (a) => { const st = need(a.station); return (await api("POST", "/api/watches", { station: st, owner: st, element: a.element, mode: a.mode || "approach", tiles: a.tiles })).body.watch; } },

  { name: "watch_arrivals",
    description: "Convenience: set an 'approach' watch on EVERY signal in your station at once, so you are warned about all incoming trains. Call this once at startup, then loop on await_events.",
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["approach", "reach", "pass"] }, station: { type: "string" } } },
    run: async (a) => {
      const st = need(a.station);
      const station = (await api("GET", `/api/stations/${encodeURIComponent(st)}`)).body.station;
      const made = [];
      for (const sig of (station.signals || [])) {
        if (!sig.name) continue;
        const w = (await api("POST", "/api/watches", { station: st, owner: st, element: sig.name, mode: a.mode || "approach" })).body.watch;
        if (w) made.push(w);
      }
      return { watching: made.map(w => ({ element: w.element, mode: w.mode, id: w.id })) };
    } },

  { name: "await_events",
    description: "BLOCK until something happens for you, then return it: a watched TRAIN (the train's type number/name + which element + approach/reach/pass), or a MESSAGE from the human operator (mode 'message', with the text). THIS IS HOW YOU RECEIVE NOTIFICATIONS — call it, act on what it returns (route trains per your instructions; answer operator messages with send_message), then call it again. If nothing happens within timeout_seconds it returns no events; just call it again to keep waiting.",
    inputSchema: { type: "object", properties: { timeout_seconds: { type: "number", description: "how long to block, default 25, max 55" }, station: { type: "string" } } },
    run: async (a) => {
      const owner = need(a.station);
      const wait = Math.min(Math.max(Number(a.timeout_seconds) || 25, 1), 55);
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), (wait + 5) * 1000);
      try {
        const res = await fetch(`${SERVER}/api/notifications?owner=${encodeURIComponent(owner)}&after=${cursor}&wait=${wait}${GAME ? "&game=" + encodeURIComponent(GAME) : ""}`, { signal: ctrl.signal });
        const j = await res.json();
        if (typeof j.cursor === "number") cursor = j.cursor;
        const events = (j.events || []).map(e => e.mode === "message"
          ? { mode: "message", from: e.from || "operator", message: e.text, clock: e.clock }
          : { mode: e.mode, train: e.trainTypeName, trainType: e.trainType, trainId: e.trainId, element: e.element, clock: e.clock });
        return events.length ? { events } : { events: [], note: "nothing within " + wait + "s — call await_events again to keep watching" };
      } finally { clearTimeout(to); }
    } },

  { name: "send_message",
    description: "Send a message to the human operator (it pops up in the game's notifications and highlights your station). Use it to report status, ask a question, or reply to an operator message.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, station: { type: "string" } }, required: ["text"] },
    run: async (a) => (await api("POST", `/api/stations/${encodeURIComponent(need(a.station))}/operator-message`, { text: a.text })).body },

  { name: "list_watches",
    description: "List the watches you currently have registered.",
    inputSchema: { type: "object", properties: { station: { type: "string" } } },
    run: async (a) => (await api("GET", `/api/watches?owner=${encodeURIComponent(need(a.station))}`)).body.watches },

  { name: "cancel_watch",
    description: "Remove a watch by its id.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    run: async (a) => (await api("DELETE", `/api/watches/${Number(a.id)}`)).body }
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));

// ---- JSON-RPC over stdio ------------------------------------------------------------------
function send(msg){ process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result){ send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message){ send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg){
  const { id, method, params } = msg;
  if (method === "initialize"){
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "tinytrains-station-master" + (STATION ? ":" + STATION : ""), version: "0.1.0" },
      instructions: `You are the Station Master for station "${STATION || "(unset)"}" in game "${GAME || "(default)"}". Call get_guide and get_my_instructions, then watch_arrivals, then loop on await_events — acting on each notification.`
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // no response
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === "tools/call"){
    const tool = TOOL_BY_NAME[params && params.name];
    if (!tool) return reply(id, { content: [{ type: "text", text: "unknown tool: " + (params && params.name) }], isError: true });
    try {
      const out = await tool.run((params && params.arguments) || {});
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      return reply(id, { content: [{ type: "text", text }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: "error: " + (e && e.message ? e.message : String(e)) }], isError: true });
    }
  }
  if (id != null) return replyError(id, -32601, "method not found: " + method);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0){
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    Promise.resolve(handle(msg)).catch(e => log("handler error:", e && e.message));
  }
});
process.stdin.on("end", () => process.exit(0));
log(`ready — station="${STATION || "(unset)"}" game="${GAME || "(default)"}" server=${SERVER}`);
