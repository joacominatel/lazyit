import { expect, test } from "bun:test";
import { parseTaxonomyTab } from "./taxonomy-tabs";

test("?tab= opens a known tab; absent or unknown falls back to the first one", () => {
  expect(parseTaxonomyTab("statuses")).toBe("statuses");
  expect(parseTaxonomyTab("models")).toBe("models");
  expect(parseTaxonomyTab(null)).toBe("asset");
  expect(parseTaxonomyTab(undefined)).toBe("asset");
  expect(parseTaxonomyTab("nope")).toBe("asset");
});
