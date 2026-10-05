import { describe, expect, it } from "bun:test";
import { shortcutHref } from "./shortcut-href";

describe("shortcutHref (SEC-086)", () => {
  it("links web, SSH and console shortcuts", () => {
    for (const url of ["https://nas.local:5001", "ssh://root@pve1", "rdp://dc01", "vnc://h:5900"]) {
      expect(shortcutHref(url)).toBe(url);
    }
  });

  it("refuses a link for a legacy executable-scheme URL", () => {
    for (const url of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "javascript&#58;alert(1)",
    ]) {
      expect(shortcutHref(url)).toBeNull();
    }
  });
});
