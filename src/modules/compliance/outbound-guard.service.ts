import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Session } from '../session/entities/session.entity';
import { QuietHoursService, QUIET_HOURS } from './quiet-hours.service';
import { SuppressionService, RECIPIENT_SUPPRESSED } from './suppression.service';
import { QuietHoursWindow, QuietHoursDecision } from './quiet-hours';
import { TenancyService } from '../tenancy/tenancy.service';
import { createLogger } from '../../common/services/logger.service';

/** Org settings shape this reads. Only `quietHours` is consulted. */
interface OrgSettings {
  quietHours?: {
    enabled?: boolean;
    start?: string;
    end?: string;
    timezone?: string;
    weekdays?: Array<1 | 2 | 3 | 4 | 5 | 6 | 7>;
    exemptChatIds?: string[];
  };
}

/**
 * Per-session outbound guard: the ONE place the send paths ask "may this go out right now?".
 *
 * Centralised so the two copies of the send gate (MessageSendService and BulkMessageService) cannot drift
 * apart on compliance rules — the bug that produced the forward bypass earlier was exactly two copies
 * reading a DTO differently. Both now ask this service, and adding a fourth control (consent, quiet hours,
 * suppression) does not mean adding a fourth copy of the policy to two files.
 *
 * Order is fixed and deliberate: **suppression, then quiet hours.**
 *
 * - Suppression first because it is about a specific person who said no. Its refusal must not be
 *   reportable as anything else — an opt-out answered with a 409 `QUIET_HOURS` tells the operator to wait
 *   until morning and try again, which is both wrong and, at 23:00, the start of a 9-hour gap in which
 *   nothing happens to a complaint.
 * - Quiet hours second because it is a policy overlay on a permitted send, and its refusal is
 *   retryable.
 *
 * **Neither check defers.** Both REFUSE. See QuietHoursService's header for why nothing is queued.
 */
@Injectable()
export class OutboundGuardService {
  private readonly logger = createLogger(OutboundGuardService.name);

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessions: Repository<Session>,
    private readonly quietHours: QuietHoursService,
    // Required in the app; optional so a unit test can construct the guard without a registry. Absent
    // means the opt-out check is skipped, which is why both send-path services take `SuppressionService`
    // as a required constructor param of their own — the app cannot boot in a state where that is gone.
    @Optional()
    private readonly suppression?: SuppressionService,
    // The organization-settings lookup behind per-tenant policy. Optional so this service still constructs
    // in a unit test with no tenancy wiring; absent, every send sees "no organization policy", which is
    // exactly the state of a deployment that never configured a window.
    @Optional()
    private readonly tenancy?: TenancyService,
  ) {}

  /**
   * Assert this send may go out now, or throw the refusal that says why not.
   *
   * `settings` is an OVERRIDE, not a requirement: pass it when the caller already holds the
   * organization's settings (a preview endpoint, a batch that resolved them once), and pass nothing to
   * have the guard resolve them. Resolution is memoised per organization for
   * {@link ORGANIZATION_SETTINGS_TTL_MS}, so the second send of a campaign costs nothing — which is what
   * makes it safe for this to sit on the per-message path rather than being hoisted out of it.
   */
  async assertSendAllowed(
    sessionId: string,
    chatId: string | undefined,
    settings?: OrgSettings | null,
    at: Date = new Date(),
  ): Promise<void> {
    await this.suppression?.assertNotSuppressed(sessionId, chatId ?? '');
    // Resolved AFTER suppression, not before: an opt-out is refused either way, and there is no reason to
    // spend a cross-connection read explaining a send that was never going to happen.
    const policy = settings === undefined ? await this.resolveSettings(sessionId) : settings;
    this.quietHours.assertWithinQuietHours(policy, chatId, sessionId, at);
  }

  /** The organization's settings for this session, or null when it has no organization policy. */
  private async resolveSettings(sessionId: string): Promise<OrgSettings | null> {
    return (await this.tenancy?.settingsForSession(sessionId)) ?? null;
  }

  /**
   * Evaluate without throwing, for a dry-run or a batch preview.
   *
   * Reports BOTH controls, not just the first that trips, because an operator debugging "why is this
   * contact unreachable" needs to see that a chat is suppressed AND that it is outside quiet hours —
   * fixing only the one the sender happened to hit leaves the other to be discovered mid-campaign.
   */
  async evaluate(
    sessionId: string,
    chatId: string | undefined,
    settings?: OrgSettings | null,
    at: Date = new Date(),
  ): Promise<{ allowed: boolean; suppressed: boolean; quietHours: QuietHoursDecision; codes: string[] }> {
    const suppressed = chatId ? await (this.suppression?.isSuppressed(sessionId, chatId) ?? false) : false;
    const policy = settings === undefined ? await this.resolveSettings(sessionId) : settings;
    const quiet = this.quietHours.evaluate(policy, chatId, at);
    const codes: string[] = [];
    if (suppressed) codes.push(RECIPIENT_SUPPRESSED);
    if (quiet.withinQuietHours) codes.push(QUIET_HOURS);
    return { allowed: codes.length === 0, suppressed, quietHours: quiet, codes };
  }

  /**
   * Whether the session is attributed to an organization, i.e. whether quiet-hours policy applies to it
   * at all.
   *
   * A session with no `organizationId` predates tenancy attribution, so there is no org whose settings
   * could set a window: policy is off for it, exactly as it is for a deployment with quiet hours
   * unconfigured. Returns the settings when the caller's tenancy wiring supplied them.
   *
   * Deliberately does NOT read the Organization row here — that repository is on the always-SQLite `main`
   * connection, and reaching across from a data-connection service on the send path would put a second
   * database back in front of every message, which is the reason the suppression registry lives on `data`
   * in the first place. Callers that hold the tenancy wiring pass settings into `assertSendAllowed`.
   */
  async isAttributed(sessionId: string): Promise<boolean> {
    const session = await this.sessions.findOne({
      where: { id: sessionId },
      select: { organizationId: true },
    });
    return Boolean(session?.organizationId);
  }

  /** The effective window for a settings blob, exposed for a "when may I send?" endpoint. */
  windowFor(settings: OrgSettings | null | undefined): QuietHoursWindow | null {
    return this.quietHours.resolveWindow(settings);
  }
}
