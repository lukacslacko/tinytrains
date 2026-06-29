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
// Current simulation time of day (for time-of-day instruction rules). The SCRIPT fetches it and hands
// it to the model in the prompt — the model itself never fetches anything. null if unavailable.
async function gameTime(){ try { const t = await gj("/api/time"); return t && t.ok ? t : null; } catch { return null; } }
// Standing operator overrides for a station (set over chat, "until further notice …"). Fetched fresh
// each decision and injected into the prompt so they apply to every train, not just the message that set
// them. Returns [] if none / unavailable.
async function stateFor(station){
  try { const r = await gj(`/api/stations/${encodeURIComponent(station)}/instructions`);
    return { overrides: Array.isArray(r.overrides) ? r.overrides : [], notebook: typeof r.notebook === "string" ? r.notebook : "", memory: typeof r.memory === "string" ? r.memory : "" };
  } catch { return { overrides: [], notebook: "", memory: "" }; }
}

const TOOLS = [
  { type: "function", function: { name: "set_path", description: "Route a train the easy way: path = [entry signal, then the switches in order, optional final compass dir]. Lines up every switch and clears the entry signal. Use for any 'set path …' instruction, e.g. set path 1,2,3 at A → [\"A\",\"1\",\"2\",\"3\"].",
    parameters: { type: "object", properties: { path: { type: "array", items: { type: "string" } } }, required: ["path"] } } },
  { type: "function", function: { name: "set_switch", description: "Set ONE switch so its stem connects to the given compass branch (N,NE,E,SE,S,SW,W,NW). Prefer set_path for multi-switch routes.",
    parameters: { type: "object", properties: { element: { type: "string" }, direction: { type: "string" } }, required: ["element", "direction"] } } },
  { type: "function", function: { name: "clear_signal", description: "Clear a manual signal to green to open the route ahead (set the switches first).",
    parameters: { type: "object", properties: { element: { type: "string" } }, required: ["element"] } } },
  { type: "function", function: { name: "send_message", description: "Send a short message to the human operator. Use to reply, report status, or a 'Suggestion:' about the instructions.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  { type: "function", function: { name: "set_override", description: "Record a STANDING instruction override the operator gave you (e.g. 'until further notice, trains arriving at B → set path 4,3,2,5'). It is saved and applied to EVERY future train at this station until cleared — call this whenever the operator says to override/change routing until further notice, THEN send_message to acknowledge.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  { type: "function", function: { name: "clear_overrides", description: "Remove ALL standing overrides for this station (the operator cancelled the override / said go back to normal).",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "note", description: "Append a line to your DAILY NOTEBOOK (a scratchpad, wiped each midnight). Use it to carry running state between trains — e.g. for 'alternate trains from A and B', note which side you last let through, then read it next time to pick the other. Your notebook is shown with every request.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  { type: "function", function: { name: "remember", description: "Overwrite your LONG-TERM MEMORY (kept across days, unlike the notebook). Update it at end of day with anything worth keeping. Keep it concise — it is shown with every request.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  { type: "function", function: { name: "report_to_superintendent", description: "File a short report on how the day went at your station. Call this when you receive an end-of-day request.",
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
  if (name === "set_override") return gp(`/api/stations/${encodeURIComponent(station)}/override`, { text: a.text });
  if (name === "clear_overrides") return gp(`/api/stations/${encodeURIComponent(station)}/override`, { action: "clear" });
  if (name === "note") return gp(`/api/stations/${encodeURIComponent(station)}/note`, { text: a.text });
  if (name === "remember") return gp(`/api/stations/${encodeURIComponent(station)}/memory`, { text: a.text });
  if (name === "report_to_superintendent") return gp(`/api/superintendent/report`, { station, text: a.text });
  if (name === "done") return { ok: true, done: true };
  return { ok: false, error: `no such tool "${name}". You may ONLY call: set_path, set_switch, clear_signal, send_message, set_override, clear_overrides, note, remember, report_to_superintendent, done. Events are delivered to you automatically — there is no await_events/watch/poll tool. Handle THIS event with the allowed tools, then call done.` };
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
ambiguous), do your best and also send_message a short "Suggestion: ..." for the operator, then "done".
Some instructions depend on game time (e.g. "during game time between 2 and 8 minutes: ..."); the
current game time is given with each request — apply the branch that matches it.`;

// The script owns the loop; the model just makes the routing decision it's handed. So it gets THIS
// focused brief, NOT the /api/guide text (that guide is for the MCP master and tells it to "loop with
// await_events / watch_arrivals", tools this agent does not expose — which makes literal models like
// qwen3.5 try to call await_events and get refused).
const OLLAMA_BRIEF = `You are an automated railway Station Master controlling one station. Trains that
are STOPPED at your station and described below need to be routed: set the switches and clear the
signals to send each one on its way per YOUR INSTRUCTIONS, then call done.
TOOLS YOU MAY CALL: set_path, set_switch, clear_signal, send_message, set_override, clear_overrides,
note, remember, report_to_superintendent, done — and NOTHING else. There is NO await_events,
watch_arrivals, get_infrastructure, list_trains or any polling/notification tool: the situation is handed
to you, so never try to wait for, watch, or fetch anything. Just act on what is described below with the
tools above and call done.
You have memory: a LONG-TERM MEMORY and a DAILY NOTEBOOK (wiped each midnight), both shown with every
request. Use note() to record running state an instruction needs — e.g. "alternate trains from A and B":
note which side you last let through, then read your notebook next time and pick the other. At END OF DAY
you will be asked to report_to_superintendent and to remember (update long-term memory); your notebook is
then cleared. Afterwards you are shown every station's reports and may note anything useful for tomorrow.
If the operator messages you an instruction OVERRIDE ("until further notice, route ... like ..."), do
NOT just acknowledge — a reply is forgotten by the next train. Call set_override with the rule FIRST,
then send_message to acknowledge. Standing overrides are listed with each request and TAKE PRECEDENCE
over your base instructions until the operator cancels them (then call clear_overrides).`;

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

  // Run one decision for a station through the model. The script fetches the current game time and the
  // station's saved state (overrides, long-term memory, today's notebook) and prepends them, so the model
  // applies them without any fetch tool — this state must ride along every decision, not just the message
  // that set it.
  async function act(station, user){
    const t = await gameTime();
    const timeLine = t ? `Current game time: ${t.dayClock} into the day (secondsIntoDay=${t.secondsIntoDay} of dayLength=${t.dayLength}, day ${t.day}). If your instructions have time-of-day rules (e.g. "between 2 and 8 minutes" = secondsIntoDay 120..480), apply the branch that matches NOW.\n\n` : "";
    const stt = await stateFor(station);
    const memLine = stt.memory ? `YOUR LONG-TERM MEMORY for ${station}:\n${stt.memory}\n\n` : "";
    const noteLine = stt.notebook ? `TODAY'S NOTEBOOK for ${station} (running notes; use note() to add more):\n${stt.notebook}\n\n` : "";
    const ovLine = stt.overrides.length ? `STANDING OPERATOR OVERRIDES for ${station} (these OVERRIDE your base instructions until cleared — apply the matching one before falling back to base instructions):\n${stt.overrides.map(o => "- " + o).join("\n")}\n\n` : "";
    const messages = [{ role: "system", content: ctx[station] || ctx[STATIONS[0]] }, { role: "user", content: timeLine + memLine + noteLine + ovLine + user }];
    for (let round = 0; round < 6; round++){
      let msg; try { msg = await ollamaChat(messages); } catch (e){ console.error(`  [${station}] llm error:`, e.message); return; }
      messages.push(msg);
      const calls = msg.tool_calls || [];
      if (!calls.length){ if (msg.content) console.error(`  [${station}] (model said:`, msg.content.slice(0, 120).replace(/\n/g, " ") + ")"); return; }
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
    // 1) Anything stopped? Act on it immediately, longest-waiting first, then re-check at once. But during
    // the end-of-day ceremony the game is PAUSED (dayPhase set) — skip routing and fall through to the
    // poll so we receive and handle the end_of_day / review_reports events instead of spinning on
    // not-moving trains.
    let tr; try { tr = await gj("/api/trains"); } catch { tr = {}; }
    const trains = tr.trains || [];
    const stuck = tr.dayPhase ? [] : trains
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
    } catch (e){ console.error(`[${STATIONS.join(",")}] poll error:`, e.message); await new Promise(r => setTimeout(r, 500)); continue; }
    if (typeof res.cursor === "number") cursor = res.cursor;
    for (const ev of (res.events || [])){
      const st = ev.owner || STATIONS[0];
      if (ev.mode === "message"){
        console.error(`\n→ [${st}] operator: "${ev.text}" (${ev.clock})`);
        await act(st, `The operator sent you a message: "${ev.text}". If it is an instruction OVERRIDE ("until further notice …", a lasting change to how you route), call set_override with the rule FIRST (or clear_overrides if they cancel one), then reply with send_message. Otherwise reply with send_message if warranted and take any switch/signal actions they ask for.`);
      } else if (ev.mode === "end_of_day"){
        console.error(`\n🌙 [${st}] end of day ${ev.day} — wrapping up`);
        await act(st, `END OF DAY ${ev.day} at ${st}. The game is paused for the daily wrap-up. Today's notebook:\n${ev.notebook || "(empty)"}\n\nLong-term memory:\n${ev.memory || "(empty)"}\n\nDo, in order: (1) call report_to_superintendent with a SHORT summary of how the day went at ${st}; (2) call remember with your updated long-term memory — fold in anything from today worth keeping, keep it concise (your notebook is cleared automatically after). Then call done.`);
      } else if (ev.mode === "review_reports"){
        const lines = (ev.reports || []).map(r => `- ${r.station}: ${r.text}`).join("\n") || "(no reports)";
        console.error(`\n📋 [${st}] reviewing ${(ev.reports || []).length} report(s) for day ${ev.day}`);
        await act(st, `Day ${ev.day} reports from every station:\n${lines}\n\nIf anything here is worth acting on at ${st} tomorrow, call note to jot it in your fresh daily notebook. Then call done.`);
      }
      // other modes (waiting/pass) are step 1's job — ignore here
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
