// Tiny Trains — boxscript: the station automation language (see BOXSCRIPT.md).
//
// A small event-driven DSL: one script per station, interpreted server-side against the same
// operations the Station Master API uses. This module is DOM-free and engine-agnostic: it exports
//   compile(text)          → a compiled program (throws {message, line} on a syntax error)
//   createRunner(E)        → the per-engine scheduler; E is the facade the engine passes in
// The engine (engine.js) attaches one runner per instance and calls runner.tick() from simStep().
// All of the runner's mutable state lives in E.state.boxscript[stationId] as plain JSON data, so
// it rides along in snapshots (server restarts resume scripts mid-manoeuvre for free).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TinyTrainsBoxscript = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ================= Lexer =================
  // Words are [A-Za-z0-9_]+ so element names like "1E" lex as one token; pure digits are numbers.
  // "3:00" / "hh:00" lex as one TIME token. Newlines are insignificant; ';' separates statements;
  // '#' starts a comment.
  function tokenize(text){
    const toks = [];
    let i = 0, line = 1;
    const isW = c => /[A-Za-z0-9_]/.test(c);
    while (i < text.length){
      const c = text[i];
      if (c === "\n"){ line++; i++; continue; }
      if (c === " " || c === "\t" || c === "\r"){ i++; continue; }
      if (c === "#"){ while (i < text.length && text[i] !== "\n") i++; continue; }
      if (c === '"'){
        let j = i + 1, s = "";
        while (j < text.length && text[j] !== '"'){
          if (text[j] === "\\" && j + 1 < text.length){ s += text[j + 1]; j += 2; }
          else { if (text[j] === "\n") line++; s += text[j]; j++; }
        }
        if (j >= text.length) throw err("unterminated string", line);
        toks.push({ t: "str", v: s, line }); i = j + 1; continue;
      }
      if (isW(c)){
        let j = i; while (j < text.length && isW(text[j])) j++;
        const w = text.slice(i, j);
        // a time literal: digits (or the wildcard "hh") + ':' + two digits
        if ((/^\d{1,2}$/.test(w) || w === "hh") && text[j] === ":" && /\d/.test(text[j + 1] || "")){
          let k = j + 1; while (k < text.length && /\d/.test(text[k])) k++;
          const mm = text.slice(j + 1, k);
          if (!/^\d{2}$/.test(mm)) throw err(`bad time "${w}:${mm}" (minutes must be two digits)`, line);
          toks.push({ t: "time", h: w === "hh" ? "hh" : Number(w), m: Number(mm), line });
          i = k; continue;
        }
        toks.push(/^\d+$/.test(w) ? { t: "num", v: Number(w), line } : { t: "name", v: w, line });
        i = j; continue;
      }
      const two = text.slice(i, i + 2);
      if ([":=", "==", "!=", "<=", ">=", "&&", "||"].includes(two)){ toks.push({ t: "p", v: two, line }); i += 2; continue; }
      if ("{}(),;!<>+-.".includes(c)){ toks.push({ t: "p", v: c, line }); i++; continue; }
      throw err(`unexpected character "${c}"`, line);
    }
    toks.push({ t: "eof", line });
    return toks;
  }
  function err(message, line){ const e = new Error(message + (line ? ` (line ${line})` : "")); e.line = line || null; return e; }

  // ================= Parser =================
  const ACTION_WORDS = new Set(["clear", "permit", "red", "reverse", "couple", "uncouple", "shunt", "drive", "stop", "say", "require", "wait"]);
  const RESERVED = new Set(["on", "macro", "if", "elif", "else", "when", "at", "touching", "any", "to", "after", "until", "train", "time", "true", "false", ...ACTION_WORDS]);

  function parse(text){
    const toks = tokenize(text);
    let p = 0;
    const peek = (o) => toks[p + (o || 0)];
    const next = () => toks[p++];
    const isName = (tok, v) => tok.t === "name" && (v === undefined || tok.v === v);
    const isP = (tok, v) => tok.t === "p" && tok.v === v;
    function expectP(v){ const t = next(); if (!isP(t, v)) throw err(`expected "${v}"`, t.line); return t; }
    function expectName(v){ const t = next(); if (!isName(t, v)) throw err(`expected "${v}"`, t.line); return t; }
    function skipSemis(){ while (isP(peek(), ";")) next(); }

    // an element name in a path / guard / cond: a word or a number ("A", "1", "1E", "W")
    function elemName(){
      const t = next();
      if (t.t === "name" || t.t === "num") return String(t.v);
      throw err("expected an element name", t.line);
    }

    const decls = [], handlers = [], macros = {};
    for (;;){
      skipSemis();
      const t = peek();
      if (t.t === "eof") break;
      if (isName(t, "macro")){
        next();
        const nameT = next();
        if (nameT.t !== "name" || RESERVED.has(nameT.v)) throw err("bad macro name", nameT.line);
        expectP("(");
        const params = [];
        if (!isP(peek(), ")")){
          for (;;){
            const pt = next();
            if (pt.t !== "name" || RESERVED.has(pt.v)) throw err("bad macro parameter", pt.line);
            params.push(pt.v);
            if (isP(peek(), ",")){ next(); continue; }
            break;
          }
        }
        expectP(")");
        if (macros[nameT.v]) throw err(`macro "${nameT.v}" is defined twice`, nameT.line);
        macros[nameT.v] = { params, stmts: block(), line: nameT.line };
        continue;
      }
      if (isName(t, "on")){
        next();
        let prio = 0;
        if (peek().t === "num") prio = next().v;
        else if (isP(peek(), "-") && peek(1).t === "num"){ next(); prio = -next().v; }
        expectP("(");
        let guard;
        if (peek().t === "time"){ const tt = next(); guard = { kind: "time", h: tt.h, m: tt.m }; }
        else {
          let type;
          const ty = next();
          if (isName(ty, "any")) type = "any";
          else if (ty.t === "name" || ty.t === "num") type = ty.v;
          else throw err("expected a train type (name, id or `any`) or a time", ty.line);
          expectName("at");
          guard = { kind: "train", type, element: elemName() };
        }
        expectP(")");
        handlers.push({ prio, guard, stmts: block(), line: t.line });
        continue;
      }
      if (t.t === "name" && isP(peek(1), ":=")){
        const nameT = next(); next();
        if (RESERVED.has(nameT.v)) throw err(`"${nameT.v}" is a reserved word`, nameT.line);
        decls.push({ name: nameT.v, expr: expr(), line: nameT.line });
        continue;
      }
      throw err(`expected "on", "macro" or a variable declaration, got "${t.v != null ? t.v : t.t}"`, t.line);
    }
    return { decls, handlers, macros };

    function block(){
      expectP("{");
      const stmts = [];
      for (;;){
        skipSemis();
        if (isP(peek(), "}")){ next(); return stmts; }
        if (peek().t === "eof") throw err("unclosed { block", peek().line);
        stmts.push(stmt());
      }
    }

    function stmt(){
      const t = peek();
      if (isName(t, "if")){
        next();
        const arms = [];
        expectP("("); const c0 = expr(); expectP(")");
        arms.push({ cond: c0, stmts: block() });
        for (;;){
          if (isName(peek(), "elif")){ next(); expectP("("); const c = expr(); expectP(")"); arms.push({ cond: c, stmts: block() }); continue; }
          if (isName(peek(), "else")){ next(); arms.push({ cond: null, stmts: block() }); }
          break;
        }
        return { k: "if", arms, line: t.line };
      }
      if (isName(t, "when")){
        next(); expectP("(");
        const c = cond();
        expectP(")");
        return { k: "when", cond: c, stmts: block(), line: t.line };
      }
      if (isName(t, "wait")){
        next(); expectName("until"); expectP("(");
        const tt = next();
        if (tt.t !== "time") throw err("wait until needs a time, e.g. wait until (hh:00)", tt.line);
        expectP(")");
        return { k: "wait", h: tt.h, m: tt.m, line: t.line };
      }
      if (isName(t, "require")){ next(); expectP("("); const e = expr(); expectP(")"); return { k: "require", expr: e, line: t.line }; }
      if (isName(t, "clear")){ next(); return { k: "clear", path: path(), line: t.line }; }
      if (isName(t, "permit")){
        next();
        const pth = path();
        let to = null;
        if (isName(peek(), "to")){ next(); to = elemName(); }
        return { k: "permit", path: pth, to, line: t.line };
      }
      if (isName(t, "red")){ next(); return { k: "red", elem: elemName(), line: t.line }; }
      if (isName(t, "reverse")){ next(); return { k: "reverse", line: t.line }; }
      if (isName(t, "couple")){ next(); return { k: "couple", line: t.line }; }
      if (isName(t, "uncouple")){
        next(); expectName("after");
        const n = next();
        if (n.t !== "num") throw err("uncouple after needs a number of vehicles", n.line);
        return { k: "uncouple", keep: n.v, line: t.line };
      }
      if (isName(t, "shunt") || isName(t, "drive") || isName(t, "stop")){ next(); return { k: "mode", mode: t.v, line: t.line }; }
      if (isName(t, "say")){ next(); return { k: "say", expr: expr(), line: t.line }; }
      if (t.t === "name" && isP(peek(1), ":=")){
        next(); next();
        if (RESERVED.has(t.v)) throw err(`"${t.v}" is a reserved word`, t.line);
        return { k: "assign", name: t.v, expr: expr(), line: t.line };
      }
      if (t.t === "name" && isP(peek(1), "(") && !RESERVED.has(t.v)){
        next(); next();
        const args = [];
        if (!isP(peek(), ")")){
          for (;;){ args.push(expr()); if (isP(peek(), ",")){ next(); continue; } break; }
        }
        expectP(")");
        return { k: "call", name: t.v, args, line: t.line };
      }
      throw err(`expected a statement, got "${t.v != null ? t.v : t.t}"`, t.line);
    }

    function path(){
      const names = [elemName()];
      while (isP(peek(), ",")){ next(); names.push(elemName()); }
      return names;
    }

    function cond(){
      const t = peek();
      if (isName(t, "at")){ next(); return { k: "at", elem: elemName(), line: t.line }; }
      if (isName(t, "touching")){ next(); return { k: "touching", line: t.line }; }
      if (t.t === "time"){ next(); return { k: "time", h: t.h, m: t.m, line: t.line }; }
      return { k: "expr", expr: expr(), line: t.line };
    }

    // ---- expressions: || > && > comparison > +- > unary > postfix (.field / `at`) ----
    function expr(){ return orE(); }
    function orE(){ let a = andE(); while (isP(peek(), "||")){ next(); a = { e: "bin", op: "||", a, b: andE() }; } return a; }
    function andE(){ let a = cmpE(); while (isP(peek(), "&&")){ next(); a = { e: "bin", op: "&&", a, b: cmpE() }; } return a; }
    function cmpE(){
      const a = addE();
      const t = peek();
      if (t.t === "p" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)){ next(); return { e: "bin", op: t.v, a, b: addE() }; }
      return a;
    }
    function addE(){
      let a = unE();
      for (;;){
        const t = peek();
        if (isP(t, "+") || isP(t, "-")){ next(); a = { e: "bin", op: t.v, a, b: unE() }; continue; }
        return a;
      }
    }
    function unE(){
      const t = peek();
      if (isP(t, "!")){ next(); return { e: "un", op: "!", a: unE() }; }
      if (isP(t, "-")){ next(); return { e: "un", op: "-", a: unE() }; }
      return postE();
    }
    function postE(){
      let a = primE();
      for (;;){
        if (isP(peek(), ".")){
          next();
          const f = next();
          if (f.t !== "name") throw err("expected a field name after '.'", f.line);
          a = { e: "field", obj: a, name: f.v };
          continue;
        }
        if (isName(peek(), "at")){ next(); a = { e: "at", obj: a, elem: elemName() }; continue; }
        return a;
      }
    }
    function primE(){
      const t = next();
      if (t.t === "num") return { e: "num", v: t.v };
      if (t.t === "str") return { e: "str", v: t.v };
      if (t.t === "time"){
        if (t.h === "hh") throw err("the hh wildcard is only allowed in `on (...)` and `wait until (...)`", t.line);
        return { e: "time", h: t.h, m: t.m };
      }
      if (isP(t, "(")){ const e = expr(); expectP(")"); return e; }
      if (t.t === "name"){
        if (t.v === "true") return { e: "bool", v: true };
        if (t.v === "false") return { e: "bool", v: false };
        if (t.v === "train") return { e: "train" };
        if (t.v === "time") return { e: "now" };
        if (RESERVED.has(t.v)) throw err(`"${t.v}" cannot be used in an expression`, t.line);
        return { e: "var", name: t.v, line: t.line };
      }
      throw err(`expected an expression, got "${t.v != null ? t.v : t.t}"`, t.line);
    }
  }

  // ================= Compiler =================
  // Expand macros inline, split every handler body into SEGMENTS at when/wait boundaries
  // (the sequential-shunting state machine), and validate variable use.
  function compile(text){
    const ast = parse(text);

    function substName(n, subst){
      if (!subst || !(n in subst)) return n;
      const a = subst[n];
      if (a.e === "var") return a.name;
      if (a.e === "str") return a.v;
      if (a.e === "num") return String(a.v);
      throw err(`macro argument for "${n}" cannot be used as an element name`);
    }
    function substExpr(e, subst){
      if (!e || !subst) return e;
      switch (e.e){
        case "var": return (e.name in subst) ? subst[e.name] : e;
        case "un": return { ...e, a: substExpr(e.a, subst) };
        case "bin": return { ...e, a: substExpr(e.a, subst), b: substExpr(e.b, subst) };
        case "field": return { ...e, obj: substExpr(e.obj, subst) };
        case "at": return { ...e, obj: substExpr(e.obj, subst), elem: substName(e.elem, subst) };
        default: return e;
      }
    }
    function substCond(c, subst){
      if (!c || !subst) return c;
      if (c.k === "at") return { ...c, elem: substName(c.elem, subst) };
      if (c.k === "expr") return { ...c, expr: substExpr(c.expr, subst) };
      return c;
    }
    function expandStmts(stmts, subst, stack){
      const out = [];
      for (const s of stmts){
        switch (s.k){
          case "call": {
            const m = ast.macros[s.name];
            if (!m) throw err(`unknown macro "${s.name}"`, s.line);
            if (stack.includes(s.name)) throw err(`macro "${s.name}" calls itself`, s.line);
            if (s.args.length !== m.params.length) throw err(`macro "${s.name}" takes ${m.params.length} argument(s)`, s.line);
            const sub = {};
            m.params.forEach((pn, i) => { sub[pn] = subst ? substExpr(s.args[i], subst) : s.args[i]; });
            out.push(...expandStmts(m.stmts, sub, stack.concat(s.name)));
            break;
          }
          case "if":
            out.push({ ...s, arms: s.arms.map(a => ({ cond: a.cond ? substExpr(a.cond, subst) : null, stmts: expandStmts(a.stmts, subst, stack) })) });
            break;
          case "when":
            out.push({ ...s, cond: substCond(s.cond, subst), stmts: expandStmts(s.stmts, subst, stack) });
            break;
          case "assign": case "say": case "require":
            out.push({ ...s, expr: substExpr(s.expr, subst) });
            break;
          case "clear":
            out.push({ ...s, path: s.path.map(n => substName(n, subst)) });
            break;
          case "permit":
            out.push({ ...s, path: s.path.map(n => substName(n, subst)), to: s.to ? substName(s.to, subst) : null });
            break;
          case "red":
            out.push({ ...s, elem: substName(s.elem, subst) });
            break;
          default:
            out.push(s);
        }
      }
      return out;
    }

    // when/wait live only at the TOP LEVEL of a handler body or a when-block body — never
    // inside if arms (the state machine needs a linear chain of steps).
    function assertNoBoundary(stmts){
      for (const s of stmts){
        if (s.k === "when" || s.k === "wait") throw err("`when` / `wait until` cannot be nested inside if — put them at the top level of the handler", s.line);
        if (s.k === "if") for (const a of s.arms) assertNoBoundary(a.stmts);
      }
    }
    function splitSegments(stmts){
      const segs = [{ cond: null, stmts: [] }];
      const walk = (list) => {
        for (const s of list){
          if (s.k === "wait"){ segs.push({ cond: { k: "time", h: s.h, m: s.m }, stmts: [] }); continue; }
          if (s.k === "when"){ segs.push({ cond: s.cond, stmts: [] }); walk(s.stmts); continue; }
          if (s.k === "if") for (const a of s.arms) assertNoBoundary(a.stmts);
          segs[segs.length - 1].stmts.push(s);
        }
      };
      walk(stmts);
      return segs;
    }

    const handlers = ast.handlers.map(h => {
      const segments = splitSegments(expandStmts(h.stmts, null, []));
      if (h.guard.kind === "time" && segments.length > 1)
        throw err("a time handler cannot contain `when` / `wait until` (there is no train to follow)", h.line);
      return { prio: h.prio, guard: h.guard, segments, line: h.line };
    });

    // validate variable use: every read/assigned name must be a declared station variable
    const declared = new Set(ast.decls.map(d => d.name));
    function checkExpr(e){
      if (!e) return;
      switch (e.e){
        case "var": if (!declared.has(e.name)) throw err(`unknown variable "${e.name}" (declare it at the top: ${e.name} := ...)`, e.line); break;
        case "un": checkExpr(e.a); break;
        case "bin": checkExpr(e.a); checkExpr(e.b); break;
        case "field": checkExpr(e.obj); break;
        case "at": checkExpr(e.obj); break;
      }
    }
    function checkStmts(stmts){
      for (const s of stmts){
        if (s.k === "assign"){ if (!declared.has(s.name)) throw err(`unknown variable "${s.name}" (declare it at the top: ${s.name} := ...)`, s.line); checkExpr(s.expr); }
        if (s.k === "say" || s.k === "require") checkExpr(s.expr);
        if (s.k === "if") for (const a of s.arms){ if (a.cond) checkExpr(a.cond); checkStmts(a.stmts); }
      }
    }
    for (const d of ast.decls) checkExpr(d.expr);
    for (const h of handlers) for (const seg of h.segments){
      if (seg.cond && seg.cond.k === "expr") checkExpr(seg.cond.expr);
      checkStmts(seg.stmts);
    }

    return { decls: ast.decls, handlers };
  }

  // ================= Runtime =================
  const TICK_EVERY = 15;        // run the handle loop every 15 sim frames (4×/sim-second)
  const LOG_MAX = 300;
  const MAX_ROUNDS = 25;        // pass-restart bound per tick (livelock backstop)
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

  function hashText(s){ let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h + ":" + s.length; }

  function createRunner(E){
    const compiled = new Map();   // stationId -> {hash, prog|null, error|null}

    function allRt(){ return E.state.boxscript || (E.state.boxscript = {}); }
    function nowSec(){ return E.state.simFrame / E.FRAMES_PER_SECOND; }
    function dayLen(){ return E.state.dayLength || 600; }
    // Time literals are 24h-clock times mapped onto the game day: H:MM → that fraction of dayLength.
    function timeOffset(h, m){ return ((h * 3600 + m * 60) / 86400) * dayLen(); }
    function triggerOffsets(g){
      if (g.h === "hh"){ const out = []; for (let h = 0; h < 24; h++) out.push(timeOffset(h, g.m)); return out; }
      return [timeOffset(g.h, g.m)];
    }
    function latestTrigger(g, S){
      const len = dayLen(), day = Math.floor(S / len);
      let best = null;
      for (const d of [day, day - 1]) for (const o of triggerOffsets(g)){
        const t = d * len + o;
        if (t >= 0 && t <= S && (best == null || t > best)) best = t;
      }
      return best;
    }
    function nextTrigger(g, S){
      const len = dayLen(), day = Math.floor(S / len);
      let best = null;
      for (const d of [day, day + 1]) for (const o of triggerOffsets(g)){
        const t = d * len + o;
        if (t >= S && (best == null || t < best)) best = t;
      }
      return best;
    }
    function fmtTimePat(g){ return `${g.h === "hh" ? "hh" : g.h}:${String(g.m).padStart(2, "0")}`; }
    function fmtGuard(g){ return g.kind === "time" ? fmtTimePat(g) : `${g.type} at ${g.element}`; }
    function fmtCond(c){
      if (!c) return "start";
      if (c.k === "at") return `at ${c.elem}`;
      if (c.k === "touching") return "touching";
      if (c.k === "time") return `time ${fmtTimePat(c)}`;
      return "condition";
    }

    function log(rt, kind, text){
      rt.logSeq = (rt.logSeq || 0) + 1;
      rt.log.push({ seq: rt.logSeq, frame: E.state.simFrame, clock: E.formatClock(E.state.simFrame), kind, text });
      if (rt.log.length > LOG_MAX) rt.log.splice(0, rt.log.length - LOG_MAX);
    }

    // (Re)compile a station's script and keep its runtime state in sync with the script text.
    // A CHANGED script resets the runtime (vars re-initialised, chains dropped, time triggers
    // re-armed with past times counting as fired) — the log survives.
    function ensure(st){
      const text = st.script || "";
      const h = hashText(text);
      let c = compiled.get(st.id);
      if (!c || c.hash !== h){
        c = { hash: h, prog: null, error: null };
        try { c.prog = compile(text); }
        catch (e){ c.error = { message: e.message, line: e.line || null }; }
        compiled.set(st.id, c);
      }
      const all = allRt();
      let rt = all[st.id];
      if (!rt || rt.hash !== h){
        const oldLog = rt ? rt.log : [], oldSeq = rt ? rt.logSeq : 0;
        rt = all[st.id] = { hash: h, vars: {}, consumed: {}, chains: [], timers: {}, lastFail: {}, log: oldLog, logSeq: oldSeq };
        if (c.prog){
          for (const d of c.prog.decls){
            try { rt.vars[d.name] = evalExpr(d.expr, { st, rt, train: null }); }
            catch (e){ rt.vars[d.name] = false; log(rt, "error", `initialising ${d.name}: ${e.message}`); }
          }
          c.prog.handlers.forEach((hd, hi) => {
            if (hd.guard.kind === "time") rt.timers[hi] = latestTrigger(hd.guard, nowSec()) != null ? latestTrigger(hd.guard, nowSec()) : -1;
          });
          log(rt, "script", `script loaded — ${c.prog.handlers.length} handler(s)`);
        } else {
          log(rt, "error", `script error: ${c.error.message}`);
        }
      }
      // restored snapshots carry rt without the transient failure-dedup map
      if (!rt.lastFail) rt.lastFail = {};
      return c;
    }

    // ---- events: level-triggered "a consist stands at a named element of this station" ----
    function rect(st){ const r = st.rect; return { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) }; }
    function inside(st, x, y){ const r = rect(st); return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1; }
    function findTrain(pid){ return E.state.trains.find(t => E.publicTrainId(t) === pid) || null; }
    function headElement(st, t){
      if (!inside(st, t.x, t.y)) return null;
      const tile = E.getTile(t.x, t.y);
      return tile && tile.name ? tile.name : null;
    }
    function pendingEvents(st, rt){
      const claimed = new Set(rt.chains.map(c => c.train));
      const evs = [];
      for (const t of E.state.trains){
        if (!E.hasActiveEngine(t) || !E.trainStopped(t)) continue;
        const el = headElement(st, t);
        if (!el) continue;
        const pid = E.publicTrainId(t);
        if (claimed.has(pid)) continue;
        const since = t.haltedSince != null ? t.haltedSince : E.state.simFrame;
        const key = pid + "|" + t.x + "," + t.y;
        if (rt.consumed[key] === since) continue;
        evs.push({ train: t, pid, element: el, key, since });
      }
      evs.sort((a, b) => (a.since - b.since) || (a.pid - b.pid));
      return evs;
    }
    function pruneConsumed(rt){
      for (const key of Object.keys(rt.consumed)){
        const [pid, xy] = key.split("|");
        const t = findTrain(Number(pid));
        const alive = t && E.trainStopped(t) && (t.x + "," + t.y) === xy && t.haltedSince === rt.consumed[key];
        if (!alive) delete rt.consumed[key];
      }
    }

    function typeName(t){ const tt = E.trainTypeById(t.type); return tt && tt.name ? tt.name : `type ${t.type}`; }
    function guardMatches(g, ev){
      if (String(g.element).toLowerCase() !== String(ev.element).toLowerCase()) return false;
      if (g.type === "any") return true;
      if (typeof g.type === "number") return ev.train.type === g.type;
      return typeName(ev.train).toLowerCase() === String(g.type).toLowerCase();
    }

    // ---- expression evaluation ----
    function trainValue(t){ return { __train: E.publicTrainId(t) }; }
    function isTrainVal(v){ return v && typeof v === "object" && v.__train != null; }
    function evalExpr(e, env){
      switch (e.e){
        case "num": return e.v;
        case "str": return e.v;
        case "bool": return e.v;
        case "time": return timeOffset(e.h, e.m);
        case "now": return nowSec() % dayLen();
        case "train":
          if (!env.train) throw new Error("`train` is only available in a train event handler");
          return trainValue(env.train);
        case "var": {
          if (!(e.name in env.rt.vars)) throw new Error(`unknown variable "${e.name}"`);
          return env.rt.vars[e.name];
        }
        case "un": {
          const a = evalExpr(e.a, env);
          return e.op === "!" ? !truthy(a) : -Number(a);
        }
        case "bin": {
          if (e.op === "&&") return truthy(evalExpr(e.a, env)) ? truthy(evalExpr(e.b, env)) : false;
          if (e.op === "||") return truthy(evalExpr(e.a, env)) ? true : truthy(evalExpr(e.b, env));
          const a = evalExpr(e.a, env), b = evalExpr(e.b, env);
          switch (e.op){
            case "==": return eq(a, b);
            case "!=": return !eq(a, b);
            case "<": return Number(a) < Number(b);
            case "<=": return Number(a) <= Number(b);
            case ">": return Number(a) > Number(b);
            case ">=": return Number(a) >= Number(b);
            case "+": return (typeof a === "string" || typeof b === "string") ? String(a) + String(b) : Number(a) + Number(b);
            case "-": return Number(a) - Number(b);
          }
          throw new Error("bad operator " + e.op);
        }
        case "field": {
          const v = evalExpr(e.obj, env);
          if (!isTrainVal(v)) throw new Error(`.${e.name} needs a train`);
          const t = findTrain(v.__train);
          if (!t) throw new Error(`train ${v.__train} is gone`);
          switch (e.name){
            case "id": return v.__train;
            case "type": return typeName(t);
            case "typeId": return t.type;
            case "cars": return E.trainUnits(t).filter(u => u.kind === "car").length;
            case "units": return E.trainUnits(t).length;
            case "touching": return isTouching(t);
            case "heading": {
              const tile = E.getTile(t.x, t.y);
              const ex = tile ? E.exitFor(tile, t.from) : null;
              return ex != null ? COMPASS[ex] : "";
            }
          }
          throw new Error(`unknown train field .${e.name} (id, type, typeId, cars, units, touching, heading)`);
        }
        case "at": {
          const v = evalExpr(e.obj, env);
          if (!isTrainVal(v)) throw new Error("`X at E` needs a train on the left");
          const t = findTrain(v.__train);
          if (!t || !E.trainStopped(t)) return false;
          const el = E.resolveElement(env.st.id, e.elem);
          return !!el && t.x === el.x && t.y === el.y;
        }
      }
      throw new Error("bad expression");
    }
    function truthy(v){ return v === true || (typeof v === "number" && v !== 0) || (typeof v === "string" && v !== ""); }
    function eq(a, b){
      if (isTrainVal(a) && isTrainVal(b)) return a.__train === b.__train;
      if (typeof a === "string" || typeof b === "string") return String(a).toLowerCase() === String(b).toLowerCase();
      return a === b;
    }
    function isTouching(t){
      if (t._touch) return true;
      return E.trainStopped(t) && E.obstacleDistance(t) <= 0.12;
    }

    // ---- actions ----
    function resolveEl(st, name){ return E.resolveElement(st.id, name); }
    function isCompassName(n){ return COMPASS.includes(String(n).toUpperCase()); }

    function performAction(st, rt, env, s){
      switch (s.k){
        case "clear": {
          const names = s.path.slice();
          let first = resolveEl(st, names[0]);
          if (!first || first.tile.kind !== "signal"){
            const en = env.element;
            const eh = en != null ? resolveEl(st, en) : null;
            if (eh && eh.tile.kind === "signal"){ names.unshift(String(en)); first = eh; }
            else return { ok: false, error: `clear: the path must start with a signal (got "${names[0]}")`, desc: descClear(s) };
          }
          let r;
          if (names.length === 1)
            r = E.command({ type: "clearSignal", x: first.x, y: first.y });
          else if (names.length === 2 && isCompassName(names[1]) && !resolveEl(st, names[1]))
            r = E.command({ type: "clearSignal", x: first.x, y: first.y, dir: COMPASS.indexOf(String(names[1]).toUpperCase()) });
          else
            r = E.command({ type: "setPath", station: String(st.id), path: names });
          return { ...r, error: r.error || r.reason, desc: `clear ${names.join(",")}` };
        }
        case "permit": {
          const r = E.command({ type: "permitPath", station: String(st.id), path: s.path, to: s.to });
          return { ...r, desc: `permit ${s.path.join(",")}${s.to ? " to " + s.to : ""}` };
        }
        case "red": {
          const el = resolveEl(st, s.elem);
          if (!el || el.tile.kind !== "signal") return { ok: false, error: `red: "${s.elem}" is not a signal of this station`, desc: `red ${s.elem}` };
          const r = E.command({ type: "redSignal", x: el.x, y: el.y });
          return { ...r, error: r.error || r.reason, desc: `red ${s.elem}` };
        }
        case "reverse": case "couple": case "uncouple": case "mode": {
          if (!env.train) return { ok: false, error: `${s.k}: no train in this handler (time handlers cannot give engine orders)`, desc: s.k };
          const pid = E.publicTrainId(env.train);
          let cmd;
          if (s.k === "reverse") cmd = { type: "reverse", train: pid, station: st.name };
          else if (s.k === "couple") cmd = { type: "couple", train: pid, station: st.name };
          else if (s.k === "uncouple") cmd = { type: "detach", train: pid, keep: s.keep, station: st.name };
          else cmd = { type: "setTrainMode", train: pid, mode: s.mode, station: st.name };
          const r = E.command(cmd);
          // the train object may have been replaced (couple/uncouple build new consists)
          const nt = findTrain(pid);
          if (nt) env.train = nt;
          return { ...r, error: r.error || r.reason, desc: s.k === "mode" ? s.mode : (s.k === "uncouple" ? `uncouple after ${s.keep}` : s.k) };
        }
        case "say": {
          let text;
          try { text = String(evalExpr(s.expr, env)); } catch (e){ return { ok: false, error: "say: " + e.message, desc: "say" }; }
          E.notifyOperator(st.name, text);
          return { ok: true, desc: `say "${text}"` };
        }
      }
      return { ok: false, error: "unknown action " + s.k, desc: s.k };
    }
    function descClear(s){ return `clear ${s.path.join(",")}`; }

    // Execute a segment body. Returns {failed, actions, error}. A failing action (or require)
    // stops the attempt there; earlier statements are NOT rolled back (put assignments after
    // the action they record — see BOXSCRIPT.md). Log lines are BUFFERED on env.lines: the
    // caller flushes them once per distinct outcome, so an attempt retried every pass does
    // not flood the execution log with the same failure four times a second.
    function execStmts(st, rt, env, stmts){
      let actions = 0;
      env.lines = env.lines || [];
      const emitLine = (kind, text) => {
        if (env.header){ env.lines.push({ kind: "event", text: env.header }); env.header = null; }
        env.lines.push({ kind, text });
      };
      const run = (list) => {
        for (const s of list){
          switch (s.k){
            case "assign": {
              try { rt.vars[s.name] = evalExpr(s.expr, env); }
              catch (e){ emitLine("fail", `  ${s.name} := …: ${e.message}`); return `${s.name} := …: ${e.message}`; }
              break;
            }
            case "if": {
              for (const arm of s.arms){
                let hit = arm.cond == null;
                if (!hit){
                  try { hit = truthy(evalExpr(arm.cond, env)); }
                  catch (e){ emitLine("fail", "  if: " + e.message); return "if: " + e.message; }
                }
                if (hit){ const r = run(arm.stmts); if (r) return r; break; }
              }
              break;
            }
            case "require": {
              let ok;
              try { ok = truthy(evalExpr(s.expr, env)); }
              catch (e){ emitLine("fail", "  require: " + e.message); return "require: " + e.message; }
              if (!ok){ emitLine("fail", "  require failed"); return "require failed"; }
              break;
            }
            default: {
              const r = performAction(st, rt, env, s);
              if (!r.ok){
                const msg = `${r.desc}: ${r.error || "refused"}`;
                emitLine("fail", `  ${msg}`);
                return msg;
              }
              actions++;
              emitLine("action", `  ${r.desc}${r.set && r.set.length ? " — set " + r.set.map(x => x.name + "=" + x.dir).join(",") : ""}`);
            }
          }
        }
        return null;
      };
      const error = run(stmts);
      return { failed: error != null, actions, error };
    }
    function flushLines(rt, env){
      for (const l of (env.lines || [])) log(rt, l.kind, l.text);
      env.lines = [];
    }

    // ---- chains (sequential shunting) ----
    function segOf(prog, ch){
      const h = prog.handlers[ch.h];
      return h && h.segments[ch.seg] ? h.segments[ch.seg] : null;
    }
    function armChain(rt, prog, ch){
      const seg = segOf(prog, ch);
      if (seg && seg.cond && seg.cond.k === "time") ch.due = nextTrigger(seg.cond, nowSec());
      else ch.due = null;
      ch.fired = false;
      if (seg) log(rt, "chain", `train ${ch.train}: waiting for ${fmtCond(seg.cond)}`);
    }
    function evalChainCond(st, rt, cond, t, ch){
      if (!cond) return true;
      switch (cond.k){
        case "at": {
          if (!E.trainStopped(t)) return false;
          const el = resolveEl(st, cond.elem);
          return !!el && t.x === el.x && t.y === el.y;
        }
        case "touching": return isTouching(t);
        case "time": return ch.due != null && nowSec() >= ch.due;
        case "expr": {
          try { return truthy(evalExpr(cond.expr, { st, rt, train: t })); }
          catch (e){ log(rt, "error", `chain condition: ${e.message}`); return false; }
        }
      }
      return false;
    }

    function attemptHandler(st, prog, rt, hi, ev){
      const h = prog.handlers[hi];
      const env = { st, rt, train: ev.train, element: ev.element, lines: [],
        header: `on (${fmtGuard(h.guard)}): train ${ev.pid} (${typeName(ev.train)})` };
      const failKey = hi + "|" + ev.key;
      const res = execStmts(st, rt, env, h.segments[0].stmts);
      if (res.failed){
        // a pending event is retried every pass — log each distinct failure once, not 4×/second
        if (rt.lastFail[failKey] !== res.error) flushLines(rt, env);
        rt.lastFail[failKey] = res.error;
        return false;
      }
      delete rt.lastFail[failKey];
      flushLines(rt, env);
      if (h.segments.length > 1){
        rt.consumed[ev.key] = ev.since;
        const ch = { train: ev.pid, h: hi, seg: 1, fired: false, due: null, label: fmtGuard(h.guard) };
        rt.chains.push(ch);
        log(rt, "chain", `train ${ev.pid} claimed by on (${fmtGuard(h.guard)})`);
        armChain(rt, prog, ch);
        return true;
      }
      if (res.actions > 0){
        rt.consumed[ev.key] = ev.since;
        return true;
      }
      return false; // body ran but did nothing: the event stays pending (e.g. all platforms busy)
    }

    function runChains(st, prog, rt){
      let worked = false;
      for (const ch of rt.chains.slice()){
        const t = findTrain(ch.train);
        const seg = segOf(prog, ch);
        if (!t || !seg || !inside(st, t.x, t.y)){
          const why = !t ? "the train is gone" : (!seg ? "the script changed" : "the train left the station");
          log(rt, "alert", `chain on (${ch.label}) for train ${ch.train} aborted — ${why}`);
          rt.chains = rt.chains.filter(c => c !== ch);
          continue;
        }
        if (!ch.fired){
          if (!evalChainCond(st, rt, seg.cond, t, ch)) continue;
          ch.fired = true;
          log(rt, "chain", `train ${ch.train}: ${fmtCond(seg.cond)}`);
        }
        const env = { st, rt, train: t, element: headElement(st, t), lines: [], header: null };
        const failKey = "chain" + ch.train + "|" + ch.h + "." + ch.seg;
        const res = execStmts(st, rt, env, seg.stmts);
        if (res.failed){
          if (rt.lastFail[failKey] !== res.error) flushLines(rt, env);
          rt.lastFail[failKey] = res.error;
          continue;
        }
        delete rt.lastFail[failKey];
        flushLines(rt, env);
        worked = true;
        ch.seg++;
        if (ch.seg >= prog.handlers[ch.h].segments.length){
          log(rt, "chain", `train ${ch.train}: sequence complete — released`);
          rt.chains = rt.chains.filter(c => c !== ch);
        } else {
          armChain(rt, prog, ch);
        }
      }
      return worked;
    }

    function runStation(st, prog, rt){
      // due time handlers fire first, each exactly once per trigger
      prog.handlers.forEach((h, hi) => {
        if (h.guard.kind !== "time") return;
        if (!(hi in rt.timers)){ const lt = latestTrigger(h.guard, nowSec()); rt.timers[hi] = lt != null ? lt : -1; return; }
        const trig = latestTrigger(h.guard, nowSec());
        if (trig != null && trig > rt.timers[hi]){
          rt.timers[hi] = trig;
          log(rt, "time", `on (${fmtTimePat(h.guard)})`);
          const env = { st, rt, train: null, element: null, lines: [], header: null };
          execStmts(st, rt, env, h.segments[0].stmts);
          flushLines(rt, env);   // time handlers fire once — always show what happened
        }
      });
      // the handle loop: chains + plain handlers; any resolution restarts the pass
      for (let round = 0; round < MAX_ROUNDS; round++){
        let worked = runChains(st, prog, rt);
        if (!worked){
          const pend = pendingEvents(st, rt);
          const prios = [...new Set(prog.handlers.filter(h => h.guard.kind === "train").map(h => h.prio))].sort((a, b) => b - a);
          outer:
          for (const p of prios){
            for (const ev of pend){
              for (let hi = 0; hi < prog.handlers.length; hi++){
                const h = prog.handlers[hi];
                if (h.guard.kind !== "train" || h.prio !== p || !guardMatches(h.guard, ev)) continue;
                if (attemptHandler(st, prog, rt, hi, ev)){ worked = true; break outer; }
              }
            }
          }
        }
        if (!worked) break;
        if (round === MAX_ROUNDS - 1) log(rt, "alert", `handle loop stopped after ${MAX_ROUNDS} rounds this tick`);
      }
      pruneConsumed(rt);
    }

    return {
      tick(){
        if (E.state.simFrame % TICK_EVERY !== 0) return;
        for (const st of E.state.stations){
          if (!st.script || !st.script.trim()) continue;
          const c = ensure(st);
          if (c.prog) runStation(st, c.prog, allRt()[st.id]);
        }
      },
      // called by the setScript command: compile now and report the result
      scriptChanged(st){
        compiled.delete(st.id);
        if (!st.script || !st.script.trim()){
          delete allRt()[st.id];
          return { ok: true, error: null };
        }
        const c = ensure(st);
        return { ok: true, error: c.error ? c.error.message : null };
      },
      compileError(st){
        if (!st.script || !st.script.trim()) return null;
        const c = ensure(st);
        return c.error ? c.error.message : null;
      },
      scriptLog(st, after){
        const rt = allRt()[st.id];
        const entries = rt ? rt.log.filter(e => e.seq > (after || 0)) : [];
        return { entries, cursor: rt ? rt.logSeq || 0 : 0 };
      }
    };
  }

  return { compile, parse, tokenize, createRunner };
});
