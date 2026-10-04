import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Membership } from './entities/membership.entity';
import { Organization } from './entities/organization.entity';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_NAME,
  DEFAULT_ORGANIZATION_SLUG,
  ORGANIZATION_SETTINGS_TTL_MS,
  isMultitenancyEnabled,
} from './tenancy.constants';
import { Session } from '../session/entities/session.entity';
import { mergeOrganizationSettings, OrganizationSettings } from './organization-settings';
import { UpdateOrganizationSettingsDto } from './dto/organization-settings.dto';

/**
 * The one place a request's organization is resolved.
 *
 * Every consumer — metering, and later quota and listing enforcement — resolves through here rather
 * than each reading the flag and falling back itself. That is deliberate: the fallback is a security
 * boundary, and N copies of it is N chances for one of them to be wrong in a way nothing tests.
 *
 * Resolution is deliberately forgiving on input and strict on output:
 *
 * - `MULTITENANCY_ENABLED=false` (the default) resolves EVERYTHING to the default organization, so an
 *   upgraded install behaves exactly as it did before this table existed.
 * - `true` resolves a supplied id, and only falls back to the default when the id is absent — never
 *   when the id is present but unknown. Silently billing an unknown organization to the default
 *   tenant is how one customer's usage ends up on another's invoice.
 */
@Injectable()
export class TenancyService implements OnModuleInit {
  private readonly logger = new Logger(TenancyService.name);

  /**
   * `organizations.settings` by id, memoised for {@link ORGANIZATION_SETTINGS_TTL_MS}.
   *
   * Keyed by organization id and never by session, so one cache entry serves every session of a tenant
   * on this node. `null` is a CACHED value, not a miss: an organization with no settings blob is the
   * common case, and re-querying for it on every send would defeat the cache for exactly the installs
   * that gain nothing from having one.
   */
  private readonly settingsCache = new Map<string, { at: number; settings: Record<string, unknown> | null }>();

  constructor(
    @InjectRepository(Organization, 'main') private readonly organizations: Repository<Organization>,
    @InjectRepository(Membership, 'main') private readonly memberships: Repository<Membership>,
    // The data connection, read for one column: `sessions.organizationId`. This is the ONE place the
    // tenancy module reaches across, and it is here rather than in the send path because the send path
    // should not know that a session is how an organization is found.
    @InjectRepository(Session, 'data') private readonly sessions: Repository<Session>,
  ) {}

  /**
   * The `settings` blob governing a session's organization, or null when there is none.
   *
   * This is what makes a per-organization policy — quiet hours — reachable from the data-connection
   * send path. `Organization` lives on the always-SQLite `main` connection, so reading it from a send
   * means crossing databases; the alternative is not crossing but silently having no per-tenant policy
   * at all, which is the same as not having implemented one.
   *
   * Returns null — not a default window — when the session names no organization, when that
   * organization has no settings, or when the session does not exist. All three mean "no organization
   * policy applies", which is the same answer a deployment that never configured quiet hours gives,
   * and which every consumer must therefore treat as policy-off rather than as an error.
   *
   * Callers on the hot path should prefer passing settings in (see OutboundGuardService) over calling
   * this per message; this exists for the resolution it performs, not to be called in a loop.
   */
  async settingsForSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const session = await this.sessions.findOne({
      where: { id: sessionId },
      select: { organizationId: true },
    });
    // No organization, no policy. A session predating tenancy attribution is not an error to report on
    // every message; it is a session that has no tenant whose rules could apply to it.
    if (!session?.organizationId) return null;

    return this.settingsForOrganization(session.organizationId);
  }

  /** The cached read behind `settingsForSession`, exposed for a caller that already knows the org. */
  async settingsForOrganization(organizationId: string): Promise<Record<string, unknown> | null> {
    const cached = this.settingsCache.get(organizationId);
    const now = Date.now();
    if (cached && now - cached.at < ORGANIZATION_SETTINGS_TTL_MS) return cached.settings;

    const organization = await this.organizations.findOne({
      where: { id: organizationId },
      select: { id: true, settings: true },
    });
    // An unknown organization resolves to no settings rather than to a thrown error: this runs inside
    // the send path, and a settings read must never be the reason a message fails to send.
    const settings = organization?.settings ?? null;
    this.settingsCache.set(organizationId, { at: now, settings });
    return settings;
  }

  /**
   * The organization's settings row, read fresh, for an operator-facing surface.
   *
   * Deliberately NOT `settingsForOrganization`: that one is memoised because it sits on the send
   * path, and an admin form that hydrated from a value up to 30s stale would show the operator a
   * different policy from the one they just saved. A read here is rare and the extra query is the
   * price of the form and the sends agreeing.
   *
   * Throws rather than answering null for an unknown organization: "no settings" and "no such
   * organization" are different answers, and a typo in an id must not read as a tenant that has
   * simply never configured anything.
   */
  async readOrganizationSettings(organizationId: string): Promise<OrganizationSettings> {
    const organization = await this.requireOrganization(organizationId);
    return organization.settings ?? {};
  }

  /**
   * The organization row itself, or a 404.
   *
   * Split out of `readOrganizationSettings` because the write path needs the row to save onto: a
   * settings update is a save of a loaded entity, so "load it" and "it exists" are the same question.
   */
  private async requireOrganization(organizationId: string): Promise<Organization> {
    const organization = await this.organizations.findOne({ where: { id: organizationId } });
    if (!organization) throw new NotFoundException(`Unknown organization: ${organizationId}`);
    return organization;
  }

  /**
   * Merge a PATCH into an organization's settings and persist the result.
   *
   * The three steps in this order are the contract:
   *
   * 1. **Read fresh, not from cache.** Merging onto a memoised copy would silently discard a
   *    hand-edited row that landed inside the TTL.
   * 2. **Validate the merged result**, because only a merged window is a window (see
   *    `mergeOrganizationSettings`).
   * 3. **Invalidate before returning.** The send path reads this through
   *    `settingsForOrganization`, so a write that skipped this would leave sends enforcing the OLD
   *    window for up to 30 seconds after the operator was told it was saved.
   */
  async updateOrganizationSettings(
    organizationId: string,
    patch: UpdateOrganizationSettingsDto,
  ): Promise<OrganizationSettings> {
    // Loaded once and used for both roles — the current settings to merge onto and the row to save
    // onto. Two reads would also be two chances to read DIFFERENT rows if one were deleted between
    // them, which is how a save would resurrect a tenant as a fresh default organization.
    const organization = await this.requireOrganization(organizationId);
    const merged = mergeOrganizationSettings(organization.settings ?? {}, patch);

    // `save` rather than `update`: the JSON column's type is `Record<string, unknown> | null`, which
    // TypeORM's `QueryDeepPartialEntity` cannot express — it maps the column onto an index signature
    // that an ordinary object fails to satisfy, so every shape of `update` either needs a cast on the
    // WHERE clause (which then is no longer a `FindOptionsWhere`) or on the value. Saving the loaded
    // entity side-steps that: the row was read in `readOrganizationSettings`, and `save` writes the
    // column as the declared type.
    await this.organizations.save(this.organizations.create({ ...organization, settings: merged }));
    this.forgetOrganizationSettings(organizationId);
    return merged;
  }

  /**
   * Drop an organization's memoised settings so the next read sees the write.
   *
   * Called by whatever writes `Organization.settings`. Without it a settings change made through the
   * API would take up to the TTL to take effect, which is exactly the sort of "I saved it and it did
   * nothing" that makes an operator turn the feature off and re-enable it twice.
   */
  forgetOrganizationSettings(organizationId?: string | null): void {
    if (organizationId) this.settingsCache.delete(organizationId);
    else this.settingsCache.clear();
  }

  /**
   * Ensure the default organization exists.
   *
   * The migration seeds it, but the main connection runs `synchronize: true` by default
   * (MAIN_DATABASE_SYNCHRONIZE), and synchronize creates tables WITHOUT running the migration — so on
   * the default install the default organization would not exist at all. Boot-time seeding closes
   * that: it is one INSERT OR IGNORE on a fixed primary key, so it is idempotent and safe whether the
   * schema came from synchronize or from the migration.
   *
   * `await`ed, not fire-and-forget: the first request may resolve an organization immediately after
   * boot, and a check-then-insert race between that request and a background seed would let it report
   * the "missing default organization" error on a perfectly healthy install.
   */
  async onModuleInit(): Promise<void> {
    await this.ensureDefaultOrganization();
  }

  /** Whether multi-tenant enforcement is on. The schema exists either way. */
  isEnabled(): boolean {
    return isMultitenancyEnabled();
  }

  /**
   * Create the default organization if it is absent. Never updates an existing row — an operator who
   * renamed or re-planned the default organization must not have that silently reverted on restart.
   */
  async ensureDefaultOrganization(): Promise<void> {
    const existing = await this.organizations.findOne({
      where: { id: DEFAULT_ORGANIZATION_ID },
      select: { id: true },
    });
    if (existing) return;

    await this.organizations.insert({
      id: DEFAULT_ORGANIZATION_ID,
      slug: DEFAULT_ORGANIZATION_SLUG,
      name: DEFAULT_ORGANIZATION_NAME,
      isDefault: true,
      plan: 'community',
      status: 'active',
      settings: null,
      trialEndsAt: null,
    });
    this.logger.log(`Seeded default organization ${DEFAULT_ORGANIZATION_ID}`);
  }

  /**
   * The organization a request without a resolved organization belongs to.
   *
   * Returns the frozen `DEFAULT_ORGANIZATION_ID` constant rather than querying for the `isDefault`
   * row: the constant is what `sessions.organizationId` and `usage_events.organizationId` already hold
   * (written by migration), so trusting it cannot disagree with the rows on disk. The row is still
   * verified to exist, because a database that lost it means every write below is unattributable and
   * that must be loud rather than silent.
   */
  async defaultOrganizationId(): Promise<string> {
    const existing = await this.organizations.findOne({
      where: { id: DEFAULT_ORGANIZATION_ID },
      select: { id: true },
    });
    if (!existing) {
      // Reaching here means the main-connection migration did not run (or the row was deleted by
      // hand). Metering would still write the constant, but an organization the dashboard cannot list
      // is worse than a failed boot, so say exactly what to fix.
      this.logger.error(
        `Default organization ${DEFAULT_ORGANIZATION_ID} is missing. ` +
          `Run the main-connection migrations (npm run migration:run:main) before serving traffic.`,
      );
    }
    return DEFAULT_ORGANIZATION_ID;
  }

  /**
   * Resolve the organization for a unit of work.
   *
   * @param requestedOrganizationId the caller-supplied organization, or null/undefined when the caller
   *   has none (an unauthenticated internal path, or a session row whose organizationId is still NULL).
   * @returns an organization id that is guaranteed to name a row in `organizations`.
   * @throws when enforcement is on and a supplied id names no organization — a caller must not be able
   *   to attribute usage to a tenant that does not exist.
   */
  async resolveOrganizationId(requestedOrganizationId?: string | null): Promise<string> {
    if (!isMultitenancyEnabled()) {
      // Single-tenant: the caller's id is ignored entirely, so a stale or wrong one cannot split a
      // self-hosted install into tenants.
      return this.defaultOrganizationId();
    }

    if (!requestedOrganizationId) {
      // No id supplied even though enforcement is on. Fall back so pre-tenancy callers keep working
      // during the transition, which is the whole point of landing the column before the enforcement.
      return this.defaultOrganizationId();
    }

    const exists = await this.organizations.findOne({
      where: { id: requestedOrganizationId },
      select: { id: true },
    });
    if (!exists) {
      throw new Error(`Unknown organization: ${requestedOrganizationId}`);
    }
    return requestedOrganizationId;
  }

  /** Roles a user holds in an organization. Empty when the user has no membership there. */
  async rolesForUser(organizationId: string, userId: string): Promise<Membership[]> {
    return this.memberships.find({ where: { organizationId, userId } });
  }

  /**
   * Whether the user may act in the organization at all.
   *
   * A membership row is the whole answer — there is no separate "active user" check here, because a
   * user row can be deactivated independently of its memberships. An authorization check that wants
   * "and the user is still active" must ask the users table as well; silently treating "has a
   * membership" as "is an active member" would authorize a deactivated user.
   */
  async isMember(organizationId: string, userId: string): Promise<boolean> {
    return (await this.memberships.countBy({ organizationId, userId })) > 0;
  }
}
