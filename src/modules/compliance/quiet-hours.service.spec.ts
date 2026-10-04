import { QuietHoursService, QUIET_HOURS } from './quiet-hours.service';
import { HttpException, HttpStatus } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('QuietHoursService', () => {
  const CONTACT = '15551234567@c.us';

  const service = new QuietHoursService();

  /** 23:00 UTC on a Thursday. */
  const NIGHT = new Date('2026-01-15T23:00:00Z');
  const window = { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC' };

  describe('resolveWindow', () => {
    it('returns null when quiet hours are absent', () => {
      expect(new QuietHoursService().resolveWindow(null)).toBeNull();
      expect(new QuietHoursService().resolveWindow({})).toBeNull();
    });

    it('returns null when explicitly disabled', () => {
      expect(new QuietHoursService().resolveWindow({ quietHours: { ...window, enabled: false } })).toBeNull();
    });

    it('compiles a configured window into minutes', () => {
      const resolved = new QuietHoursService().resolveWindow({ quietHours: window });

      expect(resolved).toMatchObject({ startMinutes: 22 * 60, endMinutes: 7 * 60, timezone: 'UTC' });
    });

    it('treats a partial window as OFF rather than muting everything', () => {
      // Half-configured must not mean "quiet forever".
      expect(new QuietHoursService().resolveWindow({ quietHours: { start: '22:00', timezone: 'UTC' } })).toBeNull();
    });

    it('treats an unparseable window as OFF, not as muted', () => {
      // A settings typo that muted a paid account with no log line is the worst failure a policy switch
      // can have. Failing open is deliberate; the alternative silently blocks every outbound message.
      expect(
        new QuietHoursService().resolveWindow({ quietHours: { start: 'nope', end: '07:00', timezone: 'UTC' } }),
      ).toBeNull();
    });

    it('treats equal start and end as OFF rather than picking a meaning', () => {
      expect(
        new QuietHoursService().resolveWindow({ quietHours: { start: '00:00', end: '00:00', timezone: 'UTC' } }),
      ).toBeNull();
    });

    it('drops empty weekday and exempt lists so they read as "no filter"', () => {
      const resolved = new QuietHoursService().resolveWindow({
        quietHours: { ...window, weekdays: [], exemptChatIds: [] },
      });

      expect(resolved?.weekdays).toBeUndefined();
      expect(resolved?.exemptChatIds).toBeUndefined();
    });
  });

  describe('evaluate — no throw', () => {
    it('is inside the window', () => {
      const decision = new QuietHoursService().evaluate({ quietHours: window }, CONTACT, NIGHT);

      expect(decision.withinQuietHours).toBe(true);
    });

    it('is outside when disabled', () => {
      expect(
        new QuietHoursService().evaluate({ quietHours: { ...window, enabled: false } }, CONTACT, NIGHT)
          .withinQuietHours,
      ).toBe(false);
    });
  });

  describe('assertWithinQuietHours', () => {
    it('allows a send outside the window', () => {
      expect(() =>
        service.assertWithinQuietHours({ quietHours: window }, CONTACT, 'sess-1', new Date('2026-01-15T12:00:00Z')),
      ).not.toThrow();
    });

    it('allows everything when quiet hours are off', () => {
      expect(() => service.assertWithinQuietHours(null, CONTACT, 'sess-1', NIGHT)).not.toThrow();
    });

    it('refuses inside the window with a 409 carrying QUIET_HOURS and a retry time', () => {
      let error: unknown;
      try {
        service.assertWithinQuietHours({ quietHours: window }, CONTACT, 'sess-1', NIGHT);
      } catch (thrown) {
        error = thrown;
      }

      expect(error).toBeInstanceOf(HttpException);
      const body = (error as HttpException).getResponse() as {
        statusCode: number;
        code: string;
        nextAllowedAt: string;
      };
      expect(body.statusCode).toBe(HttpStatus.CONFLICT);
      expect(body.code).toBe(QUIET_HOURS);
      // When the caller may retry, so it does not have to poll for it.
      expect(body.nextAllowedAt).toBe('2026-01-16T07:00:00.000Z');
    });

    it('is recognised by the static predicate', () => {
      expect(QuietHoursService.isQuietHoursError(new HttpException({ code: QUIET_HOURS }, 409))).toBe(true);
      expect(QuietHoursService.isQuietHoursError(new HttpException({ code: 'OTHER' }, 409))).toBe(false);
      expect(QuietHoursService.isQuietHoursError(new Error('boom'))).toBe(false);
    });

    it('honours an exempt chat', () => {
      expect(() =>
        service.assertWithinQuietHours(
          { quietHours: { ...window, exemptChatIds: [CONTACT] } },
          CONTACT,
          'sess-1',
          NIGHT,
        ),
      ).not.toThrow();
    });

    it('still mutes a non-exempt chat at the same instant', () => {
      expect(() =>
        service.assertWithinQuietHours(
          { quietHours: { ...window, exemptChatIds: ['someone-else@c.us'] } },
          CONTACT,
          'sess-1',
          NIGHT,
        ),
      ).toThrow(HttpException);
    });
  });

  describe('this service knows only about the clock', () => {
    // Ordering lives in OutboundGuardService, tested there. What matters HERE is the negative: quiet
    // hours must not acquire a second opinion about a contact's opt-out, because a copy of the registry
    // check is a second registry read per send and a second place for the two gates to drift apart.
    it('has no constructor dependencies', () => {
      expect(QuietHoursService.length).toBe(0);
    });

    it('does not import the suppression service at all', () => {
      // Guarded structurally rather than by behaviour: the failure mode (a duplicated registry read, or
      // one copy of the order updated and not the other) is invisible to a behavioural test. Matched on
      // the import statement specifically, so the comment explaining why it is absent still passes.
      const source = readFileSync(join(__dirname, 'quiet-hours.service.ts'), 'utf8');

      expect(source).not.toMatch(/^import .*SuppressionService.*$/m);
      expect(source).not.toContain('suppression.service');
    });

    it('still refuses inside the window with nothing else in play', () => {
      expect(() => service.assertWithinQuietHours({ quietHours: window }, CONTACT, 'sess-1', NIGHT)).toThrow(
        HttpException,
      );
    });
  });

  describe('an unusable timezone falls open, it does not throw', () => {
    it('ignores a zone Intl cannot construct', () => {
      // `new Intl.DateTimeFormat('Mars/Olympus')` throws a RangeError. If that reached the send path it
      // would be a 500, and only for messages sent after someone switched quiet hours ON — a config typo
      // presenting as an outage. A warning plus "not muted" is the honest reading of an unknown zone.
      const spyLogger = jest.spyOn(
        (service as unknown as { logger: { warn: (message: string) => void } }).logger,
        'warn',
      );
      expect(() =>
        service.assertWithinQuietHours(
          { quietHours: { ...window, timezone: 'Mars/Olympus' } },
          CONTACT,
          'sess-1',
          NIGHT,
        ),
      ).not.toThrow();

      expect(spyLogger).toHaveBeenCalledWith(expect.stringContaining('Mars/Olympus'));
    });

    it('ignores a fixed UTC offset, which is not an IANA zone', () => {
      // `+05:30` works in Intl on some runtimes and not others, and it cannot express DST at all. Storing
      // it as a zone name means the same account behaves differently after an ICU update.
      expect(service.resolveWindow({ quietHours: { ...window, timezone: '+05:30' } })).toBeNull();
    });

    it('accepts a real DST zone', () => {
      expect(service.resolveWindow({ quietHours: { ...window, timezone: 'Europe/Lisbon' } })).not.toBeNull();
    });
  });
});
