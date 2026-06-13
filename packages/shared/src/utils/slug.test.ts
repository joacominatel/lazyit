import { describe, expect, test } from "bun:test";
import {
  SLUG_MAX_LENGTH,
  SLUG_REGEX,
  nextAvailableSlug,
  slugify,
} from "./slug";

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

describe("nextAvailableSlug", () => {
  /** Build an `isTaken` predicate over a set of already-used slugs. */
  const takenIn = (used: string[]) => (s: string) => used.includes(s);

  test("returns the base unchanged when it is free", () => {
    expect(nextAvailableSlug("network-setup", takenIn([]))).toBe("network-setup");
  });

  test("suffixes -2 on the first collision", () => {
    expect(nextAvailableSlug("network-setup", takenIn(["network-setup"]))).toBe(
      "network-setup-2",
    );
  });

  test("walks up to the first free suffix", () => {
    expect(
      nextAvailableSlug(
        "vpn",
        takenIn(["vpn", "vpn-2", "vpn-3"]),
      ),
    ).toBe("vpn-4");
  });

  test("skips a gap and takes the lowest free suffix", () => {
    // -2 taken, -3 free → -3 wins (lowest available, never reuses an arbitrary high number).
    expect(nextAvailableSlug("vpn", takenIn(["vpn", "vpn-2"]))).toBe("vpn-3");
  });

  test("the result is always a valid slug shape", () => {
    const used = ["a", "a-2", "a-3", "a-4"];
    const slug = nextAvailableSlug("a", takenIn(used));
    expect(slug).toBe("a-5");
    expect(SLUG_REGEX.test(slug)).toBe(true);
  });

  test("truncates a max-length base to fit the suffix and stays within the cap", () => {
    const base = "a".repeat(SLUG_MAX_LENGTH); // already at the cap
    const slug = nextAvailableSlug(base, takenIn([base]));
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith("-2")).toBe(true);
    expect(SLUG_REGEX.test(slug)).toBe(true);
  });

  test("re-trims a trailing hyphen exposed by truncation", () => {
    // A cap-length base with a hyphen at the LAST kept index when slicing for a `-2` suffix
    // (room = cap - 2, so index room - 1 = cap - 3). After the cut that hyphen is trailing and must
    // be re-trimmed so the candidate stays a valid slug (no `--`, no trailing `-`).
    const base = "a".repeat(SLUG_MAX_LENGTH - 3) + "-bc";
    expect(base.length).toBe(SLUG_MAX_LENGTH);
    expect(base[SLUG_MAX_LENGTH - 3]).toBe("-"); // the last index kept by the slice
    const slug = nextAvailableSlug(base, (c) => c === base);
    expect(slug).toBe("a".repeat(SLUG_MAX_LENGTH - 3) + "-2");
    expect(SLUG_REGEX.test(slug)).toBe(true);
    expect(slug.includes("--")).toBe(false);
  });

  test("supports a within-batch Set the caller mutates between calls", () => {
    const used = new Set<string>();
    const mint = (base: string) => {
      const s = nextAvailableSlug(base, (c) => used.has(c));
      used.add(s);
      return s;
    };
    expect(mint("readme")).toBe("readme");
    expect(mint("readme")).toBe("readme-2");
    expect(mint("readme")).toBe("readme-3");
  });
});
