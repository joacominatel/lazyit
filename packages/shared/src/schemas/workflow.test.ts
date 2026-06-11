import { describe, expect, test } from "bun:test";
import {
  CompleteManualTaskSchema,
  CreateApplicationWorkflowSchema,
  CreateWorkflowConnectionSchema,
  CreateWorkflowSecretSchema,
  DEFAULT_DEPROVISION_POLICY,
  DEFAULT_PROBE_METHOD,
  DEFAULT_RETRY_POLICY,
  HttpSuccessCriteriaSchema,
  isHttpStatusSuccess,
  ManualStepSchema,
  resolveStepTransitions,
  RestConnectionConfigSchema,
  RestStepSchema,
  RetryPolicySchema,
  UpdateApplicationWorkflowSchema,
  WorkflowConnectionConfigSchema,
  WORKFLOW_CONNECTION_KINDS,
  WORKFLOW_END_SUCCESS,
  WORKFLOW_ESCALATE_TO_MANUAL,
  WORKFLOW_PROBE_METHODS,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_STOP_FAIL,
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

describe("RestConnectionConfigSchema — optional test-connection probe path (#344)", () => {
  test("healthCheckPath + healthCheckMethod are optional (a config without them parses)", () => {
    const parsed = RestConnectionConfigSchema.safeParse({
      kind: "REST",
      baseUrl: "https://api.example.com",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.healthCheckPath).toBeUndefined();
      expect(parsed.data.healthCheckMethod).toBeUndefined();
    }
  });

  test("accepts a relative health path and a READ-ONLY probe method", () => {
    const parsed = RestConnectionConfigSchema.safeParse({
      kind: "REST",
      baseUrl: "https://api.example.com",
      healthCheckPath: "/api/healthz",
      healthCheckMethod: "HEAD",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.healthCheckPath).toBe("/api/healthz");
      expect(parsed.data.healthCheckMethod).toBe("HEAD");
    }
  });

  test("trims the health path and rejects an empty / over-long one", () => {
    const trimmed = RestConnectionConfigSchema.safeParse({
      kind: "REST",
      baseUrl: "https://api.example.com",
      healthCheckPath: "  /status  ",
    });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) {
      expect(trimmed.data.healthCheckPath).toBe("/status");
    }
    expect(
      RestConnectionConfigSchema.safeParse({
        kind: "REST",
        baseUrl: "https://api.example.com",
        healthCheckPath: "   ",
      }).success,
    ).toBe(false);
    expect(
      RestConnectionConfigSchema.safeParse({
        kind: "REST",
        baseUrl: "https://api.example.com",
        healthCheckPath: "/".padEnd(2049, "x"),
      }).success,
    ).toBe(false);
  });

  test("rejects a WRITE probe method (the probe must stay side-effect-free)", () => {
    expect(
      WORKFLOW_PROBE_METHODS as readonly string[],
    ).toEqual(["GET", "HEAD"]);
    expect(DEFAULT_PROBE_METHOD).toBe("GET");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        RestConnectionConfigSchema.safeParse({
          kind: "REST",
          baseUrl: "https://api.example.com",
          healthCheckMethod: method,
        }).success,
      ).toBe(false);
    }
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

// ───────────────────────────────────────────────────────────────────────────────────────────────
// The opinionated error-handling DAG (ADR-0054 §8)
// ───────────────────────────────────────────────────────────────────────────────────────────────

const rest = (key: string, extra: Record<string, unknown> = {}) => ({
  kind: "REST" as const,
  key,
  connectionId: CUID,
  method: "POST" as const,
  path: `/rest/${key}`,
  ...extra,
});

describe("HTTP success criteria", () => {
  test("defaults to 2xx when no criteria is given", () => {
    expect(isHttpStatusSuccess(200)).toBe(true);
    expect(isHttpStatusSuccess(204)).toBe(true);
    expect(isHttpStatusSuccess(404)).toBe(false);
    expect(isHttpStatusSuccess(500)).toBe(false);
  });

  test("an explicit status set / range narrows or widens success", () => {
    expect(isHttpStatusSuccess(404, { statuses: [404] })).toBe(true);
    expect(isHttpStatusSuccess(201, { ranges: [{ from: 200, to: 299 }] })).toBe(
      true,
    );
    expect(isHttpStatusSuccess(301, { ranges: [{ from: 200, to: 299 }] })).toBe(
      false,
    );
    // 200 is NOT success when the criteria only lists 204 (a strict "no content" contract).
    expect(isHttpStatusSuccess(200, { statuses: [204] })).toBe(false);
  });

  test("schema rejects empty criteria and an inverted range", () => {
    expect(HttpSuccessCriteriaSchema.safeParse({}).success).toBe(false);
    expect(
      HttpSuccessCriteriaSchema.safeParse({ statuses: [200] }).success,
    ).toBe(true);
    expect(
      HttpSuccessCriteriaSchema.safeParse({ ranges: [{ from: 299, to: 200 }] })
        .success,
    ).toBe(false);
  });

  test("a REST step carries an optional successCriteria", () => {
    expect(
      RestStepSchema.safeParse(rest("create", { successCriteria: { statuses: [200, 201] } }))
        .success,
    ).toBe(true);
  });
});

describe("retry policy", () => {
  test("applies sane defaults (single attempt)", () => {
    const parsed = RetryPolicySchema.parse({});
    expect(parsed.maxAttempts).toBe(1);
    expect(parsed.backoff).toBe("exponential");
    expect(parsed.delayMs).toBe(1000);
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(1);
  });

  test("enforces bounds on maxAttempts", () => {
    expect(RetryPolicySchema.safeParse({ maxAttempts: 0 }).success).toBe(false);
    expect(RetryPolicySchema.safeParse({ maxAttempts: 11 }).success).toBe(false);
    expect(
      RetryPolicySchema.safeParse({ maxAttempts: 3, backoff: "fixed", delayMs: 500 })
        .success,
    ).toBe(true);
  });

  test("a REST step carries an optional retry policy", () => {
    expect(
      RestStepSchema.safeParse(rest("create", { retry: { maxAttempts: 3 } }))
        .success,
    ).toBe(true);
  });
});

describe("WorkflowStepsSchema — opinionated error-handling DAG", () => {
  // (a) A degenerate linear sequence: no explicit edges. Must validate and mean
  //     "onSuccess → next step, onFailure → STOP_FAIL".
  test("(a) a plain linear sequence is the degenerate DAG", () => {
    const parsed = WorkflowStepsSchema.parse([rest("a"), rest("b")]);
    const t0 = resolveStepTransitions(parsed, 0);
    expect(t0.onSuccess).toBe("b");
    expect(t0.onFailure).toBe(WORKFLOW_STOP_FAIL);
    const t1 = resolveStepTransitions(parsed, 1);
    expect(t1.onSuccess).toBe(WORKFLOW_END_SUCCESS);
    expect(t1.onFailure).toBe(WORKFLOW_STOP_FAIL);
  });

  // (b) A success/failure branch: a provision step routes its failure to an alert step, success ends.
  test("(b) a success/failure branch validates", () => {
    const branched = [
      rest("provision", { onSuccess: WORKFLOW_END_SUCCESS, onFailure: "alert" }),
      {
        kind: "WEBHOOK_OUT" as const,
        key: "alert",
        connectionId: CUID,
        onFailure: WORKFLOW_STOP_FAIL,
      },
    ];
    const result = WorkflowStepsSchema.safeParse(branched);
    expect(result.success).toBe(true);
    if (result.success) {
      const t0 = resolveStepTransitions(result.data, 0);
      expect(t0.onSuccess).toBe(WORKFLOW_END_SUCCESS);
      expect(t0.onFailure).toBe("alert");
    }
  });

  // (c) Acyclicity: a transition cycle is rejected.
  test("(c) rejects a transition cycle", () => {
    const cyclic = [
      rest("a", { onFailure: "b" }),
      rest("b", { onSuccess: "a" }),
    ];
    expect(WorkflowStepsSchema.safeParse(cyclic).success).toBe(false);
  });

  test("(c') rejects a self-loop", () => {
    expect(WorkflowStepsSchema.safeParse([rest("a", { onSuccess: "a" })]).success).toBe(
      false,
    );
  });

  // (d) Unknown transition targets are rejected.
  test("(d) rejects onSuccess targeting an unknown step key", () => {
    expect(
      WorkflowStepsSchema.safeParse([rest("a", { onSuccess: "ghost" })]).success,
    ).toBe(false);
  });

  test("(d') rejects onFailure targeting an unknown step key / END_SUCCESS / non-terminal", () => {
    expect(
      WorkflowStepsSchema.safeParse([rest("a", { onFailure: "ghost" })]).success,
    ).toBe(false);
    // onFailure may not resolve to the SUCCESS terminal.
    expect(
      WorkflowStepsSchema.safeParse([rest("a", { onFailure: WORKFLOW_END_SUCCESS })])
        .success,
    ).toBe(false);
  });

  test("onSuccess may not target a failure terminal", () => {
    expect(
      WorkflowStepsSchema.safeParse([rest("a", { onSuccess: WORKFLOW_STOP_FAIL })])
        .success,
    ).toBe(false);
  });

  test("a step key may not collide with a reserved terminal token", () => {
    expect(
      WorkflowStepsSchema.safeParse([rest("END_SUCCESS")]).success,
    ).toBe(false);
    expect(WorkflowStepsSchema.safeParse([rest("STOP_FAIL")]).success).toBe(false);
  });

  test("the valid failure terminals are accepted as onFailure targets", () => {
    for (const terminal of [
      WORKFLOW_STOP_FAIL,
      WORKFLOW_ESCALATE_TO_MANUAL,
      "COMPENSATE",
    ]) {
      expect(
        WorkflowStepsSchema.safeParse([rest("a", { onFailure: terminal })]).success,
      ).toBe(true);
    }
  });
});

describe("legacy onError → transition mapping (resolveStepTransitions)", () => {
  test("fail → STOP_FAIL", () => {
    const parsed = WorkflowStepsSchema.parse([rest("a", { onError: "fail" })]);
    expect(resolveStepTransitions(parsed, 0).onFailure).toBe(WORKFLOW_STOP_FAIL);
  });

  test("manual → ESCALATE_TO_MANUAL", () => {
    const parsed = WorkflowStepsSchema.parse([rest("a", { onError: "manual" })]);
    expect(resolveStepTransitions(parsed, 0).onFailure).toBe(
      WORKFLOW_ESCALATE_TO_MANUAL,
    );
  });

  test("continue → take the success edge (fall through to the next step)", () => {
    const parsed = WorkflowStepsSchema.parse([
      rest("a", { onError: "continue" }),
      rest("b"),
    ]);
    const t0 = resolveStepTransitions(parsed, 0);
    expect(t0.onSuccess).toBe("b");
    expect(t0.onFailure).toBe("b");
  });

  test("an explicit onFailure overrides the legacy onError", () => {
    const parsed = WorkflowStepsSchema.parse([
      rest("a", { onError: "continue", onFailure: WORKFLOW_STOP_FAIL }),
      rest("b"),
    ]);
    expect(resolveStepTransitions(parsed, 0).onFailure).toBe(WORKFLOW_STOP_FAIL);
  });
});
