import type { AiApprovalRequest, AiInputForm, AiInputRequest, AiRunEvent } from "@lazyit/shared";

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

/** A form with every field kind, one per importance, and a repeat group (#1388). */
export function inputForm(overrides: Partial<AiInputForm> = {}): AiInputForm {
  return {
    title: "Details for the new laptops",
    reason: "I need the model and the site to register them.",
    fields: [
      { key: "site", label: "Site", kind: "select", importance: "required", required: true, optionsFrom: "locations",
        options: [{ value: "loc1", label: "HQ" }, { value: "loc2", label: "Warehouse" }] },
      { key: "count", label: "How many", kind: "number", importance: "recommended", required: false, min: 1, max: 50 },
      { key: "arrival", label: "Arrival", kind: "date", importance: "optional", required: false },
      { key: "notes", label: "Notes", kind: "textarea", importance: "optional", required: false },
      { key: "tags", label: "Tags", kind: "multiselect", importance: "optional", required: false,
        options: [{ value: "new", label: "New" }, { value: "leased", label: "Leased" }] },
      { key: "urgent", label: "Urgent", kind: "checkbox", importance: "optional", required: false },
    ],
    groups: [
      {
        key: "items",
        label: "Laptops",
        minRows: 1,
        maxRows: 3,
        fields: [
          { key: "serial", label: "Serial", kind: "text", importance: "required", required: true },
          { key: "owner", label: "Owner", kind: "text", importance: "optional", required: false },
        ],
      },
    ],
    ...overrides,
  };
}

export function inputRequest(toolCallId: string, form: AiInputForm = inputForm()): AiInputRequest {
  return { toolCallId, form, expiresAt: "2026-09-24T10:30:00.000Z" };
}

export function ev<T extends AiRunEvent["type"]>(
  type: T,
  body: Omit<Extract<AiRunEvent, { type: T }>, "v" | "type">,
): Extract<AiRunEvent, { type: T }> {
  return { v: 1, type, ...body } as Extract<AiRunEvent, { type: T }>;
}
