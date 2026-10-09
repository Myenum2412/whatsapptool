import { DataSource } from 'typeorm';
import { AddApiKeyOwnerUserId1787000002000 } from '../1787000002000-AddApiKeyOwnerUserId';

/**
 * Regression lock: `api_keys.ownerUserId` is the account-key marker that triggers the
 * private-sessions rule in validateApiKey. It must land NULLABLE (hand-minted keys stay NULL, which
 * keeps their pre-existing fail-open model) and idempotent (the main connection has been
 * synchronize-provisioned for most installs and adoptable migrations are the norm).
 */
describe('AddApiKeyOwnerUserId migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /** The `api_keys` table as the earlier chain leaves it: no ownerUserId column. */
  const createApiKeys = async (qr: ReturnType<DataSource['createQueryRunner']>): Promise<void> => {
    await qr.query(
      `CREATE TABLE "api_keys" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"name" varchar(100) NOT NULL, ` +
        `"keyHash" varchar(64) NOT NULL, ` +
        `"keyPrefix" varchar(12) NOT NULL, ` +
        `"role" varchar(20) NOT NULL DEFAULT ('users')` +
        `)`,
    );
  };

  const seedKeys = async (qr: ReturnType<DataSource['createQueryRunner']>, ids: string[]): Promise<void> => {
    for (const id of ids) {
      await qr.query('INSERT INTO api_keys (id, name, keyHash, keyPrefix) VALUES (?, ?, ?, ?)', [
        id,
        `key-${id}`,
        `hash-${id}`,
        `prefix-${id}`,
      ]);
    }
  };

  const ownerIds = async (
    qr: ReturnType<DataSource['createQueryRunner']>,
  ): Promise<Array<{ id: string; ownerUserId: string | null }>> =>
    (await qr.query('SELECT id, ownerUserId FROM api_keys ORDER BY id')) as Array<{
      id: string;
      ownerUserId: string | null;
    }>;

  it('adds a NULLABLE column and leaves existing (hand-minted) keys ownerless', async () => {
    const qr = ds.createQueryRunner();
    await createApiKeys(qr);
    await seedKeys(qr, ['k1', 'k2']);
    await new AddApiKeyOwnerUserId1787000002000().up(qr);

    const rows = await ownerIds(qr);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.ownerUserId).toBeNull();
    await qr.release();
  });

  it('stays NULLABLE: an operator-minted key written without an owner still inserts', async () => {
    const qr = ds.createQueryRunner();
    await createApiKeys(qr);
    await seedKeys(qr, ['k1']);
    await new AddApiKeyOwnerUserId1787000002000().up(qr);

    await expect(
      qr.query('INSERT INTO api_keys (id, name, keyHash, keyPrefix) VALUES (?, ?, ?, ?)', [
        'k2',
        'key-k2',
        'hash-k2',
        'prefix-k2',
      ]),
    ).resolves.toBeDefined();
    expect((await ownerIds(qr)).find(row => row.id === 'k2')?.ownerUserId).toBeNull();
    await qr.release();
  });

  it('is idempotent on a DB a previous synchronize build (or interrupted run) already altered', async () => {
    const qr = ds.createQueryRunner();
    await createApiKeys(qr);
    await qr.query('ALTER TABLE "api_keys" ADD COLUMN "ownerUserId" varchar(36) NULL');
    await seedKeys(qr, ['k1']);

    const migration = new AddApiKeyOwnerUserId1787000002000();
    await migration.up(qr);
    await expect(migration.up(qr)).resolves.not.toThrow();
    await qr.release();
  });

  it('down() drops the column when present and no-ops when absent', async () => {
    const qr = ds.createQueryRunner();
    await createApiKeys(qr);
    await seedKeys(qr, ['k1']);
    const migration = new AddApiKeyOwnerUserId1787000002000();
    await migration.up(qr);
    await migration.down(qr);
    // The column is gone, so it must not be SELECTable any more (and the table survives).
    await expect(qr.query('SELECT id, ownerUserId FROM api_keys')).rejects.toThrow(/no such column: ownerUserId/);

    await expect(migration.down(qr)).resolves.not.toThrow();
    await qr.release();
  });
});
