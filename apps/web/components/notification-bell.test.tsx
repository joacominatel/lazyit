import { expect, test } from "bun:test";
import type { Notification } from "@lazyit/shared";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { SHARED_FORMATS } from "@/i18n/config";
import messages from "@/messages/en/notifications.json";
import { NotificationListItem } from "./notification-bell";

/**
 * The bell row's dismiss X (#1309) must never trigger the row's click-through. The guarantee is
 * structural: the X is a SIBLING of the deep-link `<a>`, not a descendant, so its click cannot bubble
 * into the link's navigation (and a `<button>` inside an `<a>` would be invalid HTML anyway). There is
 * no DOM test harness in this repo, so the row is rendered to static markup and the tree is asserted.
 */

const NOTIFICATION: Notification = {
  id: "n1",
  type: "low_stock",
  severity: "warning",
  title: "Toner is running low",
  summary: null,
  entityType: null,
  entityId: "c1",
  targetUserId: null,
  recipientUserId: null,
  metadata: null,
  createdAt: "2026-09-23T10:00:00.000Z",
  read: false,
};

function renderRow() {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      now={new Date("2026-09-23T12:00:00.000Z")}
      formats={SHARED_FORMATS}
      messages={{ notifications: messages }}
    >
      <NotificationListItem
        notification={NOTIFICATION}
        onActivate={() => {}}
        onDismiss={() => {}}
      />
    </NextIntlClientProvider>,
  );
}

test("the dismiss X sits beside the deep-link, never inside it", () => {
  const html = renderRow();
  const link = html.slice(html.indexOf("<a "), html.indexOf("</a>") + 4);

  expect(link).toContain('href="/consumables/c1"');
  expect(link).not.toContain("<button");
  // The X comes after the link closes, inside the same row.
  expect(html.indexOf("<button")).toBeGreaterThan(html.indexOf("</a>"));
});

test("the dismiss X is a plain button named after the notification", () => {
  const html = renderRow();

  expect(html).toContain('type="button"');
  expect(html).toContain(
    'aria-label="Dismiss notification: Toner is running low"',
  );
});
