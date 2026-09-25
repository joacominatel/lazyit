import { describe, expect, test } from "bun:test";
import { AI_SENTENCE_CODES, AI_SENTENCES, aiSentenceTemplateParams } from "@lazyit/shared";
import enAi from "./en/ai.json";
import esAi from "./es/ai.json";

/**
 * The web's `ai.sentences` catalogs cover the closed list of server-built sentence codes (#1384;
 * `AI_SENTENCES` in `@lazyit/shared`): every code in both locales, nothing else, the `en` template a copy
 * of the shared English, and each `es` template naming exactly the params of its `en` one.
 */

/** Dotted leaf paths of a nested catalog → their template. */
function leaves(node: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (typeof node === "string") {
    out.set(prefix, node);
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    leaves(value, prefix === "" ? key : `${prefix}.${key}`, out);
  }
  return out;
}

const catalogs = { en: leaves(enAi.sentences), es: leaves(esAi.sentences) };

describe("ai.sentences catalogs", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    test(`${locale} has exactly the shared codes`, () => {
      expect([...catalog.keys()].sort()).toEqual([...AI_SENTENCE_CODES].sort());
    });
  }

  test("each en template is the shared English template", () => {
    for (const code of AI_SENTENCE_CODES) {
      expect(catalogs.en.get(code), code).toBe(AI_SENTENCES[code].en);
    }
  });

  test("each es template names exactly the params of its en template", () => {
    for (const code of AI_SENTENCE_CODES) {
      const en = aiSentenceTemplateParams(catalogs.en.get(code)!).sort();
      const es = aiSentenceTemplateParams(catalogs.es.get(code)!).sort();
      expect(es, code).toEqual(en);
    }
  });

  test("no es template uses ICU apostrophe quoting", () => {
    for (const code of AI_SENTENCE_CODES) {
      expect(catalogs.es.get(code)!, code).not.toMatch(/'[{}#|']/);
    }
  });
});
