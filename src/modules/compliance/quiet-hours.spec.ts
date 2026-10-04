import {
  isWithinQuietHours,
  zonedMinutesOfDay,
  zonedIsoWeekday,
  parseClockTime,
  formatClockTime,
  isValidTimezone,
  assertValidQuietHours,
  QuietHoursWindow,
} from './quiet-hours';
import { BadRequestException } from '@nestjs/common';

/**
 * Fixed instants in `Date`, expressed in UTC. Every expectation is written as "an instant whose LOCAL
 * time in `TZ` is X", because the whole module exists to answer questions about local wall-clock time.
 */
describe('quiet-hours', () => {
  describe('zonedMinutesOfDay', () => {
    it('returns local minutes-of-day for a zone with a non-zero offset', () => {
      // 12:00 UTC is 19:00 in Asia/Jakarta (UTC+7).
      expect(zonedMinutesOfDay(new Date('2026-01-15T12:00:00Z'), 'Asia/Jakarta')).toBe(19 * 60);
      expect(zonedMinutesOfDay(new Date('2026-01-15T12:00:00Z'), 'UTC')).toBe(12 * 60);
      expect(zonedMinutesOfDay(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(7 * 60);
    });

    it('treats midnight as 0, not 24, whichever ICU version produced the hour', () => {
      // Some ICU builds return hour "24" for 00:00 with hour12:false. Every caller would otherwise have
      // to special-case it, and a caller that forgets gets a window that is off by a whole day.
      expect(zonedMinutesOfDay(new Date('2026-01-15T00:00:00Z'), 'UTC')).toBe(0);
      expect(zonedMinutesOfDay(new Date('2026-01-15T17:00:00Z'), 'Asia/Jakarta')).toBe(0); // 17:00Z +7 = 00:00 next day
    });

    it('handles the half-hour and 45-minute zones', () => {
      // Asia/Kolkata is +05:30 and Asia/Kathmandu +05:45; a `hour * 60` shortcut drops both.
      expect(zonedMinutesOfDay(new Date('2026-01-15T12:00:00Z'), 'Asia/Kolkata')).toBe(17 * 60 + 30);
      expect(zonedMinutesOfDay(new Date('2026-01-15T12:00:00Z'), 'Asia/Kathmandu')).toBe(17 * 60 + 45);
    });
  });

  describe('DST — the reason this is not a fixed offset', () => {
    it('follows the zone across a DST transition rather than holding a constant offset', () => {
      const zone = 'Europe/Lisbon'; // UTC+0 in winter, UTC+1 in summer
      const winter = zonedMinutesOfDay(new Date('2026-01-15T12:00:00Z'), zone);
      const summer = zonedMinutesOfDay(new Date('2026-07-15T12:00:00Z'), zone);

      expect(winter).toBe(12 * 60);
      expect(summer).toBe(13 * 60);
      // A stored `+00:00` would report 12:00 both times, making the window wrong for half the year.
      expect(summer).not.toBe(winter);
    });

    it('keeps the window in LOCAL time, so 22:00 local stays 22:00 local either side of DST', () => {
      const window: QuietHoursWindow = { startMinutes: 22 * 60, endMinutes: 7 * 60, timezone: 'Europe/Lisbon' };
      // 21:30 UTC in January = 21:30 local (before the window); in July = 22:30 local (inside it).
      expect(isWithinQuietHours(window, new Date('2026-01-15T21:30:00Z')).withinQuietHours).toBe(false);
      expect(isWithinQuietHours(window, new Date('2026-07-15T21:30:00Z')).withinQuietHours).toBe(true);
    });
  });

  describe('zonedIsoWeekday', () => {
    it('numbers Monday 1 through Sunday 7', () => {
      // 2026-01-12 is a Monday.
      expect(zonedIsoWeekday(new Date('2026-01-12T12:00:00Z'), 'UTC')).toBe(1);
      expect(zonedIsoWeekday(new Date('2026-01-18T12:00:00Z'), 'UTC')).toBe(7);
    });

    it('uses the local day, not the UTC day', () => {
      // 23:00 UTC on Saturday is already Sunday in Jakarta.
      expect(zonedIsoWeekday(new Date('2026-01-17T23:00:00Z'), 'UTC')).toBe(6);
      expect(zonedIsoWeekday(new Date('2026-01-17T23:00:00Z'), 'Asia/Jakarta')).toBe(7);
    });
  });

  describe('isValidTimezone', () => {
    it('accepts IANA zones', () => {
      expect(isValidTimezone('Europe/Lisbon')).toBe(true);
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('America/Argentina/Buenos_Aires')).toBe(true);
    });

    it('REJECTS fixed UTC offsets, which cannot follow DST', () => {
      // These resolve fine in Intl, which is exactly why they must be rejected at the edge: accepting
      // them produces a window that is silently wrong twice a year.
      expect(isValidTimezone('+01:00')).toBe(false);
      expect(isValidTimezone('01:00')).toBe(false);
      expect(isValidTimezone('UTC+1')).toBe(false);
      expect(isValidTimezone('GMT+05:30')).toBe(false);
    });

    it('rejects junk', () => {
      expect(isValidTimezone('')).toBe(false);
      expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
      expect(isValidTimezone(42)).toBe(false);
      expect(isValidTimezone(null)).toBe(false);
    });
  });

  describe('parseClockTime / formatClockTime', () => {
    it('parses HH:MM', () => {
      expect(parseClockTime('00:00')).toBe(0);
      expect(parseClockTime('22:30')).toBe(22 * 60 + 30);
      expect(parseClockTime('23:59')).toBe(23 * 60 + 59);
      expect(parseClockTime('9:05')).toBe(9 * 60 + 5); // single-digit hour is a normal thing to type
      expect(parseClockTime(' 22:00 ')).toBe(22 * 60); // trimmed
    });

    it('treats 24:00 as end-of-day rather than an error', () => {
      expect(parseClockTime('24:00')).toBe(0);
      expect(parseClockTime('24:30')).toBeNull();
    });

    it('rejects malformed and out-of-range values', () => {
      expect(parseClockTime('24')).toBeNull();
      expect(parseClockTime('22:60')).toBeNull();
      expect(parseClockTime('22')).toBeNull();
      expect(parseClockTime('2200')).toBeNull();
      expect(parseClockTime('-1:00')).toBeNull();
      expect(parseClockTime('')).toBeNull();
      expect(parseClockTime(undefined)).toBeNull();
      expect(parseClockTime(22)).toBeNull();
    });

    it('formats back to HH:MM, wrapping past midnight', () => {
      expect(formatClockTime(0)).toBe('00:00');
      expect(formatClockTime(22 * 60 + 30)).toBe('22:30');
      expect(formatClockTime(24 * 60)).toBe('00:00');
    });

    it('round-trips', () => {
      for (const raw of ['00:00', '07:15', '12:00', '22:30']) {
        expect(formatClockTime(parseClockTime(raw)!)).toBe(raw);
      }
    });
  });

  describe('assertValidQuietHours', () => {
    it('accepts a well-formed window', () => {
      expect(() =>
        assertValidQuietHours({ start: '22:00', end: '07:00', timezone: 'Europe/Lisbon', weekdays: [1, 2] }),
      ).not.toThrow();
    });

    it('rejects equal bounds as ambiguous', () => {
      // `00:00-00:00` reads as "no restriction" to an operator who meant it as "all day". Refusing the
      // ambiguity beats picking one and muting (or un-muting) the account.
      expect(() => assertValidQuietHours({ start: '09:00', end: '09:00', timezone: 'UTC' })).toThrow(/ambiguous/i);
    });

    it('rejects a fixed offset and says why', () => {
      expect(() => assertValidQuietHours({ start: '22:00', end: '07:00', timezone: '+01:00' })).toThrow(/IANA/i);
    });

    it('rejects bad weekdays and an empty weekday list', () => {
      expect(() => assertValidQuietHours({ start: '22:00', end: '07:00', timezone: 'UTC', weekdays: [0, 8] })).toThrow(
        /1-7/,
      );
      expect(() => assertValidQuietHours({ start: '22:00', end: '07:00', timezone: 'UTC', weekdays: [] })).toThrow(
        /non-empty/,
      );
    });

    it('names the offending field', () => {
      expect(() => assertValidQuietHours({ start: 'nope', end: '07:00', timezone: 'UTC' })).toThrow(
        /quietHours\.start/,
      );
      expect(() => assertValidQuietHours({ start: '22:00', end: 'nope', timezone: 'UTC' })).toThrow(/quietHours\.end/);
    });
  });

  describe('isWithinQuietHours — a plain daytime window', () => {
    // 09:00-17:00 UTC, every day. Local == UTC here so the instants read plainly.
    const window: QuietHoursWindow = { startMinutes: 9 * 60, endMinutes: 17 * 60, timezone: 'UTC' };

    it('is inside at the opening bound and outside just before it', () => {
      expect(isWithinQuietHours(window, new Date('2026-01-15T09:00:00Z')).withinQuietHours).toBe(true);
      expect(isWithinQuietHours(window, new Date('2026-01-15T08:59:00Z')).withinQuietHours).toBe(false);
    });

    it('is inside up to the closing bound and outside from it', () => {
      expect(isWithinQuietHours(window, new Date('2026-01-15T16:59:00Z')).withinQuietHours).toBe(true);
      expect(isWithinQuietHours(window, new Date('2026-01-15T17:00:00Z')).withinQuietHours).toBe(false);
    });

    it('is outside overnight', () => {
      expect(isWithinQuietHours(window, new Date('2026-01-15T23:00:00Z')).withinQuietHours).toBe(false);
      expect(isWithinQuietHours(window, new Date('2026-01-15T03:00:00Z')).withinQuietHours).toBe(false);
    });
  });

  describe('isWithinQuietHours — a wrapping (overnight) window', () => {
    // The normal 22:00-07:00 case.
    const window: QuietHoursWindow = { startMinutes: 22 * 60, endMinutes: 7 * 60, timezone: 'UTC' };

    it('is inside the evening segment', () => {
      expect(isWithinQuietHours(window, new Date('2026-01-15T22:00:00Z')).withinQuietHours).toBe(true);
      expect(isWithinQuietHours(window, new Date('2026-01-15T23:30:00Z')).withinQuietHours).toBe(true);
    });

    it('is inside the post-midnight segment', () => {
      expect(isWithinQuietHours(window, new Date('2026-01-16T02:00:00Z')).withinQuietHours).toBe(true);
      expect(isWithinQuietHours(window, new Date('2026-01-16T06:59:00Z')).withinQuietHours).toBe(true);
    });

    it('is outside during the day', () => {
      expect(isWithinQuietHours(window, new Date('2026-01-15T12:00:00Z')).withinQuietHours).toBe(false);
      expect(isWithinQuietHours(window, new Date('2026-01-15T07:00:00Z')).withinQuietHours).toBe(false);
      expect(isWithinQuietHours(window, new Date('2026-01-15T21:59:00Z')).withinQuietHours).toBe(false);
    });

    it('covers the whole 24 hours of one day and closes exactly once', () => {
      // A sanity sweep so a sign error cannot hide in a rarely-tested hour.
      let inside = 0;
      for (let h = 0; h < 24; h++) {
        if (isWithinQuietHours(window, new Date(`2026-01-15T${String(h).padStart(2, '0')}:00:00Z`)).withinQuietHours) {
          inside++;
        }
      }
      // 22:00-24:00 is 2 hours, 00:00-07:00 is 7:00, total 9.
      expect(inside).toBe(9);
    });
  });

  describe('weekday filtering', () => {
    // 2026-01-12 is a Monday, so 2026-01-16 is a Friday and 2026-01-17 a Saturday.
    const weekdaysOnly: QuietHoursWindow = {
      startMinutes: 9 * 60,
      endMinutes: 17 * 60,
      timezone: 'UTC',
      weekdays: [1, 2, 3, 4, 5],
    };

    it('applies on a listed weekday', () => {
      expect(isWithinQuietHours(weekdaysOnly, new Date('2026-01-12T10:00:00Z')).withinQuietHours).toBe(true);
    });

    it('does not apply on an unlisted weekday', () => {
      expect(isWithinQuietHours(weekdaysOnly, new Date('2026-01-17T10:00:00Z')).withinQuietHours).toBe(false);
    });

    it('a wrapping weekday window still covers the hours after midnight', () => {
      // THE case that makes naive weekday filtering wrong: a window opened Friday 22:00 is still
      // protecting the contact at 02:00 Saturday, so Saturday-02:00 must be INSIDE even though
      // Saturday (6) is not a listed weekday. Filtering only the current day opens a hole in the
      // middle of the window it was meant to define.
      const fridayNight: QuietHoursWindow = {
        startMinutes: 22 * 60,
        endMinutes: 7 * 60,
        timezone: 'UTC',
        weekdays: [5],
      };
      expect(isWithinQuietHours(fridayNight, new Date('2026-01-16T23:00:00Z')).withinQuietHours).toBe(true); // Friday night
      // Still inside at 03:00 Saturday: the window opened Friday 22:00 and has not closed yet. Treating
      // Saturday as "unlisted, so free" here is the bug — it would send promotional traffic at 03:00 on
      // the exact night the operator asked to protect.
      expect(isWithinQuietHours(fridayNight, new Date('2026-01-17T02:00:00Z')).withinQuietHours).toBe(true);
      expect(isWithinQuietHours(fridayNight, new Date('2026-01-17T06:59:00Z')).withinQuietHours).toBe(true);
      // Saturday evening is the first out-of-window moment: no window has opened since Friday closed.
      expect(isWithinQuietHours(fridayNight, new Date('2026-01-17T22:00:00Z')).withinQuietHours).toBe(false);
    });

    it('the previous-day wrap crosses the Sunday/Monday boundary correctly', () => {
      // Monday 02:00 belongs to a window that opened Sunday 22:00.
      const sundayNight: QuietHoursWindow = {
        startMinutes: 22 * 60,
        endMinutes: 7 * 60,
        timezone: 'UTC',
        weekdays: [7],
      };
      expect(isWithinQuietHours(sundayNight, new Date('2026-01-18T23:00:00Z')).withinQuietHours).toBe(true); // Sunday
      expect(isWithinQuietHours(sundayNight, new Date('2026-01-19T02:00:00Z')).withinQuietHours).toBe(true); // Monday, after midnight
    });

    it('uses the LOCAL weekday, so a zone can shift the day a send falls on', () => {
      // 16:00Z Saturday is already Sunday 00:00 in Jakarta, so a Sunday-only window has NOT opened yet
      // (it opens at 22:00 local); by contrast 17:00Z is Sunday 01:00, past the previous Saturday's window
      // close, so also outside. Both directions matter: filtering on the UTC weekday gets both wrong.
      const sundayOnlyJakarta: QuietHoursWindow = {
        startMinutes: 22 * 60,
        endMinutes: 7 * 60,
        timezone: 'Asia/Jakarta',
        weekdays: [7],
      };
      expect(isWithinQuietHours(sundayOnlyJakarta, new Date('2026-01-17T16:00:00Z')).withinQuietHours).toBe(false);
      // 15:00Z Saturday = 22:00 Saturday Jakarta, which IS the previous Saturday — also unlisted.
      // Take Wednesday UTC 16:00Z = Thursday 00:00 Jakarta with a Thursday-only window to pin the LOCAL
      // weekday directly: it is inside, and no UTC-weekday test would agree.
      const thursdayOnlyJakarta: QuietHoursWindow = {
        startMinutes: 22 * 60,
        endMinutes: 7 * 60,
        timezone: 'Asia/Jakarta',
        weekdays: [4],
      };
      // 2026-01-15 is a Thursday: 14:00Z = 21:00 Thu local (before), 15:00Z = 22:00 Thu local (inside).
      expect(isWithinQuietHours(thursdayOnlyJakarta, new Date('2026-01-15T15:00:00Z')).withinQuietHours).toBe(true);
      expect(isWithinQuietHours(thursdayOnlyJakarta, new Date('2026-01-15T14:00:00Z')).withinQuietHours).toBe(false);
    });
  });

  describe('exempt chats', () => {
    const window: QuietHoursWindow = {
      startMinutes: 22 * 60,
      endMinutes: 7 * 60,
      timezone: 'UTC',
      exemptChatIds: ['15550001111@c.us'],
    };

    it('never mutes an exempt chat', () => {
      expect(isWithinQuietHours(window, new Date('2026-01-15T23:00:00Z'), '15550001111@c.us').withinQuietHours).toBe(
        false,
      );
    });

    it('still mutes everyone else', () => {
      expect(isWithinQuietHours(window, new Date('2026-01-15T23:00:00Z'), '15559999999@c.us').withinQuietHours).toBe(
        true,
      );
    });

    it('mutes everyone when no chat is given', () => {
      expect(isWithinQuietHours(window, new Date('2026-01-15T23:00:00Z')).withinQuietHours).toBe(true);
    });
  });

  describe('the refusal tells the caller when to retry', () => {
    const window: QuietHoursWindow = { startMinutes: 22 * 60, endMinutes: 7 * 60, timezone: 'UTC' };

    it('reports a next-allowed time in the future', () => {
      const at = new Date('2026-01-15T23:00:00Z');
      const decision = isWithinQuietHours(window, at);

      expect(decision.nextAllowedAt).toBeDefined();
      expect(decision.nextAllowedAt!.getTime()).toBeGreaterThan(at.getTime());
    });

    it('points at the morning the same day for an evening refusal', () => {
      expect(isWithinQuietHours(window, new Date('2026-01-15T23:00:00Z')).nextAllowedAt?.toISOString()).toBe(
        '2026-01-16T07:00:00.000Z',
      );
    });

    it('points at the morning close for a post-midnight refusal', () => {
      // 02:00 is inside the window opened at 22:00 the previous evening, so the NEAREST exit is this
      // morning's 07:00 — not tonight's 22:00 reopening, which would tell the caller to wait 20 hours.
      expect(isWithinQuietHours(window, new Date('2026-01-16T02:00:00Z')).nextAllowedAt?.toISOString()).toBe(
        '2026-01-16T07:00:00.000Z',
      );
    });

    it('closes at the same day boundary for a non-wrapping weekday window', () => {
      // Friday 16:00 inside a 09:00-17:00 Mon-Fri window: the window closes at 17:00 the SAME Friday,
      // and Saturday is fully unmuted. Reporting Monday here would tell the caller to wait three days for
      // no reason — a wrong answer that reads as authoritative.
      const weekdays: QuietHoursWindow = {
        startMinutes: 9 * 60,
        endMinutes: 17 * 60,
        timezone: 'UTC',
        weekdays: [1, 2, 3, 4, 5],
      };
      const friday = isWithinQuietHours(weekdays, new Date('2026-01-16T16:00:00Z'));

      expect(friday.withinQuietHours).toBe(true);
      expect(friday.nextAllowedAt?.toISOString()).toBe('2026-01-16T17:00:00.000Z');
    });

    it('gives a reason naming the window and the zone', () => {
      const decision = isWithinQuietHours(window, new Date('2026-01-15T23:00:00Z'));

      expect(decision.reason).toContain('22:00');
      expect(decision.reason).toContain('07:00');
      expect(decision.reason).toContain('UTC');
    });
  });

  it('never throws on a hostile instant', () => {
    const window: QuietHoursWindow = { startMinutes: 0, endMinutes: 1439, timezone: 'UTC' };
    // A zero-window minute is not representable (start === end is refused upstream), but the evaluator
    // must still behave if one is constructed directly.
    expect(() => isWithinQuietHours({ ...window, startMinutes: 0, endMinutes: 1 }, new Date(0))).not.toThrow();
    expect(() => isWithinQuietHours(window, new Date('2026-01-15T00:00:00Z'))).not.toThrow();
  });

  it('throws BadRequestException from the validator, so it maps to a 400 automatically', () => {
    expect(() => assertValidQuietHours({ start: 'x', end: '07:00', timezone: 'UTC' })).toThrow(BadRequestException);
  });
});
