import { describe, expect, test } from "bun:test";
import { formatPreviewValue, humanizeKey, presentPreview } from "./preview";

describe("presentPreview", () => {
  test("the action row comes first, as a sentence, and is not a field row", () => {
    const model = presentPreview({
      changes: [
        { field: "serial", before: "A", after: "B" },
        { field: "action", after: "Give Ana <untrusted_content>VPN</untrusted_content> access." },
      ],
    });
    expect(model.action).toEqual({ text: "Give Ana VPN access.", untrusted: true });
    expect(model.rows.map((r) => r.field)).toEqual(["serial"]);
  });

  test("no action row → null; a create row has no before", () => {
    const model = presentPreview({ changes: [{ field: "name", after: "MBA-017" }] });
    expect(model.action).toBeNull();
    expect(model.rows[0]).toEqual({ field: "name", before: null, after: { kind: "text", text: "MBA-017", untrusted: false } });
  });
});

describe("formatPreviewValue", () => {
  test("value kinds", () => {
    expect(formatPreviewValue("s3cr3t", "redacted")).toEqual({ kind: "redacted" });
    expect(formatPreviewValue(null)).toEqual({ kind: "empty" });
    expect(formatPreviewValue("")).toEqual({ kind: "empty" });
    expect(formatPreviewValue(true, "boolean")).toEqual({ kind: "boolean", value: true });
    expect(formatPreviewValue(3)).toEqual({ kind: "number", value: 3 });
    expect(formatPreviewValue("2026-09-24T10:00:00Z", "date")).toEqual({ kind: "date", iso: "2026-09-24T10:00:00Z" });
    expect(formatPreviewValue("not a date", "date")).toEqual({ kind: "text", text: "not a date", untrusted: false });
  });

  test("entities read by label; arrays join; objects never render as markup", () => {
    expect(formatPreviewValue({ type: "user", id: "u", label: "Juan" }, "entity")).toEqual({
      kind: "text",
      text: "Juan",
      untrusted: false,
    });
    expect(formatPreviewValue(["a", "b", 3])).toEqual({ kind: "text", text: "a, b, 3", untrusted: false });
    const html = formatPreviewValue("<img src=x onerror=alert(1)>");
    expect(html).toEqual({ kind: "text", text: "<img src=x onerror=alert(1)>", untrusted: false });
  });

  test("long text is capped", () => {
    const v = formatPreviewValue("x".repeat(2000));
    expect(v.kind === "text" && v.text.length).toBe(501);
  });
});

describe("humanizeKey", () => {
  test("snake, camel and dotted keys", () => {
    expect(humanizeKey("assignedTo")).toBe("Assigned to");
    expect(humanizeKey("access_level")).toBe("Access level");
    expect(humanizeKey("asset_search")).toBe("Asset search");
  });
});

describe("presentPreview with sentences (#1384)", () => {
  /** A stand-in renderer: knows one code, stamps the rest as unrenderable. */
  const render = (sentences: unknown) => {
    const list = sentences as { code: string; params: Record<string, string> }[];
    if (!list.every((s) => s.code === "known")) return null;
    return { text: list.map((s) => `ES:${s.params.v}`).join(" "), untrusted: list.some((s) => s.params.v === "u") };
  };

  test("the action and value rows show the localized sentences", () => {
    const model = presentPreview(
      {
        changes: [
          {
            field: "action",
            after: "Add the application \"Jira\" to the catalog.",
            afterSentences: [{ code: "known", params: { v: "a" } }, { code: "known", params: { v: "b" } }],
          },
          {
            field: "audience",
            before: "Everyone",
            after: "Restricted",
            beforeSentences: [{ code: "known", params: { v: "before" } }],
            afterSentences: [{ code: "known", params: { v: "u" } }],
          },
        ],
      },
      render,
    );
    expect(model.action).toEqual({ text: "ES:a ES:b", untrusted: false });
    expect(model.rows[0]).toEqual({
      field: "audience",
      before: { kind: "text", text: "ES:before", untrusted: false },
      after: { kind: "text", text: "ES:u", untrusted: true },
    });
  });

  test("the English shows when the sentences do not render, or without a renderer", () => {
    const preview = {
      changes: [
        { field: "action", after: "Add it.", afterSentences: [{ code: "unknown", params: {} }] },
        { field: "audience", after: "Everyone", afterSentences: [{ code: "unknown", params: {} }] },
      ],
    };
    for (const model of [presentPreview(preview, render), presentPreview(preview)]) {
      expect(model.action).toEqual({ text: "Add it.", untrusted: false });
      expect(model.rows[0]!.after).toEqual({ kind: "text", text: "Everyone", untrusted: false });
    }
  });

  test("a redacted value is never replaced by sentences", () => {
    const model = presentPreview(
      { changes: [{ field: "secret", after: "x", valueKind: "redacted", afterSentences: [{ code: "known", params: { v: "a" } }] }] },
      render,
    );
    expect(model.rows[0]!.after).toEqual({ kind: "redacted" });
  });
});
