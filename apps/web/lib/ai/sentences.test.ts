import { describe, expect, test } from "bun:test";
import {
  AI_SENTENCE_CODES,
  AI_SENTENCES,
  formatAiSentence,
  type AiSentenceCode,
  type AiSentenceParamKind,
} from "@lazyit/shared";
import { createTranslator } from "next-intl";
import enAi from "../../messages/en/ai.json";
import esAi from "../../messages/es/ai.json";
import {
  LIST_ENUM_KINDS,
  localizedText,
  renderAiSentences,
  type SentenceRenderOptions,
} from "./sentences";

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

/** A translator over one locale's `ai.sentences`, throwing on any problem (as `useAiSentences` does). */
function translator(locale: "en" | "es"): Translate {
  const catalog = (locale === "en" ? enAi : esAi).sentences;
  return createTranslator({
    locale,
    timeZone: "UTC",
    messages: { sentences: catalog },
    namespace: "sentences",
    onError: (error) => {
      throw error;
    },
  } as Parameters<typeof createTranslator>[0]) as unknown as Translate;
}

function options(locale: "en" | "es", extra: Partial<SentenceRenderOptions> = {}): SentenceRenderOptions {
  const t = translator(locale);
  return { format: (code, values) => t(code, values), has: (code) => t.has(code), ...extra };
}

/** Sample params for a code: one value per declared kind. */
function sample(code: AiSentenceCode, pick: "first" | "other" = "first"): Record<string, string | number> {
  const params = AI_SENTENCES[code].params as Record<string, AiSentenceParamKind>;
  const out: Record<string, string | number> = {};
  for (const [name, kind] of Object.entries(params)) {
    if (kind === "number") out[name] = pick === "first" ? 1 : 3;
    else if (kind === "enum:YesNo") out[name] = pick === "first" ? "yes" : "no";
    else if (kind === "date") out[name] = "2026-10-01";
    else if (kind.startsWith("enum:")) out[name] = pick === "first" ? "ACCESS_REVOKED" : "zzz";
    else out[name] = `${name}-value`;
  }
  return out;
}

describe("the catalogs", () => {
  test("the en templates render exactly the English the API renders", () => {
    const en = options("en");
    for (const code of AI_SENTENCE_CODES) {
      for (const pick of ["first", "other"] as const) {
        const params = sample(code, pick);
        expect(renderAiSentences([{ code, params }], en)?.text).toBe(formatAiSentence(code, params));
      }
    }
  });

  test("every es template renders with its params and leaves no braces or unrendered English", () => {
    const es = options("es");
    for (const code of AI_SENTENCE_CODES) {
      for (const pick of ["first", "other"] as const) {
        const rendered = renderAiSentences([{ code, params: sample(code, pick) }], es);
        expect(rendered, code).not.toBeNull();
        expect(rendered!.text, code).not.toMatch(/[{}]/);
      }
    }
  });
});

describe("renderAiSentences", () => {
  const es = options("es");

  test("renders a list in the user's language, joined by one space", () => {
    const rendered = renderAiSentences(
      [
        { code: "application_create.action", params: { name: "Jira" } },
        { code: "application_create.actionCritical", params: {} },
      ],
      es,
    );
    expect(rendered).toEqual({
      text: "Agregar la aplicación “Jira” al catálogo. Queda marcada como crítica: cada cambio posterior que haga la IA sobre ella va a pedir tu contraseña en el chat.",
      untrusted: false,
    });
  });

  test("plural and select branches follow the params", () => {
    expect(
      renderAiSentences([{ code: "asset_create_batch.summary", params: { count: 3, total: 5, failed: 2 } }], es)?.text,
    ).toBe("Se crearon 3 de 5 activos; 2 no se crearon (ver problemas).");
    expect(
      renderAiSentences(
        [{ code: "user_create.summary", params: { user: "Ana", role: "ADMIN" } }],
        es,
      )?.text,
    ).toBe("Se creó a Ana como administrador.");
  });

  test("text params lose their untrusted wrappers and flag the result", () => {
    const rendered = renderAiSentences(
      [{ code: "asset_create.summary", params: { asset: "<untrusted_content>MBA-017</untrusted_content>" } }],
      es,
    );
    expect(rendered).toEqual({ text: "Se creó el activo MBA-017.", untrusted: true });
  });

  test("date params are formatted by the caller; an empty one stays empty", () => {
    const withDate = options("es", { date: (iso) => `[${iso}]` });
    const params = {
      self: "no",
      person: "Ana",
      hasLevel: "no",
      level: "",
      application: "Jira",
      hasUntil: "yes",
      until: "2026-10-01",
    };
    expect(renderAiSentences([{ code: "access_grant_create.action", params }], withDate)?.text).toBe(
      "Darle a Ana acceso a Jira hasta el [2026-10-01].",
    );
  });

  test("list-valued enum params are mapped item by item; select subjects pass raw", () => {
    const mapped = options("es", {
      enumItem: (kind, item) => (kind === "enum:PreviewFieldList" ? item.toUpperCase() : null),
    });
    expect(
      renderAiSentences(
        [{ code: "application_update.action", params: { fields: "name, url", name: "Jira" } }],
        mapped,
      )?.text,
    ).toBe("Cambiar NAME, URL de la aplicación “Jira”.");
    expect(
      renderAiSentences([{ code: "taxonomy.categoryKind", params: { kind: "applicationCategory" } }], mapped)?.text,
    ).toBe("categoría de aplicaciones");
  });

  test("the list-valued enum kinds are never a select subject", () => {
    for (const code of AI_SENTENCE_CODES) {
      const params = AI_SENTENCES[code].params as Record<string, AiSentenceParamKind>;
      for (const [name, kind] of Object.entries(params)) {
        if (!(LIST_ENUM_KINDS as readonly string[]).includes(kind)) continue;
        expect(AI_SENTENCES[code].en).not.toContain(`{${name}, select`);
      }
    }
  });

  describe("falls back (null) unless the whole list renders", () => {
    const ok = { code: "asset_create.summary", params: { asset: "MBA-017" } };
    const cases: [string, unknown][] = [
      ["no field", undefined],
      ["not a list", ok],
      ["an empty list", []],
      ["more than 20 sentences", Array.from({ length: 21 }, () => ok)],
      ["an item that is not an object", [ok, "asset_create.summary"]],
      ["a code that is not a string", [{ code: 7, params: {} }]],
      ["params that are not an object", [{ code: "asset_create.summary", params: ["MBA-017"] }]],
      ["an unknown code", [ok, { code: "asset_teleport.summary", params: {} }]],
      ["a missing param", [ok, { code: "asset_check_out.summary", params: { asset: "MBA-017" } }]],
      ["a non-numeric count", [{ code: "request_input.summary", params: { count: "many" } }]],
      ["an object param", [{ code: "asset_create.summary", params: { asset: { label: "x" } } }]],
    ];
    for (const [name, value] of cases) {
      test(name, () => {
        expect(renderAiSentences(value, es)).toBeNull();
      });
    }

    test("a code this build's catalog lacks", () => {
      expect(renderAiSentences([ok], { ...es, has: () => false })).toBeNull();
    });

    test("a template that fails to format", () => {
      expect(
        renderAiSentences([ok], {
          format: () => {
            throw new Error("FORMATTING_ERROR");
          },
        }),
      ).toBeNull();
    });
  });

  test("a numeric string counts as a number", () => {
    expect(renderAiSentences([{ code: "request_input.summary", params: { count: "2" } }], es)?.text).toBe(
      "Se pidieron 2 campos",
    );
  });
});

describe("localizedText", () => {
  const render = (sentences: unknown) => renderAiSentences(sentences, options("es"));

  test("the localized sentences when they render", () => {
    expect(
      localizedText("Article updated.", [{ code: "kb_update_article.summary", params: {} }], render),
    ).toEqual({ text: "Se actualizó el artículo.", untrusted: false });
  });

  test("the English (wrappers stripped) when there are no sentences, they do not render, or no renderer", () => {
    const english = "Created the asset <untrusted_content>X</untrusted_content>.";
    expect(localizedText(english, undefined, render)).toEqual({ text: "Created the asset X.", untrusted: true });
    expect(localizedText(english, [{ code: "nope", params: {} }], render)?.text).toBe("Created the asset X.");
    expect(localizedText(english, [{ code: "kb_update_article.summary", params: {} }], undefined)?.text).toBe(
      "Created the asset X.",
    );
  });

  test("null when there is neither", () => {
    expect(localizedText(undefined, undefined, render)).toBeNull();
  });
});
