import { describe, expect, test } from "bun:test";

import { loginClientHeaders } from "./login-client-headers";

describe("loginClientHeaders (#1420)", () => {
  test("no request, or neither header → nothing is sent", () => {
    expect(loginClientHeaders(undefined)).toEqual({});
    expect(loginClientHeaders(null)).toEqual({});
    expect(loginClientHeaders(new Headers({ accept: "*/*" }))).toEqual({});
  });

  test("X-Forwarded-For is passed through verbatim — no hop appended, no entry picked", () => {
    const xff = "198.51.100.9, 203.0.113.7";
    const out = loginClientHeaders(new Headers({ "x-forwarded-for": xff }));
    expect(out).toEqual({ "X-Forwarded-For": xff });
  });

  test("X-Forwarded-For absent → not synthesized, even when X-Real-IP is present", () => {
    const out = loginClientHeaders(
      new Headers({ "x-real-ip": "198.51.100.9", "user-agent": "UA/1" }),
    );
    expect(out).toEqual({ "User-Agent": "UA/1" });
    expect("X-Forwarded-For" in out).toBe(false);
  });

  test("an empty header counts as absent", () => {
    expect(
      loginClientHeaders(new Headers({ "x-forwarded-for": "", "user-agent": "" })),
    ).toEqual({});
  });

  test("the browser's User-Agent is passed through verbatim", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
    expect(loginClientHeaders(new Headers({ "user-agent": ua }))).toEqual({
      "User-Agent": ua,
    });
  });
});
