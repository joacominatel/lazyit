import { expect, test } from "bun:test";
import { buildRetryOverrides, type RetryOverrideRow } from "./retry-overrides";

/**
 * ADR-0057 Option 2 — the retry-override dialog builds a request-scoped `overrides` record from its
 * editable rows. These cover the PURE shaping (trim keys, drop blanks, last-write-wins, the bounds the
 * shared schema enforces) and the "no usable rows ⇒ plain bodyless retry" default. INV-6 is upheld
 * structurally elsewhere (the record is never persisted); here we only assert the wire shape.
 */

const row = (over: Partial<RetryOverrideRow> = {}): RetryOverrideRow => ({
  id: "r1",
  field: "",
  value: "",
  ...over,
});

test("builds a record from filled rows", () => {
  const result = buildRetryOverrides([
    row({ id: "a", field: "lastName", value: "{{ grantee.lastName }}" }),
  ]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.overrides).toEqual({ lastName: "{{ grantee.lastName }}" });
  }
});

test("trims the field name but keeps the value verbatim (templates can carry whitespace)", () => {
  const result = buildRetryOverrides([
    row({ field: "  lastName  ", value: " {{ grantee.lastName }} " }),
  ]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.overrides).toEqual({ lastName: " {{ grantee.lastName }} " });
  }
});

test("drops a row whose field name is blank (an operator-left-empty row)", () => {
  const result = buildRetryOverrides([
    row({ id: "a", field: "   ", value: "ignored" }),
    row({ id: "b", field: "department", value: "IT" }),
  ]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.overrides).toEqual({ department: "IT" });
  }
});

test("a later row with the same trimmed field name wins (single override per field)", () => {
  const result = buildRetryOverrides([
    row({ id: "a", field: "role", value: "first" }),
    row({ id: "b", field: " role ", value: "second" }),
  ]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.overrides).toEqual({ role: "second" });
  }
});

test("an empty value is still a valid override (clears the field's render)", () => {
  const result = buildRetryOverrides([row({ field: "nickname", value: "" })]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.overrides).toEqual({ nickname: "" });
  }
});

test("no usable rows ⇒ undefined (a plain, bodyless retry — the one-click default)", () => {
  expect(buildRetryOverrides([]).ok).toBe(true);
  expect(buildRetryOverrides([]).ok && buildRetryOverrides([]).ok).toBe(true);

  const onlyBlank = buildRetryOverrides([row({ field: "  ", value: "x" })]);
  expect(onlyBlank.ok).toBe(true);
  if (onlyBlank.ok) {
    expect(onlyBlank.overrides).toBeUndefined();
  }
});

test("rejects an over-long field name (the API would 400) before sending", () => {
  const result = buildRetryOverrides([
    row({ field: "f".repeat(201), value: "x" }),
  ]);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("invalid");
  }
});

test("rejects an over-long value before sending", () => {
  const result = buildRetryOverrides([
    row({ field: "bio", value: "x".repeat(2001) }),
  ]);
  expect(result.ok).toBe(false);
});
