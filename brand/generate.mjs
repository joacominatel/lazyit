// lazyit brand asset generator — "The Ledger".
//
// The mark is the printed-record wordmark reduced: ink "lz" on a paper tile with
// the single oxblood registration tick — the same lockup as the app favicon, the
// in-app rail, and lazyit.dev. (This replaces the old Penrose-tribar generator; the
// brand is now the ledger/stamp, per ADR-0077.)
//
// Usage:
//   bun generate.mjs           # writes SVGs, then rasterizes PNGs via headless chromium (playwright)
//   bun generate.mjs --svg     # SVGs only (no browser needed)
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = import.meta.dir;
const SVG_ONLY = process.argv.includes("--svg");

// Ledger tokens (hex mirrors of the OKLCH brand tokens).
const C = { paper: "#f7f6f4", ink: "#1a1a1a", inkSoft: "#6b6b6b", oxblood: "#9e2b25", rule: "#e0ddd8" };

// font files (woff2) — vendored in the app + the landing's @fontsource.
const F = {
  mono: "file:///Users/jminatel/dev/lazyit/apps/web/app/fonts/commit-mono-latin-600-normal.woff2",
  red400: "file:///Users/jminatel/dev/lazyit/apps/web/app/fonts/redaction-latin-400-normal.woff2",
  red700: "file:///Users/jminatel/dev/lazyit/apps/web/app/fonts/redaction-latin-700-normal.woff2",
  hanken: "file:///Users/jminatel/dev/lazyit-landing/node_modules/@fontsource/hanken-grotesk/files/hanken-grotesk-latin-400-normal.woff2",
};

// ---------- SVGs ----------
// The mark: paper tile + ink "lz" (vector paths, no font dependency) + the oxblood tick.
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32" role="img" aria-label="lazyit">
  <rect width="32" height="32" rx="6" fill="${C.paper}"/>
  <g fill="none" stroke="${C.ink}" stroke-width="3" stroke-linecap="butt" stroke-linejoin="miter">
    <path d="M8.5 7.5 V23.5"/>
    <path d="M12.8 13.5 H21.2 L13 22 H21.4"/>
  </g>
  <rect x="23.4" y="19.4" width="4.4" height="4.4" fill="${C.oxblood}"/>
</svg>
`;

// The wordmark lockup: mono "lazyit" + the oxblood tick (transparent bg).
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80" viewBox="0 0 300 80" role="img" aria-label="lazyit">
  <text x="0" y="57" font-family="'Commit Mono', ui-monospace, SFMono-Regular, Menlo, monospace" font-size="58" font-weight="600" letter-spacing="-1.5" fill="${C.ink}">lazyit</text>
  <rect x="232" y="40" width="16" height="16" rx="2.5" fill="${C.oxblood}"/>
</svg>
`;

// A simple Ledger banner SVG source (the polished raster is the .png below).
function bannerSvg(w, h, social) {
  const cx = social ? w / 2 : 80;
  const anchor = social ? "middle" : "start";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="lazyit — the system of record">
  <rect width="${w}" height="${h}" fill="${C.paper}"/>
  <g text-anchor="${anchor}" font-family="'Commit Mono', ui-monospace, monospace">
    <text x="${cx}" y="${social ? h / 2 - 24 : 188}" font-size="84" font-weight="600" letter-spacing="-2" fill="${C.ink}">lazyit</text>
    <rect x="${social ? cx + 168 : 268}" y="${social ? h / 2 - 60 : 152}" width="26" height="26" rx="4" fill="${C.oxblood}"/>
    <text x="${cx}" y="${social ? h / 2 + 44 : 250}" font-size="26" fill="${C.inkSoft}" letter-spacing="0.5">The system of record for the team that runs everything.</text>
    <text x="${cx}" y="${social ? h / 2 + 92 : 296}" font-size="20" fill="${C.inkSoft}">Self-hosted · Asset-centric · Auditable by default · AGPL-3.0</text>
  </g>
</svg>
`;
}

writeFileSync(join(OUT, "lazyit-mark.svg"), markSvg);
writeFileSync(join(OUT, "lazyit-logo.svg"), logoSvg);
writeFileSync(join(OUT, "lazyit-github-readme.svg"), bannerSvg(1280, 440, false));
writeFileSync(join(OUT, "lazyit-github-social.svg"), bannerSvg(1200, 630, true));
console.log("wrote 4 SVGs");

if (SVG_ONLY) process.exit(0);

// ---------- rasterize PNGs (real fonts via headless chromium) ----------
const fontFace = `
@font-face{font-family:'Commit Mono';font-weight:600;src:url('${F.mono}')}
@font-face{font-family:'Redaction';font-weight:400;src:url('${F.red400}')}
@font-face{font-family:'Redaction';font-weight:700;src:url('${F.red700}')}
@font-face{font-family:'Hanken Grotesk';font-weight:400;src:url('${F.hanken}')}
*{margin:0;padding:0;box-sizing:border-box}`;

const stampCss = `font-family:'Hanken Grotesk',sans-serif;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:${C.oxblood};
  padding:9px 18px;border:2.5px solid ${C.oxblood};border-radius:4px;background:${C.oxblood}17;box-shadow:inset 0 0 0 1px ${C.oxblood}38;
  text-shadow:0.5px 0 0 currentColor;opacity:0.96`;

const logoHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fontFace}
body{width:600px;height:180px;display:flex;align-items:center;gap:24px;padding:0 40px;background:transparent}
.wm{font-family:'Commit Mono',monospace;font-weight:600;font-size:104px;letter-spacing:-2px;color:${C.ink};line-height:1}
.tick{width:30px;height:30px;border-radius:5px;background:${C.oxblood}}
</style></head><body><span class="wm">lazyit</span><span class="tick"></span></body></html>`;

function bannerHtml(w, h, social) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fontFace}
:root{--bg:${C.paper};--ink:${C.ink};--ink-soft:${C.inkSoft};--stamp:${C.oxblood}}
body{width:${w}px;height:${h}px;background:var(--bg);color:var(--ink);font-family:'Hanken Grotesk',sans-serif;overflow:hidden;position:relative;
  background-image:radial-gradient(${C.ink}04 1px, transparent 1.4px);background-size:5px 5px}
.wrap{position:absolute;inset:0;padding:${social ? "0 96px" : "64px 80px"};display:flex;flex-direction:column;justify-content:center;${social ? "align-items:center;text-align:center" : ""}}
.wm{display:inline-flex;align-items:center;gap:16px;font-family:'Commit Mono',monospace;font-weight:600;font-size:${social ? 104 : 96}px;letter-spacing:-0.02em;line-height:1}
.wm .tick{width:30px;height:30px;border-radius:5px;background:var(--stamp)}
.tagline{margin-top:26px;font-family:'Redaction',Georgia,serif;font-weight:400;font-size:${social ? 44 : 40}px;line-height:1.18;color:var(--ink);max-width:20ch}
.sub{margin-top:22px;font-family:'Commit Mono',monospace;font-size:21px;letter-spacing:0.02em;color:var(--ink-soft)}
.stamp{position:absolute;${social ? "left:50%;top:54px;transform:translateX(-50%) rotate(-7deg)" : "right:78px;top:60px;transform:rotate(-7deg)"};${stampCss};font-size:30px}
.thesis{position:absolute;${social ? "left:0;right:0;bottom:46px;text-align:center" : "right:80px;bottom:54px;text-align:right"};font-family:'Redaction',Georgia,serif;font-size:27px;color:var(--ink-soft);line-height:1.3}
.thesis b{color:var(--ink);font-weight:700}
</style></head><body>
<div class="wrap"><div class="wm">lazyit<span class="tick"></span></div>
<div class="tagline">The system of record for the team that runs everything.</div>
<div class="sub">Self-hosted · Asset-centric · Auditable by default · AGPL-3.0</div></div>
<div class="stamp">Recorded</div>
<div class="thesis">Spreadsheets lie by omission.<br><b>Ledgers don&rsquo;t.</b></div>
</body></html>`;
}

const { chromium } = await import("playwright");
const browser = await chromium.launch();
async function shoot(html, w, h, file, scale = 2) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  const p = await ctx.newPage();
  await p.setContent(html, { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(OUT, file), omitBackground: file.includes("logo"), clip: { x: 0, y: 0, width: w, height: h } });
  await ctx.close();
  console.log("rasterized", file);
}
await shoot(logoHtml, 600, 180, "lazyit-logo.png");
await shoot(bannerHtml(1280, 440, false), 1280, 440, "lazyit-github-readme.png");
await shoot(bannerHtml(1200, 630, true), 1200, 630, "lazyit-github-social.png");
await shoot(bannerHtml(1200, 630, true), 1200, 630, "lazyit-github-social@2x.png", 2);
await browser.close();
console.log("done");
