import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenancyService } from '../tenancy.service';
import { Organization } from '../entities/organization.entity';
import { Membership } from '../entities/membership.entity';
import { User } from '../entities/user.entity';
import { Session } from '../../session/entities/session.entity';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_NAME,
  DEFAULT_ORGANIZATION_SLUG,
  ORGANIZATION_SETTINGS_TTL_MS,
} from '../tenancy.constants';

// `create` is included but the stub is cast wholesale: TypeORM's signature carries a no-argument
// overload that this repo never calls, and an identity stub only needs the one-argument form.
type OrgRepo = Pick<Repository<Organization>, 'findOne' | 'countBy' | 'insert' | 'save' | 'create'>;
type MembershipRepo = Pick<Repository<Membership>, 'find' | 'countBy'>;

/**
 * The default organization's id is a FROZEN constant that both the main-connection migration (which
 * seeds the row) and the data-connection migration (which backfills sessions.organizationId) import.
 * If those three ever disagree, an upgraded install silently meters usage against a tenant that does
 * not exist, and nothing else fails — so the agreement is asserted rather than trusted.
 */
describe('tenancy default organization', () => {
  it('is a stable, recognizable constant', () => {
    expect(DEFAULT_ORGANIZATION_ID).toBe('00000000-0000-4000-8000-000000000001');
  });
});

describe('TenancyService', () => {
  let service: TenancyService;
  let organizations: OrgRepo;
  let memberships: MembershipRepo;
  let sessions: Pick<Repository<Session>, 'findOne'>;

  const orgRow = (id: string): { id: string } => ({ id });

  beforeEach(async () => {
    organizations = {
      findOne: jest.fn(),
      countBy: jest.fn(),
      insert: jest.fn(),
      save: jest.fn(),
      // Identity, like the real repository's: the service spreads a loaded row and expects the same
      // object back, and a stub that invented a new one would hide a save of the wrong entity.
      create: jest.fn((entity: unknown) => entity),
    } as unknown as OrgRepo;
    memberships = { find: jest.fn(), countBy: jest.fn() };
    sessions = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenancyService,
        { provide: getRepositoryToken(Organization, 'main'), useValue: organizations },
        { provide: getRepositoryToken(Membership, 'main'), useValue: memberships },
        { provide: getRepositoryToken(User, 'main'), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Session, 'data'), useValue: sessions },
      ],
    }).compile();

    service = module.get(TenancyService);
  });

  afterEach(() => {
    delete process.env.MULTITENANCY_ENABLED;
  });

  describe('with enforcement off (the default, and every self-hosted install)', () => {
    beforeEach(() => {
      delete process.env.MULTITENANCY_ENABLED;
    });

    it('reports enforcement as off', () => {
      expect(service.isEnabled()).toBe(false);
    });

    it('resolves a request that supplies no organization to the default', async () => {
      (organizations.findOne as jest.Mock).mockResolvedValue(orgRow(DEFAULT_ORGANIZATION_ID));

      await expect(service.resolveOrganizationId(null)).resolves.toBe(DEFAULT_ORGANIZATION_ID);
    });

    it('IGNORES a supplied organization, so a stale id cannot split a single-tenant install', async () => {
      (organizations.findOne as jest.Mock).mockResolvedValue(orgRow(DEFAULT_ORGANIZATION_ID));

      await expect(service.resolveOrganizationId('some-other-org')).resolves.toBe(DEFAULT_ORGANIZATION_ID);
      // The caller's id is never looked up: there is nothing to validate if it is going to be ignored.
      expect(organizations.findOne).toHaveBeenCalledTimes(1);
      expect(organizations.findOne).toHaveBeenCalledWith({
        where: { id: DEFAULT_ORGANIZATION_ID },
        select: { id: true },
      });
    });

    it('does not throw for an unknown organization — enforcement is what makes that an error', async () => {
      (organizations.findOne as jest.Mock).mockResolvedValue(orgRow(DEFAULT_ORGANIZATION_ID));

      await expect(service.resolveOrganizationId('nope')).resolves.toBe(DEFAULT_ORGANIZATION_ID);
    });
  });

  describe('with enforcement on', () => {
    beforeEach(() => {
      process.env.MULTITENANCY_ENABLED = 'true';
    });

    it('reports enforcement as on', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('resolves a known organization to itself', async () => {
      (organizations.findOne as jest.Mock).mockResolvedValue(orgRow('org-1'));

      await expect(service.resolveOrganizationId('org-1')).resolves.toBe('org-1');
      expect(organizations.findOne).toHaveBeenCalledWith({ where: { id: 'org-1' }, select: { id: true } });
    });

    it('THROWS on an unknown organization rather than billing it to the default tenant', async () => {
      // The whole reason resolution is strict about output: silently falling back here would put one
      // customer's usage on another's invoice, with nothing in the request path to report it.
      (organizations.findOne as jest.Mock).mockResolvedValue(undefined);

      await expect(service.resolveOrganizationId('ghost-org')).rejects.toThrow(/Unknown organization/);
    });

    it('falls back to the default only when NO id was supplied, so pre-tenancy callers keep working', async () => {
      (organizations.findOne as jest.Mock).mockResolvedValue(orgRow(DEFAULT_ORGANIZATION_ID));

      await expect(service.resolveOrganizationId(undefined)).resolves.toBe(DEFAULT_ORGANIZATION_ID);
    });
  });

  describe('ensureDefaultOrganization', () => {
    it('seeds the default organization at the frozen id when it is missing', async () => {
      // The main connection defaults to synchronize:true, which creates tables WITHOUT running the
      // migration that seeds this row. Boot seeding is what makes the default install work.
      (organizations.findOne as jest.Mock).mockResolvedValue(undefined);
      (organizations.insert as jest.Mock).mockResolvedValue({ identifiers: [], generatedMaps: [], raw: [] });

      await service.ensureDefaultOrganization();

      expect(organizations.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: DEFAULT_ORGANIZATION_ID,
          slug: DEFAULT_ORGANIZATION_SLUG,
          name: DEFAULT_ORGANIZATION_NAME,
          isDefault: true,
          // Never a paid tier on a fresh install.
          plan: 'community',
        }),
      );
    });

    it('never overwrites an existing default organization', async () => {
      // An operator who renamed or re-planned it must not have that reverted on every restart.
      (organizations.findOne as jest.Mock).mockResolvedValue(orgRow(DEFAULT_ORGANIZATION_ID));

      await service.ensureDefaultOrganization();

      expect(organizations.insert).not.toHaveBeenCalled();
    });

    it('runs on boot', async () => {
      (organizations.findOne as jest.Mock).mockResolvedValue(orgRow(DEFAULT_ORGANIZATION_ID));

      await service.onModuleInit();

      expect(organizations.findOne).toHaveBeenCalled();
    });
  });

  describe('defaultOrganizationId', () => {
    it('returns the frozen constant even when the seeded row is missing', async () => {
      // Deliberate: refusing to return would break every write path, and a loud log is the signal. If
      // this threw instead, an install whose migration has not run would fail to start rather than
      // start unattributable — but it would also fail to run the migration that fixes it.
      (organizations.findOne as jest.Mock).mockResolvedValue(undefined);

      await expect(service.defaultOrganizationId()).resolves.toBe(DEFAULT_ORGANIZATION_ID);
      expect(organizations.findOne).toHaveBeenCalledWith({
        where: { id: DEFAULT_ORGANIZATION_ID },
        select: { id: true },
      });
    });
  });

  describe('memberships', () => {
    it('treats a membership row as membership and its absence as not a member', async () => {
      (memberships.countBy as jest.Mock).mockResolvedValue(1);
      await expect(service.isMember('org-1', 'user-1')).resolves.toBe(true);

      (memberships.countBy as jest.Mock).mockResolvedValue(0);
      await expect(service.isMember('org-1', 'user-2')).resolves.toBe(false);
    });

    it('scopes a membership lookup to one organization, so membership in another does not leak', async () => {
      (memberships.countBy as jest.Mock).mockResolvedValue(0);

      await expect(service.isMember('org-1', 'user-1')).resolves.toBe(false);
      expect(memberships.countBy).toHaveBeenCalledWith({ organizationId: 'org-1', userId: 'user-1' });
    });

    it('returns the roles a user holds', async () => {
      const rows = [{ role: 'owner' }] as Membership[];
      (memberships.find as jest.Mock).mockResolvedValue(rows);

      await expect(service.rolesForUser('org-1', 'user-1')).resolves.toBe(rows);
      expect(memberships.find).toHaveBeenCalledWith({ where: { organizationId: 'org-1', userId: 'user-1' } });
    });
  });
  /**
   * Per-organization policy resolution — the lookup that makes quiet hours reachable from the data-
   * connection send path.
   *
   * The bias in every case below is toward returning `null`. This runs INSIDE the send path, so a
   * settings read must never be the reason a message fails to send; the controls that are allowed to
   * refuse a send are the compliance ones, deliberately, and a lookup is not one of them.
   */
  describe('settingsForSession — per-organization policy', () => {
    const quietHours = { quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC' } };

    beforeEach(() => {
      (sessions.findOne as jest.Mock).mockResolvedValue({ organizationId: 'org-1' });
      (organizations.findOne as jest.Mock).mockResolvedValue({ id: 'org-1', settings: quietHours });
    });

    it('returns the organization settings through the session', async () => {
      await expect(service.settingsForSession('sess-1')).resolves.toEqual(quietHours);
    });

    it("reads only the session's organizationId, not the whole session", async () => {
      // The session row carries engine credentials on some paths; asking for one column means a future
      // column added to it cannot leak into this read by accident.
      await service.settingsForSession('sess-1');

      expect(sessions.findOne).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        select: { organizationId: true },
      });
    });

    it('returns null for a session that predates tenancy attribution', async () => {
      // Not an error: a session with no organization has no tenant whose rules could apply to it, and
      // reporting one per outbound message would turn a normal upgrade into a wall of noise.
      (sessions.findOne as jest.Mock).mockResolvedValue({ organizationId: null });

      await expect(service.settingsForSession('sess-1')).resolves.toBeNull();
      expect(organizations.findOne).not.toHaveBeenCalled();
    });

    it('returns null for a session that does not exist', async () => {
      (sessions.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.settingsForSession('nope')).resolves.toBeNull();
    });

    it('returns null for an organization with no settings blob', async () => {
      (organizations.findOne as jest.Mock).mockResolvedValue({ id: 'org-1', settings: null });

      await expect(service.settingsForSession('sess-1')).resolves.toBeNull();
    });

    it('returns null, not a throw, for an organization that no longer exists', async () => {
      // The session still names it (a stale attribution, or a row deleted out from under us). Throwing
      // here would fail every send from that session for a reason the operator cannot see from the send.
      (organizations.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.settingsForSession('sess-1')).resolves.toBeNull();
    });

    it('reads the organization once and reuses it for every session of that tenant', async () => {
      // The reason this is on the send path at all: a campaign is many messages to one tenant, and each
      // of them would otherwise cost a second cross-connection read for an identical answer.
      await service.settingsForSession('sess-1');
      await service.settingsForSession('sess-2');

      expect(organizations.findOne).toHaveBeenCalledTimes(1);
      expect(sessions.findOne).toHaveBeenCalledTimes(2);
    });

    it('re-reads after the TTL, so a policy change is not permanent', async () => {
      // The whole risk of an unbounded cache: a quiet-hours window turned on would never take effect on
      // the node that cached the old settings, and the operator would have no way to see why.
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000);
      await service.settingsForSession('sess-1');

      now.mockReturnValue(1_000 + ORGANIZATION_SETTINGS_TTL_MS + 1);
      await service.settingsForSession('sess-1');

      expect(organizations.findOne).toHaveBeenCalledTimes(2);
      now.mockRestore();
    });

    it('caches a null settings blob too', async () => {
      // Re-querying for the absent case would defeat the cache for exactly the installs that have no
      // quiet hours configured, which is most of them.
      (organizations.findOne as jest.Mock).mockResolvedValue({ id: 'org-1', settings: null });

      await service.settingsForSession('sess-1');
      await service.settingsForSession('sess-1');

      expect(organizations.findOne).toHaveBeenCalledTimes(1);
    });

    it('keeps tenants separate', async () => {
      // One tenant\'s window must never answer for another\'s: a cache keyed by session rather than by
      // organization is how that bug happens.
      (sessions.findOne as jest.Mock)
        .mockResolvedValueOnce({ organizationId: 'org-1' })
        .mockResolvedValueOnce({ organizationId: 'org-2' });

      await service.settingsForSession('sess-1');
      await service.settingsForSession('sess-2');

      expect(organizations.findOne).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { id: 'org-1' } }));
      expect(organizations.findOne).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { id: 'org-2' } }));
    });

    it('does not cache an unattributed session', async () => {
      // Nothing was read, so there is nothing to memoise — but the negative answer must not be pinned
      // either, or a session that is attributed later keeps reading as unattributed.
      (sessions.findOne as jest.Mock)
        .mockResolvedValueOnce({ organizationId: null })
        .mockResolvedValueOnce({ organizationId: 'org-1' });

      await expect(service.settingsForSession('sess-1')).resolves.toBeNull();
      await expect(service.settingsForSession('sess-1')).resolves.toEqual(quietHours);
    });
  });

  describe('forgetOrganizationSettings — the API path bypasses the TTL', () => {
    beforeEach(() => {
      (sessions.findOne as jest.Mock).mockResolvedValue({ organizationId: 'org-1' });
      (organizations.findOne as jest.Mock).mockResolvedValue({ id: 'org-1', settings: { quietHours: {} } });
    });

    it('sees a write immediately', async () => {
      // Without this, "I saved the quiet-hours window and nothing changed" is the exact report this
      // endpoint would generate, and the operator's response to it is to toggle it twice.
      await service.settingsForSession('sess-1');
      (organizations.findOne as jest.Mock).mockResolvedValue({
        id: 'org-1',
        settings: { quietHours: { enabled: true } },
      });

      service.forgetOrganizationSettings('org-1');

      await expect(service.settingsForSession('sess-1')).resolves.toEqual({ quietHours: { enabled: true } });
    });

    it('drops only the named organization', async () => {
      await service.settingsForOrganization('org-1');
      await service.settingsForOrganization('org-2');

      service.forgetOrganizationSettings('org-1');

      await service.settingsForOrganization('org-1');
      await service.settingsForOrganization('org-2');

      expect(organizations.findOne).toHaveBeenCalledTimes(3);
    });

    it('clears everything when given no organization', async () => {
      await service.settingsForOrganization('org-1');
      await service.settingsForOrganization('org-2');

      service.forgetOrganizationSettings();

      await service.settingsForOrganization('org-1');

      expect(organizations.findOne).toHaveBeenCalledTimes(3);
    });
  });
  /**
   * The settings WRITE path — the other half of what makes a window configurable rather than set in SQL.
   */
  describe('updateOrganizationSettings — the settings write path', () => {
    const window = { start: '22:00', end: '07:00', timezone: 'Europe/Lisbon' };

    beforeEach(() => {
      (sessions.findOne as jest.Mock).mockResolvedValue({ organizationId: 'org-1' });
      (organizations.findOne as jest.Mock).mockResolvedValue({ id: 'org-1', settings: { quietHours: window } });
    });

    it('persists the merged settings', async () => {
      const merged = await service.updateOrganizationSettings('org-1', { quietHours: { enabled: true } });

      expect(merged).toEqual({ quietHours: { ...window, enabled: true } });
      expect(organizations.save).toHaveBeenCalledWith(expect.objectContaining({ settings: merged }));
    });

    it('invalidates the memoised settings so sends see it at once', async () => {
      // The bug this prevents is the one an operator reports as "I saved it and nothing changed": the
      // send path reads through a 30s cache, and nothing else here would ever drop it.
      (organizations.findOne as jest.Mock).mockResolvedValue({ id: 'org-1', settings: { quietHours: window } });
      await service.settingsForSession('sess-1');
      expect(organizations.findOne).toHaveBeenCalledTimes(1);

      await service.updateOrganizationSettings('org-1', { quietHours: { start: '01:00' } });
      const afterWrite = (organizations.findOne as jest.Mock).mock.calls.length;
      await service.settingsForSession('sess-1');

      // Counted from AFTER the write, because the write reads the row itself — what matters is that the
      // NEXT read went back to the database instead of answering from the entry the write should have
      // dropped.
      expect((organizations.findOne as jest.Mock).mock.calls.length).toBe(afterWrite + 1);
    });

    it('reads fresh rather than merging onto the cached copy', async () => {
      // Merging onto a memoised value silently discards anything written inside the TTL by any other
      // path — which is exactly what an operator hand-editing the row does.
      (organizations.findOne as jest.Mock).mockResolvedValue({ id: 'org-1', settings: { quietHours: window } });
      await service.settingsForSession('sess-1');

      (organizations.findOne as jest.Mock).mockResolvedValue({
        id: 'org-1',
        settings: { quietHours: { ...window, start: '23:30' } },
      });
      const merged = await service.updateOrganizationSettings('org-1', { quietHours: { end: '08:00' } });

      expect(merged['quietHours']).toEqual({ start: '23:30', end: '08:00', timezone: 'Europe/Lisbon' });
    });

    it('writes nothing when the merged window is unusable', async () => {
      // The save must not happen before the refusal, or a rejected window would still be persisted and
      // the 400 would be a lie.
      await expect(
        service.updateOrganizationSettings('org-1', { quietHours: { end: '22:00' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(organizations.save).not.toHaveBeenCalled();
    });

    it('refuses an organization that does not exist', async () => {
      (organizations.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.updateOrganizationSettings('nope', { quietHours: {} })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(organizations.save).not.toHaveBeenCalled();
    });

    it('writes a window onto an organization that has none', async () => {
      (organizations.findOne as jest.Mock).mockResolvedValue({ id: 'org-1', settings: null });

      const merged = await service.updateOrganizationSettings('org-1', {
        quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' },
      });

      expect(merged).toEqual({ quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' } });
    });

    it('preserves a key written by a feature this service knows nothing about', async () => {
      (organizations.findOne as jest.Mock).mockResolvedValue({
        id: 'org-1',
        settings: { quietHours: window, retentionDays: 90 },
      });

      const merged = await service.updateOrganizationSettings('org-1', { quietHours: { enabled: true } });

      expect(merged['retentionDays']).toBe(90);
    });
  });

  describe('readOrganizationSettings — the operator-facing read', () => {
    it('does not answer from the send path cache', async () => {
      // A form that hydrates from a value up to 30s stale shows the operator a different policy from the
      // one sends are enforcing, and the difference is invisible until a send is refused.
      (sessions.findOne as jest.Mock).mockResolvedValue({ organizationId: 'org-1' });
      (organizations.findOne as jest.Mock).mockResolvedValue({
        id: 'org-1',
        settings: { quietHours: { start: '22:00' } },
      });
      await service.settingsForSession('sess-1');

      (organizations.findOne as jest.Mock).mockResolvedValue({
        id: 'org-1',
        settings: { quietHours: { start: '01:00' } },
      });

      await expect(service.readOrganizationSettings('org-1')).resolves.toEqual({ quietHours: { start: '01:00' } });
    });

    it('reports an unknown organization as missing rather than as empty settings', async () => {
      // "No settings" and "no such organization" are different answers, and a typo in an id must not
      // read as a tenant that simply never configured anything.
      (organizations.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.readOrganizationSettings('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
