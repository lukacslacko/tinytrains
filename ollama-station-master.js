// Tiny Trains — Station Master driven by a LOCAL LLM via Ollama (Node, zero dependencies).
//
//   node ollama-station-master.js --station Tiszai[,Foter,...] --game Miskolc [--model qwen2.5:7b]
//   (env: TINYTRAINS_SERVER, OLLAMA_URL, OLLAMA_MODEL)
//
// Feasibility: yes, this works on a MacBook Pro with a tool-calling local model (qwen2.5, llama3.1,
// mistral-nemo). THIS SCRIPT owns the loop (polls /api/trains for STOPPED trains — no look-ahead); the
// model only does the easy part — route the trains stopped at the station per its instructions.
// One agent can manage several stations (in one game): each decision uses that station's own context.

"use strict";
function arg(name, env, def){ const i = process.argv.indexOf("--" + name); if (i >= 0 && process.argv[i+1]) return process.argv[i+1]; if (env && process.env[env]) return process.env[env]; return def; }
const SERVER = arg("server", "TINYTRAINS_SERVER", "http://localhost:8765").replace(/\/$/, "");
const OLLAMA = arg("ollama", "OLLAMA_URL", "http://localhost:11434").replace(/\/$/, "");
const MODEL  = arg("model", "OLLAMA_MODEL", "qwen2.5:7b");
const STATIONS = arg("station", "TINYTRAINS_STATION", "").split(",").map(s => s.trim()).filter(Boolean);
const GAME = arg("game", "TINYTRAINS_GAME", "");
if (!STATIONS.length){ console.error("usage: node ollama-station-master.js --station <name[,name2,...]> [--game <name>] [--model <ollama-model>]"); process.exit(1); }
const DIRS = ["N","NE","E","SE","S","SW","W","NW"];

async function gj(path){ const r = await fetch(SERVER + path + (path.includes("?") ? "&" : "?") + (GAME ? "game=" + encodeURIComponent(GAME) : "")); return r.json(); }
async function gp(path, body){ const r = await fetch(SERVER + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ game: GAME }, body)) }); return r.json(); }

const TOOLS = [
  { type: "function", function: { name: "set_path", description: "Route a train the easy way: path = [entry signal, then the switches in order, optional final compass dir]. Lines up every switch and clears the entry signal. Use for any 'set path …' instruction, e.g. set path 1,2,3 at A → [\"A\",\"1\",\"2\",\"3\"].",
    parameters: { type: "object", properties: { path: { type: "array", items: { type: "string" } } }, required: ["path"] } } },
  { type: "function", function: { name: "set_switch", description: "Set ONE switch so its stem connects to the given compass branch (N,NE,E,SE,S,SW,W,NW). Prefer set_path for multi-switch routes.",
    parameters: { type: "object", properties: { element: { type: "string" }, direction: { type: "string" } }, required: ["element", "direction"] } } },
  { type: "function", function: { name: "clear_signal", description: "Clear a manual signal to green to open the route ahead (set the switches first).",
    parameters: { type: "object", properties: { element: { type: "string" } }, required: ["element"] } } },
  { type: "function", function: { name: "send_message", description: "Send a short message to the human operator. Use to reply, report status, or a 'Suggestion:' about the instructions.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  { type: "function", function: { name: "done", description: "Call when you have set everything needed for this event.",
    parameters: { type: "object", properties: {} } } }
];
// Tools act on the given station (each event names its station).
async function runTool(station, name, a){
  if (name === "set_path") return gp(`/api/stations/${encodeURIComponent(station)}/path`, { path: a.path });
  if (name === "set_switch") return gp(`/api/stations/${encodeURIComponent(station)}/switch`, { name: a.element, to: a.direction });
  if (name === "clear_signal") return gp(`/api/stations/${encodeURIComponent(station)}/signal`, { name: a.element, action: "clear" });
  if (name === "send_message") return gp(`/api/stations/${encodeURIComponent(station)}/operator-message`, { text: a.text });
  if (name === "done") return { ok: true, done: true };
  return { ok: false, error: `no such tool "${name}". You may ONLY call: set_path, set_switch, clear_signal, send_message, done. Events are delivered to you automatically — there is no await_events/watch/poll tool. Handle THIS event with the allowed tools, then call done.` };
}
async function ollamaChat(messages){
  const r = await fetch(OLLAMA + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: false, options: { temperature: 0 } }) });
  if (!r.ok) throw new Error("ollama " + r.status + ": " + (await r.text()).slice(0, 200));
  return (await r.json()).message;
}
const SHARED_NOTE = `A train's "line N" / "train N" in the instructions means train TYPE N (e.g. line 1 = type 1).
For a "set path …" order call set_path with the entry signal first then the switches, e.g. "arrives at
A: set path 1,2,3" -> set_path(["A","1","2","3"]). For a single switch use set_switch then clear_signal.
Then call "done". Only use THIS station's elements. If the instructions don't cover the case (or are
ambiguous), do your best and also send_message a short "Suggestion: ..." for the operator, then "done".`;

// The script owns the loop; the model just makes the routing decision it's handed. So it gets THIS
// focused brief, NOT the /api/guide text (that guide is for the MCP master and tells it to "loop with
// await_events / watch_arrivals", tools this agent does not expose — which makes literal models like
// qwen3.5 try to call await_events and get refused).
const OLLAMA_BRIEF = `You are an automated railway Station Master controlling one station. Trains that
are STOPPED at your station and described below need to be routed: set the switches and clear the
signals to send each one on its way per YOUR INSTRUCTIONS, then call done.
TOOLS YOU MAY CALL: set_path, set_switch, clear_signal, send_message, done — and NOTHING else. There is
NO await_events, watch_arrivals, get_infrastructure, list_trains or any polling/notification tool:
the situation is handed to you, so never try to wait for, watch, or fetch anything. Just act on what is
described below with the tools above and call done.`;

(async () => {
  const ctx = {};   // station -> system prompt
  for (const st of STATIONS){
    const station = (await gj(`/api/stations/${encodeURIComponent(st)}`)).station;
    if (!station){ console.error(`station "${st}" not found in game "${GAME || "(default)"}"`); process.exit(1); }
    const instructions = (await gj(`/api/stations/${encodeURIComponent(st)}/instructions`)).instructions || "";
    const switches = station.switches.map(s => `${s.name} (branches ${s.branches.map(b => DIRS[b]).join("/")})`).join(", ");
    const signals = station.signals.filter(s => s.name).map(s => s.name).join(", ");
    ctx[st] = `${OLLAMA_BRIEF}\n\nYOU ARE THE STATION MASTER OF "${st}".\nSwitches: ${switches}.\nSignals: ${signals}.\n\nYOUR INSTRUCTIONS:\n${instructions}\n\n${SHARED_NOTE}`;
    // No approach watches: the model is told about a train only once it is STOPPED at a signal (the
    // main loop polls /api/trains for stopped trains). No look-ahead, no pre-announced arrivals.
  }
  console.error(`[ollama master] game=${GAME || "(default)"} model=${MODEL} — managing ${STATIONS.join(", ")}`);

  // Run one decision for a station through the model.
  async function act(station, user){
    const messages = [{ role: "system", content: ctx[station] || ctx[STATIONS[0]] }, { role: "user", content: user }];
    for (let round = 0; round < 6; round++){
      let msg; try { msg = await ollamaChat(messages); } catch (e){ console.error("  llm error:", e.message); return; }
      messages.push(msg);
      const calls = msg.tool_calls || [];
      if (!calls.length){ if (msg.content) console.error("  (model said:", msg.content.slice(0, 120).replace(/\n/g, " ") + ")"); return; }
      for (const c of calls){
        const a = c.function.arguments || {};
        const out = await runTool(station, c.function.name, a);
        console.error(`  [${station}] ${c.function.name}(${JSON.stringify(a)}) -> ${out.ok ? "ok" : "REFUSED: " + out.error}`);
        messages.push({ role: "tool", tool_name: c.function.name, content: JSON.stringify(out) });
        if (c.function.name === "done") return;
      }
    }
  }
  // Build a "reconsider" prompt for one station from its currently-stopped trains.
  function stuckPrompt(list){
    const lines = list.slice(0, 8).map(t => `- train ${t.id} type ${t.type} ("${t.typeName}") at ${t.at || (t.x + "," + t.y)} heading ${t.heading || "?"}, stopped ${t.waitedSeconds}s${t.waitingFor ? ` — ${t.waitingFor}` : ""}`).join("\n");
    return `Trains are STOPPED in your station right now (longest wait first):\n${lines}\nRoute as many as you can — clear the LONGEST-waiting first. A route refused a moment ago may work now that other trains have moved, so just retry it. Use set_path / clear_signal. If a train is blocked by another train directly ahead and there is genuinely nothing you can do yet, skip it. Call done when you've done what you can this round.`;
  }

  // Main loop — work CONTINUOUSLY, no cooldowns: the instant the model is free, act on whatever is
  // stopped in your stations (it may touch ANY train, ANY time). Only when nothing is stopped do we
  // block waiting for the next operator message. Tiny trains, fast turnaround — no artificial delays.
  let cursor = 0;
  const owner = STATIONS.map(encodeURIComponent).join(",");
  while (true){
    // 1) Anything stopped? Act on it immediately, longest-waiting first, then re-check at once.
    let trains; try { trains = (await gj("/api/trains")).trains || []; } catch { trains = []; }
    const stuck = trains
      .filter(t => STATIONS.includes(t.station) && !t.moving && t.waitingFor !== "dwelling at stop")
      .sort((a, b) => (b.waitedSeconds || 0) - (a.waitedSeconds || 0));
    if (stuck.length){
      for (const st of STATIONS){
        const list = stuck.filter(t => t.station === st);
        if (!list.length) continue;
        console.error(`\n● [${st}] ${list.length} stopped (longest ${list[0].waitedSeconds}s) — working`);
        await act(st, stuckPrompt(list));
      }
      continue; // re-evaluate at once — the model never sits idle while a train is stopped
    }
    // 2) Nothing stopped — block until something happens, then loop. Only operator MESSAGES are acted
    // on here; a train that stops is picked up by step 1 next loop (the poll returns promptly when one
    // does, so there's little delay). No approach/look-ahead handling — stopped trains only.
    let res;
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(`${SERVER}/api/notifications?owner=${owner}&after=${cursor}&wait=20${GAME ? "&game=" + encodeURIComponent(GAME) : ""}`, { signal: ctrl.signal });
      clearTimeout(to); res = await r.json();
    } catch (e){ console.error("poll error:", e.message); await new Promise(r => setTimeout(r, 500)); continue; }
    if (typeof res.cursor === "number") cursor = res.cursor;
    for (const ev of (res.events || [])){
      if (ev.mode !== "message") continue;     // stopped trains are step 1's job; ignore waiting/pass here
      const st = ev.owner || STATIONS[0];
      console.error(`\n→ [${st}] operator: "${ev.text}" (${ev.clock})`);
      await act(st, `The operator sent you a message: "${ev.text}". Reply with send_message if warranted, and take any switch/signal actions they ask for.`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
