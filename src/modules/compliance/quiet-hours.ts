import { BadRequestException } from '@nestjs/common';

/**
 * Quiet-hours evaluation — pure, dependency-free, and the only place local wall-clock time is derived.
 *
 * Why hand-rolled: the repo has no timezone library (no luxon/date-fns/moment, see package.json) and
 * adding one to decide "is 23:00 in Jakarta" would be a large dependency for one boolean. `Intl` is
 * in every supported Node runtime and carries the IANA database, so `Intl.DateTimeFormat` is both
 * smaller and more accurate than computing an offset by hand.
 *
 * The offset trap this exists to avoid: a fixed UTC offset cannot express a timezone with DST. An
 * operator who sets "no messages between 22:00 and 07:00" for Europe/Lisbon means it in local time,
 * which shifts by an hour twice a year. Storing `+01:00` instead of `Europe/Lisbon` silently sends
 * 22:30 promotional traffic at 22:30 in summer and 21:30 in winter — a compliance window that is
 * wrong for half the year, and wrong in the direction nobody notices.
 */

/** Minutes from midnight. Chosen over `HH:MM` strings so comparison is a plain `<`/`>=`. */
export type MinutesOfDay = number;

export const MINUTES_PER_DAY = 24 * 60;

/** ISO-8601 weekday numbers: Monday = 1 … Sunday = 7 (not 0, which JS `getDay()` uses). */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface QuietHoursWindow {
  /** Local minutes-of-day the window opens, inclusive. */
  startMinutes: MinutesOfDay;
  /** Local minutes-of-day the window closes, exclusive. */
  endMinutes: MinutesOfDay;
  /** IANA zone, e.g. `Europe/Lisbon`. Never a fixed offset — see the file header. */
  timezone: string;
  /** ISO weekdays the window applies on. Omitted means every day. */
  weekdays?: IsoWeekday[];
  /** Exempt from the window entirely (e.g. an incident number). */
  exemptChatIds?: string[];
}

export interface QuietHoursDecision {
  /** True when this send must not go out now. */
  withinQuietHours: boolean;
  /** Human-readable reason, safe to return to an API caller and to log. */
  reason?: string;
  /** Local ISO timestamp the window next opens — when the send may be retried. */
  nextAllowedAt?: Date;
}

/**
 * Minutes elapsed since local midnight in `timezone` at instant `at`.
 *
 * `formatToParts` is used rather than a formatted string so the result is locale-independent: a
 * formatter in a non-Gregorian calendar or an `en-GB` locale must not change the answer, and no
 * parsing of `hh:mm AM` can be got wrong.
 */
export function zonedMinutesOfDay(at: Date, timezone: string): MinutesOfDay {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(at);

  const pick = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  const hour = Number(pick('hour'));
  // `hour: '2-digit', hour12: false` yields 24 rather than 0 at midnight in some ICU versions.
  // Normalising here means every caller can treat 0 and 24 as the same midnight.
  const minute = Number(pick('minute'));
  return (hour % 24) * 60 + minute;
}

/** The ISO weekday (Monday = 1) of `at` in `timezone`. */
export function zonedIsoWeekday(at: Date, timezone: string): IsoWeekday {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).formatToParts(at);
  const names: Record<string, IsoWeekday> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const day = parts.find(p => p.type === 'weekday')?.value ?? '';
  return names[day] ?? 1;
}

/** True when `timezone` is a zone `Intl` can resolve. Rejects `+01:00` and `UTC+1` style offsets. */
export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || timezone.trim() === '') return false;
  // An offset string would resolve fine but is exactly what this module refuses to store: it cannot
  // follow DST. Rejecting it at the edge is better than accepting a value that is silently wrong twice
  // a year.
  if (/^(utc|gmt)?\s*[+-]?\d{1,2}(:?\d{2})?$/i.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `HH:MM` into minutes-of-day. `24:00` is accepted as end-of-day so an operator can write
 * `22:00-24:00` meaning "rest of the evening" without special-casing midnight on the close bound.
 */
export function parseClockTime(value: unknown): MinutesOfDay | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  if (hours === 24 && minutes > 0) return null; // 24:30 is not a time
  const total = hours * 60 + minutes;
  return total >= MINUTES_PER_DAY ? 0 : total;
}

/** Render minutes-of-day back to `HH:MM`, for messages the operator reads. */
export function formatClockTime(minutes: MinutesOfDay): string {
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(normalized / 60);
  return `${String(hours).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

/** Validate an operator-supplied window, throwing a message naming the offending field. */
export function assertValidQuietHours(input: {
  start?: string;
  end?: string;
  timezone?: string;
  weekdays?: unknown;
}): void {
  const start = parseClockTime(input.start);
  if (start === null) {
    throw new BadRequestException(`quietHours.start must be HH:MM (24:00 allowed); got ${JSON.stringify(input.start)}`);
  }
  const end = parseClockTime(input.end);
  if (end === null) {
    throw new BadRequestException(`quietHours.end must be HH:MM (24:00 allowed); got ${JSON.stringify(input.end)}`);
  }
  if (start === end) {
    // Equal bounds are the classic off-by-one: is that "never" or "always"? It reads as "all day" to
    // an operator who set 00:00-00:00 meaning "no restriction". Refusing it makes the ambiguity
    // explicit instead of silently muting or unmuting the account.
    throw new BadRequestException(
      'quietHours start and end are equal, which is ambiguous (never vs always); use a different end or disable quiet hours',
    );
  }
  if (!isValidTimezone(input.timezone)) {
    throw new BadRequestException(
      `quietHours.timezone must be an IANA zone such as "Europe/Lisbon", not a fixed UTC offset; got ${JSON.stringify(input.timezone)}`,
    );
  }
  if (input.weekdays !== undefined) {
    if (!Array.isArray(input.weekdays) || input.weekdays.length === 0) {
      throw new BadRequestException('quietHours.weekdays must be a non-empty array of ISO weekdays (1 = Monday)');
    }
    const bad = input.weekdays.filter(d => !Number.isInteger(d) || (d as number) < 1 || (d as number) > 7);
    if (bad.length) {
      throw new BadRequestException(
        `quietHours.weekdays must be integers 1-7 (Monday = 1); got ${JSON.stringify(bad)}`,
      );
    }
  }
}

/**
 * Whether `at` falls inside the window.
 *
 * The window wraps past midnight when `startMinutes > endMinutes` (the normal 22:00–07:00 case), and
 * that wrap is checked against the PREVIOUS day's weekday for the post-midnight segment — otherwise a
 * Friday-night window would silently stop applying from Saturday 00:00 and stop protecting the very
 * hours it was set for. A weekday-filtered wrapping window is therefore treated as covering the listed
 * weekdays AND the day after each, because 02:00 Saturday belongs to a window that opened Friday
 * 22:00.
 */
export function isWithinQuietHours(window: QuietHoursWindow, at: Date, chatId?: string): QuietHoursDecision {
  const { startMinutes, endMinutes, timezone } = window;

  // An exempt chat is never muted: it is the escape hatch for the account that must stay reachable, and
  // it is checked before any time math so it works even if the window is otherwise misconfigured.
  if (chatId !== undefined && window.exemptChatIds?.includes(chatId)) {
    return { withinQuietHours: false };
  }

  const minutes = zonedMinutesOfDay(at, timezone);
  const weekday = zonedIsoWeekday(at, timezone);
  const wraps = startMinutes > endMinutes;

  const inClockRange = wraps
    ? minutes >= startMinutes || minutes < endMinutes
    : minutes >= startMinutes && minutes < endMinutes;

  // For a wrapping window the post-midnight segment (minutes < endMinutes) belongs to the window that
  // opened the PREVIOUS day.
  const appliesToWeekday = (day: IsoWeekday): boolean => !window.weekdays?.length || window.weekdays.includes(day);

  let weekdayApplies: boolean;
  if (!wraps) {
    weekdayApplies = appliesToWeekday(weekday);
  } else if (minutes >= startMinutes) {
    weekdayApplies = appliesToWeekday(weekday);
  } else {
    const previous: IsoWeekday = weekday === 1 ? 7 : ((weekday - 1) as IsoWeekday);
    weekdayApplies = appliesToWeekday(previous);
  }

  if (!inClockRange || !weekdayApplies) {
    return { withinQuietHours: false };
  }

  return {
    withinQuietHours: true,
    reason: `quiet hours: no outbound messages to this chat between ${formatClockTime(startMinutes)} and ${formatClockTime(endMinutes)} ${timezone}`,
    // Computed rather than approximated: a caller told "after quiet hours" with no time has to poll to
    // find out when it may retry, and a poll is exactly the load a policy switch was meant to shed.
    nextAllowedAt: computeNextAllowedAt(window, at),
  };
}

/**
 * The instant whose LOCAL wall clock in `timezone` is `minutesOfDay` on the local calendar day
 * `localDayOffset` days after `at`'s local day.
 *
 * A local wall-clock time is not a UTC time, and the offset between them depends on the date (DST) —
 * so this resolves by fixed-point iteration rather than arithmetic: guess that the zone offset is
 * zero, ask `Intl` what local time that guess actually is, correct by the difference, and repeat. One
 * extra pass settles the ambiguous hour at a DST transition, where the first correction lands on the
 * wrong side of the jump.
 */
export function zonedInstantAtLocalMinutes(
  at: Date,
  timezone: string,
  minutesOfDay: MinutesOfDay,
  localDayOffset = 0,
): Date {
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);

  const pick = (type: string): number => Number(local.find(p => p.type === type)?.value ?? '0');
  // Build midnight local, on the requested local day, as if it were UTC. `hour % 24` normalises the
  // 24-at-midnight ICU variant the same way zonedMinutesOfDay does.
  const localMidnightAsUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day') + localDayOffset, 0, 0, 0, 0);
  const targetUtcMs = localMidnightAsUtc + minutesOfDay * 60 * 1000;

  let guess = targetUtcMs;
  for (let pass = 0; pass < 2; pass++) {
    const actual = zonedMinutesOfDay(new Date(guess), timezone);
    const drift = (((minutesOfDay - actual) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    guess += drift * 60 * 1000;
  }
  return new Date(guess);
}

/** The first instant at or after `at` that is OUTSIDE the window — i.e. when a refused send may go. */
function computeNextAllowedAt(window: QuietHoursWindow, at: Date): Date | undefined {
  const { startMinutes, endMinutes, timezone } = window;
  const minutes = zonedMinutesOfDay(at, timezone);
  const wraps = startMinutes > endMinutes;
  // Which LOCAL day the closing edge falls on. For a non-wrapping window (09:00-17:00) it is always
  // today. For a wrapping one it is today only when we are in the post-midnight segment (02:00 closes at
  // 07:00 the same day); the evening segment opened yesterday and closes tomorrow.
  const dayOffset = wraps && minutes >= startMinutes ? 1 : 0;

  // Candidate boundaries, soonest first: the window's closing edge if we are already inside it, then its
  // opening edge. Which one is nearer depends on which half of a wrapping window we are in.
  const candidates = [
    { minutes: endMinutes, day: dayOffset },
    { minutes: startMinutes, day: dayOffset },
    { minutes: endMinutes, day: dayOffset + 1 },
    { minutes: startMinutes, day: dayOffset + 1 },
    { minutes: endMinutes, day: dayOffset + 2 },
    { minutes: startMinutes, day: dayOffset + 2 },
  ];

  for (const candidate of candidates) {
    const instant = zonedInstantAtLocalMinutes(at, timezone, candidate.minutes, candidate.day);
    // Strictly future: "now" is already known to be inside the window, and a caller told to retry at the
    // instant it just asked would retry immediately and be refused again.
    if (instant.getTime() <= at.getTime()) continue;
    // Verified against the real evaluator rather than assumed, so a weekday-filtered window whose next
    // boundary is itself muted (a wrapping window that closed into another quiet day) is skipped instead
    // of handing the caller a retry time that gets refused.
    if (!isWithinQuietHours(window, instant).withinQuietHours) return instant;
  }
  return undefined;
}
