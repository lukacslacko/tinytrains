// Tiny Trains — boxscript parser/compiler tests (grammar, macro expansion, segment
// splitting, compile-time validation). Pure in-process, no engine needed.
//
//   node test/boxscript-parse.test.js
"use strict";
const BS = require("../boxscript.js");

let failures = 0, checks = 0;
function assert(cond, msg){
  checks++;
  if (!cond){ failures++; console.error("  ✗ " + msg); }
}
function compiles(src, msg){
  checks++;
  try { return BS.compile(src); }
  catch (e){ failures++; console.error(`  ✗ ${msg}: ${e.message}`); return null; }
}
function rejects(src, re, msg){
  checks++;
  try { BS.compile(src); failures++; console.error(`  ✗ ${msg}: compiled but should not have`); }
  catch (e){ if (!re.test(e.message)){ failures++; console.error(`  ✗ ${msg}: wrong error "${e.message}"`); } }
}

console.log("the platform example from BOXSCRIPT.md");
{
  const p = compiles(`
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
  `, "platform example compiles");
  if (p){
    assert(p.decls.length === 2, "two variable declarations");
    assert(p.handlers.length === 5, "five handlers");
    assert(p.handlers[0].guard.type === "any" && p.handlers[0].guard.element === "A", "guard any at A");
    assert(p.handlers[0].segments.length === 1, "no when → a single segment");
    const ifStmt = p.handlers[0].segments[0].stmts[0];
    assert(ifStmt.k === "if" && ifStmt.arms.length === 2, "if with elif arm");
    assert(ifStmt.arms[0].stmts[0].k === "clear" && ifStmt.arms[0].stmts[0].path.join(",") === "1,2,3,C", "clear path parsed");
  }
}

console.log("priorities, types, times, one-liner style");
{
  const p = compiles(`
    on 2 (red at A) { clear 1,B }; on (3 at A) { clear 1,B }; on -1 (any at A) { say "low" }
    on (3:00) { daytime := true }; on (22:15) { daytime := false }; on (hh:30) { say "half past" }
    daytime := false
  `, "compiles");
  if (p){
    assert(p.handlers[0].prio === 2 && p.handlers[2].prio === -1, "priorities parsed (2, -1)");
    assert(p.handlers[1].guard.type === 3, "numeric train type guard");
    assert(p.handlers[3].guard.kind === "time" && p.handlers[3].guard.h === 3 && p.handlers[3].guard.m === 0, "time guard 3:00");
    assert(p.handlers[5].guard.h === "hh" && p.handlers[5].guard.m === 30, "hh:30 wildcard guard");
  }
}

console.log("the run-around macro: expansion + when-chain segments");
{
  const p = compiles(`
    macro store_last_car(t) {
      require (t at B)
      uncouple after 1
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
    on (red at B) { store_last_car(train) }
  `, "macro example compiles");
  if (p){
    const h = p.handlers[0];
    assert(h.segments.length === 8, `macro expands to 8 segments (got ${h.segments.length})`);
    assert(h.segments[0].stmts.length === 4, "segment 0: require, uncouple, shunt, permit");
    assert(h.segments[1].cond.k === "at" && h.segments[1].cond.elem === "X", "segment 1 armed on at X");
    assert(h.segments[3].cond.k === "touching", "segment 3 armed on touching");
    const req = h.segments[0].stmts[0];
    assert(req.k === "require" && req.expr.e === "at" && req.expr.obj.e === "train", "macro param t substituted by the train argument");
    assert(h.segments[0].stmts[3].k === "permit" && h.segments[0].stmts[3].to === "X", "permit ... to X");
    const last = h.segments[7].stmts;
    assert(last.map(s => s.k).join(",") === "couple,reverse,mode", "final segment couple; reverse; stop");
  }
}

console.log("wait until is sugar for a time-conditioned segment");
{
  const p = compiles(`on (red at B) { wait until (hh:00); clear 1,2,B }`, "timetable example compiles");
  if (p){
    const h = p.handlers[0];
    assert(h.segments.length === 2, "wait until splits the body");
    assert(h.segments[0].stmts.length === 0, "nothing before the wait");
    assert(h.segments[1].cond.k === "time" && h.segments[1].cond.h === "hh", "second segment waits for hh:00");
    assert(h.segments[1].stmts[0].k === "clear", "clear after the wait");
  }
}

console.log("expressions: train fields, at, concatenation, comparisons");
{
  const p = compiles(`
    n := 0
    on (any at A) {
      if (train.heading == "W" && train.cars >= 2) { clear 1,B }
      elif (train at A || n + 1 < 3) { say "hello " + train.type }
      else { clear A,E }
      n := n + 1
    }
  `, "expression forms compile");
  if (p){
    const arms = p.handlers[0].segments[0].stmts[0].arms;
    assert(arms.length === 3, "if/elif/else three arms");
    assert(arms[2].stmts[0].k === "clear" && arms[2].stmts[0].path.join(",") === "A,E", "clear A,E direction form parses");
  }
}

console.log("compile-time rejections");
{
  rejects(`on (any at A) { clear 1,B; x := true }`, /unknown variable "x"/, "assignment to undeclared variable");
  rejects(`on (any at A) { if (busy) { clear 1,B } }`, /unknown variable "busy"/, "read of undeclared variable");
  rejects(`on (any at A) { if (true) { when (at X) { reverse } } }`, /cannot be nested inside if/, "when inside if");
  rejects(`on (any at A) { if (true) { wait until (hh:00) } }`, /cannot be nested inside if/, "wait until inside if");
  rejects(`on (3:00) { when (at X) { reverse } }`, /time handler cannot contain/, "when inside a time handler");
  rejects(`on (any at A) { clear 1,B`, /unclosed \{ block/, "unclosed block");
  rejects(`macro m(a) { m(a) }\non (any at A) { m(train) }`, /calls itself/, "recursive macro");
  rejects(`on (any at A) { m(train) }`, /unknown macro/, "unknown macro");
  rejects(`macro m(a,b) { reverse }\non (any at A) { m(train) }`, /takes 2 argument/, "macro arity");
  rejects(`on (any at A) { if (time > hh:00) { reverse } }`, /wildcard/, "hh wildcard outside on/wait");
  rejects(`train := 3`, /reserved word/, "reserved word as variable");
  rejects(`on (any at A) { uncouple 2 }`, /expected "after"/, "uncouple needs after");
}

console.log("editor-defined variables: compile accepts knownVars");
{
  rejects(`on (any at A) { if (go) { clear A } }`, /unknown variable "go"/, "unknown variable without the editor");
  checks++;
  try { BS.compile(`on (any at A) { if (go) { clear A } }`, ["go"]); }
  catch (e){ failures++; console.error("  ✗ a known (editor-defined) variable should satisfy the compiler: " + e.message); }
  rejects(`on (any at A) { go := true }`, /unknown variable "go"/, "assignment also needs the variable to exist");
  checks++;
  try { BS.compile(`on (any at A) { go := true }`, ["go"]); }
  catch (e){ failures++; console.error("  ✗ assigning a known variable should compile: " + e.message); }
}

console.log("format: normalized spacing/indentation, comments and line structure kept");
{
  const src = `# header comment
a:=false
on   2 ( red at A ) {
      clear 1 , 2 , B ;
   a := true    # trailing comment
}


on (any at C) {clear 3,2,B;a:=false}
on (any at B) { wait until (hh:00); clear A,E }`;
  const f = BS.format(src);
  const lines = f.split("\n");
  assert(lines[0] === "# header comment", "standalone comment kept on its own line");
  assert(lines[1] === "a := false", "declaration spacing normalized");
  assert(lines[2] === "on 2 (red at A) {", "priority + guard spacing normalized");
  assert(lines[3] === "  clear 1,2,B", "statement indented, commas tight, end-of-line semicolon dropped");
  assert(lines[4] === "  a := true   # trailing comment", "trailing comment stays attached");
  assert(lines[6] === "", "blank line between sections preserved (collapsed to one)");
  assert(lines[7] === "on (any at C) { clear 3,2,B; a := false }", "one-liner body stays inline with its semicolons");
  assert(BS.format(f) === f, "formatting is idempotent");
  const strip = o => JSON.parse(JSON.stringify(o, (k, v) => k === "line" ? undefined : v));
  assert(JSON.stringify(strip(BS.compile(src))) === JSON.stringify(strip(BS.compile(f))), "formatted script compiles to the same program");
  checks++; try { BS.format("on (any at A) {"); failures++; console.error("  ✗ format accepted a broken script"); }
  catch (e){ if (!/unclosed/.test(e.message)){ failures++; console.error("  ✗ format: wrong error " + e.message); } }
  assert(BS.format("   \n\n") === "", "whitespace-only formats to empty");
  assert(/on -1 \(any at A\)/.test(BS.format("on -1 (any at A) { reverse }")), "negative priority survives formatting");
}

console.log("line numbers in errors");
{
  try { BS.compile(`x := 1\n\non (any at A) {\n  clear 1,B\n  y := 2\n}`); assert(false, "should not compile"); }
  catch (e){ assert(e.line === 5, `error carries line 5 (got ${e.line})`); checks++; }
}

console.log(failures ? `\n${failures}/${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
