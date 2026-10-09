import { DataSource } from 'typeorm';
import { CreateTenancyTables1786900000000 } from '../1786900000000-CreateTenancyTables';
import { AddUserRole1787000000000 } from '../1787000000000-AddUserRole';

/**
 * Regression lock: the main-connection migration must add `role` to `users` so a deploy with
 * `MAIN_DATABASE_SYNCHRONIZE=false` can store and enforce a sign-in role — the entity declares the
 * column, and a chain that never creates it would 500 on every /api/auth/login.
 */
describe('AddUserRole migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const columns = async (): Promise<string[]> => {
    const qr = ds.createQueryRunner();
    const rows = (await qr.query(`PRAGMA table_info("users")`)) as Array<{ name: string }>;
    await qr.release();
    return rows.map(r => r.name);
  };

  it('adds the role column with least-privilege default on the existing users table', async () => {
    const qr = ds.createQueryRunner();
    await new CreateTenancyTables1786900000000().up(qr);
    expect(await columns()).not.toContain('role');

    await new AddUserRole1787000000000().up(qr);
    expect(await columns()).toContain('role');

    await qr.query("INSERT INTO users (id, email, name, passwordHash) VALUES ('1', 'a@b.c', 'A', NULL)");
    const rows = (await qr.query("SELECT role FROM users WHERE id = '1'")) as Array<{ role: string }>;
    expect(rows[0].role).toBe('users');
    await qr.release();
  });

  it('is idempotent', async () => {
    const qr = ds.createQueryRunner();
    await new CreateTenancyTables1786900000000().up(qr);
    const migration = new AddUserRole1787000000000();
    await migration.up(qr);
    await expect(migration.up(qr)).resolves.not.toThrow();
    await qr.release();
  });

  it('down() drops the column', async () => {
    const qr = ds.createQueryRunner();
    await new CreateTenancyTables1786900000000().up(qr);
    const migration = new AddUserRole1787000000000();
    await migration.up(qr);
    await migration.down(qr);
    expect(await columns()).not.toContain('role');
    await qr.release();
  });
});
