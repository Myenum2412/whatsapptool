import { DataSource } from 'typeorm';
import { AddSessionOrganizationId1786900001000 } from '../1786900001000-AddSessionOrganizationId';
import { DEFAULT_ORGANIZATION_ID } from '../../../modules/tenancy/tenancy.constants';

/**
 * Regression lock: `sessions.organizationId` must land backfilled, because it is the join key from
 * every WhatsApp account to the ledger. A NULL there means usage meters against nothing, and the
 * fallback is designed to be silent — so the backfill is the only thing standing between an upgraded
 * install and unattributable usage.
 */
describe('AddSessionOrganizationId migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /** The `sessions` table as the earlier chain leaves it: no organizationId column. */
  const createSessions = async (qr: ReturnType<DataSource['createQueryRunner']>): Promise<void> => {
    await qr.query(
      `CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar(100) NOT NULL, ` +
        `"status" varchar(50) NOT NULL DEFAULT ('created'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
  };

  const seedSessions = async (qr: ReturnType<DataSource['createQueryRunner']>, ids: string[]): Promise<void> => {
    for (const id of ids) {
      await qr.query('INSERT INTO sessions (id, name) VALUES (?, ?)', [id, `name-${id}`]);
    }
  };

  const organizationIds = async (
    qr: ReturnType<DataSource['createQueryRunner']>,
  ): Promise<Array<{ id: string; organizationId: string | null }>> =>
    (await qr.query('SELECT id, organizationId FROM sessions ORDER BY id')) as Array<{
      id: string;
      organizationId: string | null;
    }>;

  it('adds a NULLABLE column and backfills existing sessions to the default organization', async () => {
    const qr = ds.createQueryRunner();
    await createSessions(qr);
    await seedSessions(qr, ['s1', 's2']);
    await new AddSessionOrganizationId1786900001000().up(qr);

    const rows = await organizationIds(qr);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.organizationId).toBe(DEFAULT_ORGANIZATION_ID);
    }
    await qr.release();
  });

  it('stays NULLABLE — enforcement is a later increment, and SQLite cannot NOT NULL a populated table', async () => {
    const qr = ds.createQueryRunner();
    await createSessions(qr);
    await seedSessions(qr, ['s1']);
    await new AddSessionOrganizationId1786900001000().up(qr);

    // A session written by a path that has not been threaded through the resolver yet must still be
    // insertable. A NOT NULL column here would break exactly those paths.
    await expect(qr.query("INSERT INTO sessions (id, name) VALUES ('s2', 'name-s2')")).resolves.toBeDefined();
    const rows = await organizationIds(qr);
    expect(rows.find(row => row.id === 's2')?.organizationId).toBeNull();
    await qr.release();
  });

  it('is idempotent: re-running neither throws nor duplicates the index or the backfill', async () => {
    const qr = ds.createQueryRunner();
    await createSessions(qr);
    await seedSessions(qr, ['s1']);
    const migration = new AddSessionOrganizationId1786900001000();

    await migration.up(qr);
    await expect(migration.up(qr)).resolves.not.toThrow();

    const indexes = (await qr.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'",
    )) as Array<{ name: string }>;
    expect(indexes.filter(index => index.name === 'IDX_sessions_organizationId')).toHaveLength(1);

    const rows = await organizationIds(qr);
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(DEFAULT_ORGANIZATION_ID);
    await qr.release();
  });

  it('re-points a row left NULL by an earlier partial attempt', async () => {
    const qr = ds.createQueryRunner();
    await createSessions(qr);
    await seedSessions(qr, ['s1']);
    await new AddSessionOrganizationId1786900001000().up(qr);

    // Simulate a session written after the backfill by a path that has not been migrated yet.
    await qr.query("UPDATE sessions SET organizationId = NULL WHERE id = 's1'");
    await new AddSessionOrganizationId1786900001000().up(qr);

    const rows = await organizationIds(qr);
    expect(rows[0].organizationId).toBe(DEFAULT_ORGANIZATION_ID);
    await qr.release();
  });

  it('is safe on a DB a previous synchronize build already altered', async () => {
    const qr = ds.createQueryRunner();
    await createSessions(qr);
    await qr.query('ALTER TABLE "sessions" ADD COLUMN "organizationId" varchar(36) NULL');
    await seedSessions(qr, ['s1']);

    await expect(new AddSessionOrganizationId1786900001000().up(qr)).resolves.not.toThrow();
    const rows = await organizationIds(qr);
    expect(rows[0].organizationId).toBe(DEFAULT_ORGANIZATION_ID);
    await qr.release();
  });

  it('down() drops the index but KEEPS the column and its data', async () => {
    const qr = ds.createQueryRunner();
    await createSessions(qr);
    await seedSessions(qr, ['s1']);
    const migration = new AddSessionOrganizationId1786900001000();
    await migration.up(qr);
    await migration.down(qr);

    const indexes = (await qr.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'",
    )) as Array<{ name: string }>;
    expect(indexes.some(index => index.name === 'IDX_sessions_organizationId')).toBe(false);
    // Dropping the column would destroy the backfill of every pre-existing session.
    const rows = await organizationIds(qr);
    expect(rows[0].organizationId).toBe(DEFAULT_ORGANIZATION_ID);
    await qr.release();
  });
});
