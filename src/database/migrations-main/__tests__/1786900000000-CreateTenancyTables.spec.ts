import { DataSource } from 'typeorm';
import { CreateTenancyTables1786900000000 } from '../1786900000000-CreateTenancyTables';
import { DEFAULT_ORGANIZATION_ID } from '../../../modules/tenancy/tenancy.constants';

/**
 * Regression lock: with MAIN_DATABASE_SYNCHRONIZE=false the main connection is schema-managed by this
 * migration alone, so a fresh install that skipped it would have no `organizations` row to resolve
 * against — every request would fall back to a tenant that does not exist, silently.
 */
describe('CreateTenancyTables migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const tables = async (qr: ReturnType<DataSource['createQueryRunner']>): Promise<string[]> => {
    const rows = (await qr.query("SELECT name FROM sqlite_master WHERE type='table'")) as Array<{ name: string }>;
    return rows.map(row => row.name);
  };

  it('creates the three tenancy tables', async () => {
    const qr = ds.createQueryRunner();
    await new CreateTenancyTables1786900000000().up(qr);

    const names = await tables(qr);
    expect(names).toContain('organizations');
    expect(names).toContain('users');
    expect(names).toContain('memberships');
    await qr.release();
  });

  it('seeds exactly one default organization at the id the data migration backfills to', async () => {
    const qr = ds.createQueryRunner();
    await new CreateTenancyTables1786900000000().up(qr);

    const rows = (await qr.query('SELECT id, slug, isDefault, plan, status FROM organizations')) as Array<{
      id: string;
      slug: string;
      isDefault: number;
      plan: string;
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(DEFAULT_ORGANIZATION_ID);
    expect(rows[0].isDefault).toBe(1);
    // A fresh install must not land on a paid tier by accident.
    expect(rows[0].plan).toBe('community');

    await qr.release();
  });

  it('creates the user/membership tables EMPTY — an identity nobody can authenticate as is not a seed', async () => {
    const qr = ds.createQueryRunner();
    await new CreateTenancyTables1786900000000().up(qr);

    // The tables must exist (no FK-free route into them otherwise) but hold no rows: a placeholder
    // user with no usable credential would only confuse the first person to read the table.
    const users = (await qr.query('SELECT COUNT(*) AS n FROM users')) as Array<{ n: number }>;
    const memberships = (await qr.query('SELECT COUNT(*) AS n FROM memberships')) as Array<{ n: number }>;
    expect(users[0].n).toBe(0);
    expect(memberships[0].n).toBe(0);
    await qr.release();
  });

  it('is idempotent, and re-running does not disturb a row an operator added', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateTenancyTables1786900000000();
    await migration.up(qr);

    await qr.query("INSERT INTO organizations (id, slug, name, isDefault) VALUES ('org-2', 'acme', 'Acme', 0)");
    await expect(migration.up(qr)).resolves.not.toThrow();

    const rows = (await qr.query('SELECT slug FROM organizations ORDER BY slug')) as Array<{ slug: string }>;
    // The seeded default survives (INSERT OR IGNORE on the primary key) and so does the operator's row.
    expect(rows.map(row => row.slug)).toEqual(['acme', 'default']);
    await qr.release();
  });

  it('gives a membership the column defaults the entity declares', async () => {
    const qr = ds.createQueryRunner();
    await new CreateTenancyTables1786900000000().up(qr);

    await qr.query("INSERT INTO memberships (id, organizationId, userId) VALUES ('m1', 'org-1', 'user-1')");
    const rows = (await qr.query('SELECT role FROM memberships WHERE id = ?', ['m1'])) as Array<{ role: string }>;
    expect(rows[0].role).toBe('member');
    await qr.release();
  });

  it('enforces one membership per (organization, user) in the database, not just in code', async () => {
    const qr = ds.createQueryRunner();
    await new CreateTenancyTables1786900000000().up(qr);

    await qr.query("INSERT INTO memberships (id, organizationId, userId) VALUES ('m1', 'org-1', 'user-1')");
    await expect(
      qr.query("INSERT INTO memberships (id, organizationId, userId) VALUES ('m2', 'org-1', 'user-1')"),
    ).rejects.toThrow();

    // The same user in a different organization is a different membership, so it must insert.
    await expect(
      qr.query("INSERT INTO memberships (id, organizationId, userId) VALUES ('m3', 'org-2', 'user-1')"),
    ).resolves.toBeDefined();
    await qr.release();
  });

  it('down() drops all three tables', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateTenancyTables1786900000000();
    await migration.up(qr);
    await migration.down(qr);

    const names = await tables(qr);
    expect(names).not.toContain('organizations');
    expect(names).not.toContain('users');
    expect(names).not.toContain('memberships');
    await qr.release();
  });
});
