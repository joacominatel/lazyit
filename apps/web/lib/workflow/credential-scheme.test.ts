import { expect, test } from "bun:test";
import type { WorkflowConnectionConfig } from "@lazyit/shared";
import { BINDABLE_AUTH_SCHEMES, deriveSchemePatch } from "./credential-scheme";

/**
 * #342 — the guided add-credential flow captures the AUTH TYPE together with the value. `NONE` is never
 * a bindable scheme (a credential with no scheme is an orphan the engine ignores), and the derived
 * config patch sets the chosen scheme on the connection as part of binding — preserving the other
 * config fields and refusing a HEADER scheme with no header name.
 */

const rest = (
  over: Partial<Extract<WorkflowConnectionConfig, { kind: "REST" }>> = {},
): WorkflowConnectionConfig => ({
  kind: "REST",
  baseUrl: "https://api.example.com",
  authScheme: "NONE",
  ...over,
});

test("NONE is excluded from the bindable schemes", () => {
  expect(BINDABLE_AUTH_SCHEMES).toEqual(["BEARER", "BASIC", "HEADER"]);
  expect(BINDABLE_AUTH_SCHEMES as readonly string[]).not.toContain("NONE");
});

test("a NONE connection gets a patch that sets the chosen scheme (no orphan)", () => {
  const result = deriveSchemePatch({
    config: rest({ authScheme: "NONE" }),
    scheme: "BEARER",
    headerName: "",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.patch).toMatchObject({ kind: "REST", authScheme: "BEARER" });
  }
});

test("the patch preserves unrelated config fields (baseUrl, healthCheckPath)", () => {
  const result = deriveSchemePatch({
    config: rest({
      authScheme: "NONE",
      baseUrl: "https://jira.example.com",
      healthCheckPath: "/health",
    }),
    scheme: "BEARER",
    headerName: "",
  });
  expect(result.ok).toBe(true);
  if (result.ok && result.patch?.kind === "REST") {
    expect(result.patch.baseUrl).toBe("https://jira.example.com");
    expect(result.patch.healthCheckPath).toBe("/health");
    expect(result.patch.authScheme).toBe("BEARER");
  }
});

test("HEADER carries the trimmed header name", () => {
  const result = deriveSchemePatch({
    config: rest({ authScheme: "NONE" }),
    scheme: "HEADER",
    headerName: "  X-Api-Key  ",
  });
  expect(result.ok).toBe(true);
  if (result.ok && result.patch?.kind === "REST") {
    expect(result.patch.authScheme).toBe("HEADER");
    expect(result.patch.authHeaderName).toBe("X-Api-Key");
  }
});

test("HEADER without a header name is rejected (the API would 400)", () => {
  const result = deriveSchemePatch({
    config: rest({ authScheme: "NONE" }),
    scheme: "HEADER",
    headerName: "   ",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("header-name-required");
  }
});

test("a non-HEADER scheme clears a stale header name", () => {
  const result = deriveSchemePatch({
    config: rest({ authScheme: "HEADER", authHeaderName: "X-Api-Key" }),
    scheme: "BEARER",
    headerName: "X-Api-Key",
  });
  expect(result.ok).toBe(true);
  if (result.ok && result.patch?.kind === "REST") {
    expect(result.patch.authScheme).toBe("BEARER");
    expect(result.patch.authHeaderName).toBeUndefined();
  }
});

test("no change is needed when the scheme already matches (no patch)", () => {
  const result = deriveSchemePatch({
    config: rest({ authScheme: "BEARER" }),
    scheme: "BEARER",
    headerName: "",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.patch).toBeUndefined();
  }
});

test("an unchanged HEADER (same name) needs no patch", () => {
  const result = deriveSchemePatch({
    config: rest({ authScheme: "HEADER", authHeaderName: "X-Api-Key" }),
    scheme: "HEADER",
    headerName: "X-Api-Key",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.patch).toBeUndefined();
  }
});

test("a non-REST connection never produces a patch", () => {
  const result = deriveSchemePatch({
    config: { kind: "MANUAL" },
    scheme: "BEARER",
    headerName: "",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.patch).toBeUndefined();
  }
});
