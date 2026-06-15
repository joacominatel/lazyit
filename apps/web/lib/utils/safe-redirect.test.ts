import { describe, expect, test } from "bun:test";
import { DEFAULT_REDIRECT, safeInternalPath } from "./safe-redirect";

/**
 * Open-redirect guard (#495). The fix is security-sensitive, so the malicious-input matrix is
 * asserted directly: anything that a browser would resolve to a foreign origin — or any non-path
 * value — must collapse to the same-origin default.
 */
describe("safeInternalPath", () => {
  test("passes through safe same-origin relative paths", () => {
    expect(safeInternalPath("/dashboard")).toBe("/dashboard");
    expect(safeInternalPath("/tickets?status=open")).toBe("/tickets?status=open");
    expect(safeInternalPath("/articles/abc#section")).toBe("/articles/abc#section");
    expect(safeInternalPath("/")).toBe("/");
  });

  test("rejects absolute and protocol-relative URLs", () => {
    for (const raw of [
      "https://evil.example",
      "http://evil.example/path",
      "//evil.example",
      "//evil.example/dashboard",
    ]) {
      expect(safeInternalPath(raw)).toBe(DEFAULT_REDIRECT);
    }
  });

  test("rejects backslash tricks browsers normalise to a foreign origin", () => {
    expect(safeInternalPath("/\\evil.example")).toBe(DEFAULT_REDIRECT);
    expect(safeInternalPath("\\/evil.example")).toBe(DEFAULT_REDIRECT);
    expect(safeInternalPath("/\\")).toBe(DEFAULT_REDIRECT);
  });

  test("rejects any scheme form", () => {
    for (const raw of [
      "javascript:alert(1)",
      "mailto:x@example.com",
      "http:evil",
      "data:text/html,<script>",
    ]) {
      expect(safeInternalPath(raw)).toBe(DEFAULT_REDIRECT);
    }
  });

  test("rejects control characters (CR/LF response splitting)", () => {
    const crlf = "/dashboard" + String.fromCharCode(13, 10) + "Set-Cookie: x=1";
    expect(safeInternalPath(crlf)).toBe(DEFAULT_REDIRECT);
    expect(safeInternalPath("/dashboard" + String.fromCharCode(9))).toBe(
      DEFAULT_REDIRECT,
    );
  });

  test("rejects non-leading-slash and non-string values", () => {
    expect(safeInternalPath("dashboard")).toBe(DEFAULT_REDIRECT);
    expect(safeInternalPath("")).toBe(DEFAULT_REDIRECT);
    expect(safeInternalPath(undefined)).toBe(DEFAULT_REDIRECT);
    expect(safeInternalPath(null)).toBe(DEFAULT_REDIRECT);
    expect(safeInternalPath(42)).toBe(DEFAULT_REDIRECT);
  });
});
