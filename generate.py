#!/usr/bin/env python3
"""Build a single self-contained index.html port of train3.p8.

The PICO-8 cart is a pixel-buffer simulation: the screen IS the game state.
We reproduce PICO-8's primitives (cls/pget/pset/spr/mget) over a 128x128
colour-index framebuffer and translate the Lua logic 1:1 to JS. The sprite
sheet (__gfx__) and map (__map__) data are embedded verbatim so the
framebuffer is reproduced exactly.
"""
import json
import re
import sys

SRC = "train3.p8"


def section(text, name, stop):
    """Return the data lines of a __name__ section up to the next marker."""
    lines = text.splitlines()
    out, grabbing = [], False
    for ln in lines:
        if ln.strip() == f"__{name}__":
            grabbing = True
            continue
        if grabbing and ln.startswith("__"):
            break
        if grabbing:
            out.append(ln.rstrip("\r"))
    return out


def main():
    with open(SRC, "r") as fh:
        text = fh.read()

    gfx = section(text, "gfx", "map")
    mp = section(text, "map", "sfx")

    data_js = (
        "const GFX=" + json.dumps(gfx) + ";\n"
        "const MAP=" + json.dumps(mp) + ";\n"
    )

    html = TEMPLATE.replace("/*__DATA__*/", data_js)
    html = html.replace("/*__ENGINE__*/", ENGINE_JS)
    html = html.replace("/*__DOM__*/", DOM_JS)

    with open("index.html", "w") as fh:
        fh.write(html)
    print("wrote index.html (%d gfx rows, %d map rows)" % (len(gfx), len(mp)))

    # also emit a DOM-free engine for a node smoke test
    test_js = data_js + ENGINE_JS + "\nmodule.exports={_init,_update,getInfo};\n"
    with open("_engine_test.js", "w") as fh:
        fh.write(test_js)


# ---------------------------------------------------------------------------
# Engine: pure simulation, no DOM. Faithful translation of the Lua cart.
# `playSfx` is a hook the DOM layer overrides; default is a no-op.
# ---------------------------------------------------------------------------
ENGINE_JS = r'''
const PALETTE=[
 [0,0,0],[29,43,83],[126,37,83],[0,135,81],
 [171,82,54],[95,87,79],[194,195,199],[255,241,232],
 [255,0,77],[255,163,0],[255,236,39],[0,228,54],
 [41,173,255],[131,118,156],[255,119,168],[255,204,170]
];

const W=128,H=128;
let fb=new Uint8Array(W*H);

function cls(c){ fb.fill(c||0); }
function pget(x,y){ x=Math.floor(x); y=Math.floor(y);
  if(x<0||x>=W||y<0||y>=H) return 0; return fb[y*W+x]; }
function pset(x,y,c){ x=Math.floor(x); y=Math.floor(y);
  if(x<0||x>=W||y<0||y>=H) return; fb[y*W+x]=c&15; }
function spritePixel(n,sx,sy){
  const br=Math.floor(n/16)*8+sy, bc=(n%16)*8+sx;
  if(br<0||br>=GFX.length) return 0;
  const row=GFX[br];
  if(bc<0||bc>=row.length) return 0;
  const v=parseInt(row.charAt(bc),16);
  return isNaN(v)?0:v;
}
function spr(n,px,py){
  for(let sy=0;sy<8;sy++) for(let sx=0;sx<8;sx++)
    pset(px+sx,py+sy,spritePixel(n,sx,sy));
}
function mget(x,y){
  if(y<0||y>=MAP.length) return 0;
  const row=MAP[y]; const i=x*2;
  if(i<0||i+1>=row.length) return 0;
  const v=parseInt(row.substr(i,2),16);
  return isNaN(v)?0:v;
}

function del(a,v){ const i=a.indexOf(v); if(i>=0) a.splice(i,1); }
function find(v,a){ return v.indexOf(a)!==-1; }
function f(x){ if(x>0) return 1; if(x<0) return -1; return 0; }
function free(x,y){ const c=pget(x,y);
  return c===3||c===7||c===4||c===10||c===6; }

// --- simulation state (1-indexed to mirror the Lua) ---
let sigx={}, sigy={};
let tx=[], ty=[], tc=[], tw=[], tk=[], tt=[], ts=[];
let nt=1;
let xa=0, ya=0;

function _init(){
  sigx={}; sigy={};
  cls(0);
  for(let x=0;x<=15;x++) for(let y=0;y<=12;y++) spr(mget(x,y),8*x,8*y);
  tx=[]; ty=[]; tc=[]; tw=[]; tk=[]; tt=[]; ts=[]; nt=1;
  for(let x=0;x<=127;x++) for(let y=0;y<=127;y++){
    if(pget(x,y)===15){
      tx[nt]=[0,x,x-1,x-2,x-3,x-4];
      ty[nt]=[0,y,y,y,y,y];
      tc[nt]=[0,7,7,7,7,7];
      tw[nt]=0;
      tk[nt]=pget(x-1,y);
      tt[nt]=false;
      ts[nt]=false;
      nt+=1;
    }
  }
}

function signal(x,y){ sigcol(x,y,11,8); }
function unsignal(x,y){ sigcol(x,y,8,11); }

function sigcol(x,y,oldc,newc){
  const ky=128*x+y+128*128*oldc;
  if(sigx[ky]==null){
    sigx[ky]=[]; sigy[ky]=[];
    let nex=[];
    for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++)
      nex.push(128*(dx+x)+dy+y);
    let vis=[];
    while(nex.length>0){
      const n=nex[0]; del(nex,n);
      if(!find(vis,n)){
        vis.push(n);
        const nx=Math.floor(n/128), ny=n-128*nx;
        const ch=pget(nx,ny), ct=pget(nx,ny-1);
        if(ch===4||ch===7||ch===10||ch===6){
          if(ch===4 && ct===oldc){
            sigx[ky].push(nx); sigy[ky].push(ny-1);
            pset(nx,ny-1,newc);
          } else {
            for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){
              const m=128*(nx+dx)+ny+dy;
              if(!find(vis,m)) nex.push(m);
            }
          }
        }
      }
    }
  }
  for(let i=0;i<sigx[ky].length;i++)
    pset(sigx[ky][i], sigy[ky][i], newc);
}

function step(i,nx,ny){
  const nc=pget(nx,ny);
  if(nc===7||nc===10||nc===4||nc===6){
    if(tw[i]>0){ tw[i]-=1; return true; }
    const ca=pget(nx,ny-1);
    if(nc===4 && ca===8){ if(!ts[i]) return true; }
    if(nc===6 && (ca===tk[i]||ca===7)){ tt[i]=true; }
    pset(tx[i][5],ty[i][5],tc[i][5]);
    const x5=tx[i][5], y5=ty[i][5]-1;
    const c5=pget(x5,y5);
    if(tc[i][5]===4 && c5!==3){
      if(c5===9){ pset(x5,y5,8); }
      else { unsignal(x5,y5); ts[i]=false; }
    }
    if(tc[i][2]===10){ tt[i]=false; }
    pset(xa,ya,tk[i]);
    for(let j=5;j>=1;j--){
      tx[i][j+1]=tx[i][j];
      ty[i][j+1]=ty[i][j];
      tc[i][j+1]=tc[i][j];
    }
    tx[i][1]=nx; ty[i][1]=ny; tc[i][1]=nc;
    if(nc===4 && ca===3){ tw[i]=30; }
    else { tw[i]=1; if(tk[i]===12||tk[i]===2||tk[i]===8) tw[i]=0; }
    if(nc===4 && ca===11){ signal(nx,ny); pset(nx,ny-1,9); ts[i]=true; }
    pset(nx,ny,15);
    return true;
  }
  return false;
}

function _update(){
  for(let i=1;i<=nt-1;i++){
    xa=tx[i][1]; ya=ty[i][1];
    const dx=tx[i][1]-tx[i][2], dy=ty[i][1]-ty[i][2];
    const lx=f(dx-dy), ly=f(dy+dx);
    const rx=f(dx+dy), ry=f(dy-dx);
    if(free(xa+dx,ya+dy)){
      if(tt[i]){
        if(!step(i,xa+rx,ya+ry))
          if(!step(i,xa+lx,ya+ly))
            step(i,xa+dx,ya+dy);
      } else {
        if(!step(i,xa+dx,ya+dy))
          if(!step(i,xa+rx,ya+ry))
            step(i,xa+lx,ya+ly);
      }
    }
  }
}

function getInfo(){
  const heads=[];
  for(let i=1;i<=nt-1;i++) heads.push([tx[i][1],ty[i][1],tk[i]]);
  return {trains:nt-1, heads:heads};
}
'''


# ---------------------------------------------------------------------------
# DOM layer: canvas render, WebAudio sfx, controls, run loop.
# ---------------------------------------------------------------------------
DOM_JS = r'''
if (typeof document !== 'undefined') {
  const VH=104; // visible playfield height (13 tile rows); rest is unused black
  const canvas=document.getElementById('screen');
  const wrap=document.getElementById('wrap');
  const ctx=canvas.getContext('2d');
  canvas.width=W; canvas.height=VH;
  const img=ctx.createImageData(W,VH);

  function render(){
    const d=img.data;
    for(let p=0;p<W*VH;p++){
      const c=PALETTE[fb[p]]||PALETTE[0];
      const o=p*4; d[o]=c[0]; d[o+1]=c[1]; d[o+2]=c[2]; d[o+3]=255;
    }
    ctx.putImageData(img,0,0);
  }

  // scale the canvas to fill its area while keeping the 128:104 pixel ratio
  function fit(){
    const cw=wrap.clientWidth, ch=wrap.clientHeight;
    const s=Math.min(cw/W, ch/VH);
    canvas.style.width=(W*s)+'px';
    canvas.style.height=(VH*s)+'px';
  }
  window.addEventListener('resize',fit);

  // --- run loop: PICO-8 updates at 30Hz ---
  let running=true, speed=1, acc=0, last=0;
  const STEP=1000/30;
  function frame(t){
    if(!last) last=t;
    let dt=t-last; last=t;
    if(dt>250) dt=250;
    if(running){
      acc+=dt*speed; let guard=0;
      while(acc>=STEP && guard<480){ _update(); acc-=STEP; guard++; }
    }
    render();
    requestAnimationFrame(frame);
  }

  // --- controls ---
  const btnPause=document.getElementById('pause');
  const btnReset=document.getElementById('reset');
  const btnSpeed=document.getElementById('speed');
  const speeds=[1,2,4,0.5,0.25];
  let si=0;
  function setPause(p){ running=!p; btnPause.textContent=running?'❙❙ Pause':'▶ Play'; }
  btnPause.onclick=()=>{ setPause(running); };
  btnReset.onclick=()=>{ _init(); acc=0; render(); };
  btnSpeed.onclick=()=>{ si=(si+1)%speeds.length; speed=speeds[si]; btnSpeed.textContent='Speed '+speed+'×'; };

  window.addEventListener('keydown',(e)=>{
    if(e.code==='Space'){ e.preventDefault(); setPause(running); }
    else if(e.key==='r'||e.key==='R'){ _init(); acc=0; render(); }
  });

  _init();
  fit();
  render();
  requestAnimationFrame(frame);
}
'''


TEMPLATE = r'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Train</title>
<style>
  :root{ --ink:#e8eaf0; --accent:#29adff; --line:#232a3a; }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden}
  body{
    background:#0b0e14;color:var(--ink);
    font:14px/1.4 ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    height:100vh;display:flex;flex-direction:column;
  }
  #wrap{
    flex:1 1 auto;min-height:0;
    display:flex;align-items:center;justify-content:center;
    padding:6px;
  }
  canvas{
    display:block;image-rendering:pixelated;image-rendering:crisp-edges;
    background:#000;
  }
  .controls{
    flex:0 0 auto;
    display:flex;gap:10px;flex-wrap:wrap;justify-content:center;
    padding:10px;
  }
  button{
    appearance:none;cursor:pointer;color:var(--ink);
    background:#1c2333;border:1px solid var(--line);border-radius:9px;
    padding:9px 14px;font:inherit;letter-spacing:.02em;
    transition:transform .06s ease,border-color .15s ease,background .15s ease;
  }
  button:hover{border-color:var(--accent);background:#222b40}
  button:active{transform:translateY(1px)}
</style>
</head>
<body>
  <div id="wrap">
    <canvas id="screen" width="128" height="104"></canvas>
  </div>
  <div class="controls">
    <button id="pause">&#10073;&#10073; Pause</button>
    <button id="reset">&#8635; Reset</button>
    <button id="speed">Speed 1&times;</button>
  </div>

<script>
(function(){
"use strict";
/*__DATA__*/
/*__ENGINE__*/
/*__DOM__*/
})();
</script>
</body>
</html>
'''


if __name__ == "__main__":
    sys.exit(main())
