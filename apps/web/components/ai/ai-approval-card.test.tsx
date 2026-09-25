import { describe, expect, test } from "bun:test";
import type { AiMessagePart } from "@lazyit/shared";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { approval } from "@/lib/ai/test-fixtures";
import en from "@/messages/en/ai.json";
import es from "@/messages/es/ai.json";
import shared from "@/messages/en/shared.json";
import assetsEn from "@/messages/en/assets.json";
import assetsEs from "@/messages/es/assets.json";
import { AiApprovalCard, approvalStage, isPasswordSubmitKey } from "./ai-approval-card";

type ApprovalPart = Extract<AiMessagePart, { type: "approval" }>;

function render(part: ApprovalPart, locale: "en" | "es" = "en", callStatus?: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={{ ai: locale === "en" ? en : es, shared, assets: locale === "en" ? assetsEn : assetsEs }}
      timeZone="UTC"
    >
      <AiApprovalCard
        part={part}
        callStatus={callStatus as never}
        onDecide={async () => ({ ok: true })}
      />
    </NextIntlClientProvider>,
  );
}

const pending = (overrides = {}): ApprovalPart => ({
  type: "approval",
  request: approval("w1", overrides),
  outcome: null,
});

describe("AiApprovalCard", () => {
  test("server-built sentences render in the user's language; the English stays the fallback (#1384)", () => {
    const req = approval("w1");
    req.preview = {
      ...req.preview,
      changes: [
        {
          field: "action",
          after: "Add the application \"Jira\" to the catalog.",
          afterSentences: [{ code: "application_create.action", params: { name: "<untrusted_content>Jira</untrusted_content>" } }],
        },
        {
          field: "usedBy",
          after: "Unknown to you: asset models, child locations",
          afterSentences: [{ code: "taxonomy.usedByUnknown", params: { kinds: "asset models, child locations" } }],
        },
      ],
    };
    const part: ApprovalPart = { type: "approval", request: req, outcome: null };
    const esHtml = render(part, "es");
    expect(esHtml).toContain("Agregar la aplicación “Jira” al catálogo.");
    expect(esHtml).toContain("No lo podés ver: modelos de activo, ubicaciones hijas");
    expect(esHtml).not.toContain("untrusted_content");
    expect(render(part, "en")).toContain("Add the application &quot;Jira&quot; to the catalog.");

    // A code this build does not know: the whole row falls back to the English.
    req.preview = {
      ...req.preview,
      changes: [
        {
          field: "action",
          after: "Teleport the asset.",
          afterSentences: [
            { code: "application_create.action", params: { name: "Jira" } },
            { code: "asset_teleport.action", params: {} },
          ],
        },
      ],
    };
    expect(render({ type: "approval", request: req, outcome: null }, "es")).toContain("Teleport the asset.");
  });

  test("the action sentence comes first, then target, rows and warnings", () => {
    const html = render(pending());
    const action = html.indexOf("Assign MBP-042 to Juan Pérez.");
    expect(action).toBeGreaterThan(-1);
    expect(html.indexOf("Applies to")).toBeGreaterThan(action);
    expect(html).toContain('href="/assets/a1"');
    expect(html).toContain("Juan Pérez");
    expect(html).toContain(en.approval.warnings.NOTIFIES_USERS);
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    // No password field unless the server asks for it.
    expect(html).not.toContain('type="password"');
  });

  test("every shared warning code renders its own copy; an unknown one renders generically", () => {
    const req = approval("w1");
    req.preview = { ...req.preview, warnings: [...Object.keys(en.approval.warnings).filter((k) => k !== "unknown"), "FUTURE_CODE"] };
    for (const [locale, catalog] of [["en", en], ["es", es]] as const) {
      const html = render({ type: "approval", request: req, outcome: null }, locale);
      for (const [code, text] of Object.entries(catalog.approval.warnings)) {
        if (code === "unknown") continue;
        expect(html).toContain(text.replace(/'/g, "&#x27;"));
      }
      expect(html).toContain("FUTURE_CODE");
    }
  });

  test("step-up: a password field when the server requires it (critical application)", () => {
    const req = approval("w1", { stepUpRequired: true, elevated: true });
    req.preview = { ...req.preview, warnings: ["CRITICAL_APPLICATION"], stepUpRequired: true, elevated: true };
    const html = render({ type: "approval", request: req, outcome: null });
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain("Sensitive change");
    expect(html).toContain(en.approval.passwordRequired);
    // Approve stays disabled until a password is typed.
    expect(/<button[^>]*disabled=""[^>]*>Approve<\/button>/.test(html)).toBe(true);
  });

  test("untrusted sources raise the banner; untrusted text is plain text", () => {
    const req = approval("w1", {
      untrustedSources: [{ type: "article", id: "k1", slug: "howto", op: "updated", label: "How-to" }],
    });
    req.preview = {
      ...req.preview,
      changes: [{ field: "action", after: "Do <untrusted_content><b>this</b></untrusted_content>" }],
    };
    const html = render({ type: "approval", request: req, outcome: null });
    expect(html).toContain(en.approval.untrustedTitle);
    expect(html).toContain('href="/kb/howto"');
    expect(html).toContain("Do &lt;b&gt;this&lt;/b&gt;");
    expect(html).not.toContain("<b>this</b>");
    expect(html).not.toContain("untrusted_content");
  });

  test("redacted values never show", () => {
    const req = approval("w1");
    req.preview = { ...req.preview, changes: [{ field: "password", after: "hunter2", valueKind: "redacted" }] };
    const html = render({ type: "approval", request: req, outcome: null });
    expect(html).not.toContain("hunter2");
    expect(html).toContain(en.approval.redacted);
  });

  test("a batch's rows render as a table: labelled columns, skipped rows, linked duplicates, flat defaults", () => {
    const req = approval("b1", { preview: {
      ...approval("b1").preview,
      toolName: "asset_create_batch",
      target: undefined,
      warnings: [],
      changes: [
        { field: "action", after: "Create 1 of 2 assets; 1 row skipped as requested." },
        { field: "defaultsApplied", after: ["status: IN_STORAGE (1 of 1 rows)"], valueKind: "text" },
        { field: "duplicatesUnchecked", after: true, valueKind: "boolean" },
        {
          field: "rows",
          valueKind: "text",
          after: [
            { row: 1, name: "MBP-01", assetTag: "LZ-1", serial: null, status: "IN_STORAGE", statusDefaulted: true,
              model: null, category: null, location: { type: "location", id: "l1", label: "HQ" },
              skipped: false, valid: true, errors: [], duplicates: [] },
            { row: 2, name: "<b>MBP-02</b>", assetTag: "LZ-9", serial: null, status: "OPERATIONAL",
              model: null, category: null, location: null, skipped: true, valid: false,
              errors: ['assetTag "LZ-9" already belongs to LZ-9'],
              duplicates: [{ field: "assetTag", value: "LZ-9", existing: { type: "asset", id: "a9", label: "LZ-9" } }] },
          ],
        },
      ],
    } });
    for (const [locale, catalog] of [["en", en], ["es", es]] as const) {
      const html = render({ type: "approval", request: req, outcome: null }, locale);
      expect(html).toContain("<table");
      expect(html).toContain(`>${catalog.fields.assetTag}</th>`);
      expect(html).toContain(`>${catalog.approval.table.problems}</th>`);
      expect(html).toContain(catalog.approval.table.willBeSkipped.replace(/'/g, "&#x27;"));
      expect(html).toContain(catalog.approval.table.onlyProblems.replace("{count}", "1"));
      expect(html).toContain(catalog.approval.notices.duplicatesUnchecked.replace(/'/g, "&#x27;"));
    }
    const html = render({ type: "approval", request: req, outcome: null });
    expect(html).toContain('href="/assets/a9"');
    expect(html).toContain('href="/locations/l1"');
    expect(html).toContain("&lt;b&gt;MBP-02&lt;/b&gt;");
    expect(html).toContain(`${assetsEn.status.IN_STORAGE}</span><span class="ml-1 text-muted-foreground">(default)`);
    expect(html).toContain("status: IN_STORAGE (1 of 1 rows)");
    // The duplicate sentence is not repeated under its structured, linked form.
    expect(html).not.toContain("already belongs to LZ-9");
  });

  test("decided cards have no buttons", () => {
    const html = render({ ...pending(), outcome: "rejected" });
    expect(html).not.toContain(">Approve<");
    expect(html).toContain(en.approval.rejectedNote);
  });
});

describe("approvalStage", () => {
  test("from the decision and the execution", () => {
    expect(approvalStage(null, "AWAITING_APPROVAL", null)).toBe("pending");
    expect(approvalStage(null, undefined, "approve")).toBe("approving");
    expect(approvalStage("approved", "EXECUTING", null)).toBe("approved");
    expect(approvalStage("approved", "SUCCEEDED", null)).toBe("executed");
    expect(approvalStage("approved", "FAILED", null)).toBe("failed");
    expect(approvalStage("approved", "OUTCOME_UNKNOWN", null)).toBe("failed");
    expect(approvalStage("expired", undefined, null)).toBe("expired");
  });
});

describe("isPasswordSubmitKey", () => {
  test("Enter submits once; auto-repeat, IME composition and other keys never do", () => {
    expect(isPasswordSubmitKey({ key: "Enter", repeat: false })).toBe(true);
    expect(isPasswordSubmitKey({ key: "Enter", repeat: true })).toBe(false);
    expect(isPasswordSubmitKey({ key: "Enter", repeat: false, nativeEvent: { isComposing: true } })).toBe(false);
    expect(isPasswordSubmitKey({ key: "a", repeat: false })).toBe(false);
  });
});
