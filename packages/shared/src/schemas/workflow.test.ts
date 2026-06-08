import { describe, expect, test } from "bun:test";
import {
  CompleteManualTaskSchema,
  CreateApplicationWorkflowSchema,
  CreateWorkflowConnectionSchema,
  CreateWorkflowSecretSchema,
  DEFAULT_DEPROVISION_POLICY,
  ManualStepSchema,
  RestStepSchema,
  UpdateApplicationWorkflowSchema,
  WorkflowConnectionConfigSchema,
  WORKFLOW_CONNECTION_KINDS,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_TRIGGERS,
  WORKFLOW_TRIGGERS_V1,
  WorkflowSecretSchema,
  WorkflowStepsSchema,
  WorkflowTriggerSchema,
  publicHttpsUrl,
} from "./workflow";

const CUID = "clh1abc0000xyz0000000abcd";
const CUID2 = "clh1abc0000xyz0000000abce";
const UUID = "11111111-1111-4111-8111-111111111111";

describe("enum catalogs", () => {
  test("triggers cover the v1 subset + reserved slots", () => {
    expect(WORKFLOW_TRIGGERS).toContain("ACCESS_GRANTED");
    expect(WORKFLOW_TRIGGERS).toContain("ACCESS_REVOKED");
    // Reserved (no behavior in Phase 1a) but present so a later phase needs no enum migration.
    expect(WORKFLOW_TRIGGERS).toContain("TIMER_AFTER_GRANT");
    expect(WORKFLOW_TRIGGERS).toContain("RECERTIFICATION");
    expect(WORKFLOW_TRIGGERS_V1).toEqual(["ACCESS_GRANTED", "ACCESS_REVOKED"]);
  });

  test("connection kinds reserve SDK/MCP/PREBUILT/CUSTOM", () => {
    for (const k of ["SDK", "MCP", "PREBUILT", "CUSTOM"]) {
      expect(WORKFLOW_CONNECTION_KINDS).toContain(k);
    }
  });

  test("run statuses include the COMPENSATED terminal + AWAITING_INPUT pause", () => {
    expect(WORKFLOW_RUN_STATUSES).toContain("AWAITING_INPUT");
    expect(WORKFLOW_RUN_STATUSES).toContain("COMPENSATED");
  });

  test("WorkflowTriggerSchema rejects an unknown trigger", () => {
    expect(WorkflowTriggerSchema.safeParse("ACCESS_GRANTED").success).toBe(true);
    expect(WorkflowTriggerSchema.safeParse("ACCESS_EXPIRED").success).toBe(false);
  });
});

describe("publicHttpsUrl — v1 egress is public https only", () => {
  test("accepts an https URL", () => {
    expect(publicHttpsUrl.safeParse("https://api.example.com/v1").success).toBe(
      true,
    );
  });
  test("rejects http, non-URL and non-https schemes", () => {
    expect(publicHttpsUrl.safeParse("http://api.example.com").success).toBe(false);
    expect(publicHttpsUrl.safeParse("ftp://example.com").success).toBe(false);
    expect(publicHttpsUrl.safeParse("not a url").success).toBe(false);
  });
});

describe("CreateApplicationWorkflowSchema", () => {
  test("applies safe defaults (disabled, LAST_ACTIVE_GRANT)", () => {
    const parsed = CreateApplicationWorkflowSchema.parse({
      applicationId: CUID,
      trigger: "ACCESS_GRANTED",
      name: "Provision Jira",
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.deprovisionPolicy).toBe(DEFAULT_DEPROVISION_POLICY);
  });

  test("rejects a reserved (non-v1) trigger at create", () => {
    expect(
      CreateApplicationWorkflowSchema.safeParse({
        applicationId: CUID,
        trigger: "RECERTIFICATION",
        name: "x",
      }).success,
    ).toBe(false);
  });

  test("strictObject rejects unknown keys (mass-assignment guard)", () => {
    expect(
      CreateApplicationWorkflowSchema.safeParse({
        applicationId: CUID,
        trigger: "ACCESS_GRANTED",
        name: "x",
        id: CUID,
      }).success,
    ).toBe(false);
  });
});

describe("UpdateApplicationWorkflowSchema", () => {
  test("allows a partial patch and clearing description", () => {
    expect(
      UpdateApplicationWorkflowSchema.safeParse({ description: null }).success,
    ).toBe(true);
    expect(UpdateApplicationWorkflowSchema.safeParse({ enabled: true }).success).toBe(
      true,
    );
  });
});

describe("WorkflowConnectionConfigSchema — discriminated on kind", () => {
  test("REST config requires an https baseUrl", () => {
    expect(
      WorkflowConnectionConfigSchema.safeParse({
        kind: "REST",
        baseUrl: "https://jira.example.com",
      }).success,
    ).toBe(true);
    expect(
      WorkflowConnectionConfigSchema.safeParse({
        kind: "REST",
        baseUrl: "http://jira.example.com",
      }).success,
    ).toBe(false);
  });

  test("MANUAL config takes no endpoint", () => {
    expect(
      WorkflowConnectionConfigSchema.safeParse({ kind: "MANUAL" }).success,
    ).toBe(true);
  });

  test("an unknown kind is rejected", () => {
    expect(
      WorkflowConnectionConfigSchema.safeParse({ kind: "SDK", baseUrl: "https://x.dev" })
        .success,
    ).toBe(false);
  });
});

describe("CreateWorkflowConnectionSchema — config.kind must match", () => {
  test("rejects a mismatched config kind", () => {
    expect(
      CreateWorkflowConnectionSchema.safeParse({
        applicationId: CUID,
        kind: "REST",
        name: "Jira",
        config: { kind: "MANUAL" },
      }).success,
    ).toBe(false);
  });
  test("accepts a matching REST connection", () => {
    expect(
      CreateWorkflowConnectionSchema.safeParse({
        applicationId: CUID,
        kind: "REST",
        name: "Jira",
        config: { kind: "REST", baseUrl: "https://jira.example.com", authScheme: "BEARER" },
      }).success,
    ).toBe(true);
  });
});

describe("WorkflowStepsSchema — discriminated steps + unique keys", () => {
  const restStep = {
    kind: "REST" as const,
    key: "create-user",
    connectionId: CUID,
    method: "POST" as const,
    path: "/rest/api/3/user",
  };

  test("accepts a valid REST + MANUAL sequence", () => {
    const parsed = WorkflowStepsSchema.safeParse([
      restStep,
      {
        kind: "MANUAL",
        key: "confirm-team",
        prompt: "Which team?",
        inputFields: [{ name: "team", label: "Team", type: "text" }],
      },
    ]);
    expect(parsed.success).toBe(true);
  });

  test("rejects duplicate step keys", () => {
    expect(
      WorkflowStepsSchema.safeParse([restStep, { ...restStep }]).success,
    ).toBe(false);
  });

  test("rejects an empty step list", () => {
    expect(WorkflowStepsSchema.safeParse([]).success).toBe(false);
  });

  test("REST step applies idempotent/onError defaults", () => {
    const parsed = RestStepSchema.parse(restStep);
    expect(parsed.idempotent).toBe(false);
    expect(parsed.onError).toBe("fail");
  });

  test("MANUAL step needs at least one input field", () => {
    expect(
      ManualStepSchema.safeParse({
        kind: "MANUAL",
        key: "k",
        prompt: "p",
        inputFields: [],
      }).success,
    ).toBe(false);
  });
});

describe("CompleteManualTaskSchema", () => {
  test("accepts an input record", () => {
    expect(
      CompleteManualTaskSchema.safeParse({ input: { team: "Platform" } }).success,
    ).toBe(true);
  });
  test("rejects unknown top-level keys", () => {
    expect(
      CompleteManualTaskSchema.safeParse({ input: {}, hacked: true }).success,
    ).toBe(false);
  });
});

describe("WorkflowSecret contracts — never carry crypto material", () => {
  test("the read shape exposes only a redacted descriptor", () => {
    const ok = WorkflowSecretSchema.safeParse({
      id: CUID,
      applicationId: CUID2,
      connectionId: null,
      label: "Jira API token",
      keyVersion: 1,
      configured: true,
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
      deletedAt: null,
    });
    expect(ok.success).toBe(true);
    // No ciphertext/iv/authTag/value field exists on the wire shape.
    expect("ciphertext" in WorkflowSecretSchema.shape).toBe(false);
    expect("value" in WorkflowSecretSchema.shape).toBe(false);
  });

  test("create accepts a cleartext value (encrypted server-side, never returned)", () => {
    expect(
      CreateWorkflowSecretSchema.safeParse({
        applicationId: CUID,
        label: "Jira API token",
        value: "super-secret-token",
      }).success,
    ).toBe(true);
  });
});
