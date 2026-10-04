import { Logger } from '@nestjs/common';
import { DataSource, QueryDeepPartialEntity } from 'typeorm';
import { UsageEvent, UsageEventKind } from '../entities/usage-event.entity';
import { Session, SessionStatus } from '../../session/entities/session.entity';
import { UsageService } from '../usage.service';
import { TenancyService } from '../../tenancy/tenancy.service';
import { DEFAULT_ORGANIZATION_ID } from '../../tenancy/tenancy.constants';

/**
 * Uses a real in-memory SQLite DataSource rather than a mocked repository, deliberately.
 *
 * Two of the properties under test are invisible to a mock: that the aggregate SQL actually runs
 * against the declared columns (a hand-written `SUM(quantity)` over a misspelled column throws only
 * against a real schema — see send-pacing-cold-query.spec.ts for the same reasoning), and that
 * `occurredAt` round-trips through the entity's DateTransformer on the way into the window filter.
 * The window boundary test in particular would pass against a mock that ignored its arguments.
 */
describe('UsageService', () => {
  let ds: DataSource;
  let service: UsageService;
  let tenancy: { defaultOrganizationId: jest.Mock; resolveOrganizationId: jest.Mock };

  const orgA = '00000000-0000-4000-8000-00000000000a';
  const orgB = '00000000-0000-4000-8000-00000000000b';

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [UsageEvent, Session],
      synchronize: true,
    });
    await ds.initialize();
    delete process.env.MULTITENANCY_ENABLED;

    // A hand-rolled stub rather than a real TenancyService: its repositories live on the main
    // connection, which this spec does not open, and the single-tenant path never reads them anyway.
    // Stubbing resolution is what is actually under test — that UsageService DELEGATES attribution
    // instead of deciding it.
    tenancy = {
      defaultOrganizationId: jest.fn().mockResolvedValue(DEFAULT_ORGANIZATION_ID),
      resolveOrganizationId: jest.fn((id?: string | null) => Promise.resolve(id ?? DEFAULT_ORGANIZATION_ID)),
    };

    service = new UsageService(
      ds.getRepository(UsageEvent),
      ds.getRepository(Session),
      // Only the two resolution methods are exercised; the rest of TenancyService would need the
      // main-connection repositories this spec deliberately does not open.
      tenancy as unknown as TenancyService,
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /** Let the fire-and-forget insert land before asserting on rows. */
  const settle = () => new Promise(resolve => setImmediate(resolve));

  const rows = () => ds.getRepository(UsageEvent).find({ order: { kind: 'ASC' } });

  describe('attribution', () => {
    it('attributes every event to the default organization without a session read when enforcement is off', async () => {
      service.recordMessageSent('session-1');
      service.recordMessageReceived('session-1');
      await settle();

      const events = await rows();
      expect(events).toHaveLength(2);
      expect(events.every(event => event.organizationId === DEFAULT_ORGANIZATION_ID)).toBe(true);
      // The hot-path claim: no session lookup at all on the default install, so metering adds an
      // INSERT per message and zero SELECTs.
      expect(tenancy.resolveOrganizationId).not.toHaveBeenCalled();
    });

    it('resolves through tenancy from the session row when enforcement is on', async () => {
      process.env.MULTITENANCY_ENABLED = 'true';
      await ds.getRepository(Session).save({
        id: 'session-1',
        name: 'test',
        phone: '1555',
        status: SessionStatus.READY,
        organizationId: orgA,
      } as never);

      service.recordMessageSent('session-1');
      await settle();

      expect((await rows())[0].organizationId).toBe(orgA);
      expect(tenancy.resolveOrganizationId).toHaveBeenCalledWith(orgA);
    });

    it('falls back to the default when the session row has no organization yet', async () => {
      process.env.MULTITENANCY_ENABLED = 'true';
      // A session created before the backfill: organizationId is NULL, not absent.
      await ds.getRepository(Session).save({
        id: 'session-old',
        name: 'test',
        phone: '1555',
        status: SessionStatus.READY,
        organizationId: null,
      } as never);

      service.recordMessageSent('session-old');
      await settle();

      // Passed through resolveOrganizationId as null rather than short-circuited, so the
      // unknown-tenant rejection applies uniformly once enforcement is on.
      expect(tenancy.resolveOrganizationId).toHaveBeenCalledWith(null);
      expect((await rows())[0].organizationId).toBe(DEFAULT_ORGANIZATION_ID);
    });

    it('never passes an organization from the caller — the service is the only resolver', async () => {
      service.recordMessageSent('session-1');
      await settle();

      const [event] = await rows();
      expect(event.kind).toBe(UsageEventKind.MESSAGE_SENT);
      expect(event.quantity).toBe(1);
      expect(event.sessionId).toBe('session-1');
      expect(event.subject).toBeNull();
      expect(event.occurredAt).toBeInstanceOf(Date);
    });
  });

  describe('failure isolation', () => {
    it('swallows a failed write so the caller is never affected', async () => {
      // recordMessageSent returns void by contract — a caller cannot await a rejection even in
      // principle. Assert the write actually failed, or this test proves nothing.
      const insert = jest.spyOn(ds.getRepository(UsageEvent), 'insert').mockRejectedValue(new Error('disk gone'));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      expect(() => service.recordMessageSent('session-1')).not.toThrow();
      await settle();

      expect(insert).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('disk gone'),
        expect.objectContaining({ kind: 'message.sent' }),
      );
      warn.mockRestore();
      insert.mockRestore();
    });

    it('returns undefined rather than a promise, so no caller can await it', () => {
      expect(service.recordMessageSent('session-1')).toBeUndefined();
    });
  });

  describe('period reconstruction', () => {
    // Same scoped cast the service makes: metadata is a json column, so the driver takes the value
    // as-is and TypeORM simply cannot see through `Record<string, unknown>` to prove it.
    const insert = (over: Partial<UsageEvent>) =>
      ds.getRepository(UsageEvent).insert({
        organizationId: DEFAULT_ORGANIZATION_ID,
        kind: UsageEventKind.MESSAGE_SENT,
        quantity: 1,
        sessionId: null,
        subject: null,
        occurredAt: new Date('2026-03-10T12:00:00Z'),
        metadata: null,
        ...over,
      } as QueryDeepPartialEntity<UsageEvent>);

    it('sums quantity per kind, so one batched row counts as its full size', async () => {
      await insert({ quantity: 500 });
      await insert({ quantity: 1 });

      const summary = await service.summarize(
        DEFAULT_ORGANIZATION_ID,
        new Date('2026-03-01T00:00:00Z'),
        new Date('2026-04-01T00:00:00Z'),
      );

      expect(summary).toEqual([{ kind: UsageEventKind.MESSAGE_SENT, quantity: 501, events: 2 }]);
    });

    it('reconstructs an invoice for a closed period from the rows alone', async () => {
      await insert({ kind: UsageEventKind.MESSAGE_SENT, quantity: 10 });
      await insert({ kind: UsageEventKind.MESSAGE_RECEIVED, quantity: 4 });

      const summary = await service.summarize(
        DEFAULT_ORGANIZATION_ID,
        new Date('2026-03-01T00:00:00Z'),
        new Date('2026-04-01T00:00:00Z'),
      );

      const total = summary.reduce((sum, row) => sum + row.quantity, 0);
      expect(total).toBe(14);
      expect(summary.map(row => row.kind).sort()).toEqual(['message.received', 'message.sent']);
    });

    it('tiles adjacent periods without double-counting the boundary instant', async () => {
      // from inclusive, to exclusive: the row exactly on the boundary belongs to the later period.
      await insert({ occurredAt: new Date('2026-04-01T00:00:00Z'), quantity: 7 });

      const march = await service.totalFor(
        DEFAULT_ORGANIZATION_ID,
        UsageEventKind.MESSAGE_SENT,
        new Date('2026-03-01T00:00:00Z'),
        new Date('2026-04-01T00:00:00Z'),
      );
      const april = await service.totalFor(
        DEFAULT_ORGANIZATION_ID,
        UsageEventKind.MESSAGE_SENT,
        new Date('2026-04-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
      );

      expect(march).toBe(0);
      expect(april).toBe(7);
      expect(march + april).toBe(7);
    });

    it('never lets one organization read another', async () => {
      await insert({ organizationId: orgA, quantity: 3 });
      await insert({ organizationId: orgB, quantity: 99 });

      expect(
        await service.totalFor(
          orgB,
          UsageEventKind.MESSAGE_SENT,
          new Date('2026-01-01T00:00:00Z'),
          new Date('2027-01-01T00:00:00Z'),
        ),
      ).toBe(99);
      expect(
        await service.totalFor(
          orgA,
          UsageEventKind.MESSAGE_SENT,
          new Date('2026-01-01T00:00:00Z'),
          new Date('2027-01-01T00:00:00Z'),
        ),
      ).toBe(3);
    });

    it('returns numeric totals, not the strings Postgres returns for SUM', async () => {
      await insert({ quantity: 12 });
      const summary = await service.summarize(
        DEFAULT_ORGANIZATION_ID,
        new Date('2026-01-01T00:00:00Z'),
        new Date('2027-01-01T00:00:00Z'),
      );
      // Postgres returns SUM/COUNT as bigint, which the pg driver hands back as a string. A caller
      // summing two windows would concatenate them silently.
      expect(typeof summary[0].quantity).toBe('number');
      expect(typeof summary[0].events).toBe('number');
    });

    it('reports zero rather than null for a window with no usage', async () => {
      expect(
        await service.totalFor(
          orgA,
          UsageEventKind.MESSAGE_SENT,
          new Date('2026-01-01T00:00:00Z'),
          new Date('2027-01-01T00:00:00Z'),
        ),
      ).toBe(0);
    });
  });

  describe('append-only invariants', () => {
    it('has no updatedAt column, so a row cannot be silently modified in place', async () => {
      const columns: Array<{ name: string }> = await ds.query("SELECT name FROM pragma_table_info('usage_events')");
      const names = columns.map(column => column.name);
      // Billing must be able to re-derive a total from the rows alone. An auto-updating column would
      // only invite the in-place UPDATE that breaks that.
      expect(names).not.toContain('updatedAt');
      expect(names).toContain('createdAt');
      expect(names).toContain('occurredAt');
    });

    it('stamps createdAt and occurredAt independently', async () => {
      service.recordMessageSent('session-1');
      await settle();

      const [event] = await rows();
      expect(event.createdAt).toBeInstanceOf(Date);
      expect(event.occurredAt).toBeInstanceOf(Date);
    });
  });
});
