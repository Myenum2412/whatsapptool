import { Injectable, HttpStatus, HttpException } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import {
  QuietHoursWindow,
  QuietHoursDecision,
  IsoWeekday,
  assertValidQuietHours,
  isValidTimezone,
  isWithinQuietHours,
  parseClockTime,
} from './quiet-hours';

/** Body code on a quiet-hours refusal, so a caller can tell it from a suppression refusal. */
export const QUIET_HOURS = 'QUIET_HOURS';

/** The org-settings shape this reads. Only these keys are consulted; anything else is left alone. */
interface ComplianceSettings {
  quietHours?: {
    enabled?: boolean;
    /** `HH:MM`. */
    start?: string;
    /** `HH:MM`. `24:00` allowed. */
    end?: string;
    /** IANA zone, e.g. `Europe/Lisbon`. */
    timezone?: string;
    /** ISO weekdays, Monday = 1. Omitted means every day. */
    weekdays?: IsoWeekday[];
    exemptChatIds?: string[];
  };
}

/**
 * Quiet hours: the policy half of compliance, as opposed to suppression's per-contact half.
 *
 * Suppression answers "may we ever contact this chat"; quiet hours answers "may we contact anyone
 * right now". They are separate because they have different scopes and different remedies — one is
 * about a specific person who said no, the other about a time of day — and a single "blocked" flag
 * cannot express either without losing the distinction.
 *
 * **The window is enforced, not deferred.** A send inside quiet hours is REFUSED, not queued. The
 * caller is told when the window opens so it can decide; the gateway does not hold a message, because
 * holding it means a send issued at 23:00 arrives at 07:05 the next morning, and "deliver later"
 * silently changes the consent basis the send was made under (a price quoted at 23:00 is often stale
 * at 07:00). Refusing makes the operator's policy the visible one.
 *
 * Settings come from the organization's own row rather than process env, because a quiet-hours window
 * is a per-tenant business decision and env is per-process — with two tenants on one gateway, env
 * would apply one tenant's window to the other.
 */
@Injectable()
export class QuietHoursService {
  private readonly logger = createLogger(QuietHoursService.name);

  // No dependencies, and deliberately so: this service knows about the CLOCK and nothing else.
  //
  // An earlier draft took `SuppressionService` and checked the registry itself, so that "suppression
  // first" could be guaranteed here. That was the wrong home for the ordering. The send path asks
  // `OutboundGuardService`, which already runs both checks in the right order, so a copy here would be
  // a SECOND registry read on every send and a second place to keep the two checks in step. Ordering
  // lives in exactly one file; this one is a pure time-window policy.

  /**
   * The effective window for a settings blob, or null when quiet hours are off or unset.
   *
   * "Off" is the default everywhere. A window is not inferred from a missing `enabled` flag, and an
   * unparseable window is treated as off rather than as "quiet forever": a settings typo that muted an
   * account with no log line is the worst possible failure for a policy switch, so it warns loudly and
   * falls open. Falling open is a deliberate choice here — the alternative is a bad config silently
   * blocking every outbound message on a paid account.
   */
  resolveWindow(settings: ComplianceSettings | null | undefined): QuietHoursWindow | null {
    const raw = settings?.quietHours;
    if (!raw || raw.enabled === false) return null;
    if (!raw.start || !raw.end || !raw.timezone) return null;

    const startMinutes = parseClockTime(raw.start);
    const endMinutes = parseClockTime(raw.end);
    if (startMinutes === null || endMinutes === null) {
      this.logger.warn(
        `Ignoring quietHours: unparseable window ${JSON.stringify(raw.start)}-${JSON.stringify(raw.end)}; outbound is NOT muted`,
      );
      return null;
    }
    if (!isValidTimezone(raw.timezone)) {
      // Checked HERE rather than left to Intl. Every `new Intl.DateTimeFormat(zone)` throws a RangeError
      // on an unusable zone, so a typo here would surface as an unhandled 500 rather than a refusal.
      // Worse, it would surface only for some sends: the window is compiled once but evaluated per
      // message, so an account with quiet hours switched OFF would keep working until someone turned it
      // on and every send started throwing. A config mistake should look like a config mistake.
      this.logger.warn(
        `Ignoring quietHours: ${JSON.stringify(raw.timezone)} is not an IANA timezone; outbound is NOT muted`,
      );
      return null;
    }
    if (startMinutes === endMinutes) {
      this.logger.warn(
        `Ignoring quietHours: start equals end (${raw.start}); refusing the ambiguous window rather than muting or unmuting the account`,
      );
      return null;
    }
    return {
      startMinutes,
      endMinutes,
      timezone: raw.timezone,
      weekdays: raw.weekdays?.length ? raw.weekdays : undefined,
      exemptChatIds: raw.exemptChatIds?.length ? raw.exemptChatIds : undefined,
    };
  }

  /** Evaluate the window without throwing — for a dry-run endpoint or a batch preview. */
  evaluate(settings: ComplianceSettings | null | undefined, chatId: string | undefined, at: Date): QuietHoursDecision {
    const window = this.resolveWindow(settings);
    if (!window) return { withinQuietHours: false };
    return isWithinQuietHours(window, at, chatId);
  }

  /**
   * Refuse a send inside quiet hours; return normally otherwise.
   *
   * Only the window is consulted. Callers that also need the opt-out check must use
   * `OutboundGuardService.assertSendAllowed`, which runs suppression BEFORE this, so an opt-out is never
   * reported as a timing problem that quietly resolves itself in the morning.
   */
  assertWithinQuietHours(
    settings: ComplianceSettings | null | undefined,
    chatId: string | undefined,
    sessionId: string,
    at: Date = new Date(),
  ): void {
    const window = this.resolveWindow(settings);
    if (!window) return;

    const decision = isWithinQuietHours(window, at, chatId);
    if (!decision.withinQuietHours) return;

    this.logger.warn(`Refusing send to ${chatId} on session ${sessionId}: ${decision.reason}`);
    throw new HttpException(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: decision.reason,
        code: QUIET_HOURS,
        // When the caller may retry, so it does not have to guess or poll.
        nextAllowedAt: decision.nextAllowedAt?.toISOString(),
      },
      HttpStatus.CONFLICT,
    );
  }

  /** True for the 409 `assertWithinQuietHours` throws. Mirrors `isRecipientSuppressedError`. */
  static isQuietHoursError(error: unknown): boolean {
    if (!(error instanceof HttpException)) return false;
    const body = error.getResponse();
    return typeof body === 'object' && body !== null && (body as { code?: string }).code === QUIET_HOURS;
  }
}

export { assertValidQuietHours };
