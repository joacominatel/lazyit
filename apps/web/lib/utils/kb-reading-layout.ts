/**
 * Geometry for the KB article reading view (#1292). The class strings live here — not inline in
 * `article-detail-view.tsx` — because they encode one arithmetic relationship that three separate
 * elements have to agree on, and because the two TOC placements must stay exact complements of the
 * rail breakpoint or the table of contents is rendered twice, or not at all.
 *
 * The problem being solved: the reading view used to split into three columns at Tailwind's `xl`
 * (1280px), a viewport breakpoint that says nothing about how much room the split actually has. On
 * a 1440px viewport the fixed chrome ({@link READING_CHROME_PX}) and the rail ({@link RAIL_COST_PX})
 * left the prose ~544px, so its `max-w-3xl` cap never engaged; on 1920px the outer `max-w-6xl`
 * stopped the block ~200px short of the available width and the prose stopped 56px short of the
 * rail. Both are the same mistake read from opposite ends.
 *
 * So the split is gated on {@link RAIL_MIN_VIEWPORT} — the width where the three columns fit at the
 * full {@link READING_MEASURE_PX} — and the container above it is capped at exactly measure + rail
 * cost, so prose, gap and rail tile it with nothing dead in between. The measure is continuous
 * across the breakpoint: 872px on either side of it.
 *
 * The numbers are exported so `kb-reading-layout.test.ts` can check the relationship still holds;
 * Tailwind only ever sees the literal class strings.
 */

/**
 * The reading measure. Wide enough that a runbook's tables and code blocks are not squeezed, still
 * bounded so an ultra-wide monitor does not stretch body prose to an unreadable line length.
 */
export const READING_MEASURE_PX = 872;

/** `gap-x-10` (40px) + the right rail's `w-72` (288px) — what the three-column split costs. */
export const RAIL_COST_PX = 40 + 288;

/**
 * Chrome outside this view at `md`+ with the KB folder tree showing: the app sidebar (`w-60`, 240px),
 * the app shell's `md:p-6` (48px) and the folder rail (`lg:w-64` + `gap-6`, 280px). None of it is
 * this unit's to change — it is the fixed cost the reading column is measured against.
 */
export const READING_CHROME_PX = 240 + 48 + 280;

/**
 * Viewport width from which the right rail sits beside the prose instead of stacking below it.
 * `READING_MEASURE_PX + RAIL_COST_PX + READING_CHROME_PX` is 1768; rounded up to a round 1800.
 * Tailwind has no stock breakpoint here, hence the arbitrary `min-[1800px]:` variant below.
 */
export const RAIL_MIN_VIEWPORT = 1800;

/** Container cap once the rail is beside the prose: the measure plus exactly what the rail costs. */
export const READING_CONTAINER_PX = READING_MEASURE_PX + RAIL_COST_PX;

/** Outer block: the bare measure while stacked, measure + rail cost once the rail is beside it. */
export const READING_CONTAINER = "max-w-[54.5rem] min-[1800px]:max-w-[75rem]";

/** The prose/rail row — column while stacked, row once the rail fits. */
export const READING_ROW = "min-[1800px]:flex-row min-[1800px]:items-start";

/** The rail `<aside>`: full width while stacked below the prose, a fixed 288px column above. */
export const READING_RAIL = "min-[1800px]:w-72 min-[1800px]:shrink-0";

/** The rail only sticks once it is a column; stacked below the prose it scrolls with the page. */
export const READING_RAIL_STICKY =
  "min-[1800px]:sticky min-[1800px]:top-4 min-[1800px]:max-h-[calc(100vh-2rem)] min-[1800px]:overflow-y-auto min-[1800px]:pb-4";

/** The sticky rail TOC — shown only where the rail is a column. Complement of {@link TOC_STACKED_ONLY}. */
export const TOC_RAIL_ONLY = "hidden min-[1800px]:block";

/** The `<details>` TOC disclosure above the prose — shown only while stacked. */
export const TOC_STACKED_ONLY = "min-[1800px]:hidden";
