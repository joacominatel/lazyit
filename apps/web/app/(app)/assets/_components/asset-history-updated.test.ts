/**
 * The asset history `UPDATED` payload → text glue (#1382): tolerant parsing of `{ fields, source }`
 * and the comma-joined, labelled list the timeline shows.
 */

import { describe, expect, test } from "bun:test";
import {
  ASSET_PLAIN_FIELDS,
  formatChangedFields,
  parseUpdatedPayload,
} from "./asset-history-updated";

const LABELS: Record<string, string> = {
  name: "Name",
  notes: "Notes",
  assetTag: "Asset tag",
};
const labelFor = (field: string) => LABELS[field] ?? `label:${field}`;

describe("parseUpdatedPayload", () => {
  test("reads the changed field names", () => {
    expect(parseUpdatedPayload({ fields: ["name", "notes"] })).toEqual({
      fields: ["name", "notes"],
      viaImport: false,
    });
  });

  test("flags a re-import row and keeps its fields", () => {
    expect(
      parseUpdatedPayload({
        fields: ["serial"],
        source: "import",
        sessionId: "s1",
        rowIndex: 3,
      }),
    ).toEqual({ fields: ["serial"], viaImport: true });
  });

  test("a provenance-only re-import marker has no fields", () => {
    expect(
      parseUpdatedPayload({ source: "import", sessionId: "s1", rowIndex: 0 }),
    ).toEqual({ fields: [], viaImport: true });
  });

  test("a legacy row without fields (or no payload) stays neutral", () => {
    expect(parseUpdatedPayload({})).toEqual({ fields: [], viaImport: false });
    expect(parseUpdatedPayload(null)).toEqual({ fields: [], viaImport: false });
    expect(parseUpdatedPayload(undefined)).toEqual({
      fields: [],
      viaImport: false,
    });
  });

  test("tolerates malformed payloads", () => {
    expect(parseUpdatedPayload({ fields: "name" }).fields).toEqual([]);
    expect(parseUpdatedPayload([1, 2]).fields).toEqual([]);
    expect(parseUpdatedPayload("oops").fields).toEqual([]);
    expect(
      parseUpdatedPayload({ fields: ["name", 42, null, "", "  ", "name", " notes "] })
        .fields,
    ).toEqual(["name", "notes"]);
    expect(parseUpdatedPayload({ source: "IMPORT" }).viaImport).toBe(false);
  });
});

describe("formatChangedFields", () => {
  test("joins the translated labels with commas", () => {
    expect(formatChangedFields(["name", "notes"], labelFor)).toBe("Name, Notes");
  });

  test("an unknown field falls back to its raw name", () => {
    expect(formatChangedFields(["assetTag", "futureField"], labelFor)).toBe(
      "Asset tag, futureField",
    );
  });

  test("nothing to list returns null", () => {
    expect(formatChangedFields([], labelFor)).toBeNull();
  });

  test("labels every plain field the API can write", () => {
    const text = formatChangedFields([...ASSET_PLAIN_FIELDS], labelFor);
    for (const field of ASSET_PLAIN_FIELDS) {
      expect(text).toContain(labelFor(field));
    }
  });
});
