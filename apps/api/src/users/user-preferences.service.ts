import { Injectable } from '@nestjs/common';
import {
  ThemePreferenceSchema,
  UiLocaleSchema,
  type ThemePreference,
  type UiLocale,
  type UpdateUserPreferences,
  type UserPreferences,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read-tolerant projection of a stored preference (issue #1422): a value outside today's catalog (a
 * retired language, a hand-edited row) reads as `null` = "never chosen" instead of breaking the read.
 * Validation is enforced on WRITE only, by the strict `UpdateUserPreferencesSchema`.
 */
export function toUiLocale(value: string | null | undefined): UiLocale | null {
  const parsed = UiLocaleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toThemePreference(
  value: string | null | undefined,
): ThemePreference | null {
  const parsed = ThemePreferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The caller's per-user UI preferences — language and colour theme (issue #1422). Self-only: the user id
 * always comes from the authenticated principal. The BROWSER's own value wins on the web; these only seed
 * a browser that has no preference of its own, so they follow the user across devices.
 *
 * No UserHistory row is written: a language or theme choice is a personal display setting, not a change
 * to the person record the audit trail describes (the same call as the email opt-outs, issue #879).
 */
@Injectable()
export class UserPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<UserPreferences> {
    const row = await this.prisma.user.findFirstOrThrow({
      where: { id: userId },
      select: { locale: true, theme: true },
    });
    return {
      locale: toUiLocale(row.locale),
      theme: toThemePreference(row.theme),
    };
  }

  /**
   * Partial write: an omitted key is left unchanged, `null` clears it, a value sets it. The body was
   * already validated strict (unknown key or value → 400, empty body → 400).
   */
  async update(
    userId: string,
    data: UpdateUserPreferences,
  ): Promise<UserPreferences> {
    const row = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.locale !== undefined ? { locale: data.locale } : {}),
        ...(data.theme !== undefined ? { theme: data.theme } : {}),
      },
      select: { locale: true, theme: true },
    });
    return {
      locale: toUiLocale(row.locale),
      theme: toThemePreference(row.theme),
    };
  }
}
