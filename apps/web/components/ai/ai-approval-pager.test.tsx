import { describe, expect, test } from "bun:test";
import type { AiApprovalRequest, AiMessagePart } from "@lazyit/shared";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { approval } from "@/lib/ai/test-fixtures";
import en from "@/messages/en/ai.json";
import es from "@/messages/es/ai.json";
import shared from "@/messages/en/shared.json";
import assetsEn from "@/messages/en/assets.json";
import assetsEs from "@/messages/es/assets.json";
import { AiApprovalPager } from "./ai-approval-pager";
import { AiRefusedCalls } from "./ai-refused-calls";

type ApprovalPart = Extract<AiMessagePart, { type: "approval" }>;
type ToolPart = Extract<AiMessagePart, { type: "tool" }>;

function render(node: ReactNode, locale: "en" | "es" = "en"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={{ ai: locale === "en" ? en : es, shared, assets: locale === "en" ? assetsEn : assetsEs }}
      timeZone="UTC"
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const card = (id: string, outcome: ApprovalPart["outcome"] = null, overrides: Partial<AiApprovalRequest> = {}) =>
  ({ type: "approval", request: approval(id, overrides), outcome }) satisfies ApprovalPart;

const pager = (parts: ApprovalPart[], locale: "en" | "es" = "en") =>
  render(
    <AiApprovalPager parts={parts} tools={new Map()} navigated={[]} onDecide={async () => ({ ok: true })} />,
    locale,
  );

describe("AiApprovalPager", () => {
  test("one card with pages, opened on the first change still waiting", () => {
    const html = pager([card("w1", "approved"), card("w2"), card("w3")]);
    expect(html).toContain("Proposed changes");
    expect(html).toContain("3 changes");
    expect(html).toContain("2 of 3");
    expect(html).toContain("Change 2 of 3");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Previous change"');
    expect(html).toContain('aria-label="Next change"');
    expect(html).toContain('aria-label="Change 1: Approved"');
    expect(html).toContain('aria-current="step"');
    // Every page is mounted, only the current one is shown.
    expect(html.match(/<div hidden="">/g)?.length).toBe(2);
    expect(html).toContain("1 of 3 decided");
  });

  test("the bulk actions say how many they cover and why the rest are left out", () => {
    const html = pager([
      card("w1"),
      card("w2"),
      card("w3", null, { stepUpRequired: true }),
      card("w4", null, { untrustedSources: [{ type: "article", id: "k1", op: "navigate" }] }),
    ]);
    // The untrusted-source change is covered; its page keeps the banner.
    expect(html).toContain("Approve all (3)");
    expect(html).toContain("Reject all (3)");
    expect(html).toContain("Approve all and Reject all cover 3 changes still waiting.");
    expect(html).toContain("1 needs your password");
    expect(html).not.toContain("1 is based on content written by others");
    expect(html).toContain(en.approval.untrustedTitle);
  });

  test("nothing eligible disables the bulk actions; all decided hides them", () => {
    const none = pager([card("w1", null, { elevated: true }), card("w2", null, { stepUpRequired: true })]);
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>Approve all \(0\)/);
    const done = pager([card("w1", "approved"), card("w2", "rejected")]);
    expect(done).not.toContain("Approve all");
    expect(done).toContain("Every change in this step is decided.");
    expect(done).toContain("1 of 2");
  });

  test("renders in Spanish", () => {
    const html = pager([card("w1"), card("w2")], "es");
    expect(html).toContain("Cambios propuestos");
    expect(html).toContain("1 de 2");
    expect(html).toContain("Aprobar todos (2)");
  });
});

describe("AiRefusedCalls", () => {
  const refused = (id: string): ToolPart => ({
    type: "tool",
    toolCallId: id,
    name: "asset_update",
    class: "write",
    status: "FAILED",
    result: {
      toolCallId: id,
      kind: "mutation",
      status: "error",
      mutated: false,
      entityRefs: [],
      error: { code: "RATE_LIMITED", message: "Propose at most 5 changes at a time" },
    },
  });

  test("one line for all of them, the details grouped and collapsed", () => {
    const parts = Array.from({ length: 20 }, (_, i) => refused(`r${i}`));
    const html = render(<AiRefusedCalls parts={parts} />);
    expect(html).toContain("20 changes couldn&#x27;t be proposed");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("×20: Propose at most 5 changes at a time");
    expect(html).toMatch(/<ul[^>]*hidden=""/);
    const esHtml = render(<AiRefusedCalls parts={parts} />, "es");
    expect(esHtml).toContain("20 cambios no se pudieron proponer");
  });
});
