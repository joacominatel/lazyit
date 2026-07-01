import { Injectable, Logger } from '@nestjs/common';
import type {
  SendTestEmailResult,
  SmtpSettings,
  UpdateSmtpSettings,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SMTP_SETTINGS_SINGLETON_ID } from './email.constants';
import {
  decryptSmtpPassword,
  encryptSmtpPassword,
  isSmtpSecretKeyConfigured,
} from './smtp.crypto';
import {
  buildTransport,
  formatFrom,
  renderNotificationEmail,
  type ResolvedSmtpConfig,
} from './email.mailer';

/**
 * SmtpService — the singleton instance-config store for OUTBOUND EMAIL (issue #615, ADR-0079), the same
 * shape as AssetTagSchemeService (ADR-0063): read the single row (or an explicit disabled default) and
 * upsert it. Also owns transport resolution (decrypting the at-rest password in memory) and the inline
 * "send test email" action. The password is WRITE-ONLY: {@link getSettings} never returns it (only
 * `passwordSet`); it leaves this service only as an SMTP auth credential to the relay.
 */
@Injectable()
export class SmtpService {
  private readonly logger = new Logger(SmtpService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the settings for the config surface. Returns the explicit DISABLED default (enabled false, empty
   * fields) when no row has ever been written — so the form always receives a concrete redacted shape,
   * never a 404 (the AssetTagScheme convention).
   */
  async getSettings(): Promise<SmtpSettings> {
    const row = await this.prisma.smtpSettings.findFirst({
      where: { id: SMTP_SETTINGS_SINGLETON_ID },
    });
    if (!row) {
      const now = new Date().toISOString();
      return {
        enabled: false,
        host: null,
        port: null,
        security: 'starttls',
        username: null,
        passwordSet: false,
        fromAddress: null,
        fromName: null,
        rejectUnauthorized: true,
        createdAt: now,
        updatedAt: now,
      };
    }
    return this.toWire(row);
  }

  /**
   * Upsert the single config row (`PUT`). Fields are set wholesale. The PASSWORD is write-only:
   *   - a non-empty `password` → encrypt (AES-256-GCM under SMTP_SECRET_KEY) and store the envelope;
   *   - omitted/empty → the stored envelope is LEFT UNCHANGED (so re-saving the read form, which never
   *     receives the password, never wipes it).
   * Encrypting throws {@link SmtpSecretKeyMissingError} (mapped to 409 at the controller) if the master
   * key is unset — the rest of the config still saves without a password. Returns the redacted settings.
   */
  async updateSettings(input: UpdateSmtpSettings): Promise<SmtpSettings> {
    const base = {
      enabled: input.enabled,
      host: input.host ?? null,
      port: input.port ?? null,
      security: input.security,
      username: input.username ?? null,
      fromAddress: input.fromAddress ?? null,
      fromName: input.fromName ?? null,
      rejectUnauthorized: input.rejectUnauthorized,
    };
    // Encrypt only when a non-empty password was supplied (set/rotate); otherwise leave the envelope.
    const envelope =
      input.password && input.password.length > 0
        ? encryptSmtpPassword(input.password)
        : null;
    const envelopeData = envelope
      ? {
          passwordCiphertext: envelope.ciphertext,
          passwordIv: envelope.iv,
          passwordAuthTag: envelope.authTag,
          passwordKeyVersion: envelope.keyVersion,
        }
      : {};

    const row = await this.prisma.smtpSettings.upsert({
      where: { id: SMTP_SETTINGS_SINGLETON_ID },
      create: {
        id: SMTP_SETTINGS_SINGLETON_ID,
        ...base,
        ...envelopeData,
      },
      update: {
        ...base,
        // On update, only touch the envelope columns when a new password was provided.
        ...envelopeData,
      },
    });
    return this.toWire(row);
  }

  /**
   * Resolve the in-memory transport config (INTERNAL). Reads the row, requires the minimum to send
   * (host + port + fromAddress), and decrypts the password if one is stored. Returns null when the config
   * is incomplete or (when `requireEnabled`) email is turned off — the caller treats null as "don't send".
   */
  async resolveConfig(
    requireEnabled: boolean,
  ): Promise<ResolvedSmtpConfig | null> {
    const row = await this.prisma.smtpSettings.findFirst({
      where: { id: SMTP_SETTINGS_SINGLETON_ID },
    });
    if (!row) return null;
    if (requireEnabled && !row.enabled) return null;
    if (!row.host || !row.port || !row.fromAddress) return null;

    let password: string | null = null;
    if (
      row.passwordCiphertext &&
      row.passwordIv &&
      row.passwordAuthTag &&
      row.passwordKeyVersion != null
    ) {
      password = decryptSmtpPassword({
        ciphertext: row.passwordCiphertext,
        iv: row.passwordIv,
        authTag: row.passwordAuthTag,
        keyVersion: row.passwordKeyVersion,
      });
    }
    return {
      host: row.host,
      port: row.port,
      security: row.security as ResolvedSmtpConfig['security'],
      username: row.username,
      password,
      fromAddress: row.fromAddress,
      fromName: row.fromName,
      rejectUnauthorized: row.rejectUnauthorized,
    };
  }

  /**
   * Send a REAL one-off test email to `to` using the currently-saved config (email need NOT be enabled —
   * the admin tests before flipping it on). Returns a clean pass/fail; on failure the error is a short,
   * non-secret message (never the password or a raw stack). Runs INLINE so the admin gets immediate
   * feedback (the fork chose a real send over a bare `verify()` — it confirms end-to-end deliverability).
   */
  async sendTest(to: string): Promise<SendTestEmailResult> {
    const config = await this.resolveConfig(false).catch((err) => {
      // A decrypt failure (e.g. SMTP_SECRET_KEY changed) surfaces cleanly, not as a 500.
      this.logger.warn(`SMTP test could not resolve config: ${errText(err)}`);
      return null;
    });
    if (!config) {
      return {
        ok: false,
        error:
          'SMTP is not fully configured. Set host, port and a From address first.',
      };
    }
    try {
      const rendered = renderNotificationEmail({
        title: 'lazyit SMTP test email',
        summary:
          'If you are reading this, your outbound email settings are working.',
        appUrl: process.env.WEB_ORIGIN ?? null,
        brandName: 'lazyit',
      });
      const transporter = buildTransport(config);
      await transporter.sendMail({
        from: formatFrom(config),
        to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  }

  /** Whether a usable SMTP master key is configured (surfaced so the UI can warn before a password write). */
  isSecretKeyConfigured(): boolean {
    return isSmtpSecretKeyConfigured();
  }

  /** Map the Prisma row to the redacted wire shape — drops the password envelope columns entirely. */
  private toWire(row: {
    enabled: boolean;
    host: string | null;
    port: number | null;
    security: string;
    username: string | null;
    passwordCiphertext: string | null;
    fromAddress: string | null;
    fromName: string | null;
    rejectUnauthorized: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): SmtpSettings {
    return {
      enabled: row.enabled,
      host: row.host,
      port: row.port,
      security: row.security as SmtpSettings['security'],
      username: row.username,
      passwordSet: row.passwordCiphertext != null,
      fromAddress: row.fromAddress,
      fromName: row.fromName,
      rejectUnauthorized: row.rejectUnauthorized,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** A short, non-secret error string (message only — never a stack, never the payload). */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
