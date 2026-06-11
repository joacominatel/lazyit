import { expect, test } from "bun:test";
import {
  type RestConnectionConfig,
  WorkflowConnectionConfigSchema,
} from "@lazyit/shared";
import {
  buildConnectionConfig,
  type ConnectionConfigInput,
} from "./connection-config";

const restForm: ConnectionConfigInput = {
  kind: "REST",
  url: "https://api.example.com",
  authScheme: "NONE",
  authHeaderName: "",
  signatureHeader: "",
  healthCheckPath: "",
  healthCheckMethod: undefined,
};

test("create (no existing config) yields exactly the form's REST fields", () => {
  const config = buildConnectionConfig(restForm);
  expect(config).toEqual({
    kind: "REST",
    baseUrl: "https://api.example.com",
    authScheme: "NONE",
  });
});

test("edit preserves defaultHeaders the form does not expose (issue #351)", () => {
  const existing: RestConnectionConfig = {
    kind: "REST",
    baseUrl: "https://api.example.com",
    authScheme: "NONE",
    defaultHeaders: { Accept: "application/json" },
  };

  const config = buildConnectionConfig(
    { ...restForm, url: "https://api.example.com/v2" },
    existing,
  );

  // The edited baseUrl is applied AND the untouched defaultHeaders survive the round-trip.
  expect(config).toMatchObject({
    kind: "REST",
    baseUrl: "https://api.example.com/v2",
    defaultHeaders: { Accept: "application/json" },
  });
  // The merged result is still a valid wire config.
  expect(WorkflowConnectionConfigSchema.safeParse(config).success).toBe(true);
});

test("edit carries defaultHeaders alongside other edited fields", () => {
  const existing: RestConnectionConfig = {
    kind: "REST",
    baseUrl: "https://api.example.com",
    authScheme: "NONE",
    defaultHeaders: { Accept: "application/json", "X-Tenant": "acme" },
  };

  const config = buildConnectionConfig(
    {
      ...restForm,
      authScheme: "HEADER",
      authHeaderName: "X-Api-Key",
      healthCheckPath: "/health",
      healthCheckMethod: "HEAD",
    },
    existing,
  ) as RestConnectionConfig;

  expect(config.authScheme).toBe("HEADER");
  expect(config.authHeaderName).toBe("X-Api-Key");
  expect(config.healthCheckPath).toBe("/health");
  expect(config.healthCheckMethod).toBe("HEAD");
  expect(config.defaultHeaders).toEqual({
    Accept: "application/json",
    "X-Tenant": "acme",
  });
});

test("edit without defaultHeaders does not introduce the key", () => {
  const existing: RestConnectionConfig = {
    kind: "REST",
    baseUrl: "https://api.example.com",
    authScheme: "NONE",
  };
  const config = buildConnectionConfig(restForm, existing) as RestConnectionConfig;
  expect("defaultHeaders" in config).toBe(false);
});

test("WEBHOOK_OUT build trims url and carries the signature header", () => {
  const config = buildConnectionConfig({
    kind: "WEBHOOK_OUT",
    url: "  https://hooks.example.com  ",
    authScheme: "NONE",
    authHeaderName: "",
    signatureHeader: "X-Signature",
    healthCheckPath: "",
    healthCheckMethod: undefined,
  });
  expect(config).toEqual({
    kind: "WEBHOOK_OUT",
    url: "https://hooks.example.com",
    signatureHeader: "X-Signature",
  });
});

test("MANUAL build is the bare discriminant", () => {
  const config = buildConnectionConfig({
    ...restForm,
    kind: "MANUAL",
  });
  expect(config).toEqual({ kind: "MANUAL" });
});
