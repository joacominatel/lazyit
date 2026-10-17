import { expect, test } from "bun:test";
import type { Notification, NotificationGroup } from "@lazyit/shared";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { SHARED_FORMATS } from "@/i18n/config";
import messages from "@/messages/en/notifications.json";
import type { ReactNode } from "react";
import {
  NotificationGroupItem,
  NotificationListItem,
  UnreadBadge,
} from "./notification-bell";

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

function render(node: ReactNode, now = "2026-09-23T12:00:00.000Z") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      now={new Date(now)}
      formats={SHARED_FORMATS}
      messages={{ notifications: messages }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

function renderRow() {
  return render(
    <NotificationListItem
      notification={NOTIFICATION}
      onActivate={() => {}}
      onDismiss={() => {}}
    />,
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

const GROUP: NotificationGroup = {
  type: "critical_app_access",
  day: "2026-10-17",
  count: 312,
  unread: 40,
  latestAt: "2026-10-17T10:00:00.000Z",
  latest: [
    { ...NOTIFICATION, id: "g1", type: "critical_app_access", title: "Access to Vault granted to Ana" },
    { ...NOTIFICATION, id: "g2", type: "critical_app_access", title: "Access to Vault granted to Bo" },
  ],
};

function renderGroup(group: NotificationGroup, now = "2026-10-17T15:00:00.000Z") {
  return render(
    <NotificationGroupItem
      group={group}
      rowActions={() => ({ onActivate: () => {}, onDismiss: () => {} })}
      onMarkRead={() => {}}
    />,
    now,
  );
}

test("a group row summarizes its type and count, with the day and the unread", () => {
  const html = renderGroup(GROUP);

  expect(html).toContain("312 grants on critical applications");
  expect(html).toContain("Today");
  expect(html).toContain("40 unread");
  expect(html).toContain("Access to Vault granted to Ana");
  expect(html).toContain("Mark group as read");
});

test("a group row is a collapsed disclosure, not a link", () => {
  const html = renderGroup(GROUP);

  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("<a ");
});

test("an older group shows its date and no mark-read action once read", () => {
  const html = renderGroup({ ...GROUP, unread: 0 }, "2026-10-20T15:00:00.000Z");

  expect(html).toContain("Oct 17, 2026");
  expect(html).not.toContain("Today");
  expect(html).not.toContain("unread");
  expect(html).not.toContain("Mark group as read");
});

test("the badge caps at 99+ and never shows the raw count", () => {
  expect(renderToStaticMarkup(<UnreadBadge unread={912} />)).toContain(">99+<");
  expect(renderToStaticMarkup(<UnreadBadge unread={7} />)).toContain(">7<");
});
