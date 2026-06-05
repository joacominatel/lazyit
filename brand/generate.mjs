// lazyit brand asset generator.
//
// The mark is a Penrose impossible triangle (tribar) rendered as a faceted 3D
// ribbon. It is built from exact isometric math: the three drawing axes are 120°
// apart and sum to zero, which is precisely why the ribbon loop closes in 2D while
// remaining impossible in 3D — the geometry IS the brand idea ("lazy" = achieving the
// impossible effortlessly; structure/systems for an IT-native, asset-centric tool).
//
// Usage:
//   bun generate.mjs           # writes SVGs, then rasterizes PNGs via headless Chrome
//   bun generate.mjs --svg     # SVGs only (no Chrome needed)
//
// PNG rasterization uses Google Chrome (for real type + the SVG glow filter). Edit
// CHROME_BIN below if Chrome lives elsewhere.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = import.meta.dir;
const TMP = join(tmpdir(), "lazyit-brand-html");
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SVG_ONLY = process.argv.includes("--svg");
mkdirSync(TMP, { recursive: true });

// ---------- the mark ----------
function tribarPolys(size, opts = {}) {
  const L = opts.L ?? 4.4, t = opts.t ?? 1.2;
  const rot = (opts.rot ?? -90) * Math.PI / 180;
  const AX = [0.8660254, 0.5], AY = [-0.8660254, 0.5], AZ = [0, -1];
  const c = Math.cos(rot), s = Math.sin(rot);
  const pr = (i, j, k) => {
    const x = i * AX[0] + j * AY[0] + k * AZ[0];
    const y = i * AX[1] + j * AY[1] + k * AZ[1];
    return [x * c - y * s, x * s + y * c];
  };
  const faces = (i0, i1, j0, j1, k0, k1) => {
    const F = [];
    const q = (cs, ty) => F.push({
      pts: cs.map(p => pr(p[0], p[1], p[2])),
      ty, d: cs.reduce((a, p) => a + p[0] + p[1] + p[2], 0) / 4,
    });
    q([[i0,j0,k0],[i0,j1,k0],[i0,j1,k1],[i0,j0,k1]], "i");
    q([[i1,j0,k0],[i1,j1,k0],[i1,j1,k1],[i1,j0,k1]], "i");
    q([[i0,j0,k0],[i1,j0,k0],[i1,j0,k1],[i0,j0,k1]], "j");
    q([[i0,j1,k0],[i1,j1,k0],[i1,j1,k1],[i0,j1,k1]], "j");
    q([[i0,j0,k0],[i1,j0,k0],[i1,j1,k0],[i0,j1,k0]], "k");
    q([[i0,j0,k1],[i1,j0,k1],[i1,j1,k1],[i0,j1,k1]], "k");
    return F;
  };
  const beams = [[0,L,0,t,0,t],[L-t,L,0,L,0,t],[L-t,L,L-t,L,0,L]];
  let all = [];
  beams.forEach(b => (all = all.concat(faces(...b))));
  all.sort((a, b) => a.d - b.d);
  let mnX=1e9,mnY=1e9,mxX=-1e9,mxY=-1e9;
  all.forEach(f => f.pts.forEach(p => {
    if (p[0]<mnX) mnX=p[0]; if (p[0]>mxX) mxX=p[0];
    if (p[1]<mnY) mnY=p[1]; if (p[1]>mxY) mxY=p[1];
  }));
  const w=mxX-mnX, h=mxY-mnY, pad=size*0.17, sc=(size-pad*2)/Math.max(w,h);
  const oX=(size-w*sc)/2-mnX*sc, oY=(size-h*sc)/2-mnY*sc;
  const col={k:"#FFFFFF",i:"#CED0DA",j:"#9598A6"}, sw=(size*0.0038).toFixed(2);
  return all.map(f => {
    const pts = f.pts.map(p => (p[0]*sc+oX).toFixed(2)+","+(p[1]*sc+oY).toFixed(2)).join(" ");
    return `<polygon points="${pts}" fill="${col[f.ty]}" stroke="#1B1B22" stroke-width="${sw}" stroke-linejoin="round"/>`;
  }).join("");
}
function glowFilter(id, size) {
  const big = (size*0.030).toFixed(1), tight = (size*0.009).toFixed(1);
  return `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="${big}" result="b1"/>
    <feFlood flood-color="#c9ccff" flood-opacity="0.42" result="c1"/>
    <feComposite in="c1" in2="b1" operator="in" result="g1"/>
    <feGaussianBlur in="SourceAlpha" stdDeviation="${tight}" result="b2"/>
    <feFlood flood-color="#ffffff" flood-opacity="0.62" result="c2"/>
    <feComposite in="c2" in2="b2" operator="in" result="g2"/>
    <feMerge><feMergeNode in="g1"/><feMergeNode in="g2"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>`;
}
const markFrag = (size, fid) => `<defs>${glowFilter(fid, size)}</defs><g filter="url(#${fid})">${tribarPolys(size)}</g>`;
const markSVG = (size, fid) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${markFrag(size, fid)}</svg>`;

const FSTACK = "Inter,'Avenir Next','Helvetica Neue',Arial,sans-serif";
const WORD_EM = 2.32; // empirical advance of "lazyit" in ems (Avenir Next 600, -3% tracking)

function bannerSVG(W, H, markSize, wordSize, tagSize, gap, tag) {
  const total = markSize + gap + wordSize * WORD_EM;
  const startX = (W - total) / 2, markY = (H - markSize) / 2;
  const textX = startX + markSize + gap, cy = H / 2;
  const wordY = cy + wordSize * 0.34 - (tag ? tagSize * 0.9 : 0);
  const tagY = wordY + tagSize * 1.7;
  const tagEl = tag ? `\n  <text x="${textX.toFixed(1)}" y="${tagY.toFixed(1)}" font-family="${FSTACK}" font-weight="500" font-size="${tagSize}" letter-spacing="${(tagSize*0.02).toFixed(2)}" fill="#7C7C88">${tag}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000000"/>
  <g transform="translate(${startX.toFixed(1)},${markY.toFixed(1)})">${markFrag(markSize,"glowB")}</g>
  <text x="${textX.toFixed(1)}" y="${wordY.toFixed(1)}" font-family="${FSTACK}" font-weight="600" font-size="${wordSize}" letter-spacing="${(-wordSize*0.03).toFixed(2)}" fill="#FFFFFF">lazyit</text>${tagEl}
</svg>`;
}
function bannerHTML(W, H, markSize, wordSize, tagSize, gap, tag) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}html,body{background:#000}
  #stage{width:${W}px;height:${H}px;background:#000;display:flex;align-items:center;justify-content:center;gap:${gap}px}
  .word{font-family:${FSTACK};font-weight:600;font-size:${wordSize}px;letter-spacing:${(-wordSize*0.03).toFixed(2)}px;color:#fff;line-height:1}
  .tag{font-family:${FSTACK};font-weight:500;font-size:${tagSize}px;letter-spacing:${(tagSize*0.02).toFixed(2)}px;color:#7C7C88;line-height:1;margin-top:${(tagSize*0.9).toFixed(0)}px}
  svg{display:block;overflow:visible}</style></head>
  <body><div id="stage">${markSVG(markSize,"glowB")}<div><div class="word">lazyit</div>${tag?`<div class="tag">${tag}</div>`:""}</div></div></body></html>`;
}
const pageHTML = (W, H, inner) => `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{background:#000}#stage{width:${W}px;height:${H}px;overflow:hidden}svg{display:block}</style></head><body><div id="stage">${inner}</div></body></html>`;

// ---------- assets ----------
const TAG = "asset-centric IT operations";
const logo512 = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#000000"/>${markFrag(512,"glow")}</svg>`;
const social = bannerSVG(1280, 640, 300, 168, 25, 60, TAG);
const readme = bannerSVG(1200, 360, 176, 104, 19, 44, TAG);

writeFileSync(join(OUT, "lazyit-mark.svg"), markSVG(512, "glow"));
writeFileSync(join(OUT, "lazyit-logo.svg"), logo512);
writeFileSync(join(OUT, "lazyit-github-social.svg"), social);
writeFileSync(join(OUT, "lazyit-github-readme.svg"), readme);
console.log("✓ SVGs written");

if (SVG_ONLY) process.exit(0);
if (!existsSync(CHROME_BIN)) {
  console.log("! Chrome not found at", CHROME_BIN, "— skipping PNGs (run with the right CHROME_BIN, or --svg).");
  process.exit(0);
}
writeFileSync(join(TMP, "logo.html"), pageHTML(512, 512, logo512));
writeFileSync(join(TMP, "social.html"), bannerHTML(1280, 640, 300, 168, 25, 60, TAG));
writeFileSync(join(TMP, "readme.html"), bannerHTML(1200, 360, 176, 104, 19, 44, TAG));
const shot = (html, w, h, scale, out) => execFileSync(CHROME_BIN, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  `--force-device-scale-factor=${scale}`, `--window-size=${w},${h}`,
  `--screenshot=${join(OUT, out)}`, `file://${join(TMP, html)}`,
], { stdio: "ignore" });
shot("logo.html", 512, 512, 2, "lazyit-logo.png");
shot("social.html", 1280, 640, 1, "lazyit-github-social.png");
shot("social.html", 1280, 640, 2, "lazyit-github-social@2x.png");
shot("readme.html", 1200, 360, 1, "lazyit-github-readme.png");
console.log("✓ PNGs rasterized");
