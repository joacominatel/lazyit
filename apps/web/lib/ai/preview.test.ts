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
