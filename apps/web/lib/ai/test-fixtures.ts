import type { AiApprovalRequest, AiRunEvent } from "@lazyit/shared";

/** Test fixtures for the chat's pure modules (not a test file itself). */
export const RUN = "ckrun0000000000000000001";

export function approval(toolCallId: string, overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
  return {
    toolCallId,
    preview: {
      toolName: "asset_update",
      class: "write",
      target: { type: "asset", id: "a1", op: "updated", label: "MBP-042" },
      changes: [
        { field: "action", after: "Assign MBP-042 to Juan Pérez." },
        { field: "assignee", before: null, after: "Juan Pérez", valueKind: "entity" },
      ],
      warnings: ["NOTIFIES_USERS"],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
    },
    elevated: false,
    stepUpRequired: false,
    untrustedSources: [],
    expiresAt: "2026-09-24T10:30:00.000Z",
    ...overrides,
  };
}

export function ev<T extends AiRunEvent["type"]>(
  type: T,
  body: Omit<Extract<AiRunEvent, { type: T }>, "v" | "type">,
): Extract<AiRunEvent, { type: T }> {
  return { v: 1, type, ...body } as Extract<AiRunEvent, { type: T }>;
}
