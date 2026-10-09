import { DataSource } from 'typeorm';
import { AddSessionOwnerUserId1787000002000 } from '../1787000002000-AddSessionOwnerUserId';

/**
 * Regression lock: `sessions.ownerUserId` is the whole privacy boundary of the "private sessions per
 * account" rule. It must land as a NULLABLE, UNBACKFILLED column — NULL is the orgmenu-only marker
 * for pre-existing / hand-minted sessions — and it must be indexed for the owner filter.
 */
describe('AddSessionOwnerUserId migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /** The `sessions` table as the earlier chain leaves it: no ownerUserId column. */
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

  const ownerIds = async (
    qr: ReturnType<DataSource['createQueryRunner']>,
  ): Promise<Array<{ id: string; ownerUserId: string | null }>> =>
    (await qr.query('SELECT id, ownerUserId FROM sessions ORDER BY id')) as Array<{
      id: string;
      ownerUserId: string | null;
    }>;

  it('adds a NULLABLE column and leaves existing sessions UNOWNED (orgmenu-only), never backfilled', async () => {
    const qr = ds.createQueryRunner();
    await createSessions(qr);
    await seedSessions(qr, ['s1', 's2']);
    await new AddSessionOwnerUserId1787000002000().up(qr);

    const rows = await ownerIds(qr);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Pre-existing sessions have no account; backfilling them to ANY account would grant that
      // account private access to connections it never created.
      expect(row.ownerUserId).toBeNull();
    }
    await qr.release();
  });

  it('stays NULLABLE and inserts a fresh session unowned (no write path forced to know its owner)', async () => {
    const qr = ds.createQueryRunner();
    await createSessions(qr);
    await seedSessions(qr, ['s1']);
    await new AddSessionOwnerUserId1787000002000().up(qr);

    await expect(qr.query("INSERT INTO sessions (id, name) VALUES ('s2', 'name-s2')")).resolves.toBeDefined();
    expect((await ownerIds(qr)).find(row => row.id === 's2')?.ownerUserId).toBeNull();
    await qr.release();
  });

  it('is idempotent: re-running neither throws nor duplicates the owner index', async () => {
    const qr = ds.createQueryRunner();
    await createSessions(qr);
    await seedSessions(qr, ['s1']);
    const migration = new AddSessionOwnerUserId1787000002000();

    await migration.up(qr);
    await expect(migration.up(qr)).resolves.not.toThrow();

    const indexes = (await qr.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'",
    )) as Array<{ name: string }>;
    expect(indexes.filter(index => index.name === 'IDX_sessions_ownerUserId')).toHaveLength(1);
    await qr.release();
  });

  it('is safe on a DB a previous synchronize build already altered', async () => {
    const qr = ds.createQueryRunner();
    await createSessions(qr);
    await qr.query('ALTER TABLE "sessions" ADD COLUMN "ownerUserId" varchar(36) NULL');
    await seedSessions(qr, ['s1']);

    await expect(new AddSessionOwnerUserId1787000002000().up(qr)).resolves.not.toThrow();
    await qr.release();
  });

  it('down() drops the index but KEEPS the owner column (revert loses nothing)', async () => {
    const qr = ds.createQueryRunner();
    await createSessions(qr);
    await seedSessions(qr, ['s1']);
    const migration = new AddSessionOwnerUserId1787000002000();
    await migration.up(qr);
    await migration.down(qr);

    const indexes = (await qr.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'",
    )) as Array<{ name: string }>;
    expect(indexes.some(index => index.name === 'IDX_sessions_ownerUserId')).toBe(false);
    // A reverted privacy migration must not also destroy whatever ownership data was stamped.
    await expect(ownerIds(qr)).resolves.toHaveLength(1);
    await qr.release();
  });
});
