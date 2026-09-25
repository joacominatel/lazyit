import { describe, expect, test } from "bun:test";
import {
  AI_SENTENCE_CODES,
  AI_SENTENCES,
  AiSentenceListSchema,
  AiSentencesFieldSchema,
  aiSentenceTemplateParams,
  formatAiSentence,
  formatAiSentences,
  isAiSentenceCode,
} from "./ai-sentences";
import { AiActionPreviewSchema, AiToolResultSchema } from "./ai-tools";
import { AiToolResultSummarySchema } from "./ai-run";

// Localizable server-built sentences (#1384; tools-and-execution.md §9.1).

const entries = Object.entries(AI_SENTENCES) as [
  keyof typeof AI_SENTENCES,
  { en: string; params: Record<string, string> },
][];

describe("the closed list of sentence codes", () => {
  test("is non-empty and every code is well formed", () => {
    expect(AI_SENTENCE_CODES.length).toBeGreaterThan(100);
    for (const code of AI_SENTENCE_CODES) {
      expect(code).toMatch(/^[a-z][a-z_]*(\.[a-zA-Z]+)+$/);
      expect(isAiSentenceCode(code)).toBe(true);
    }
    expect(isAiSentenceCode("not.a_code")).toBe(false);
    expect(isAiSentenceCode("toString")).toBe(false);
  });

  test.each(entries)("%s declares exactly the params its template names", (_code, def) => {
    expect(aiSentenceTemplateParams(def.en).sort()).toEqual(Object.keys(def.params).sort());
  });

  test.each(entries)("%s declares only known param kinds", (_code, def) => {
    for (const kind of Object.values(def.params)) {
      expect(kind).toMatch(/^(text|number|date|enum:[A-Za-z]+)$/);
    }
  });

  test.each(entries)("%s never uses ICU apostrophe quoting", (_code, def) => {
    // `'{`, `'}`, `''` and `'#` quote in ICU MessageFormat; a plain apostrophe (`person's`) does not.
    expect(def.en).not.toMatch(/'[{}#']/);
  });

  test.each(entries)("%s: a YesNo flag selects on `yes` with an `other` branch", (_code, def) => {
    for (const [name, kind] of Object.entries(def.params)) {
      if (kind !== "enum:YesNo") continue;
      expect(def.en).toContain(`{${name}, select, yes {`);
    }
  });
});

describe("formatAiSentence (the English, rendered from the template)", () => {
  test("fills arguments", () => {
    expect(formatAiSentence("application_create.action", { name: "Jira" })).toBe(
      'Add the application "Jira" to the catalog.',
    );
  });

  test("selects, including nested arguments and apostrophes", () => {
    const base = { person: "Ana Ops", hasLevel: "yes", level: "admin", application: "VPN" };
    expect(formatAiSentence("access_grant_revoke.action", { ...base, self: "no" })).toBe(
      `Remove Ana Ops's "admin" access to VPN.`,
    );
    expect(
      formatAiSentence("access_grant_revoke.action", { ...base, self: "yes", hasLevel: "no" }),
    ).toBe("Remove your access to VPN.");
  });

  test("plurals: exact, one, other and #", () => {
    const at = (skipped: number) =>
      formatAiSentence("asset_create_batch.action", { count: 3, total: 3 + skipped, skipped });
    expect(at(0)).toBe("Create 3 of 3 assets.");
    expect(at(1)).toBe("Create 3 of 4 assets; 1 row skipped as requested.");
    expect(at(2)).toBe("Create 3 of 5 assets; 2 rows skipped as requested.");
  });

  test("a param value is inserted verbatim, never parsed as a template", () => {
    expect(formatAiSentence("kb.audience.folder", { folder: "{odd} #1 'x'" })).toBe(
      "{odd} #1 'x':",
    );
  });

  test("throws on a missing param", () => {
    expect(() => formatAiSentence("application_create.action", {})).toThrow(/name/);
  });

  test("a list renders its sentences joined by one space", () => {
    expect(
      formatAiSentences([
        { code: "application_create.action", params: { name: "Jira" } },
        { code: "application_create.actionCritical", params: {} },
      ]),
    ).toBe(
      'Add the application "Jira" to the catalog. It is marked critical: every later AI change to it needs your password in the chat.',
    );
  });
});

describe("the wire fields are optional and read-tolerant", () => {
  const sentences = [{ code: "application_create.action", params: { name: "Jira" } }];

  test("a sentence list parses; an empty or malformed one does not", () => {
    expect(AiSentenceListSchema.safeParse(sentences).success).toBe(true);
    expect(AiSentenceListSchema.safeParse([]).success).toBe(false);
    expect(AiSentenceListSchema.safeParse([{ code: "", params: {} }]).success).toBe(false);
  });

  test("the optional field drops what it cannot read instead of failing", () => {
    expect(AiSentencesFieldSchema.parse(undefined)).toBeUndefined();
    expect(AiSentencesFieldSchema.parse("nonsense")).toBeUndefined();
    expect(AiSentencesFieldSchema.parse([{ code: 1 }])).toBeUndefined();
    expect(AiSentencesFieldSchema.parse(sentences)).toEqual(sentences);
  });

  const preview = {
    toolName: "application_create",
    class: "write",
    changes: [{ field: "action", after: 'Add the application "Jira" to the catalog.' }],
    warnings: [],
    elevated: false,
    stepUpRequired: false,
  };

  test("a preview stored before #1384 (no sentences) still parses unchanged", () => {
    const parsed = AiActionPreviewSchema.parse(preview);
    expect(parsed.changes[0]).toEqual(preview.changes[0]!);
  });

  test("a preview carries the sentences of a row; a malformed list is dropped, the preview kept", () => {
    const withSentences = AiActionPreviewSchema.parse({
      ...preview,
      changes: [{ ...preview.changes[0], afterSentences: sentences }],
    });
    expect(withSentences.changes[0]!.afterSentences).toEqual(sentences);
    const malformed = AiActionPreviewSchema.safeParse({
      ...preview,
      changes: [{ ...preview.changes[0], afterSentences: [{ nope: true }] }],
    });
    expect(malformed.success).toBe(true);
    expect(malformed.data!.changes[0]!.afterSentences).toBeUndefined();
  });

  test("a tool result and its web summary carry summary and error sentences", () => {
    const ok = AiToolResultSchema.parse({
      ok: true,
      kind: "mutation",
      data: null,
      summary: 'Added the application "Jira" to the catalog.',
      summarySentences: [{ code: "application_create.summary", params: { name: "Jira" } }],
      mutated: true,
      entityRefs: [],
    });
    expect(ok.ok && ok.summarySentences?.[0]?.code).toBe("application_create.summary");
    const failed = AiToolResultSummarySchema.parse({
      toolCallId: "t1",
      kind: "mutation",
      status: "error",
      mutated: false,
      entityRefs: [],
      error: {
        code: "STALE",
        message: "The target changed…",
        messageSentences: [{ code: "refusal.stale", params: {} }],
      },
    });
    expect(failed.error?.messageSentences?.[0]?.code).toBe("refusal.stale");
    // An older summary, without them, still parses.
    expect(
      AiToolResultSummarySchema.safeParse({
        toolCallId: "t1",
        kind: "read",
        status: "ok",
        summary: "Found 3",
        mutated: false,
        entityRefs: [],
      }).success,
    ).toBe(true);
  });
});
