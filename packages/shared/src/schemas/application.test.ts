import { describe, expect, test } from "bun:test";
import {
  ApplicationSchema,
  CreateApplicationSchema,
  isSafeApplicationUrl,
  UpdateApplicationSchema,
} from "./application";

// SEC-008 — Application.url must not accept an executable scheme (javascript:/data:/…) that would
// become a stored XSS sink when rendered as a link href, while still allowing scheme-less internal
// hosts and http(s) urls.
describe("isSafeApplicationUrl (SEC-008)", () => {
  test("allows http(s) urls and scheme-less internal hosts (incl. host:port)", () => {
    const ok = [
      "https://jira.corp",
      "http://10.0.0.5",
      "HTTPS://Jira.Corp",
      "vpn.corp.local",
      "vpn.corp.local/admin",
      "vpn.corp.local:8080",
      "10.0.0.5:3000/console",
    ];
    for (const url of ok) expect(isSafeApplicationUrl(url)).toBe(true);
  });

  test("rejects javascript:/data:/vbscript:/file: including obfuscations", () => {
    const bad = [
      "javascript:alert(document.cookie)",
      "JavaScript:alert(1)",
      "java\tscript:alert(1)", // TAB inside the scheme
      "java\nscript:alert(1)", // LF inside the scheme
      "  javascript:alert(1)", // leading whitespace
      String.fromCharCode(1) + "javascript:alert(1)", // leading control byte
      "data:text/html;base64,PHN2Zz4=",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ];
    for (const url of bad) expect(isSafeApplicationUrl(url)).toBe(false);
  });
});

// SEC-051 — the host:port carve-out must not let a browser-interpreted scheme through. A value shaped
// `<scheme>:<digits>/<rest>` reads as `host:port/path` to a regex, but a browser reads it as that
// scheme: `javascript:1/alert(1)` evaluates `1 / alert(1)` and so CALLS alert.
describe("isSafeApplicationUrl — host:port carve-out bypass (SEC-051)", () => {
  test("rejects a dangerous scheme shaped like host:port/path", () => {
    const bad = [
      "javascript:1/alert(document.cookie)",
      "javascript:0//x",
      "javascript:1",
      "javascript:65535/alert(1)",
      "vbscript:1/msgbox(1)",
      "data:1/text/html,<script>alert(1)</script>",
      "file:1/etc/passwd",
      "blob:1/x",
      "view-source:1/x",
    ];
    for (const url of bad) expect(isSafeApplicationUrl(url)).toBe(false);
  });

  test("rejects the same shape under case, whitespace and control-char obfuscation", () => {
    const bad = [
      "JaVaScRiPt:1/alert(1)",
      "JAVASCRIPT:1/alert(1)",
      "java\tscript:1/alert(1)",
      "java\nscript:1/alert(1)",
      "java\rscript:1/alert(1)",
      "  javascript:1/alert(1)",
      "\n\tjavascript:1/alert(1)",
      String.fromCharCode(1) + "javascript:1/alert(1)",
      String.fromCharCode(0) + "vbscript:1/msgbox(1)",
    ];
    for (const url of bad) expect(isSafeApplicationUrl(url)).toBe(false);
  });

  test("rejects percent- and character-reference-encoded dangerous schemes", () => {
    const bad = [
      "javascript%3Aalert(1)",
      "javascript%3a1/alert(1)",
      "%6Aavascript:alert(1)",
      "java%09script:alert(1)", // encoded TAB inside the scheme
      "&#106;avascript:alert(1)",
      "&#x6A;avascript:1/alert(1)",
      "&#0000106avascript:alert(1)", // no terminating semicolon, zero-padded
      "javascript&#58;1/alert(1)",
      "javascript&#x3a;alert(1)",
      "javascript&colon;alert(1)",
      "java&Tab;script:alert(1)",
      "vbscript&#58;msgbox(1)",
    ];
    for (const url of bad) expect(isSafeApplicationUrl(url)).toBe(false);
  });

  test("still allows scheme-less host:port (single-label and dotted) and encoded http(s) urls", () => {
    const ok = [
      "jenkins:8080",
      "jenkins:8080/job/build",
      "localhost:3000",
      "vpn.corp.local:443/",
      "10.0.0.5:3000/console",
      "javascript.corp.local:8080", // a host that merely starts with a scheme name
      "vpn.corp.local/path%20with%20spaces",
      "wiki.corp/page?a=1&b=2",
      "https://jira.corp/search?q=a%3Ab",
      "https://jira.corp/#&#58;",
    ];
    for (const url of ok) expect(isSafeApplicationUrl(url)).toBe(true);
  });
});

describe("Application url schemas — SEC-051 on write, tolerant on read", () => {
  test("CreateApplicationSchema rejects the carve-out bypass", () => {
    expect(
      CreateApplicationSchema.safeParse({
        name: "Evil",
        url: "javascript:1/alert(document.cookie)",
      }).success,
    ).toBe(false);
  });

  test("UpdateApplicationSchema rejects the carve-out bypass", () => {
    expect(
      UpdateApplicationSchema.safeParse({ url: "vbscript:1/msgbox(1)" })
        .success,
    ).toBe(false);
  });

  test("ApplicationSchema (read) still loads a legacy row holding a now-rejected url", () => {
    const legacy = {
      id: "cjld2cjxh0000qzrmn831i7rn",
      name: "Legacy",
      description: null,
      url: "javascript:1/alert(document.cookie)",
      vendor: null,
      categoryId: null,
      isCritical: false,
      metadata: null,
      notes: null,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
      deletedAt: null,
    };
    expect(ApplicationSchema.safeParse(legacy).success).toBe(true);
  });
});

describe("CreateApplicationSchema.url scheme guard (SEC-008)", () => {
  test("rejects a javascript: url on create", () => {
    expect(
      CreateApplicationSchema.safeParse({
        name: "Evil",
        url: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });

  test("accepts a scheme-less host and an https url", () => {
    expect(
      CreateApplicationSchema.safeParse({ name: "VPN", url: "vpn.corp.local" })
        .success,
    ).toBe(true);
    expect(
      CreateApplicationSchema.safeParse({
        name: "Jira",
        url: "https://jira.corp",
      }).success,
    ).toBe(true);
  });
});

// License / seat tracking (#949). The read fields must be `.nullish()` so web object-construction
// sites (Quick View mappers, fixtures, list joins) that omit them keep type-checking, and `seatsUsed`
// is a DERIVED read-only value that create/update must reject (strictObject).
describe("Application seat/license tracking (#949)", () => {
  const baseRead = {
    id: "cjld2cjxh0000qzrmn831i7rn",
    name: "Jira",
    description: null,
    url: null,
    vendor: null,
    categoryId: null,
    isCritical: false,
    metadata: null,
    notes: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    deletedAt: null,
  };

  test("ApplicationSchema: the seat fields are OPTIONAL (omitting all keeps parsing green)", () => {
    expect(ApplicationSchema.safeParse(baseRead).success).toBe(true);
  });

  test("ApplicationSchema: the seat fields accept null (untracked)", () => {
    expect(
      ApplicationSchema.safeParse({
        ...baseRead,
        seatsPurchased: null,
        costPerSeat: null,
        renewalDate: null,
        seatsUsed: null,
      }).success,
    ).toBe(true);
  });

  test("ApplicationSchema: accepts populated seat fields (minor-unit cost, ISO renewal)", () => {
    const parsed = ApplicationSchema.safeParse({
      ...baseRead,
      seatsPurchased: 50,
      costPerSeat: 1299, // $12.99 in minor units
      renewalDate: "2027-01-01T00:00:00.000Z",
      seatsUsed: 12,
    });
    expect(parsed.success).toBe(true);
  });

  test("CreateApplicationSchema: accepts the writable seat fields", () => {
    expect(
      CreateApplicationSchema.safeParse({
        name: "GitHub",
        seatsPurchased: 25,
        costPerSeat: 2100,
        renewalDate: "2027-03-15T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  test("CreateApplicationSchema: REJECTS the derived seatsUsed (read-only)", () => {
    expect(
      CreateApplicationSchema.safeParse({
        name: "GitHub",
        seatsUsed: 5,
      }).success,
    ).toBe(false);
  });

  test("CreateApplicationSchema: rejects a negative cost / seat count", () => {
    expect(
      CreateApplicationSchema.safeParse({ name: "X", seatsPurchased: -1 })
        .success,
    ).toBe(false);
    expect(
      CreateApplicationSchema.safeParse({ name: "X", costPerSeat: -100 })
        .success,
    ).toBe(false);
  });

  test("UpdateApplicationSchema: allows clearing the seat fields to null", () => {
    expect(
      UpdateApplicationSchema.safeParse({
        seatsPurchased: null,
        costPerSeat: null,
        renewalDate: null,
      }).success,
    ).toBe(true);
  });

  test("UpdateApplicationSchema: REJECTS the derived seatsUsed (read-only)", () => {
    expect(UpdateApplicationSchema.safeParse({ seatsUsed: 5 }).success).toBe(
      false,
    );
  });
});
