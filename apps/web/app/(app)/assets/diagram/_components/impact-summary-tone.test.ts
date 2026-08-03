import { describe, expect, it } from "bun:test";
import { impactSummaryTone } from "./impact-summary-tone";

/** Every colour utility Tailwind would apply to TEXT, pulled out of a class list. */
function textUtilities(className: string): string[] {
  return className
    .split(/\s+/)
    .filter(Boolean)
    .filter((utility) => /^(?:[a-z-]+:)*text-/.test(utility));
}

describe("impactSummaryTone", () => {
  it("wears the success tone when nothing depends on the node", () => {
    const tone = impactSummaryTone(true);
    expect(tone.surface).toBe("border-success/40 bg-success/10");
    expect(tone.icon).toBe("text-success");
  });

  it("wears the destructive tone when something does", () => {
    const tone = impactSummaryTone(false);
    expect(tone.surface).toBe("border-destructive/40 bg-destructive/10");
    expect(tone.icon).toBe("text-destructive");
  });

  // The rule this file exists for (issue #812 / ADR-0049 / `Callout`): a status hue on a /10 tint of
  // its own hue measures 3.72:1 (success) and 3.93:1 (destructive) as text on this canvas — under the
  // 4.5:1 floor PRODUCT.md commits to. Asserted as a RULE over whatever utilities the surface carries
  // rather than as a literal string, so it still bites if someone adds `dark:text-destructive` or a
  // third tone later. The banner's readable text is `text-foreground`, set by the component.
  for (const safe of [true, false]) {
    it(`never paints the ${safe ? "safe" : "affected"} surface's text in the status hue`, () => {
      expect(textUtilities(impactSummaryTone(safe).surface)).toEqual([]);
    });
  }

  // The hue is not banned outright — it is banned from READABLE text. It still has to reach the
  // decorative icon, or "safe" and "affected" would be told apart by wording alone.
  it("keeps the status hue on the decorative icon", () => {
    expect(textUtilities(impactSummaryTone(true).icon)).toHaveLength(1);
    expect(textUtilities(impactSummaryTone(false).icon)).toHaveLength(1);
  });
});
