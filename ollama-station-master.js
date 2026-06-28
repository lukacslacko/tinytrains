// Tiny Trains — Station Master driven by a LOCAL LLM via Ollama (Node, zero dependencies).
//
//   node ollama-station-master.js --station Tiszai --game Miskolc [--model qwen2.5:7b]
//   (env: TINYTRAINS_SERVER, OLLAMA_URL, OLLAMA_MODEL)
//
// Feasibility: yes, this works on a MacBook Pro with a tool-calling local model (qwen2.5, llama3.1,
// mistral-nemo). The trick is that THIS SCRIPT owns the event loop (registers approach watches and
// long-polls for arrivals); the model only has to do the easy part — for each arriving train, look
// at the station's instructions and emit set_switch / clear_signal tool calls. Each decision starts
// from a fresh short context, so even a small model stays reliable.

"use strict";
function arg(name, env, def){ const i = process.argv.indexOf("--" + name); if (i >= 0 && process.argv[i+1]) return process.argv[i+1]; if (env && process.env[env]) return process.env[env]; return def; }
const SERVER = arg("server", "TINYTRAINS_SERVER", "http://localhost:8765").replace(/\/$/, "");
const OLLAMA = arg("ollama", "OLLAMA_URL", "http://localhost:11434").replace(/\/$/, "");
const MODEL  = arg("model", "OLLAMA_MODEL", "qwen2.5:7b");
const STATION = arg("station", "TINYTRAINS_STATION", "");
const GAME = arg("game", "TINYTRAINS_GAME", "");
if (!STATION){ console.error("usage: node ollama-station-master.js --station <name> [--game <name>] [--model <ollama-model>]"); process.exit(1); }

const qs = GAME ? `?game=${encodeURIComponent(GAME)}` : "";
async function gj(path){ const r = await fetch(SERVER + path + (path.includes("?") ? "&" : "?") + (GAME ? "game=" + encodeURIComponent(GAME) : "")); return r.json(); }
async function gp(path, body){ const r = await fetch(SERVER + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ game: GAME }, body)) }); return r.json(); }

// Tools the model may call. Kept tiny on purpose.
const TOOLS = [
  { type: "function", function: { name: "set_switch", description: "Set a station switch so its stem connects to the given branch. direction is a compass bearing (N,NE,E,SE,S,SW,W,NW).",
    parameters: { type: "object", properties: { element: { type: "string" }, direction: { type: "string" } }, required: ["element", "direction"] } } },
  { type: "function", function: { name: "clear_signal", description: "Clear a station manual signal to green to open the route ahead (set the switches first).",
    parameters: { type: "object", properties: { element: { type: "string" } }, required: ["element"] } } },
  { type: "function", function: { name: "send_message", description: "Send a short message to the human operator (appears in the game). Use to reply to the operator or report status.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  { type: "function", function: { name: "done", description: "Call when you have set everything needed for this event.",
    parameters: { type: "object", properties: {} } } }
];
async function runTool(name, a){
  if (name === "set_switch") return gp(`/api/stations/${encodeURIComponent(STATION)}/switch`, { name: a.element, to: a.direction });
  if (name === "clear_signal") return gp(`/api/stations/${encodeURIComponent(STATION)}/signal`, { name: a.element, action: "clear" });
  if (name === "send_message") return gp(`/api/stations/${encodeURIComponent(STATION)}/operator-message`, { text: a.text });
  if (name === "done") return { ok: true, done: true };
  return { ok: false, error: "unknown tool " + name };
}

async function ollamaChat(messages){
  const r = await fetch(OLLAMA + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: false, options: { temperature: 0 } }) });
  if (!r.ok) throw new Error("ollama " + r.status + ": " + (await r.text()).slice(0, 200));
  return (await r.json()).message;
}

(async () => {
  // 1) Learn the station.
  const guide = (await gj("/api/guide")).guide || "";
  const station = (await gj(`/api/stations/${encodeURIComponent(STATION)}`)).station;
  if (!station){ console.error(`station "${STATION}" not found in game "${GAME || "(default)"}"`); process.exit(1); }
  const instructions = (await gj(`/api/stations/${encodeURIComponent(STATION)}/instructions`)).instructions || "";
  const switches = station.switches.map(s => `${s.name} (branches ${s.branches.map(b => ["N","NE","E","SE","S","SW","W","NW"][b]).join("/")})`).join(", ");
  const signals = station.signals.filter(s => s.name).map(s => s.name).join(", ");

  // 2) Register approach watches on every signal, so we get early warning.
  let cursor = 0;
  for (const sig of station.signals) if (sig.name) await gp("/api/watches", { station: STATION, owner: STATION, element: sig.name, mode: "approach" });

  const system = `${guide}

YOU ARE THE STATION MASTER OF "${STATION}".
Switches: ${switches}.
Signals: ${signals}.

YOUR INSTRUCTIONS:
${instructions}

A train's "line N" / "train N" in the instructions means train TYPE N (e.g. line 1 = type 1).
When told a train is approaching, follow the instructions for that train type + entry point: emit
set_switch and clear_signal tool calls (set switches first, then clear the entry signal), then call
"done". Only use the listed elements. If the instructions don't cover it, just call "done".`;

  console.error(`[ollama master] station=${STATION} game=${GAME || "(default)"} model=${MODEL} — watching ${signals}`);

  // Run one decision through the model (it may emit several tool calls, then "done").
  async function act(user){
    const messages = [{ role: "system", content: system }, { role: "user", content: user }];
    for (let round = 0; round < 6; round++){
      let msg; try { msg = await ollamaChat(messages); } catch (e){ console.error("  llm error:", e.message); return; }
      messages.push(msg);
      const calls = msg.tool_calls || [];
      if (!calls.length){ if (msg.content) console.error("  (model said:", msg.content.slice(0, 120).replace(/\n/g, " ") + ")"); return; }
      for (const c of calls){
        const a = c.function.arguments || {};
        const out = await runTool(c.function.name, a);
        console.error(`  ${c.function.name}(${JSON.stringify(a)}) -> ${out.ok ? "ok" : "REFUSED: " + out.error}`);
        messages.push({ role: "tool", tool_name: c.function.name, content: JSON.stringify(out) });
        if (c.function.name === "done") return;
      }
    }
  }
  // Sweep every signal for a train already WAITING at it and route it (these fire no fresh event).
  // A short per-train cooldown avoids re-deciding a train that can't yet be cleared.
  const handled = {};
  async function sweepWaiting(){
    let report; try { report = (await gj(`/api/stations/${encodeURIComponent(STATION)}`)).station; } catch { return; }
    for (const sig of (report.signals || [])){
      for (const w of (sig.waiting || [])){
        const key = `${sig.name}:${w.trainType}:${w.wantsDir}`;
        if (handled[key] && Date.now() - handled[key] < 12000) continue;
        handled[key] = Date.now();
        console.error(`\n→ waiting: train "${w.trainTypeName}" at ${sig.name} wants ${w.wantsDir}`);
        await act(`A train of type ${w.trainType} ("${w.trainTypeName}") is WAITING at ${sig.name} wanting to go ${w.wantsDir}. Set its route and clear ${sig.name} per your instructions.`);
      }
    }
  }

  // 3) Loop owned by the script: handle waiting trains, then long-poll for new arrivals/messages.
  await sweepWaiting();
  while (true){
    let res;
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 35000);
      const r = await fetch(`${SERVER}/api/notifications?owner=${encodeURIComponent(STATION)}&after=${cursor}&wait=25${GAME ? "&game=" + encodeURIComponent(GAME) : ""}`, { signal: ctrl.signal });
      clearTimeout(to); res = await r.json();
    } catch (e){ console.error("poll error:", e.message); await new Promise(r => setTimeout(r, 1000)); continue; }
    if (typeof res.cursor === "number") cursor = res.cursor;
    for (const ev of (res.events || [])){
      if (ev.mode === "message"){
        console.error(`\n→ operator: "${ev.text}" (${ev.clock})`);
        await act(`The operator sent you a message: "${ev.text}". Reply with send_message if a reply is warranted, and take any switch/signal actions they ask for.`);
      } else {
        console.error(`\n→ ${ev.mode}: train "${ev.trainTypeName}" at ${ev.element} (${ev.clock})`);
        await act(`A train of type ${ev.trainType} ("${ev.trainTypeName}") is ${ev.mode === "pass" ? "leaving" : "approaching"} ${ev.element}. Set its route and clear its signal per your instructions.`);
      }
    }
    await sweepWaiting(); // every cycle, also clear any train stuck waiting at a signal
  }
})().catch(e => { console.error(e); process.exit(1); });
