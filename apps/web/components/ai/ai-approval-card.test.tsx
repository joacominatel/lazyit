import { describe, expect, test } from "bun:test";
import type { AiMessagePart } from "@lazyit/shared";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { approval } from "@/lib/ai/test-fixtures";
import en from "@/messages/en/ai.json";
import es from "@/messages/es/ai.json";
import shared from "@/messages/en/shared.json";
import { AiApprovalCard, approvalStage } from "./ai-approval-card";

type ApprovalPart = Extract<AiMessagePart, { type: "approval" }>;

function render(part: ApprovalPart, locale: "en" | "es" = "en", callStatus?: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={{ ai: locale === "en" ? en : es, shared }}
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
