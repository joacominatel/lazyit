import { describe, expect, test } from "bun:test";
import { SLUG_MAX_LENGTH, SLUG_REGEX, slugify } from "./slug";

describe("slugify", () => {
  test("lowercases and hyphenates words", () => {
    expect(slugify("Network Setup Guide")).toBe("network-setup-guide");
  });

  test("strips diacritics", () => {
    expect(slugify("Configuración de Servidores")).toBe(
      "configuracion-de-servidores",
    );
  });

  test("collapses non-alphanumeric runs into single hyphens", () => {
    expect(slugify("VPN  /  Wireguard — notes!!")).toBe("vpn-wireguard-notes");
  });

  test("trims leading and trailing separators", () => {
    expect(slugify("  --Hello--  ")).toBe("hello");
  });

  test("caps at SLUG_MAX_LENGTH without a trailing hyphen", () => {
    const slug = slugify("a".repeat(40) + " " + "b".repeat(40));
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
    expect(SLUG_REGEX.test(slug)).toBe(true);
  });

  test("returns empty string when there is nothing alphanumeric", () => {
    expect(slugify("—  !!  ")).toBe("");
  });

  test("output always matches SLUG_REGEX when non-empty", () => {
    for (const input of ["Hello World", "a.b.c", "multi---hyphen", "Tëst 17"]) {
      expect(SLUG_REGEX.test(slugify(input))).toBe(true);
    }
  });
});

describe("SLUG_REGEX", () => {
  test("accepts valid slugs", () => {
    for (const s of ["a", "network-setup", "abc123", "a-1-b-2"]) {
      expect(SLUG_REGEX.test(s)).toBe(true);
    }
  });

  test("rejects invalid slugs", () => {
    for (const s of ["", "-x", "x-", "a--b", "Hello", "a b", "a_b"]) {
      expect(SLUG_REGEX.test(s)).toBe(false);
    }
  });
});
