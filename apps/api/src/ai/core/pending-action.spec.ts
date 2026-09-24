import { AI_PREVIEW_WARNING_CODES } from '@lazyit/shared';
import { ForbiddenException } from '@nestjs/common';
import {
  AI_CHANNEL_REFUSED_WARNINGS,
  AI_STEP_UP_WARNINGS,
  assertChannelAllows,
  channelRefusal,
  requiresStepUp,
} from './pending-action';

/**
 * The step-up rule core derives from a preview (tools-and-execution.md §9): the CEO's closed list, plus
 * the ADR-0097 decision 3 amendment (2026-09-24, #1315) — an action on a critical application requires
 * step-up, an outbound-integration change on its own does not.
 */
describe('requiresStepUp', () => {
  const elevated = (...warnings: string[]) => ({
    elevated: true,
    stepUpRequired: false,
    warnings,
  });

  it('is the closed list: the four "Opción 2" codes plus CRITICAL_APPLICATION', () => {
    expect([...AI_STEP_UP_WARNINGS].sort()).toEqual(
      [
        'CREDENTIAL_DELIVERY',
        'CRITICAL_APPLICATION',
        'IDENTITY_CHANGE',
        'PRIVILEGE_GRANT',
        'ROLE_CHANGE',
      ].sort(),
    );
    for (const code of AI_STEP_UP_WARNINGS) {
      expect(AI_PREVIEW_WARNING_CODES).toContain(code);
    }
  });

  it('does not list OUTBOUND_INTEGRATION (CEO: no password unless the application is critical)', () => {
    expect(AI_STEP_UP_WARNINGS).not.toContain('OUTBOUND_INTEGRATION');
  });

  it('a workflow write on a critical application requires step-up though the tool did not ask', () => {
    expect(
      requiresStepUp(elevated('OUTBOUND_INTEGRATION', 'CRITICAL_APPLICATION')),
    ).toBe(true);
    expect(requiresStepUp(elevated('CRITICAL_APPLICATION'))).toBe(true);
  });

  it('an access revoke on a critical application requires step-up', () => {
    expect(
      requiresStepUp(
        elevated('EXTERNAL_DEPROVISIONING', 'CRITICAL_APPLICATION'),
      ),
    ).toBe(true);
  });

  it('an outbound integration on a non-critical application needs no step-up', () => {
    expect(requiresStepUp(elevated('OUTBOUND_INTEGRATION'))).toBe(false);
    expect(
      requiresStepUp(elevated('OUTBOUND_INTEGRATION', 'EXTERNAL_PROVISIONING')),
    ).toBe(false);
  });

  it('a tool may still ask for step-up on its own', () => {
    expect(
      requiresStepUp({
        ...elevated('OUTBOUND_INTEGRATION'),
        stepUpRequired: true,
      }),
    ).toBe(true);
  });

  it('derives step-up from a WRITE-class preview too: an access revoke on a critical app (not escalated)', () => {
    expect(
      // A `write`-class preview that was not escalated to `elevated`.
      requiresStepUp({
        stepUpRequired: false,
        warnings: ['EXTERNAL_DEPROVISIONING', 'CRITICAL_APPLICATION'],
      }),
    ).toBe(true);
  });

  it('a write-class preview without a listed warning needs no step-up', () => {
    expect(
      // A `write`-class preview that was not escalated to `elevated`.
      requiresStepUp({
        stepUpRequired: false,
        warnings: ['EXTERNAL_DEPROVISIONING', 'OUTBOUND_INTEGRATION'],
      }),
    ).toBe(false);
  });
});

/**
 * Per-channel refusal by warning (CEO decision 2026-09-24, #1315: MCP and headless writes on critical
 * applications are refused — "Rechazar").
 */
describe('channel refusal by warning', () => {
  it.each(['MCP', 'HEADLESS'] as const)(
    '%s: refuses a write on a critical application with a 403 that points to the chat',
    (channel) => {
      expect(AI_CHANNEL_REFUSED_WARNINGS[channel]).toEqual([
        'CRITICAL_APPLICATION',
      ]);
      expect(
        channelRefusal(channel, [
          'EXTERNAL_PROVISIONING',
          'CRITICAL_APPLICATION',
        ]),
      ).toBe('CRITICAL_APPLICATION');
      let thrown: unknown;
      try {
        assertChannelAllows(channel, ['CRITICAL_APPLICATION']);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown as ForbiddenException).getStatus()).toBe(403);
      expect((thrown as ForbiddenException).message).toBe(
        'This application is critical; do it from the lazyit chat, where it is confirmed with your password.',
      );
    },
  );

  it.each(['MCP', 'HEADLESS'] as const)(
    '%s: allows a write on a non-critical application, outbound integration included',
    (channel) => {
      expect(
        channelRefusal(channel, [
          'OUTBOUND_INTEGRATION',
          'EXTERNAL_PROVISIONING',
        ]),
      ).toBeUndefined();
      expect(() =>
        assertChannelAllows(channel, ['OUTBOUND_INTEGRATION']),
      ).not.toThrow();
    },
  );

  it('the chat refuses nothing by warning: a critical application goes through step-up there', () => {
    expect(AI_CHANNEL_REFUSED_WARNINGS.CHAT).toEqual([]);
    expect(() =>
      assertChannelAllows('CHAT', ['CRITICAL_APPLICATION']),
    ).not.toThrow();
  });

  it('honours an explicit refusal map (a generic message for a code without one)', () => {
    const refused = { CHAT: [], MCP: [], HEADLESS: ['IRREVERSIBLE'] } as const;
    expect(() =>
      assertChannelAllows('HEADLESS', ['IRREVERSIBLE'], refused),
    ).toThrow(/IRREVERSIBLE.*HEADLESS/);
    expect(() =>
      assertChannelAllows('HEADLESS', ['CRITICAL_APPLICATION'], refused),
    ).not.toThrow();
  });
});
