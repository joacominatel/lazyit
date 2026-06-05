# lazyit — Brand assets

Logo and GitHub banners for **lazyit** (asset-centric, self-hosted IT operations).

## The mark

A **Penrose impossible triangle** (tribar) rendered as a faceted 3D ribbon — white,
glowing, on pure black. It's generated from exact isometric math: the three drawing
axes sit 120° apart and **sum to zero**, which is exactly why the ribbon loop closes
in 2D while remaining impossible in 3D. The geometry *is* the idea — structure and
systems for an IT-native tool, plus the wink in the name: *lazy* = making the
impossible look effortless.

> Brand context, not app UI. The product canvas is the warm **bone + indigo** system
> in `../DESIGN.md`; the brand mark deliberately uses a dark, high-contrast treatment
> (black + white + glow) for avatars, social cards and READMEs. The two coexist on
> purpose.

## Files

| File | Size | Use |
| --- | --- | --- |
| `lazyit-mark.svg` | 512² | Mark only, **transparent** — app icon source, favicons, avatars |
| `lazyit-logo.svg` / `.png` | 512² / 1024² | Mark on black — square logo / GitHub org avatar |
| `lazyit-github-social.svg` / `.png` | 1280×640 | **GitHub “Social preview”** (Settings → Social preview). `@2x` = 2560×1280 |
| `lazyit-github-readme.svg` / `.png` | 1200×360 | Wide header image for `README.md` |

Palette: background `#000000` · ribbon top `#FFFFFF`, sides `#CED0DA` / `#9598A6` ·
facet edge `#1B1B22` · glow white→`#c9ccff` · wordmark `#FFFFFF` · tagline `#7C7C88`.
Wordmark type: Inter / Avenir Next (Geist in the product), weight 600, −3% tracking.

## Use in the README

```md
<p align="center"><img src="brand/lazyit-github-readme.svg" alt="lazyit" width="600"></p>
```

(SVG carries the glow filter and renders on GitHub. Prefer the `.png` if you need a
guaranteed raster, e.g. the Social preview, which must be PNG/JPG.)

## Regenerate

```sh
bun generate.mjs        # SVGs + PNGs (PNGs need Google Chrome; edit CHROME_BIN if needed)
bun generate.mjs --svg  # SVGs only, no Chrome
```

PNGs are rasterized with headless Chrome so the SVG glow filter and the real
typeface render faithfully.

## Figma source

Editable source file: **lazyit — Brand** —
<https://www.figma.com/design/NYL6gdKIJjlkBxrlhXjxZK>
(contains the logo; banners are generated here via `generate.mjs`).
