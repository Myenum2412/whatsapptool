import { DataSource, QueryRunner } from 'typeorm';
import { CreateAuthAuditTables1779900000000 } from '../1779900000000-CreateAuthAuditTables';
import { AddApiKeyAllowedChats1786600000000 } from '../1786600000000-AddApiKeyAllowedChats';
import { CreateTenancyTables1786900000000 } from '../1786900000000-CreateTenancyTables';
import { AddUserRole1787000000000 } from '../1787000000000-AddUserRole';
import { RenameAuthRoles1787000000001 } from '../1787000000001-RenameAuthRoles';

/**
 * Regression lock: the two-role collapse must remap EXISTING rows (`admin`/`operator`/`viewer`)
 * onto `orgmenu`/`users` on both `users` and `api_keys`, and flip the `api_keys.role` default to
 * `'users'` (SQLite cannot ALTER a default, so the migration rebuilds the table). A deploy where
 * this does not run leaves every old role value unrecognised — and an unrecognised role is denied
 * at the guard, locking out the operator.
 */
describe('RenameAuthRoles migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const buildChain = async (runner: QueryRunner): Promise<void> => {
    await new CreateTenancyTables1786900000000().up(runner);
    await new AddUserRole1787000000000().up(runner);
    await new CreateAuthAuditTables1779900000000().up(runner);
    await new AddApiKeyAllowedChats1786600000000().up(runner);
  };

  it('remaps every old role value on users and api_keys, and rebuilds the api_keys default', async () => {
    const qr = ds.createQueryRunner();
    try {
      await buildChain(qr);

      await qr.query("INSERT INTO users (id, email, name, role) VALUES ('u1', 'a@b.c', 'A', 'admin')");
      await qr.query("INSERT INTO users (id, email, name, role) VALUES ('u2', 'c@d.e', 'C', 'viewer')");
      await qr.query(
        "INSERT INTO api_keys (id, name, keyHash, keyPrefix, role) VALUES ('k1', 'K1', 'h1', 'ow_', 'admin')",
      );
      await qr.query(
        "INSERT INTO api_keys (id, name, keyHash, keyPrefix, role) VALUES ('k2', 'K2', 'h2', 'ow_', 'operator')",
      );
      await qr.query(
        "INSERT INTO api_keys (id, name, keyHash, keyPrefix, role) VALUES ('k3', 'K3', 'h3', 'ow_', 'viewer')",
      );

      await new RenameAuthRoles1787000000001().up(qr);

      const userRoles = (await qr.query('SELECT email, role FROM users ORDER BY email')) as Array<{
        email: string;
        role: string;
      }>;
      expect(userRoles).toEqual([
        { email: 'a@b.c', role: 'orgmenu' },
        { email: 'c@d.e', role: 'users' },
      ]);

      const keyRoles = (await qr.query('SELECT name, role FROM api_keys ORDER BY name')) as Array<{
        name: string;
        role: string;
      }>;
      expect(keyRoles).toEqual([
        { name: 'K1', role: 'orgmenu' },
        { name: 'K2', role: 'users' },
        { name: 'K3', role: 'users' },
      ]);

      // Default rebuilt to 'users': a key created without an explicit role is a plain user.
      await qr.query("INSERT INTO api_keys (id, name, keyHash, keyPrefix) VALUES ('k4', 'K4', 'h4', 'ow_')");
      const fresh = (await qr.query("SELECT role FROM api_keys WHERE id = 'k4'")) as Array<{ role: string }>;
      expect(fresh[0].role).toBe('users');

      // The unique keyHash index survived the rebuild (INSERT of a duplicate would throw).
      await expect(
        qr.query("INSERT INTO api_keys (id, name, keyHash, keyPrefix) VALUES ('k5', 'K5', 'h4', 'ow_')"),
      ).rejects.toThrow();
    } finally {
      await qr.release();
    }
  });

  it('is idempotent against already-renamed data (remap maps values onto themselves)', async () => {
    const qr = ds.createQueryRunner();
    try {
      await buildChain(qr);

      await qr.query(
        "INSERT INTO api_keys (id, name, keyHash, keyPrefix, role) VALUES ('k1', 'K1', 'h1', 'ow_', 'orgmenu')",
      );
      await qr.query(
        "INSERT INTO api_keys (id, name, keyHash, keyPrefix, role) VALUES ('k2', 'K2', 'h2', 'ow_', 'users')",
      );

      const migration = new RenameAuthRoles1787000000001();
      await migration.up(qr);
      await expect(migration.up(qr)).resolves.not.toThrow();

      const roles = (await qr.query('SELECT role FROM api_keys ORDER BY name')) as Array<{ role: string }>;
      expect(roles).toEqual([{ role: 'orgmenu' }, { role: 'users' }]);
    } finally {
      await qr.release();
    }
  });

  it('down() reverses the default back to operators and restores old role values', async () => {
    const qr = ds.createQueryRunner();
    try {
      await buildChain(qr);
      await new RenameAuthRoles1787000000001().up(qr);

      await qr.query(
        "INSERT INTO api_keys (id, name, keyHash, keyPrefix, role) VALUES ('k1', 'K1', 'h1', 'ow_', 'orgmenu')",
      );
      await qr.query(
        "INSERT INTO api_keys (id, name, keyHash, keyPrefix, role) VALUES ('k2', 'K2', 'h2', 'ow_', 'users')",
      );

      const migration = new RenameAuthRoles1787000000001();
      await migration.down(qr);

      const roles = (await qr.query('SELECT role FROM api_keys ORDER BY name')) as Array<{ role: string }>;
      expect(roles).toEqual([{ role: 'admin' }, { role: 'operator' }]);
    } finally {
      await qr.release();
    }
  });
});
