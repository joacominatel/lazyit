import { describe, expect, test } from "bun:test";
import { AgentReportSchema } from "@lazyit/shared";
import {
  DECOMMISSION_FIELD,
  decommissionPayload,
  describeDecommission,
  interpretDecommission,
} from "./decommission";

const REPORT = AgentReportSchema.parse({
  agentVersion: "1.12.0",
  reportingSource: "agent:abc123",
  externalId: "machine-id-xyz",
  reportedAt: "2026-10-22T12:00:00.000Z",
  host: { hostname: "web-01" },
  software: [{ name: "openssl", version: "3.0.13" }],
});

describe("decommissionPayload (#1701)", () => {
  test("is the FULL report plus the flag, so an older server reads an ordinary check-in", () => {
    const payload = decommissionPayload(REPORT);
    expect(payload[DECOMMISSION_FIELD]).toBe(true);
    expect(payload.software).toEqual(REPORT.software);
    expect(payload.host).toEqual(REPORT.host);
    expect(payload.externalId).toBe(REPORT.externalId);
  });

  test("does not mutate the report it was given", () => {
    decommissionPayload(REPORT);
    expect(REPORT).not.toHaveProperty(DECOMMISSION_FIELD);
  });

  test("still parses against the shared contract, which may or may not declare the flag", () => {
    expect(AgentReportSchema.safeParse(decommissionPayload(REPORT)).success).toBe(true);
  });
});

describe("interpretDecommission (#1701)", () => {
  test("an ack carrying `retired: true` means the node is retired", () => {
    expect(interpretDecommission(200, { nodeId: "n1", accepted: true, retired: true })).toEqual({
      kind: "retired",
      nodeId: "n1",
    });
  });

  test("a 2xx WITHOUT `retired` is an instance that predates the flag — nothing was retired", () => {
    expect(interpretDecommission(200, { nodeId: "n1", accepted: true, softwareDelta: true })).toEqual(
      { kind: "unsupported", nodeId: "n1" },
    );
  });

  test("an unparseable 2xx body is treated as unsupported, never as success", () => {
    expect(interpretDecommission(200, null)).toEqual({ kind: "unsupported" });
    expect(interpretDecommission(200, "ok")).toEqual({ kind: "unsupported" });
    expect(interpretDecommission(200, { retired: "true" })).toEqual({ kind: "unsupported" });
  });

  test("a 404 is a host lazyit has no live node for", () => {
    expect(interpretDecommission(404, null)).toEqual({ kind: "unknownHost" });
  });

  test("any other status is a refusal, with a bounded detail", () => {
    const outcome = interpretDecommission(401, null, "x".repeat(2000));
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.status).toBe(401);
      expect(outcome.detail.length).toBe(500);
    }
  });
});

describe("describeDecommission (#1701)", () => {
  test("only a retirement succeeds", () => {
    expect(describeDecommission({ kind: "retired", nodeId: "n1" }).ok).toBe(true);
    expect(describeDecommission({ kind: "unsupported" }).ok).toBe(false);
    expect(describeDecommission({ kind: "unknownHost" }).ok).toBe(false);
    expect(describeDecommission({ kind: "rejected", status: 500, detail: "" }).ok).toBe(false);
  });

  test("every failure tells the operator how to finish by hand, or that there is nothing to do", () => {
    expect(describeDecommission({ kind: "unsupported" }).message).toMatch(/retire the node by hand/i);
    expect(describeDecommission({ kind: "rejected", status: 500, detail: "" }).message).toMatch(
      /retire the node by hand/i,
    );
    expect(describeDecommission({ kind: "unknownHost" }).message).toMatch(/nothing to retire/i);
  });

  test("a retirement says it reverses itself if the host reports again", () => {
    expect(describeDecommission({ kind: "retired" }).message).toMatch(/un-retired automatically/i);
  });
});
