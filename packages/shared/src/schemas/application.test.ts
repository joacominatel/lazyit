import { describe, expect, test } from "bun:test";
import { CreateApplicationSchema, isSafeApplicationUrl } from "./application";

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

  // SEC-051 — the host:port carve-out used to accept `<scheme>:<digits>/<anything>`, so a
  // `javascript:1/alert(1)` (the JS expression `1 / alert(1)`, whose division CALLS alert) slipped
  // past the SEC-008 scheme guard. The port carve-out is now a BARE port only.
  test("rejects the host:port carve-out bypass: scheme + digits + /payload (SEC-051)", () => {
    const bad = [
      "javascript:1/alert(document.cookie)",
      "javascript:1/alert(1)",
      "javascript:0//x",
      "vbscript:1/msgbox(1)",
      "data:1/text",
      "JavaScript:1/alert(1)", // case + tail
      "java\tscript:1/alert(1)", // obfuscated scheme + tail
    ];
    for (const url of bad) expect(isSafeApplicationUrl(url)).toBe(false);
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
