import { renderNotificationEmail } from './email.mailer';

describe('renderNotificationEmail footer (AUD-090)', () => {
  const base = {
    title: 'Access request approved',
    summary: 'Your request for GitHub was approved.',
    appUrl: 'https://it.example.com/',
    brandName: 'lazyit',
  };

  it('does not tell a notification recipient they administer the instance', () => {
    const { text, html } = renderNotificationEmail(base);
    expect(html).not.toMatch(/administer/i);
    expect(text).not.toMatch(/administer/i);
  });

  it('points every notification recipient at their own email preferences, in both parts', () => {
    const { text, html } = renderNotificationEmail(base);
    const prefs = 'https://it.example.com/account/notifications';
    expect(text).toContain('Notification emails');
    expect(text).toContain(prefs);
    expect(html).toContain('Notification emails');
    expect(html).toContain(`href="${prefs}"`);
  });

  it('omits the preferences link when no app URL is configured', () => {
    const { text, html } = renderNotificationEmail({ ...base, appUrl: null });
    expect(text).toContain('Notification emails');
    expect(text).not.toContain('/account/notifications');
    expect(html).not.toContain('/account/notifications');
  });

  it('keeps the SMTP test footer pointing at the instance email settings', () => {
    const { html } = renderNotificationEmail({ ...base, kind: 'smtp-test' });
    expect(html).toContain('Settings → Email');
    expect(html).not.toContain('/account/notifications');
  });

  it('a security notice says it cannot be turned off and links to no switch (#1699)', () => {
    const { text, html } = renderNotificationEmail({
      ...base,
      kind: 'security-notice',
    });
    expect(text).toContain('cannot be turned off');
    expect(html).toContain('cannot be turned off');
    expect(text).not.toContain('/account/notifications');
    expect(html).not.toContain('/account/notifications');
  });
});
