import { NotFoundException } from '@nestjs/common';
import assert from 'node:assert/strict';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditAction } from '../../audit/entities/audit-log.entity';
import { AuditService } from '../../audit/audit.service';
import { Session } from '../../session/entities/session.entity';
import { OrganizationSettingsController } from '../organization-settings.controller';
import { Organization } from '../entities/organization.entity';
import { Membership } from '../entities/membership.entity';
import { TenancyService } from '../tenancy.service';

/**
 * The handler-level contract: which organization a request is about, and what the write reports.
 *
 * The guard's own role and session-scope behaviour is NOT re-tested here — `api-key.guard.spec.ts` and
 * the coverage specs own that. What is pinned here is the part this controller alone decides.
 */
describe('OrganizationSettingsController', () => {
  let controller: OrganizationSettingsController;
  let tenancy: {
    resolveOrganizationId: jest.Mock;
    readOrganizationSettings: jest.Mock;
    updateOrganizationSettings: jest.Mock;
  };
  /** Typed so the recorded calls can be asserted field by field — an `any`-typed mock makes every
   * read of `mock.calls` an unsafe assignment, and asymmetric matchers around them are worse. */
  let audit: { logInfo: jest.Mock<Promise<null>, [AuditAction, { metadata?: Record<string, unknown> }]> };

  const window = { start: '22:00', end: '07:00', timezone: 'Europe/Lisbon' };

  beforeEach(async () => {
    tenancy = {
      // Echoes a supplied id and answers the default otherwise, the way the real resolver behaves once
      // enforcement is on — so a case asserting "wrote to the resolved org" can tell the two apart.
      resolveOrganizationId: jest.fn((id?: string) => Promise.resolve(id ?? 'org-1')),
      readOrganizationSettings: jest.fn().mockResolvedValue({ quietHours: window }),
      updateOrganizationSettings: jest.fn().mockResolvedValue({ quietHours: { ...window, enabled: true } }),
    };
    // Typed at construction rather than cast at the assignment, so the recorded-call tuple the
    // assertions read is checked against the real `AuditService.logInfo` context shape.
    audit = {
      logInfo: jest.fn<Promise<null>, [AuditAction, { metadata?: Record<string, unknown> }]>(() =>
        Promise.resolve(null),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationSettingsController],
      providers: [
        { provide: TenancyService, useValue: tenancy },
        { provide: AuditService, useValue: audit },
        { provide: getRepositoryToken(Organization, 'main'), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Membership, 'main'), useValue: {} },
        { provide: getRepositoryToken(Session, 'data'), useValue: { findOne: jest.fn() } },
      ],
    }).compile();

    controller = module.get(OrganizationSettingsController);
  });

  /** The `AuditAction` and metadata of the single call the handler made, in that order. */
  const audited = (): [AuditAction, { metadata?: Record<string, unknown> }] => {
    assert.equal(audit.logInfo.mock.calls.length, 1, 'expected exactly one audit row');
    return audit.logInfo.mock.calls[0];
  };

  describe('resolving which organization a request is about', () => {
    it('passes a supplied id to the tenancy resolver rather than trusting it', async () => {
      await controller.getSettings('org-7');

      expect(tenancy.resolveOrganizationId).toHaveBeenCalledWith('org-7');
      expect(tenancy.readOrganizationSettings).toHaveBeenCalledWith('org-7');
    });

    it('resolves with no id when the query names none', async () => {
      await controller.getSettings(undefined);

      expect(tenancy.resolveOrganizationId).toHaveBeenCalledWith(undefined);
    });

    it('answers 404 for an unknown organization rather than 500', async () => {
      // `resolveOrganizationId` throws a bare Error because its other callers are background jobs. An
      // HTTP route cannot let a typo in a query string read as a server fault.
      tenancy.resolveOrganizationId.mockRejectedValue(new Error('Unknown organization: org-9'));

      await expect(controller.getSettings('org-9')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reports the stored settings against the RESOLVED organization, not the requested one', async () => {
      // With enforcement off the resolver discards the supplied id; echoing the query back would tell
      // the operator they edited an organization they did not.
      tenancy.resolveOrganizationId.mockResolvedValue('00000000-0000-4000-8000-000000000001');

      const body = await controller.getSettings('org-7');

      expect(body.organizationId).toBe('00000000-0000-4000-8000-000000000001');
    });

    it('omits quietHours when the organization has never configured one', async () => {
      tenancy.readOrganizationSettings.mockResolvedValue({});

      await expect(controller.getSettings()).resolves.toEqual({ organizationId: 'org-1' });
    });
  });

  describe('updating', () => {
    it('returns the settings after the merge, not the patch', async () => {
      // A client that re-reads its own request would conclude the save did nothing when it merged into
      // an existing window — which is the common case for a one-field form.
      const body = await controller.updateSettings({ quietHours: { enabled: true } });

      expect(body).toEqual({ organizationId: 'org-1', quietHours: { ...window, enabled: true } });
    });

    it('does not audit the patch but the stored result', async () => {
      // "What did this request ask for" cannot answer "what policy is now in force", which is the only
      // question worth asking about a compliance control after the fact.
      tenancy.updateOrganizationSettings.mockResolvedValue({ quietHours: { ...window, enabled: false } });

      await controller.updateSettings({ quietHours: { enabled: false } });

      const [action, context] = audited();
      assert.equal(action, AuditAction.ORGANIZATION_SETTINGS_UPDATED);
      // The whole metadata, not a subset: a row that also carried the rejected patch would answer a
      // different question ("what was asked for") than the one an audit of a control has to answer.
      assert.deepEqual(context.metadata, {
        organizationId: 'org-1',
        quietHours: { ...window, enabled: false },
      });
    });

    it('attributes the audit row to the organization it actually wrote', async () => {
      tenancy.resolveOrganizationId.mockResolvedValue('org-3');

      await controller.updateSettings({ quietHours: { enabled: true } }, 'org-3');

      const [action, context] = audited();
      assert.equal(action, AuditAction.ORGANIZATION_SETTINGS_UPDATED);
      assert.equal(context.metadata?.organizationId, 'org-3');
    });

    it('audits a null window when one is being removed, so the row is not silent about it', async () => {
      tenancy.updateOrganizationSettings.mockResolvedValue({});

      await controller.updateSettings({ quietHours: { enabled: false } });

      const [action, context] = audited();
      assert.equal(action, AuditAction.ORGANIZATION_SETTINGS_UPDATED);
      // Explicitly null rather than an absent key: "a window was removed" and "this save carried no
      // window" are different facts, and only one of them is why an operator is reading the row.
      assert.deepEqual(context.metadata, { organizationId: 'org-1', quietHours: null });
    });

    it('does not record a change the service refused', async () => {
      tenancy.updateOrganizationSettings.mockRejectedValue(new Error('quietHours.timezone must be an IANA zone'));

      await expect(controller.updateSettings({ quietHours: { timezone: 'Mars/Olympus' } })).rejects.toThrow();

      expect(audit.logInfo).not.toHaveBeenCalled();
    });

    it('still serves when no audit service is wired', async () => {
      // The service is @Global in the app but absent from a direct-construction test; a settings save
      // must not become un-callable depending on how its test was written.
      const bare = new OrganizationSettingsController(tenancy as unknown as TenancyService);

      await expect(bare.updateSettings({ quietHours: { enabled: true } })).resolves.toEqual({
        organizationId: 'org-1',
        quietHours: { ...window, enabled: true },
      });
    });
  });
});
