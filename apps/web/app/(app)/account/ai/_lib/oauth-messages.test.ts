import { describe, expect, test } from "bun:test";
import { OAUTH_AUTHORIZE_REFUSALS, OAUTH_SCOPES } from "@lazyit/shared";
import en from "@/messages/en/oauth.json";
import es from "@/messages/es/oauth.json";
import { scopeMessageKey } from "./scope-labels";

/** Covering set (docs/ai-assistant/frontend.md §8.1): every scope and refusal has copy in both catalogs. */
describe("oauth catalogs cover the closed sets", () => {
  for (const [locale, catalog] of [
    ["en", en],
    ["es", es],
  ] as const) {
    test(`${locale}: every scope has a label`, () => {
      const keys = new Set(OAUTH_SCOPES.map(scopeMessageKey));
      expect(keys.size).toBe(OAUTH_SCOPES.length);
      for (const key of keys) {
        const entry = catalog.scopes[key];
        expect(entry.short.length).toBeGreaterThan(0);
        expect(entry.label.length).toBeGreaterThan(0);
        expect(entry.description.length).toBeGreaterThan(0);
      }
    });

    test(`${locale}: every consent refusal has a title and body`, () => {
      for (const refusal of OAUTH_AUTHORIZE_REFUSALS) {
        const entry = catalog.consent.stop.refusal[refusal];
        expect(entry.title.length).toBeGreaterThan(0);
        expect(entry.body.length).toBeGreaterThan(0);
      }
    });
  }
});
