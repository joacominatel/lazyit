import { createTransport, type Transporter } from 'nodemailer';
import type { SmtpSecurity } from '@lazyit/shared';

/**
 * Mailer helpers (issue #615, ADR-0079): build a nodemailer transport from resolved SMTP config, and
 * render the ONE branded multipart (HTML + plain-text) email. No templating framework, no per-type
 * layouts — a single template literal (one line before fifty).
 */

/** The in-memory resolved config a transport is built from (password already decrypted). */
export interface ResolvedSmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  /** Decrypted password (in memory only) — null for an open/unauthenticated relay. */
  password: string | null;
  fromAddress: string;
  fromName: string | null;
  rejectUnauthorized: boolean;
}

/**
 * Map the closed `security` mode to nodemailer's transport flags (verified against nodemailer 9 docs):
 *   - `tls`      → implicit TLS from the first byte (port 465): `secure:true`.
 *   - `starttls` → plaintext connect then upgrade: `secure:false, requireTLS:true` (fails cleanly if the
 *                  server can't STARTTLS, rather than silently sending in the clear).
 *   - `none`     → plaintext, no TLS (trusted internal relay): `secure:false, ignoreTLS:true`.
 * `auth` is included ONLY when a username is set (an open relay needs none). `tls.rejectUnauthorized`
 * carries the admin's cert-verification choice.
 */
export function buildTransport(config: ResolvedSmtpConfig): Transporter {
  const secure = config.security === 'tls';
  return createTransport({
    host: config.host,
    port: config.port,
    secure,
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    ...(config.username
      ? { auth: { user: config.username, pass: config.password ?? '' } }
      : {}),
    tls: { rejectUnauthorized: config.rejectUnauthorized },
    // Bound the handshake/socket so a dead relay fails fast (the test action + a queued send never hang).
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** The `from` field nodemailer accepts — a display name is optional. */
export function formatFrom(config: ResolvedSmtpConfig): {
  name?: string;
  address: string;
} {
  return config.fromName
    ? { name: config.fromName, address: config.fromAddress }
    : { address: config.fromAddress };
}

/** The rendered email parts. */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Minimal HTML-escape for the few interpolated strings (title/summary come from server-built copy). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the ONE branded notification email (the Ledger/lazyit look — oxblood accent rule, plain type).
 * Subject = the notification title; body = title + optional summary + a single "View in lazyit" link to
 * the app (NOT a per-entity deep link — ponytail ceiling below). Always multipart: a plain-text part for
 * text clients + a simple inline-styled HTML part (email clients strip <style>, so styles are inline).
 *
 * ponytail: one template for every notification type; ceiling — no per-type layouts, no MJML/handlebars,
 * and the CTA links to the app root, not a per-entity deep link. Upgrade: add an entityType→path map here
 * if operators ask for deep links.
 */
export function renderNotificationEmail(input: {
  title: string;
  summary: string | null;
  appUrl: string | null;
  brandName: string;
}): RenderedEmail {
  const { title, summary, appUrl, brandName } = input;
  const subject = title;
  const textParts = [title];
  if (summary) textParts.push('', summary);
  if (appUrl) textParts.push('', `View in ${brandName}: ${appUrl}`);
  textParts.push('', `— ${brandName}`);
  const text = textParts.join('\n');

  const safeTitle = escapeHtml(title);
  const safeSummary = summary ? escapeHtml(summary) : null;
  const cta = appUrl
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#7b2d26;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px">View in ${escapeHtml(brandName)}</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f5f4f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <div style="background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;padding:28px">
      <div style="font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#7b2d26;margin-bottom:12px">${escapeHtml(brandName)}</div>
      <h1 style="margin:0;font-size:19px;line-height:1.35;font-weight:600">${safeTitle}</h1>
      ${safeSummary ? `<p style="margin:12px 0 0;font-size:15px;line-height:1.5;color:#44403c">${safeSummary}</p>` : ''}
      ${cta}
    </div>
    <p style="margin:20px 4px 0;font-size:12px;color:#a8a29e">You are receiving this because you administer this ${escapeHtml(brandName)} instance. Manage outbound email under Settings → Instance → SMTP.</p>
  </div>
</body></html>`;

  return { subject, text, html };
}
