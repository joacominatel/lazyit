import { describe, expect, it } from "bun:test";
import {
  RAIL_COST_PX,
  RAIL_MIN_VIEWPORT,
  READING_CHROME_PX,
  READING_CONTAINER,
  READING_CONTAINER_PX,
  READING_MEASURE_PX,
  READING_RAIL,
  READING_RAIL_STICKY,
  READING_ROW,
  TOC_RAIL_ONLY,
  TOC_STACKED_ONLY,
} from "./kb-reading-layout";

/** rem → px for the arbitrary `max-w-[…rem]` value carried by one variant (or by the base). */
function remValue(classes: string, variant: string | null): number {
  const wanted = variant ? `${variant}:` : "";
  for (const token of classes.split(" ")) {
    const body = variant ? (token.startsWith(wanted) ? token.slice(wanted.length) : null) : token;
    if (!body || (!variant && token.includes(":"))) continue;
    const match = /^max-w-\[([\d.]+)rem]$/.exec(body);
    if (match) return Number(match[1]) * 16;
  }
  throw new Error(`no max-w-[…rem] for ${variant ?? "the base"} in "${classes}"`);
}

const VARIANT = `min-[${RAIL_MIN_VIEWPORT}px]`;

describe("KB reading layout geometry", () => {
  it("only splits into three columns once the reading measure, the rail and the fixed chrome all fit", () => {
    // The #1292 bug: `xl` (1280px) split the row long before there was room for it, so the prose
    // was squeezed to whatever the rail left over instead of keeping its measure.
    expect(RAIL_MIN_VIEWPORT).toBeGreaterThanOrEqual(
      READING_MEASURE_PX + RAIL_COST_PX + READING_CHROME_PX,
    );
  });

  it("caps the split container at exactly the measure plus what the rail costs", () => {
    // Anything larger leaves dead space between the prose and the rail (the 1920px half of #1292);
    // anything smaller shrinks the prose below its measure.
    expect(READING_CONTAINER_PX).toBe(READING_MEASURE_PX + RAIL_COST_PX);
    expect(remValue(READING_CONTAINER, VARIANT)).toBe(READING_CONTAINER_PX);
  });

  it("gives the stacked column the full reading measure, so the measure is continuous across the breakpoint", () => {
    expect(remValue(READING_CONTAINER, null)).toBe(READING_MEASURE_PX);
  });

  it("keeps the two TOC placements exact complements, so it is never doubled nor unreachable", () => {
    expect(TOC_RAIL_ONLY).toBe(`hidden ${VARIANT}:block`);
    expect(TOC_STACKED_ONLY).toBe(`${VARIANT}:hidden`);
  });

  it("gates every rail-only class on the same breakpoint as the row split", () => {
    for (const classes of [READING_ROW, READING_RAIL, READING_RAIL_STICKY, TOC_RAIL_ONLY]) {
      for (const token of classes.split(" ")) {
        if (token === "hidden") continue; // the unconditional base of TOC_RAIL_ONLY
        expect(token.startsWith(`${VARIANT}:`)).toBe(true);
      }
    }
  });
});
