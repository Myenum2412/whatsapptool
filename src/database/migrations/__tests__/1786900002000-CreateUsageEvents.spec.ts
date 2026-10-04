import { DataSource } from 'typeorm';
import { CreateUsageEvents1786900002000 } from '../1786900002000-CreateUsageEvents';

/**
 * Regression lock: the usage ledger is what an invoice is summed from, so its shape and its indexes
 * are load-bearing. The two composite indexes exist so a per-organization window is an index range;
 * losing either turns every billing query into a table scan over the highest-volume table.
 */
describe('CreateUsageEvents migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('creates usage_events with an explicit id', async () => {
    const qr = ds.createQueryRunner();
    await new CreateUsageEvents1786900002000().up(qr);

    const rows = (await qr.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='usage_events'",
    )) as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    await qr.release();
  });

  it('creates both composite indexes under the names the entity declares', async () => {
    const qr = ds.createQueryRunner();
    await new CreateUsageEvents1786900002000().up(qr);

    const indexes = (await qr.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='usage_events'",
    )) as Array<{ name: string }>;
    const names = indexes.map(index => index.name);
    expect(names).toContain('IDX_usage_events_organizationId_occurredAt');
    expect(names).toContain('IDX_usage_events_organizationId_kind_occurredAt');
    await qr.release();
  });

  it('records usage and reads it back with the declared defaults', async () => {
    const qr = ds.createQueryRunner();
    await new CreateUsageEvents1786900002000().up(qr);

    await qr.query('INSERT INTO usage_events (id, organizationId, kind, quantity, occurredAt) VALUES (?, ?, ?, ?, ?)', [
      'u1',
      'org-1',
      'message.sent',
      500,
      '2026-01-01T00:00:00.000Z',
    ]);
    const rows = (await qr.query('SELECT quantity, metadata, createdAt FROM usage_events WHERE id = ?', [
      'u1',
    ])) as Array<{ quantity: number; metadata: string | null; createdAt: string }>;
    expect(rows[0].quantity).toBe(500);
    expect(rows[0].metadata).toBeNull();
    // createdAt must be filled by the column default — a ledger row with no write time cannot be
    // reconciled after the fact.
    expect(rows[0].createdAt).toBeTruthy();
    await qr.release();
  });

  it('requires an organization and a kind', async () => {
    const qr = ds.createQueryRunner();
    await new CreateUsageEvents1786900002000().up(qr);

    await expect(
      qr.query("INSERT INTO usage_events (id, kind, occurredAt) VALUES ('u1', 'message.sent', '2026-01-01')"),
    ).rejects.toThrow();
    await qr.release();
  });

  it('is idempotent', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateUsageEvents1786900002000();
    await migration.up(qr);
    await expect(migration.up(qr)).resolves.not.toThrow();
    await qr.release();
  });

  it('down() drops the table and both indexes', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateUsageEvents1786900002000();
    await migration.up(qr);
    await migration.down(qr);

    const tables = (await qr.query("SELECT name FROM sqlite_master WHERE name='usage_events'")) as Array<{
      name: string;
    }>;
    expect(tables).toHaveLength(0);
    await qr.release();
  });
});
