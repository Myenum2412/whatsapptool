import { DataSource } from 'typeorm';
import { HttpException, HttpStatus } from '@nestjs/common';
import { OutboundGuardService } from './outbound-guard.service';
import { QuietHoursService } from './quiet-hours.service';
import { SuppressionService, RECIPIENT_SUPPRESSED } from './suppression.service';
import { Session } from '../session/entities/session.entity';
import { TenancyService } from '../tenancy/tenancy.service';

describe('OutboundGuardService', () => {
  let ds: DataSource;
  let guard: OutboundGuardService;
  let suppression: { assertNotSuppressed: jest.Mock; isSuppressed: jest.Mock };
  let quietHours: QuietHoursService;
  let tenancy: { settingsForSession: jest.Mock };

  const CONTACT = '15551234567@c.us';
  const NIGHT = new Date('2026-01-15T23:00:00Z');
  const DAY = new Date('2026-01-15T12:00:00Z');
  const window = { quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC' } };

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Session], synchronize: true });
    await ds.initialize();
    suppression = {
      assertNotSuppressed: jest.fn().mockResolvedValue(undefined),
      isSuppressed: jest.fn().mockResolvedValue(false),
    };
    quietHours = new QuietHoursService();
    tenancy = { settingsForSession: jest.fn().mockResolvedValue(null) };
    guard = new OutboundGuardService(
      ds.getRepository(Session),
      quietHours,
      suppression as unknown as SuppressionService,
      tenancy as unknown as TenancyService,
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const suppressionError = (): HttpException =>
    new HttpException(
      { statusCode: HttpStatus.CONFLICT, error: 'Conflict', code: RECIPIENT_SUPPRESSED },
      HttpStatus.CONFLICT,
    );

  describe('ordering — suppression before quiet hours', () => {
    it('lets a suppression refusal through untouched', async () => {
      // If quiet hours refused first, an opt-out would be reported as a timing problem and the operator
      // would be told to retry in the morning — which is not just wrong, it leaves a complaint
      // unanswered for nine hours.
      const error = suppressionError();
      suppression.assertNotSuppressed.mockRejectedValue(error);

      const caught = await guard.assertSendAllowed('sess-1', CONTACT, window, NIGHT).catch((e: unknown) => e);

      expect(caught).toBe(error);
      expect((caught as HttpException).getResponse()).toMatchObject({ code: RECIPIENT_SUPPRESSED });
    });

    it('does not even evaluate quiet hours once suppression has refused', async () => {
      suppression.assertNotSuppressed.mockRejectedValue(suppressionError());
      const spy = jest.spyOn(quietHours, 'assertWithinQuietHours');

      await guard.assertSendAllowed('sess-1', CONTACT, window, NIGHT).catch(() => undefined);

      expect(spy).not.toHaveBeenCalled();
    });

    it('reports the QUIET_HOURS code when only the window trips', async () => {
      const caught = await guard.assertSendAllowed('sess-1', CONTACT, window, NIGHT).catch((e: unknown) => e);

      expect((caught as HttpException).getResponse()).toMatchObject({ code: 'QUIET_HOURS' });
    });
  });

  describe('allowing', () => {
    it('allows when nothing is configured', async () => {
      await expect(guard.assertSendAllowed('sess-1', CONTACT, null, NIGHT)).resolves.toBeUndefined();
    });

    it('allows outside the window', async () => {
      await expect(guard.assertSendAllowed('sess-1', CONTACT, window, DAY)).resolves.toBeUndefined();
    });

    it('still consults suppression when the clock says yes', async () => {
      // The registry is the per-contact gate; the clock must never short-circuit it.
      await guard.assertSendAllowed('sess-1', CONTACT, window, DAY);

      expect(suppression.assertNotSuppressed).toHaveBeenCalledWith('sess-1', CONTACT);
    });

    it('works with no suppression registry wired', async () => {
      const bare = new OutboundGuardService(ds.getRepository(Session), quietHours);

      await expect(bare.assertSendAllowed('sess-1', CONTACT, window, NIGHT)).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe("resolving the organization's policy", () => {
    it('looks the settings up when the caller supplies none', async () => {
      // This is what makes quiet hours reachable at all: the send path has no organization, only a
      // session, so "pass nothing" has to mean "resolve it" rather than "there is no policy".
      tenancy.settingsForSession.mockResolvedValue(window);

      await expect(guard.assertSendAllowed('sess-1', CONTACT, undefined, NIGHT)).rejects.toBeInstanceOf(HttpException);
      expect(tenancy.settingsForSession).toHaveBeenCalledWith('sess-1');
    });

    it('prefers an explicit override over the lookup', async () => {
      // A preview endpoint or a batch that already resolved its tenant must not pay for a second read,
      // and must not be overruled by whatever is cached.
      tenancy.settingsForSession.mockResolvedValue({ quietHours: { ...window.quietHours, enabled: false } });

      await expect(guard.assertSendAllowed('sess-1', CONTACT, window, NIGHT)).rejects.toBeInstanceOf(HttpException);
      expect(tenancy.settingsForSession).not.toHaveBeenCalled();
    });

    it('treats an explicit null as "no policy", not as "look it up"', async () => {
      // `undefined` means "resolve it"; `null` means "I looked, there is nothing". Collapsing them
      // would make a caller that deliberately suppresses policy resolution unable to say so.
      await expect(guard.assertSendAllowed('sess-1', CONTACT, null, NIGHT)).resolves.toBeUndefined();
      expect(tenancy.settingsForSession).not.toHaveBeenCalled();
    });

    it('does not read the settings for a send that suppression already refused', async () => {
      // The comment in the code claims this ordering; this is what stops the claim rotting.
      suppression.assertNotSuppressed.mockRejectedValue(suppressionError());
      tenancy.settingsForSession.mockResolvedValue(window);

      await guard.assertSendAllowed('sess-1', CONTACT, undefined, NIGHT).catch(() => undefined);

      expect(tenancy.settingsForSession).not.toHaveBeenCalled();
    });

    it('allows the send when the tenancy lookup finds no policy', async () => {
      // The ordinary single-tenant install: no quiet hours configured anywhere.
      tenancy.settingsForSession.mockResolvedValue(null);

      await expect(guard.assertSendAllowed('sess-1', CONTACT, undefined, NIGHT)).resolves.toBeUndefined();
    });

    it('still enforces quiet hours when no tenancy wiring exists at all', async () => {
      // A guard built without TenancyService has no organization policy, so it must read `undefined`
      // settings as policy-off rather than throwing or refusing.
      const bare = new OutboundGuardService(ds.getRepository(Session), quietHours);

      await expect(bare.assertSendAllowed('sess-1', CONTACT, undefined, NIGHT)).resolves.toBeUndefined();
      await expect(bare.assertSendAllowed('sess-1', CONTACT, window, NIGHT)).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe('evaluate — reporting both controls', () => {
    it('reports nothing wrong when both allow', async () => {
      const result = await guard.evaluate('sess-1', CONTACT, window, DAY);

      expect(result).toMatchObject({ allowed: true, suppressed: false, codes: [] });
    });

    it('reports ONLY the suppression when only the contact is suppressed', async () => {
      suppression.isSuppressed.mockResolvedValue(true);

      const result = await guard.evaluate('sess-1', CONTACT, window, DAY);

      expect(result).toMatchObject({ allowed: false, suppressed: true, codes: [RECIPIENT_SUPPRESSED] });
      expect(result.quietHours.withinQuietHours).toBe(false);
    });

    it('reports BOTH when a chat is suppressed and outside quiet hours', async () => {
      // An operator debugging "why can't I reach this contact" needs to see both. Surfacing only the one
      // the sender happened to hit leaves the other to be discovered mid-campaign.
      suppression.isSuppressed.mockResolvedValue(true);

      const result = await guard.evaluate('sess-1', CONTACT, window, NIGHT);

      expect(result.allowed).toBe(false);
      expect(result.codes).toEqual([RECIPIENT_SUPPRESSED, 'QUIET_HOURS']);
    });

    it('carries a retry time for the quiet-hours half', async () => {
      const result = await guard.evaluate('sess-1', CONTACT, window, NIGHT);

      expect(result.quietHours.nextAllowedAt?.toISOString()).toBe('2026-01-16T07:00:00.000Z');
    });

    it('does not consult the registry for a send with no chat', async () => {
      const result = await guard.evaluate('sess-1', undefined, window, DAY);

      expect(result).toMatchObject({ allowed: true, suppressed: false });
      expect(suppression.isSuppressed).not.toHaveBeenCalled();
    });
  });

  describe('windowFor', () => {
    it('compiles settings into a window for a preview endpoint', () => {
      expect(guard.windowFor(window)).toMatchObject({ startMinutes: 22 * 60, endMinutes: 7 * 60 });
      expect(guard.windowFor(null)).toBeNull();
    });
  });

  describe('isAttributed', () => {
    it('is false for a session with no organization', async () => {
      // A session predating tenancy attribution has no org whose settings could set a window, so policy
      // is off for it — exactly as it is for any unconfigured deployment.
      await ds.getRepository(Session).save({ id: 'sess-1', name: 'One', status: 'STARTED' } as never);

      expect(await guard.isAttributed('sess-1')).toBe(false);
    });

    it('is true once the session names an organization', async () => {
      await ds.getRepository(Session).save({
        id: 'sess-2',
        name: 'Two',
        status: 'STARTED',
        organizationId: 'org-1',
      } as never);

      expect(await guard.isAttributed('sess-2')).toBe(true);
    });

    it('is false for a session that does not exist', async () => {
      expect(await guard.isAttributed('nope')).toBe(false);
    });
  });
});
