import { describe, expect, test } from "bun:test";
import {
  isThemePreference,
  localePreferencePatch,
  readLocaleCookie,
  resolveAdoption,
  themePreferencePatch,
} from "./preference-sync";

describe("readLocaleCookie", () => {
  test("reads NEXT_LOCALE among other cookies", () => {
    expect(readLocaleCookie("a=1; NEXT_LOCALE=es; b=2")).toBe("es");
    expect(readLocaleCookie("NEXT_LOCALE=en")).toBe("en");
  });

  test("no cookie, an empty string or a look-alike name is no preference", () => {
    expect(readLocaleCookie("")).toBeNull();
    expect(readLocaleCookie("a=1; b=2")).toBeNull();
    expect(readLocaleCookie("MY_NEXT_LOCALE=es")).toBeNull();
  });

  test("an unsupported value counts as no preference", () => {
    expect(readLocaleCookie("NEXT_LOCALE=fr")).toBeNull();
    expect(readLocaleCookie("NEXT_LOCALE=%E0%A4%A")).toBeNull();
  });
});

describe("resolveAdoption", () => {
  const none = { locale: null, theme: null };

  test("a browser with no value of its own adopts the stored ones", () => {
    expect(
      resolveAdoption({
        browser: none,
        stored: { locale: "es", theme: "dark" },
        activeLocale: "en",
      }),
    ).toEqual({ locale: "es", theme: "dark" });
  });

  test("the browser's own value always wins", () => {
    expect(
      resolveAdoption({
        browser: { locale: "en", theme: "light" },
        stored: { locale: "es", theme: "dark" },
        activeLocale: "en",
      }),
    ).toEqual({});
  });

  test("each key is decided on its own", () => {
    expect(
      resolveAdoption({
        browser: { locale: "en", theme: null },
        stored: { locale: "es", theme: "system" },
        activeLocale: "en",
      }),
    ).toEqual({ theme: "system" });
    expect(
      resolveAdoption({
        browser: { locale: null, theme: "dark" },
        stored: { locale: "es", theme: "light" },
        activeLocale: "en",
      }),
    ).toEqual({ locale: "es" });
  });

  test("nothing stored, or unknown stored values, adopts nothing", () => {
    expect(
      resolveAdoption({ browser: none, stored: { locale: null, theme: null }, activeLocale: "en" }),
    ).toEqual({});
    expect(resolveAdoption({ browser: none, stored: undefined, activeLocale: "en" })).toEqual({});
    expect(
      resolveAdoption({
        browser: none,
        stored: { locale: "fr", theme: "sepia" } as never,
        activeLocale: "en",
      }),
    ).toEqual({});
  });

  test("a stored locale that is already on screen is not re-applied", () => {
    expect(
      resolveAdoption({ browser: none, stored: { locale: "en", theme: null }, activeLocale: "en" }),
    ).toEqual({});
  });
});

describe("preference payloads", () => {
  test("a supported value becomes a one-key body", () => {
    expect(localePreferencePatch("es")).toEqual({ locale: "es" });
    expect(themePreferencePatch("system")).toEqual({ theme: "system" });
  });

  test("an unsupported value builds nothing", () => {
    expect(localePreferencePatch("fr")).toBeNull();
    expect(themePreferencePatch("sepia")).toBeNull();
    expect(themePreferencePatch(undefined)).toBeNull();
  });

  test("isThemePreference", () => {
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference(null)).toBe(false);
  });
});
