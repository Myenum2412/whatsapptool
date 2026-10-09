import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `role` to `users` — the authorization tier of a dashboard sign-in (POST /api/auth/login).
 *
 * The column is `varchar(20)` with a `'users'` default so rows that existed before sign-in landed
 * (created under the "named operator, no credential" increment) adopt least privilege on upgrade
 * rather than inheriting key-management power they were never granted. The seeded bootstrap admin
 * is written with an explicit `orgmenu` role by LoginService, not by this default.
 *
 * Runs on the **main** connection (auth/audit), which is always SQLite. Idempotent: the column is
 * probed before the ALTER, so a run interrupted after the DDL still completes and a database
 * previously created by `synchronize` is safe to adopt (the same shape as AddApiKeyAllowedChats).
 */
export class AddUserRole1787000000000 implements MigrationInterface {
  name = 'AddUserRole1787000000000';

  private async hasColumn(queryRunner: QueryRunner, name: string): Promise<boolean> {
    if (queryRunner.connection.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = '${name}'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("users")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner, 'role'))) {
      await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "role" varchar(20) NOT NULL DEFAULT 'users'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner, 'role')) {
      await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "role"`);
    }
  }
}
